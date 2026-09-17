import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import type { AgentGateway } from "../gateway/gateway.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { AppSettings, DepartmentConfig, DepartmentList } from "../types.js";
import type { ShutdownReport } from "../shutdown.js";
import { isUsageGranularity, isUsageTimeZone } from "../usage/series.js";
import { normalizeDepartment } from "../settings.js";
import {
  resolveAttachmentPath,
  validateIncomingImages,
  type IncomingImage,
} from "../attachments.js";
import { registerUiVersionGuard } from "./ui-version.js";

export async function registerRoutes(
  app: FastifyInstance,
  gateway: AgentGateway,
  providers: ProviderRegistry,
  opts: {
    dataDir: string;
    appVersion: string;
    /** Live version for /health (disk VERSION preferred). */
    resolveAppVersion?: () => string;
    /** Version baked into the running gateway process (env APP_VERSION). */
    processAppVersion?: string;
    /**
     * When true (default), `/api/ops/restart-notify` pauses starting new runs
     * until the running agents finish (graceful restart by the platform).
     */
    gracefulRestart?: boolean;
    /** Started-at (ms epoch) of this process — /health reports uptime/pid. */
    processStartedAt?: number;
    /** How the previous process exited, when it got the chance to record it. */
    previousShutdown?: ShutdownReport | null;
    /** Organization service (department catalogue) for project settings. */
    organization?: { list(opts?: { refresh?: boolean }): Promise<DepartmentList> };
  },
): Promise<void> {
  const gracefulRestart = opts.gracefulRestart !== false;
  const version = (): string =>
    opts.resolveAppVersion?.() ?? opts.appVersion;

  // Every frontend write must prove it comes from the version this project
  // currently serves; a stale page gets 409/428 `ui-version-mismatch` instead
  // of writing (see ./ui-version.ts).
  registerUiVersionGuard(app, { serverVersion: version });

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
      processVersion: opts.processAppVersion ?? opts.appVersion,
      time: new Date().toISOString(),
      // Restart observability: which process answers, since when, and how its
      // predecessor died (set only when that process recorded a shutdown).
      pid: process.pid,
      startedAt: opts.processStartedAt
        ? new Date(opts.processStartedAt).toISOString()
        : null,
      uptimeSec: opts.processStartedAt
        ? Math.max(0, Math.round((Date.now() - opts.processStartedAt) / 1000))
        : null,
      previousShutdown: opts.previousShutdown ?? null,
    };
  });

  /**
   * Deployment-service restart poll contract: the platform polls this until
   * `canRestart` / `ready` / `canDeploy` is true, then restarts the service.
   */
  app.get("/api/ops/restart-status", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    const snap = gateway.getRestartStatus();
    return {
      ...snap,
      // Deployment-service poll aliases (any true → proceed).
      canDeploy: snap.canRestart,
      ready: snap.canRestart,
      gracefulRestart,
      pollHint: snap.canRestart
        ? undefined
        : "稍后再次 GET /api/ops/restart-status",
    };
  });

  /**
   * Deployment-service restart notify contract:
   * POST JSON → begin drain (admissionPaused). Body is logged; 2xx is enough.
   */
  app.post<{
    Body: {
      serviceId?: string;
      requestId?: string;
      deployment?: string;
      version?: string;
      message?: string;
    };
  }>("/api/ops/restart-notify", async (req, reply) => {
    const body = req.body ?? {};
    const serviceId = body.serviceId?.trim() || "";
    const requestId = body.requestId?.trim() || "";
    const deployment = body.deployment?.trim() || "";
    const message = body.message?.trim() || "";
    if (!serviceId || !requestId || !deployment || !message) {
      return reply.code(400).send({
        error:
          "serviceId, requestId, deployment, and message are required",
      });
    }
    gateway.beginDeployDrain({
      serviceId,
      requestId,
      deployment,
      ...(body.version?.trim() ? { version: body.version.trim() } : {}),
      message,
    });
    const snap = gateway.getRestartStatus();
    return reply.code(200).send({
      ok: true,
      admissionPaused: true,
      canRestart: snap.canRestart,
      runningCount: snap.runningCount,
      message: "drain started; poll /api/ops/restart-status until canRestart",
    });
  });

  app.get("/api/ops/runtime", async () => ({
    version: version(),
    appVersion: version(),
  }));

  app.get<{
    Querystring: {
      windowMs?: string;
      from?: string;
      to?: string;
      all?: string;
    };
  }>("/api/ops/agent-runtime", async (req) => {
    const raw = Number(req.query.windowMs);
    const windowMs = Number.isFinite(raw) && raw > 0 ? raw : undefined;
    const from = req.query.from?.trim() || undefined;
    const to = req.query.to?.trim() || undefined;
    const allRaw = (req.query.all ?? "").toLowerCase();
    const all = allRaw === "1" || allRaw === "true" || allRaw === "yes";
    return gateway.getAgentRuntimeStatus({
      ...(windowMs != null ? { windowMs } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(all ? { all: true } : {}),
    });
  });

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

  // ---- organization (department catalogue) ----

  /**
   * Departments for the project-settings picker, sourced from the organization
   * service. When that service is unreachable we still answer 200 with
   * `available: false` so the page keeps the already-stored value and just
   * shows a hint instead of failing the whole settings load.
   * `?refresh=1` bypasses the short-lived cache.
   */
  app.get<{ Querystring: { refresh?: string } }>(
    "/api/org/departments",
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!opts.organization) {
        return reply.code(200).send({
          available: false,
          items: [],
          types: [],
          source: "",
          fetchedAt: new Date().toISOString(),
          error: "organization client is not configured",
        } satisfies DepartmentList);
      }
      const refresh = ["1", "true", "yes"].includes(
        (req.query.refresh ?? "").trim().toLowerCase(),
      );
      return opts.organization.list({ refresh });
    },
  );

  // ---- projects ----

  app.get("/api/projects", async () => gateway.listProjects());

  app.post<{
    Body: {
      name?: string;
      gitRepoUrl?: string;
      /** 新建项目时同时指定所属部门（catalogue 来自 organization 服务）。 */
      department?: DepartmentConfig;
    };
  }>("/api/projects", async (req, reply) => {
    const name = req.body?.name?.trim();
    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }
    // 部门是项目的必填属性：这里拦死，避免绕过 UI 建出“无部门”的项目。
    // （内部调用（系统项目等）走 store，不经过这个路由。）
    const department = normalizeDepartment(req.body?.department);
    if (!department) {
      return reply.code(400).send({ error: "department is required" });
    }
    try {
      const project = gateway.createProject(name, {
        ...(req.body?.gitRepoUrl?.trim()
          ? { gitRepoUrl: req.body.gitRepoUrl.trim() }
          : {}),
        department,
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
}
