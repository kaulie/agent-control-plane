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
import { createBillingService } from "./billing/index.js";
import { warmModelLimits } from "./context/index.js";
import { createProviderRegistry } from "./providers/registry.js";
import { AgentGateway } from "./gateway/gateway.js";
import { registerRoutes } from "./http/routes.js";
import { registerWebSocket } from "./ws/ws.js";
import { AutonomyClient } from "./autonomy.js";
import { OrganizationClient } from "./organization.js";
import { ServiceRegistryClient } from "./service-registry.js";
import {
  buildShutdownReport,
  formatPreviousExit,
  formatShutdownLog,
  readPreviousExit,
  readPreviousShutdown,
} from "./shutdown.js";
import { shouldExitOnProcessError } from "./process-errors.js";

const config = loadConfig();
/** Prefer on-disk VERSION so /health matches rsynced web assets mid-restart. */
function advertisedVersion(): string {
  return readRuntimeVersion(config.productRoot) ?? config.appVersion;
}
const runningFlag = path.join(config.dataDir, "running.flag");
const crashed = fs.existsSync(runningFlag);

/**
 * Restart attribution: `node-exit.status` is written by supervise-node.sh and
 * `last-shutdown.json` by our own shutdown handler, so both "how did the
 * previous process die" and "why is this one going away" are recorded.
 */
const startedAt = Date.now();
const backendDir = path.dirname(config.dataDir);
const exitStatusFile = path.join(backendDir, "node-exit.status");
const lastShutdownFile = path.join(config.dataDir, "last-shutdown.json");
const previousExit = readPreviousExit(exitStatusFile);
const previousShutdown = readPreviousShutdown(lastShutdownFile);
console.log(formatPreviousExit(previousExit, { crashFlagPresent: crashed }));

const crashReportDir = path.join(config.dataDir, "crash-reports");
function writeCrashReport(kind: string, err: unknown): void {
  try {
    fs.mkdirSync(crashReportDir, { recursive: true });
    const file = path.join(
      crashReportDir,
      `crash-${kind}-${Date.now()}-${process.pid}.json`,
    );
    const body = {
      kind,
      pid: process.pid,
      appVersion: config.appVersion,
      timestamp: new Date().toISOString(),
      rssBytes: process.memoryUsage().rss,
      error:
        err instanceof Error
          ? { message: err.message, stack: err.stack ?? "" }
          : String(err),
    };
    fs.writeFileSync(file, JSON.stringify(body, null, 2));
    console.error(`[fatal] ${kind} 报告已写入 ${file}`);
  } catch (reportErr) {
    console.error("[fatal] 写入崩溃报告失败:", reportErr);
  }
}

process.on("uncaughtException", (err) => {
  if (!shouldExitOnProcessError(err)) {
    logBenignSdkClosedStream("uncaughtException", err);
    return;
  }
  writeCrashReport("uncaughtException", err);
  console.error("[fatal] uncaughtException:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  if (!shouldExitOnProcessError(reason)) {
    logBenignSdkClosedStream("unhandledRejection", reason);
    return;
  }
  writeCrashReport("unhandledRejection", reason);
  console.error("[fatal] unhandledRejection:", reason);
  process.exit(1);
});

function logBenignSdkClosedStream(kind: string, reason: unknown): void {
  const detail =
    reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : String(reason);
  console.warn(
    `[sdk] ignored late WriteIterableClosedError from ${kind} (Cursor stream already closed; not fatal): ${detail}`,
  );
}

