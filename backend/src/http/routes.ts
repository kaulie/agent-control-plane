import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import type { AgentGateway } from "../gateway/gateway.js";
import type { AgentProvider } from "../providers/types.js";
import {
  resolveAttachmentPath,
  validateIncomingImages,
  type IncomingImage,
} from "../attachments.js";

export async function registerRoutes(
  app: FastifyInstance,
  gateway: AgentGateway,
  provider: AgentProvider,
  opts: { dataDir: string },
): Promise<void> {
  app.get("/health", async () => ({
    ok: true,
    service: "web-cursor-agent-gateway",
    provider: provider.name,
    time: new Date().toISOString(),
  }));

  app.get("/api/auth", async () => provider.verifyAuth());

  app.get("/api/models", async () => {
    const models = await provider.listModels();
    const resolved = await provider.resolveModel();
    return { models, resolved };
  });

  // ---- projects ----

  app.get("/api/projects", async () => gateway.listProjects());

  app.post<{ Body: { name?: string } }>("/api/projects", async (req, reply) => {
    const name = req.body?.name?.trim();
    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }
    try {
      const project = gateway.createProject(name);
      reply.code(201);
      return project;
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch<{ Params: { projectId: string }; Body: { name?: string } }>(
    "/api/projects/:projectId",
    async (req, reply) => {
      const name = req.body?.name?.trim();
      if (!name) {
        return reply.code(400).send({ error: "name is required" });
      }
      try {
        const project = gateway.renameProject(req.params.projectId, name);
        if (!project) {
          return reply.code(404).send({ error: "project not found" });
        }
        return project;
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

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
    Body: { title?: string; workspace?: string; model?: string; projectId?: string };
  }>("/api/tasks", async (req, reply) => {
    const body = req.body ?? {};
    try {
      const task = gateway.createTask({
        title: body.title,
        workspace: body.workspace,
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
    Body: { message?: string; images?: IncomingImage[]; mode?: string };
  }>("/api/tasks/:taskId/messages", async (req, reply) => {
    const message = typeof req.body?.message === "string" ? req.body.message : "";
    const rawImages = Array.isArray(req.body?.images) ? req.body.images : undefined;
    const validated = validateIncomingImages(rawImages);
    if (!validated.ok) {
      return reply.code(400).send({ error: validated.error });
    }
    if (!message.trim() && validated.images.length === 0) {
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
      const { runId } = await gateway.sendMessage(req.params.taskId, {
        text: message,
        images: validated.images,
        mode,
      });
      return { runId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = msg.includes("already in progress") ? 409 : 400;
      return reply.code(code).send({ error: msg });
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
}
