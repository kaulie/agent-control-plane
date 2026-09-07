import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, readRuntimeVersion } from "./config.js";
import {
  applyShellProxyEnv,
  assertMcpServerPresent,
} from "./git-via-proxy.js";
import { Store } from "./store/db.js";
import { createProviderRegistry } from "./providers/registry.js";
import { AgentGateway } from "./gateway/gateway.js";
import { registerRoutes } from "./http/routes.js";
import { registerWebSocket } from "./ws/ws.js";
import { DeployQueue } from "./ops/deploy-queue.js";

const config = loadConfig();
const deployQueue = new DeployQueue(config.deployHome);
/** Prefer on-disk VERSION so /health matches rsynced web assets mid-restart. */
function advertisedVersion(): string {
  return readRuntimeVersion(config.productRoot) ?? config.appVersion;
}
const runningFlag = path.join(config.dataDir, "running.flag");
const crashed = fs.existsSync(runningFlag);

if (!config.apiKey) {
  console.warn(
    "[startup] CURSOR_API_KEY is not set. Cursor-backed tasks will fail until it is set.\n" +
      "          Set it in backend/.env (see backend/.env.example).",
  );
}
if (!config.clineApiKey) {
  console.warn(
    "[startup] DEEPSEEK_API_KEY is not set. Cline-backed tasks will fail until it is set.\n" +
      "          Set it in backend/.env (see backend/.env.example).",
  );
}

const proxyEnabled = Boolean(config.gitViaProxyUrl);
if (proxyEnabled && config.gitViaProxyShell) {
  applyShellProxyEnv(config.gitViaProxyUrl);
}
const mcpWanted = proxyEnabled && config.gitViaProxyMcp;
if (mcpWanted && !assertMcpServerPresent(config.gitViaProxyServerPath)) {
  console.warn(
    `[startup] GIT_VIA_PROXY_MCP=1 but MCP server missing at ${config.gitViaProxyServerPath}\n` +
      "          Run: npm install --omit=dev  (in mcp-servers/git-via-proxy)",
  );
}

const store = new Store(config.dataDir);
const interrupted = store.markInterruptedRuns();
const providers = createProviderRegistry({
  defaultName: config.provider,
  apiKey: config.apiKey,
  model: config.model,
  gitViaProxyUrl: config.gitViaProxyUrl,
  gitViaProxyMcp:
    mcpWanted && assertMcpServerPresent(config.gitViaProxyServerPath),
  gitViaProxyServerPath: config.gitViaProxyServerPath,
  cline: {
    providerId: config.clineProviderId,
    model: config.clineModel,
    apiKey: config.clineApiKey,
    baseUrl: config.clineBaseUrl,
    systemPrompt: config.clineSystemPrompt,
  },
});
if (interrupted.orphans.length) {
  console.warn(
    `[startup] clearing ${interrupted.orphans.length} orphaned SDK agent run(s) from prior process`,
  );
  await providers.reconcileAfterRestart(interrupted.orphans);
}
if (interrupted.finalized.length) {
  console.warn(
    `[startup] finalized ${interrupted.finalized.length} interrupted run(s) as cancelled`,
  );
}

// Allow text + several base64 images in one JSON POST (decoded images are capped separately).
const app = Fastify({ logger: true, bodyLimit: 25 * 1024 * 1024 });

app.addHook("onSend", async (_req, reply, payload) => {
  reply.header("X-App-Version", advertisedVersion());
  return payload;
});

await app.register(cors, { origin: true });
await app.register(websocket, { options: { maxPayload: 1048576 } });

const publish = registerWebSocket(app);

// Serve the built web UI if present (single-process mode after `npm run build`).
if (fs.existsSync(config.webDistDir)) {
  await app.register(fastifyStatic, {
    root: config.webDistDir,
    prefix: "/",
  });
  app.log.info(`serving web UI from ${config.webDistDir}`);
}

const gateway = new AgentGateway(
  store,
  providers,
  {
    agentWorkspaceRoot: config.agentWorkspaceRoot,
    agentWorkspace: config.agentWorkspaceRoot,
    canonicalDevRepo: config.canonicalDevRepo,
    dataDir: config.dataDir,
    decisionContext: {
      ambientProxyUrl: config.gitViaProxyUrl,
      ambientShellProxy: Boolean(config.gitViaProxyUrl) && config.gitViaProxyShell,
      mcpProxyAvailable:
        Boolean(config.gitViaProxyUrl) &&
        config.gitViaProxyMcp &&
        assertMcpServerPresent(config.gitViaProxyServerPath),
    },
  },
  publish,
);

await registerRoutes(app, gateway, providers, {
  dataDir: config.dataDir,
  appVersion: advertisedVersion(),
  resolveAppVersion: advertisedVersion,
  deployQueue,
});
app.log.info(`deploy home (async ops): ${config.deployHome}`);

// 标记本次运行（若本次进程崩溃，下次启动即可据此检测）
fs.writeFileSync(runningFlag, String(process.pid));

for (const provider of providers.list()) {
  const auth = await provider.verifyAuth();
  app.log.info(
    `auth[${provider.name}]: ${auth.ok ? "OK" : "FAILED"} — ${auth.detail}`,
  );
}
app.log.info(`default agent provider: ${providers.defaultProviderName}`);
app.log.info(`agent workspace root: ${config.agentWorkspaceRoot}`);
app.log.info(
  `git-via-proxy: url=${config.gitViaProxyUrl || "(off)"} shell=${config.gitViaProxyShell ? "on" : "off"} mcp=${
    mcpWanted && assertMcpServerPresent(config.gitViaProxyServerPath) ? "on" : "off"
  }`,
);

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Agent Gateway listening on http://${config.host}:${config.port}`);

  // Push terminal events for runs that died with the previous process so
  // reconnecting UIs leave "running" and show a clear stop reason.
  for (const item of interrupted.finalized) {
    publish({ type: "agent_event", event: item.event });
    publish({
      type: "task_updated",
      task: store.getTask(item.taskId),
      stats: store.getTaskStats(item.taskId),
      runId: item.runId,
    });
  }

  if (crashed) {
    app.log.warn("检测到上次异常退出（崩溃），自动发起崩溃分析任务...");
    void gateway.createCrashAnalysisTask().catch((err) => {
      app.log.error({ err }, "崩溃分析任务创建失败");
    });
  }

  void gateway.runPendingSelfChecks().then((n) => {
    if (n > 0) {
      app.log.info(`[self-check] started ${n} pending feedback run(s)`);
    }
  }).catch((err) => {
    app.log.error({ err }, "self-check startup failed");
  });

  const recovered = gateway.recoverQueuedRuns();
  if (recovered > 0) {
    app.log.info(`[queue] resumed ${recovered} queued message run(s) after restart`);
  }
} catch (err) {
  app.log.error(err);
  try {
    fs.rmSync(runningFlag, { force: true });
  } catch {
    /* ignore */
  }
  store.close();
  process.exit(1);
}

const shutdown = (): void => {
  try {
    fs.rmSync(runningFlag, { force: true });
  } catch {
    /* ignore */
  }
  providers.dispose();
  store.close();
  app.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
