import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import type { AgentGateway } from "../gateway/gateway.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { AppSettings } from "../types.js";
import { isUsageGranularity, isUsageTimeZone } from "../usage/series.js";
import {
  resolveAttachmentPath,
  validateIncomingImages,
  type IncomingImage,
} from "../attachments.js";
import type { DeployQueue } from "../ops/deploy-queue.js";

export async function registerRoutes(
  app: FastifyInstance,
  gateway: AgentGateway,
  providers: ProviderRegistry,
  opts: {
    dataDir: string;
    appVersion: string;
    /** Live version for /health (disk VERSION preferred). */
    resolveAppVersion?: () => string;
    deployQueue: DeployQueue;
    /** When false, deploy enqueues immediately (legacy). Default true. */
    gracefulRestart?: boolean;
  },
): Promise<void> {
  const gracefulRestart = opts.gracefulRestart !== false;
  const version = (): string =>
    opts.resolveAppVersion?.() ?? opts.appVersion;

  app.get("/health", async (_req, reply) => {
    reply.header("Cache-Control", "no-store, no-cache, must-revalidate");
    const v = version();
    reply.header("X-App-Version", v);
    return {
      ok: true,
      service: "web-cursor-agent-gateway",
      provider: providers.defaultProviderName,
      providers: providers.names(),
      version: v,
      time: new Date().toISOString(),
    };
  });

  /**
   * Async deploy: enqueue for the independent deploy-agent.
   * When GRACEFUL_RESTART=1 (default): if agents are running, hold the request,
   * pause starting queued runs, and ask the caller to poll restart-status
   * (max wait: DEPLOY_GRACEFUL_WAIT_MS, default 10 min).
   * When GRACEFUL_RESTART=0 or force=true: enqueue immediately (legacy).
   */
  app.post<{
    Body: {
      deployment?: string;
      hash?: string;
      taskId?: string;
      requestId?: string;
      force?: boolean;
    };
  }>("/api/ops/deploy", async (req, reply) => {
    const raw = req.body?.deployment?.trim() || req.body?.hash?.trim() || "";
    if (!raw) {
      return reply.code(400).send({ error: "deployment or hash is required" });
    }
    const force = req.body?.force === true;
    const useGraceful = gracefulRestart && !force;
    try {
      if (useGraceful) {
        gateway.beginDeployDrain();
        const snap = gateway.getRestartStatus();
        if (!snap.canRestart) {
          let status;
          const existing = opts.deployQueue.getHeld();
          if (existing) {
            status = opts.deployQueue.getStatus(existing.requestId)!;
          } else {
            status = opts.deployQueue.hold({
              deployment: raw,
              runningCount: snap.runningCount,
              queuedCount: snap.queuedCount,
              ...(req.body?.taskId?.trim()
                ? { taskId: req.body.taskId.trim() }
                : {}),
              ...(req.body?.requestId?.trim()
                ? { requestId: req.body.requestId.trim() }
                : {}),
            });
          }
          return reply.code(202).send({
            ...status,
            canRestart: false,
            admissionPaused: true,
            gracefulRestart: true,
            activeRuns: snap.activeRuns,
            poll: "/api/ops/restart-status",
          });
        }
      }

      if (force || !gracefulRestart) {
        opts.deployQueue.cancelHeld();
        if (gateway.isAdmissionPaused()) {
          gateway.endDeployDrain();
        }
      }

      const status = opts.deployQueue.enqueue({
        deployment: raw,
        ...(req.body?.taskId?.trim() ? { taskId: req.body.taskId.trim() } : {}),
        ...(req.body?.requestId?.trim()
          ? { requestId: req.body.requestId.trim() }
          : {}),
      });
      return reply.code(202).send({
        ...status,
        canRestart: true,
        gracefulRestart,
        ...(force
          ? { forced: true }
          : !gracefulRestart
            ? { forced: true, reason: "GRACEFUL_RESTART=0" }
            : { admissionPaused: gateway.isAdmissionPaused() }),
      });
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/ops/restart-status", async () => {
    const snap = gateway.getRestartStatus();
    const held = opts.deployQueue.getHeld();
    let deploy = held ? opts.deployQueue.getStatus(held.requestId) : undefined;
    const waitUntil = opts.deployQueue.getHeldWaitUntil();
    const remainingMs =
      waitUntil && Number.isFinite(Date.parse(waitUntil))
        ? Math.max(0, Date.parse(waitUntil) - Date.now())
        : null;

    if (snap.canRestart && opts.deployQueue.getHeld()) {
      const released = opts.deployQueue.releaseHeld();
      if (released) {
        deploy = released;
      }
    }

    const heldAfter = opts.deployQueue.getHeld();
    return {
      ...snap,
      gracefulRestart,
      maxWaitMs: opts.deployQueue.maxWaitMs,
      waitUntil: heldAfter ? waitUntil : null,
      remainingMs: heldAfter ? remainingMs : null,
      heldDeployment: heldAfter?.deployment ?? deploy?.deployment ?? null,
      deploy: deploy ?? null,
      pollHint: snap.canRestart
        ? undefined
        : "稍后再次 GET /api/ops/restart-status；空闲或等待超时后会自动放行已 hold 的部署",
    };
  });

  app.post("/api/ops/deploy/cancel-hold", async (_req, reply) => {
    const cancelled = opts.deployQueue.cancelHeld();
    const resumed = gateway.endDeployDrain();
    if (!cancelled && resumed === 0 && !gateway.isAdmissionPaused()) {
      return reply.code(404).send({
        error: "no held deploy and admission is not paused",
      });
    }
    return {
      cancelled,
      resumedQueuedStarts: resumed,
      restart: gateway.getRestartStatus(),
    };
  });

  app.get<{ Params: { requestId: string } }>(
    "/api/ops/deploy/:requestId",
    async (req, reply) => {
      const status = opts.deployQueue.getStatus(req.params.requestId);
      if (!status) {
        return reply.code(404).send({ error: "deploy request not found" });
      }
      return {
        ...status,
        runtimeVersion: opts.deployQueue.runtimeVersion(),
      };
    },
  );

  app.get("/api/ops/runtime", async () => ({
    version: opts.deployQueue.runtimeVersion() ?? null,
    appVersion: version(),
  }));

  app.get("/api/ops/agent-runtime", async () => gateway.getAgentRuntimeStatus());

  app.get("/api/auth", async () => {
    const results = await Promise.all(
      providers.list().map(async (p) => {
        const auth = await p.verifyAuth();
        return { name: p.name, ...auth };
      }),
    );
    const defaultAuth = results.find((r) => r.name === providers.defaultProviderName);
    return {
      ok: results.some((r) => r.ok),
      detail: defaultAuth
        ? `default=${defaultAuth.name}: ${defaultAuth.detail}`
        : results.map((r) => `${r.name}: ${r.detail}`).join("; "),
      providers: results,
    };
  });

  app.get("/api/providers", async () => {
    const list = await Promise.all(
      providers.list().map(async (p) => {
        const auth = await p.verifyAuth();
        return {
          name: p.name,
          ok: auth.ok,
          detail: auth.detail,
          isDefault: p.name === providers.defaultProviderName,
        };
      }),
    );
    return { providers: list, defaultProvider: providers.defaultProviderName };
  });

  app.get<{ Querystring: { provider?: string } }>("/api/models", async (req, reply) => {
    const name =
      req.query.provider?.trim() || providers.defaultProviderName;
    try {
      const provider = providers.get(name);
      const models = await provider.listModels();
      const resolved = await provider.resolveModel();
      return { provider: provider.name, models, resolved };
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- settings ----

  app.get("/api/settings/global", async () => gateway.getGlobalSettings());

  app.patch<{ Body: AppSettings }>("/api/settings/global", async (req, reply) => {
    try {
      return gateway.updateGlobalSettings(req.body ?? {});
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/settings",
    async (req, reply) => {
      const view = gateway.getProjectSettingsView(req.params.projectId);
      if (!view) {
        return reply.code(404).send({ error: "project not found" });
      }
      return view;
    },
  );

  app.patch<{
    Params: { projectId: string };
    Body: AppSettings;
  }>("/api/projects/:projectId/settings", async (req, reply) => {
    try {
      const view = gateway.updateProjectSettings(
        req.params.projectId,
        req.body ?? {},
      );
      if (!view) {
        return reply.code(404).send({ error: "project not found" });
      }
      return view;
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- projects ----

  app.get("/api/projects", async () => gateway.listProjects());

  app.post<{
    Body: { name?: string; gitRepoUrl?: string };
  }>("/api/projects", async (req, reply) => {
    const name = req.body?.name?.trim();
    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }
    try {
      const project = gateway.createProject(name, {
        ...(req.body?.gitRepoUrl?.trim()
          ? { gitRepoUrl: req.body.gitRepoUrl.trim() }
          : {}),
      });
      reply.code(201);
      return project;
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch<{
    Params: { projectId: string };
    Body: {
      name?: string;
      gitRepoUrl?: string | null;
    };
  }>("/api/projects/:projectId", async (req, reply) => {
      const name = req.body?.name?.trim();
      const hasName = name !== undefined && name.length > 0;
      const hasGitRepoUrl = req.body?.gitRepoUrl !== undefined;
      if (!hasName && !hasGitRepoUrl) {
        return reply
          .code(400)
          .send({ error: "name or gitRepoUrl is required" });
      }
      try {
        const project = gateway.updateProject(req.params.projectId, {
          ...(hasName ? { name } : {}),
          ...(hasGitRepoUrl ? { gitRepoUrl: req.body?.gitRepoUrl } : {}),
        });
        if (!project) {
          return reply.code(404).send({ error: "project not found" });
        }
        return project;
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
  });

  // ---- tasks ----

  app.get<{ Querystring: { projectId?: string } }>(
    "/api/tasks",
    async (req) => {
      const projectId = req.query.projectId?.trim() || undefined;
      return gateway.listTasks({ projectId }).map((task) => {
        const detail = gateway.getTaskDetail(task.taskId);
        return { ...task, stats: detail?.stats };
      });
    },
  );

  app.post<{
    Body: {
      title?: string;
      workspace?: string;
      provider?: string;
      model?: string;
      projectId?: string;
    };
  }>("/api/tasks", async (req, reply) => {
    const body = req.body ?? {};
    try {
      const task = gateway.createTask({
        title: body.title,
        workspace: body.workspace,
        provider: body.provider,
        model: body.model,
        projectId: body.projectId,
      });
      reply.code(201);
      return task;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId",
    async (req, reply) => {
      const detail = gateway.getTaskDetail(req.params.taskId);
      if (!detail) {
        return reply.code(404).send({ error: "task not found" });
      }
      return detail;
    },
  );

  app.get<{
    Params: { taskId: string };
    Querystring: { after?: string; before?: string; limit?: string };
  }>("/api/tasks/:taskId/events", async (req, reply) => {
    const detail = gateway.getTaskDetail(req.params.taskId);
    if (!detail) {
      return reply.code(404).send({ error: "task not found" });
    }
    const after = req.query.after ? Number(req.query.after) : undefined;
    const before = req.query.before ? Number(req.query.before) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const { events, hasMore } = gateway.listEvents(req.params.taskId, {
      after,
      before,
      limit,
    });
    return {
      events,
      nextSeq: gateway.maxEventSeq(req.params.taskId),
      hasMore,
    };
  });

  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/agent-successions",
    async (req, reply) => {
      const detail = gateway.getTaskDetail(req.params.taskId);
      if (!detail) {
        return reply.code(404).send({ error: "task not found" });
      }
      return { successions: gateway.listAgentSuccessions(req.params.taskId) };
    },
  );

  /**
   * Cross-task token-usage series grouped by provider/model.
   * Query: ?granularity=hour|day|week&timeZone=local|utc&projectId=&from=&to=
   */
  app.get<{
    Querystring: {
      projectId?: string;
      granularity?: string;
      timeZone?: string;
      from?: string;
      to?: string;
    };
  }>("/api/stats/token-usage", async (req) => {
    const granularityRaw = req.query.granularity?.trim();
    const granularity = isUsageGranularity(granularityRaw) ? granularityRaw : "day";
    const timeZoneRaw = req.query.timeZone?.trim();
    const timeZone = isUsageTimeZone(timeZoneRaw) ? timeZoneRaw : "local";
    return gateway.getTokenUsageSeries({
      ...(req.query.projectId?.trim() ? { projectId: req.query.projectId.trim() } : {}),
      granularity,
      timeZone,
      ...(req.query.from?.trim() ? { from: req.query.from.trim() } : {}),
      ...(req.query.to?.trim() ? { to: req.query.to.trim() } : {}),
    });
  });

  app.patch<{
    Params: { taskId: string };
    Body: { prUrl?: string | null };
  }>("/api/tasks/:taskId", async (req, reply) => {
    if (req.body?.prUrl === undefined) {
      return reply.code(400).send({ error: "prUrl is required" });
    }
    const task = gateway.updateTaskPrUrl(req.params.taskId, req.body.prUrl);
    if (!task) {
      return reply.code(404).send({ error: "task not found" });
    }
    return task;
  });

  app.post<{
    Params: { taskId: string };
    Body: { title?: string; body?: string };
  }>("/api/tasks/:taskId/pull-request", async (req, reply) => {
    try {
      const result = await gateway.createPullRequest(req.params.taskId, {
        title: req.body?.title,
        body: req.body?.body,
      });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const notFound = /not found/i.test(msg);
      return reply.code(notFound ? 404 : 400).send({ error: msg });
    }
  });

  app.post<{
    Params: { taskId: string };
    Body: {
      message?: string;
      images?: IncomingImage[];
      mode?: string;
      planAnswerBatch?: {
        batchId: string;
        answers: Array<{
          questionId: string;
          optionId?: string;
          optionLabel?: string;
          otherText?: string;
          skipped?: boolean;
        }>;
      };
    };
  }>("/api/tasks/:taskId/messages", async (req, reply) => {
    const message = typeof req.body?.message === "string" ? req.body.message : "";
    const rawImages = Array.isArray(req.body?.images) ? req.body.images : undefined;
    const validated = validateIncomingImages(rawImages);
    if (!validated.ok) {
      return reply.code(400).send({ error: validated.error });
    }
    const planAnswerBatch = req.body?.planAnswerBatch;
    const hasPlanAnswers =
      planAnswerBatch &&
      typeof planAnswerBatch.batchId === "string" &&
      Array.isArray(planAnswerBatch.answers);
    if (!message.trim() && validated.images.length === 0 && !hasPlanAnswers) {
      return reply
        .code(400)
        .send({ error: "message text or at least one image is required" });
    }
    const rawMode = req.body?.mode;
    let mode: "agent" | "plan" = "agent";
    if (rawMode != null) {
      if (rawMode !== "agent" && rawMode !== "plan") {
        return reply.code(400).send({ error: "mode must be \"agent\" or \"plan\"" });
      }
      mode = rawMode;
    }
    const detail = gateway.getTaskDetail(req.params.taskId);
    if (!detail) {
      return reply.code(404).send({ error: "task not found" });
    }
    try {
      const { runId, queued, queueLength } = await gateway.sendMessage(
        req.params.taskId,
        {
          text: message,
          images: validated.images,
          mode,
          ...(hasPlanAnswers ? { planAnswerBatch: planAnswerBatch! } : {}),
        },
      );
      return { runId, queued, queueLength };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }
  });

  app.get<{ Params: { taskId: string; attachmentId: string } }>(
    "/api/tasks/:taskId/attachments/:attachmentId",
    async (req, reply) => {
      const detail = gateway.getTaskDetail(req.params.taskId);
      if (!detail) {
        return reply.code(404).send({ error: "task not found" });
      }
      const resolved = resolveAttachmentPath(
        opts.dataDir,
        req.params.taskId,
        req.params.attachmentId,
      );
      if (!resolved) {
        return reply.code(404).send({ error: "attachment not found" });
      }
      const buf = fs.readFileSync(resolved.filePath);
      return reply
        .header("content-type", resolved.mimeType)
        .header("cache-control", "public, max-age=31536000, immutable")
        .send(buf);
    },
  );

  app.post<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/stop",
    async (req, reply) => {
      const detail = gateway.getTaskDetail(req.params.taskId);
      if (!detail) {
        return reply.code(404).send({ error: "task not found" });
      }
      try {
        const { runId } = await gateway.stopTask(req.params.taskId);
        return { runId, stopped: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = msg.includes("No active run") ? 409 : 400;
        return reply.code(code).send({ error: msg });
      }
    },
  );

  app.post<{ Params: { taskId: string; runId: string } }>(
    "/api/tasks/:taskId/runs/:runId/cancel",
    async (req, reply) => {
      const detail = gateway.getTaskDetail(req.params.taskId);
      if (!detail) {
        return reply.code(404).send({ error: "task not found" });
      }
      try {
        const result = gateway.cancelQueuedRun(
          req.params.taskId,
          req.params.runId,
        );
        return { ...result, cancelled: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not found")) {
          return reply.code(404).send({ error: msg });
        }
        if (msg.includes("Only queued")) {
          return reply.code(409).send({ error: msg });
        }
        return reply.code(400).send({ error: msg });
      }
    },
  );

  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/plans",
    async (req, reply) => {
      const detail = gateway.getTaskDetail(req.params.taskId);
      if (!detail) {
        return reply.code(404).send({ error: "task not found" });
      }
      return { plans: gateway.listPlanDocuments(req.params.taskId) };
    },
  );

  app.get<{ Params: { taskId: string; runId: string } }>(
    "/api/tasks/:taskId/plans/:runId",
    async (req, reply) => {
      const detail = gateway.getTaskDetail(req.params.taskId);
      if (!detail) {
        return reply.code(404).send({ error: "task not found" });
      }
      try {
        const doc = gateway.getPlanDocument(
          req.params.taskId,
          req.params.runId,
        );
        if (!doc) {
          return reply.code(404).send({ error: "plan not found" });
        }
        return doc;
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
