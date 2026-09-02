import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import type { AgentGateway } from "../gateway/gateway.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { AppSettings } from "../types.js";
import {
  resolveAttachmentPath,
  validateIncomingImages,
  type IncomingImage,
} from "../attachments.js";

export async function registerRoutes(
  app: FastifyInstance,
  gateway: AgentGateway,
  providers: ProviderRegistry,
  opts: { dataDir: string; appVersion: string },
): Promise<void> {
  app.get("/health", async (_req, reply) => {
    reply.header("Cache-Control", "no-store, no-cache, must-revalidate");
    return {
      ok: true,
      service: "web-cursor-agent-gateway",
      provider: providers.defaultProviderName,
      providers: providers.names(),
      version: opts.appVersion,
      time: new Date().toISOString(),
    };
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

  // ---- projects ----

  app.get("/api/projects", async () => gateway.listProjects());

  app.post<{
    Body: { name?: string; workspaceRoot?: string; gitRepoUrl?: string };
  }>("/api/projects", async (req, reply) => {
    const name = req.body?.name?.trim();
    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }
    try {
      const project = gateway.createProject(name, {
        ...(req.body?.workspaceRoot?.trim()
          ? { workspaceRoot: req.body.workspaceRoot.trim() }
          : {}),
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
      workspaceRoot?: string | null;
      gitRepoUrl?: string | null;
    };
  }>("/api/projects/:projectId", async (req, reply) => {
      const name = req.body?.name?.trim();
      const hasName = name !== undefined && name.length > 0;
      const hasWorkspaceRoot = req.body?.workspaceRoot !== undefined;
      const hasGitRepoUrl = req.body?.gitRepoUrl !== undefined;
      if (!hasName && !hasWorkspaceRoot && !hasGitRepoUrl) {
        return reply
          .code(400)
          .send({ error: "name, workspaceRoot, or gitRepoUrl is required" });
      }
      try {
        const project = gateway.updateProject(req.params.projectId, {
          ...(hasName ? { name } : {}),
          ...(hasWorkspaceRoot ? { workspaceRoot: req.body?.workspaceRoot } : {}),
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

  app.post<{
    Params: { taskId: string };
    Body: { toState?: string };
  }>("/api/tasks/:taskId/workflow/transition", async (req, reply) => {
    const toState = req.body?.toState?.trim();
    if (!toState) {
      return reply.code(400).send({ error: "toState is required" });
    }
    const detail = gateway.getTaskDetail(req.params.taskId);
    if (!detail) {
      return reply.code(404).send({ error: "task not found" });
    }
    try {
      const task = gateway.transitionTask(req.params.taskId, toState);
      return { task, workflow: gateway.getTaskDetail(req.params.taskId)!.workflow };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }
  });

  app.patch<{
    Params: { taskId: string };
    Body: {
      prUrl?: string | null;
      provider?: string;
      model?: string | null;
    };
  }>("/api/tasks/:taskId", async (req, reply) => {
    const body = req.body ?? {};
    const hasPrUrl = body.prUrl !== undefined;
    const hasProvider = body.provider !== undefined;
    const hasModel = body.model !== undefined;
    if (!hasPrUrl && !hasProvider && !hasModel) {
      return reply
        .code(400)
        .send({ error: "prUrl, provider, or model is required" });
    }

    try {
      if (hasProvider || hasModel) {
        const task = gateway.updateTaskRuntime(req.params.taskId, {
          ...(hasProvider ? { provider: body.provider } : {}),
          ...(hasModel ? { model: body.model } : {}),
        });
        if (hasPrUrl) {
          const withPr = gateway.updateTaskPrUrl(req.params.taskId, body.prUrl!);
          return withPr ?? task;
        }
        return task;
      }

      const task = gateway.updateTaskPrUrl(req.params.taskId, body.prUrl!);
      if (!task) {
        return reply.code(404).send({ error: "task not found" });
      }
      return task;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const notFound = /not found/i.test(msg);
      const conflict = /active or queued/i.test(msg);
      return reply
        .code(notFound ? 404 : conflict ? 409 : 400)
        .send({ error: msg });
    }
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

  app.get("/api/workflows/coding", async () => {
    const { CODING_WORKFLOW } = await import("../workflows/coding.js");
    return CODING_WORKFLOW;
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