const store = new Store(config.dataDir);
const seeded = store.seedLegacyAccountsIfEmpty({
  workspaceRoot:
    store.getGlobalSettings().workspace?.root?.trim() ||
    config.agentWorkspaceRoot,
  ...(config.apiKey ? { cursorApiKey: config.apiKey } : {}),
  ...(config.clineApiKey ? { clineApiKey: config.clineApiKey } : {}),
  clineVendor: config.clineProviderId,
});
if (seeded.length) {
  console.warn(
    `[startup] 账号池为空，已从旧 env 迁入 ${seeded.length} 个默认账号；之后以全局设置的账号池为准，不再读 CURSOR_API_KEY / DEEPSEEK_API_KEY。`,
  );
} else if (!store.listAccounts().length) {
  console.warn(
    "[startup] 账号池是空的。请在全局设置里添加 Cursor / Cline 账号，否则本机 agent 无法鉴权。",
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

const interrupted = store.markInterruptedRuns();
// 计费模块：provider 与 gateway 共用同一个实例（数据源 = billing_rules 表）。
const billing = createBillingService(store);
const providers = createProviderRegistry({
  defaultName: config.provider,
  billing,
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
    compaction: config.clineCompaction,
    compactionStrategy: config.clineCompactionStrategy,
    ...(config.clineCompactionModel ? { compactionModel: config.clineCompactionModel } : {}),
    // 网关重启后按磁盘历史续接会话（见 providers/cline/restart-resume.ts）。
    resumeSeed: config.clineResumeSeed,
    resumeSeedChars: config.clineResumeSeedChars,
  },
});
// 预热模型窗口（上下文占比要用；失败只是"窗口未知"，不影响启动）。
void warmModelLimits(providers).catch((err) => {
  console.warn(
    "[context] warmModelLimits failed:",
    err instanceof Error ? err.message : err,
  );
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
    maxConcurrentRuns: config.maxConcurrentRuns,
    agentRssLimitMb: config.agentRssLimitMb,
    deployGracefulWaitMs: config.deployGracefulWaitMs,
    billing,
    autoRotate: config.contextAutoRotate,
    contextDigest: config.contextDigest,
    digest: {
      ...(config.clineApiKey ? { apiKey: config.clineApiKey } : {}),
      ...(config.clineBaseUrl ? { baseUrl: config.clineBaseUrl } : {}),
      providerId: config.clineProviderId,
      ...(config.contextDigestModel ? { model: config.contextDigestModel } : {}),
    },
    // 注入 agent 的仓库地址来源：project → 组织 id → 服务中心的服务清单（含 git 仓库地址）。
    serviceRegistry: new ServiceRegistryClient({
      baseUrl: config.serviceRegistryApiUrl,
      timeoutMs: config.serviceRegistryTimeoutMs,
    }),
  },
  publish,
);

await registerRoutes(app, gateway, providers, {
  dataDir: config.dataDir,
  appVersion: advertisedVersion(),
  resolveAppVersion: advertisedVersion,
  processAppVersion: config.appVersion,
  gracefulRestart: config.gracefulRestart,
  processStartedAt: startedAt,
  previousShutdown,
  // Department catalogue for project settings (best-effort, never blocks boot).
  organization: new OrganizationClient({
    baseUrl: config.organizationApiUrl,
    timeoutMs: config.organizationTimeoutMs,
  }),
  // 「交给 autonomy」入口：控制面只代理它的接口（不落库）；入口开关也一起传下去。
  autonomy: new AutonomyClient({
    baseUrl: config.autonomyApiUrl,
    timeoutMs: config.autonomyTimeoutMs,
  }),
  taskEntry: config.taskEntry,
});
app.log.info(
  `deploy graceful_restart=${config.gracefulRestart ? 1 : 0} maxWaitMs=${config.deployGracefulWaitMs}`,
);

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
app.log.info(
  `organization service: ${config.organizationApiUrl} (project 所属部门, timeout=${config.organizationTimeoutMs}ms)`,
);
app.log.info(
  `service registry: ${config.serviceRegistryApiUrl} (project 组织 → 服务/仓库注入, timeout=${config.serviceRegistryTimeoutMs}ms)`,
);

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Agent Gateway listening on http://${config.host}:${config.port}`);
  gateway.startRuntimeGuards();

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

  // Queue first: a message that only ever queued (never started) is resumed
  // from the queue, so the feedback self-check must see it as already owned
  // instead of firing a second run for the same user message.
  const recovered = gateway.recoverQueuedRuns();
  if (recovered > 0) {
    app.log.info(`[queue] resumed ${recovered} queued message run(s) after restart`);
  }

  void gateway.runPendingSelfChecks().then((n) => {
    if (n > 0) {
      app.log.info(`[self-check] started ${n} pending feedback run(s)`);
    }
  }).catch((err) => {
    app.log.error({ err }, "self-check startup failed");
  });
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

let shuttingDown = false;

/** One bad step must never block a restart: log it and keep going. */
function bestEffort(step: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.warn(
      `[shutdown] ${step} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) {
    console.warn(`[shutdown] ${signal} ignored — already shutting down`);
    return;
  }
  shuttingDown = true;

  // Attribution: a SIGTERM *without* a platform drain is an external kill
  // (`kill <pid>`, another repo's stop.sh, …) — the case that used to leave no
  // trace at all in server.log.
  let drainRequested = false;
  let runningCount = 0;
  let queuedCount = 0;
  try {
    const snap = gateway.getRestartStatus();
    drainRequested = snap.admissionPaused;
    runningCount = snap.runningCount;
    queuedCount = snap.queuedCount;
  } catch {
    /* shutdown must not depend on the gateway being healthy */
  }
  const report = buildShutdownReport({
    signal,
    pid: process.pid,
    ppid: process.ppid,
    startedAt,
    drainRequested,
    runningCount,
    queuedCount,
  });
  console.warn(formatShutdownLog(report));
  bestEffort("write last-shutdown.json", () => {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(lastShutdownFile, JSON.stringify(report, null, 2));
  });
  bestEffort("remove running.flag", () => fs.rmSync(runningFlag, { force: true }));
  bestEffort("stop runtime guards", () => gateway.stopRuntimeGuards());
  bestEffort("dispose providers", () => providers.dispose());
  bestEffort("close store", () => store.close());

  // Never let a hanging close() look like an outage: bounded exit.
  const forced = setTimeout(() => {
    console.warn("[shutdown] app.close() did not settle; exiting anyway");
    process.exit(0);
  }, 5000);
  forced.unref();
  app.close()
    .then(() => process.exit(0))
    .catch((err) => {
      console.warn("[shutdown] app.close failed:", err);
      process.exit(0);
    });
};

// SIGHUP too: supervise-node.sh forwards HUP, and the default disposition kills
// node without cleanup (leaving running.flag → bogus "crashed" detection).
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => shutdown(signal));
}
