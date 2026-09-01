import type { FastifyInstance } from "fastify";
import type { AgentGateway } from "../gateway/gateway.js";
import type { AgentProvider } from "../providers/types.js";

export async function registerRoutes(
  app: FastifyInstance,
  gateway: AgentGateway,
  provider: AgentProvider,
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

  app.get("/api/tasks", async () => {
    return gateway.listTasks().map((task) => {
      const detail = gateway.getTaskDetail(task.taskId);
      return { ...task, stats: detail?.stats };
    });
  });

  app.post<{ Body: { title?: string; workspace?: string; model?: string } }>(
    "/api/tasks",
    async (req, reply) => {
      const body = req.body ?? {};
      const task = gateway.createTask({
        title: body.title,
        workspace: body.workspace,
        model: body.model,
      });
      reply.code(201);
      return task;
    },
  );

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

  app.get<{ Params: { taskId: string }; Querystring: { after?: string } }>(
    "/api/tasks/:taskId/events",
    async (req, reply) => {
      const detail = gateway.getTaskDetail(req.params.taskId);
      if (!detail) {
        return reply.code(404).send({ error: "task not found" });
      }
      const after = req.query.after ? Number(req.query.after) : undefined;
      return { events: gateway.listEvents(req.params.taskId, after) };
    },
  );

  app.post<{ Params: { taskId: string }; Body: { message?: string } }>(
    "/api/tasks/:taskId/messages",
    async (req, reply) => {
      const message = req.body?.message;
      if (!message || !message.trim()) {
        return reply.code(400).send({ error: "message is required" });
      }
      const detail = gateway.getTaskDetail(req.params.taskId);
      if (!detail) {
        return reply.code(404).send({ error: "task not found" });
      }
      const { runId } = await gateway.sendMessage(req.params.taskId, message);
      return { runId };
    },
  );
}
