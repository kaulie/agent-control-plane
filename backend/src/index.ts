import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { Store } from "./store/db.js";
import { CursorProvider } from "./providers/cursor.js";
import { AgentGateway } from "./gateway/gateway.js";
import { registerRoutes } from "./http/routes.js";
import { registerWebSocket } from "./ws/ws.js";

const config = loadConfig();

const runningFlag = path.join(config.dataDir, "running.flag");
const crashed = fs.existsSync(runningFlag);

if (!config.apiKey) {
  console.warn(
    "[startup] CURSOR_API_KEY is not set. The gateway will start, but agent runs will fail.\n" +
      "          Set it in backend/.env (see backend/.env.example).",
  );
}

const store = new Store(config.dataDir);
const interrupted = store.markInterruptedRuns();
const provider = new CursorProvider({
  apiKey: config.apiKey,
  model: config.model,
});
if (interrupted.orphans.length) {
  console.warn(
    `[startup] clearing ${interrupted.orphans.length} orphaned SDK agent run(s) from prior process`,
  );
  await provider.reconcileAfterRestart(interrupted.orphans);
}
if (interrupted.finalized.length) {
  console.warn(
    `[startup] finalized ${interrupted.finalized.length} interrupted run(s) as cancelled`,
  );
}

// Allow text + several base64 images in one JSON POST (decoded images are capped separately).
const app = Fastify({ logger: true, bodyLimit: 25 * 1024 * 1024 });

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
  provider,
  {
    agentWorkspaceRoot: config.agentWorkspaceRoot,
    agentWorkspace: config.agentWorkspaceRoot,
    canonicalDevRepo: config.canonicalDevRepo,
    dataDir: config.dataDir,
  },
  publish,
);

await registerRoutes(app, gateway, provider, { dataDir: config.dataDir });

// 标记本次运行（若本次进程崩溃，下次启动即可据此检测）
fs.writeFileSync(runningFlag, String(process.pid));

const auth = await provider.verifyAuth();
app.log.info(`auth: ${auth.ok ? "OK" : "FAILED"} — ${auth.detail}`);
app.log.info(`agent workspace root: ${config.agentWorkspaceRoot}`);

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
  provider.dispose();
  store.close();
  app.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
