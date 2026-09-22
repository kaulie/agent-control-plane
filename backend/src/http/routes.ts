import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import type { AgentGateway } from "../gateway/gateway.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { AppSettings, DepartmentConfig, DepartmentList } from "../types.js";
import type { BillingRuleInput } from "../billing/index.js";
import type { TaskEntry } from "../config.js";
import { AGENT_PATHS, isAgentPath, normalizeAgentPath } from "../agent-path.js";
import type {
  AutonomyCreateResult,
  AutonomyInstructionResult,
  AutonomyStatus,
  AutonomyTaskDetailResult,
  AutonomyTaskListResult,
} from "../autonomy.js";
import type { ShutdownReport } from "../shutdown.js";
import { isUsageGranularity, isUsageTimeZone } from "../usage/series.js";
import { normalizeDepartment } from "../settings.js";
import {
  resolveAttachmentPath,
  validateIncomingImages,
  type IncomingImage,
} from "../attachments.js";
import { registerUiVersionGuard } from "./ui-version.js";
import {
  isTaskType,
  MAX_TASK_DESCRIPTION_CHARS,
  TASK_TYPE_IDS,
} from "../task-types.js";
import {
  DEFAULT_TASK_GOAL,
  isTaskGoal,
  TASK_GOAL_IDS,
} from "../task-goals.js";
import { parseExecutorInputMode } from "../executor-input-mode.js";

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
    /**
     * autonomy runtime（「交给 autonomy」入口）。只用来**代理**它的接口：
     * 控制面不落库、不缓存业务状态（见 docs/autonomy-integration.md）。
     */
    autonomy?: {
      url: string;
      status(opts?: { refresh?: boolean }): Promise<AutonomyStatus>;
      listTasks(opts?: { projectId?: string }): Promise<AutonomyTaskListResult>;
      getTask(taskId: string): Promise<AutonomyTaskDetailResult>;
      createTask(input: { description: string; projectId?: string }): Promise<AutonomyCreateResult>;
      /** chat 输入：给**已存在**的执行方任务追加一条指令（忙则排队）。 */
      addInstruction(input: {
        taskId: string;
        message: string;
        mode?: "chat" | "command";
      }): Promise<AutonomyInstructionResult>;
    };
    /** 新建任务入口开关（`TASK_ENTRY`）：both（默认）/ autonomy / gateway。 */
    taskEntry?: TaskEntry;
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
      // `detail` 是右上角状态条直接显示的那行字：默认 provider 命中时就用它自己的
      // 文案（如 `authenticated as <email>`），不再加 `default=<name>: ` 前缀 ——
      // 那个前缀对用户没意义，只会让「当前是哪个账号」更难读。
      detail: defaultAuth
        ? defaultAuth.detail
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

  // ---- autonomy（「交给 autonomy」入口）------------------------------------
  //
  // 只做**代理**：任务与对话数据的唯一真源是 autonomy，控制面不落库（不写 task/run/event），
  // 也不把它的任务混进 `/api/tasks` 列表（见 docs/autonomy-integration.md 第 0 节）。
  // - 读：best-effort，不可达 → 200 + `available:false`（页面显示「autonomy 不可达」，不是 500）；
  // - 写：绝不静默降级 —— 按 autonomy 的状态码转 4xx / 503，并把它的原文带出给用户。
  const autonomy = opts.autonomy;
  /** 入口开关只决定前端显示哪个入口；接口本身不因开关被拒（内部任务仍走 /api/tasks）。 */
  const taskEntry: TaskEntry = opts.taskEntry ?? "both";

  app.get("/api/autonomy/meta", async () => {
    const status: AutonomyStatus = autonomy
      ? await autonomy.status()
      : {
          available: false,
          url: "",
          error: "autonomy 未配置（AUTONOMY_API_URL）",
          fetchedAt: new Date().toISOString(),
        };
    return { ...status, entry: taskEntry };
  });

  app.get<{ Querystring: { projectId?: string } }>(
    "/api/autonomy/tasks",
    async (req) => {
      const projectId = req.query.projectId?.trim() || undefined;
      const result: AutonomyTaskListResult = autonomy
        ? await autonomy.listTasks({ projectId })
        : {
            available: false,
            tasks: [],
            url: "",
            error: "autonomy 未配置（AUTONOMY_API_URL）",
            fetchedAt: new Date().toISOString(),
          };
      return { ...result, entry: taskEntry };
    },
  );

  app.get<{ Params: { taskId: string } }>(
    "/api/autonomy/tasks/:taskId",
    async (req, reply) => {
      if (!autonomy) {
        return reply.code(503).send({ error: "autonomy 未配置（AUTONOMY_API_URL）" });
      }
      const result = await autonomy.getTask(req.params.taskId);
      if (result.available && result.task) {
        return { ...result.task, fetchedAt: result.fetchedAt };
      }
      // 404（没有这条 task）原样透传；不可达 / 超时 → 503。
      return reply
        .code(result.status === 404 ? 404 : 503)
        .send({ error: result.error ?? "autonomy 不可达" });
    },
  );

  /**
   * chat 输入（**对账行**口径）：给只在 autonomy 那边存在、我们没建过的任务投递一条指令。
   *
   * 与 `POST /api/tasks/{我们的 id}/messages` 是同一件事（autonomy 的 `POST /api/tasks` 带 `task_id`
   * = 给同一只 agent 追加一条指令，忙则排队，契约 A2③），区别只在**寻址**：这里直接用它的 task id
   * （那些行在我们库里没有 task 行，`executor` 就是它的 id）。
   *
   * 口径与另一条完全一致：只收文字（带图 400 且不投递）、投递前先确认它真有这条 task（未知 id 会被
   * autonomy 当成**新建**任务）、不可达 / 被拒 → 4xx/5xx + 原文、**我方库一行都不写**（纯代理）。
   */
  app.post<{
    Params: { taskId: string };
    Body: { message?: string; images?: IncomingImage[]; mode?: string };
  }>("/api/autonomy/tasks/:taskId/messages", async (req, reply) => {
    if (!autonomy) {
      return reply.code(503).send({ error: "autonomy 未配置（AUTONOMY_API_URL）" });
    }
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const rawImages = Array.isArray(req.body?.images) ? req.body.images : undefined;
    if (rawImages && rawImages.length > 0) {
      return reply.code(400).send({
        error: "执行方（autonomy）只收文字：这条消息没有投递（请去掉图片附件）",
      });
    }
    if (!message) {
      return reply.code(400).send({ error: "message text is required（执行方只收文字消息）" });
    }
    const parsedMode = parseExecutorInputMode(req.body?.mode);
    if (!parsedMode.ok) {
      return reply.code(400).send({ error: parsedMode.error });
    }
    const executorTaskId = req.params.taskId.trim();
    const known = await autonomy.getTask(executorTaskId);
    if (!known.available) {
      return reply
        .code(known.status === 404 ? 404 : 503)
        .send({
          error:
            known.status === 404
              ? `autonomy 没有这条任务（${executorTaskId}）：没有投递`
              : (known.error ?? "autonomy 不可达"),
        });
    }
    const sent = await autonomy.addInstruction({
      taskId: executorTaskId,
      message,
      mode: parsedMode.mode,
    });
    if (!sent.ok) {
      return reply
        .code(sent.httpStatus && sent.httpStatus >= 400 && sent.httpStatus < 500 ? sent.httpStatus : 503)
        .send({ error: sent.error });
    }
    reply.code(202);
    return {
      executor: true as const,
      executorTaskId: sent.taskId,
      ...(sent.agentId != null ? { executorAgentId: sent.agentId } : {}),
      ...(sent.status ? { executorStatus: sent.status } : {}),
      ...(sent.messageId != null ? { messageId: sent.messageId } : {}),
      ...(sent.queued != null ? { queueAhead: sent.queued } : {}),
      inputMode: parsedMode.mode,
    };
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

  /**
   * 计费规则（`billing_rules` 表）：模型价目 + 峰谷时段规则。
   * 改完立即生效（计费每次现读表），不需要重启。
   */
  app.get("/api/billing/rules", async () => ({ rules: gateway.listBillingRules() }));

  app.put<{ Params: { ruleId: string }; Body: BillingRuleInput }>(
    "/api/billing/rules/:ruleId",
    async (req, reply) => {
      try {
        return gateway.upsertBillingRule(req.params.ruleId, req.body ?? {});
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.delete<{ Params: { ruleId: string } }>(
    "/api/billing/rules/:ruleId",
    async (req, reply) => {
      const deleted = gateway.deleteBillingRule(req.params.ruleId);
      if (!deleted) return reply.code(404).send({ error: "billing rule not found" });
      return { deleted: req.params.ruleId };
    },
  );

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

  /**
   * 单个项目（按 projectId 查）。列表里的每个元素和这里返回的是同一个形状：
   * 名字 / `department`（organization 的部门 id + 名字快照）。
   * 不知道 / 已删掉的项目 → 404（调用方不用自己去列表里翻）。
   *
   * ⚠️ 项目上**没有** Git 仓库地址字段：老的 `gitRepoUrl` 已删除（不再返回、
   * UI 也不展示）。agent 的仓库地址只有一个真源 —— 项目所属组织 → 服务中心
   * `GET /v1/orgs/{orgId}/services`（见 `GET /api/projects/:projectId/service-repos`）。
   */
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId",
    async (req, reply) => {
      const project = gateway.getProject(req.params.projectId);
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }
      return project;
    },
  );

  app.post<{
    Body: {
      name?: string;
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
      // 注意：项目上没有 Git 仓库地址（老的 gitRepoUrl 已删除，body 里传了也会被忽略）。
      const project = gateway.createProject(name, { department });
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
    };
  }>("/api/projects/:projectId", async (req, reply) => {
      const name = req.body?.name?.trim();
      const hasName = name !== undefined && name.length > 0;
      if (!hasName) {
        return reply.code(400).send({ error: "name is required" });
      }
      try {
        const project = gateway.updateProject(req.params.projectId, { name });
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

  /**
   * 这个项目**会被注入哪些仓库地址**：project → 所属组织（`department.departmentId`）
   * → 服务中心 `GET /v1/orgs/{orgId}/services`（含每个服务的 git 仓库地址）。
   *
   * 只读，供排查「agent 的简报里到底拿到了什么仓库」。项目没有所属组织 /
   * 服务中心不可达 → `repos: null`（简报此时退回「按需自己 clone」的兜底文案）。
   * `?refresh=1` 绕开 30s 缓存。
   *
   * 注意：项目配置里**没有**仓库地址字段（老的 `gitRepoUrl` 已删除），所以这里
   * 是「registry 视角」的清单 —— 与项目元数据无关。
   */
  app.get<{
    Params: { projectId: string };
    Querystring: { refresh?: string };
  }>("/api/projects/:projectId/service-repos", async (req, reply) => {
    const project = gateway.getProject(req.params.projectId);
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";
    return gateway.getProjectServiceRepos(project.projectId, { refresh });
  });

  // ---- tasks ----

  /**
   * Agent board (`scope=current|all`): every agent with its department
   * (来自 task 所属 project), project, task, 最后活跃时间, 模型, token 消耗与
   * 累计工作时长。只读，因此不需要页面版本校验。
   */
  app.get<{ Querystring: { scope?: string; projectId?: string } }>(
    "/api/agents",
    async (req) => {
      const scopeRaw = req.query.scope?.trim().toLowerCase();
      const projectId = req.query.projectId?.trim() || undefined;
      return gateway.getAgentBoard({
        scope:
          scopeRaw === "all" ? "all" : scopeRaw === "task" ? "task" : "current",
        ...(projectId ? { projectId } : {}),
      });
    },
  );

  /**
   * Agent 时间线：某段时间内这个 agent 的工作状态（idle / thinking / working）
   * 与用户的 input 事件。只读。
   * Query: `?from=&to=`（ISO；默认最近 1 小时，跨度上限 30 天）、`?projectId=`。
   */
  app.get<{
    Params: { agentId: string };
    Querystring: { from?: string; to?: string; projectId?: string };
  }>("/api/agents/:agentId/timeline", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const from = req.query.from?.trim() || undefined;
    const to = req.query.to?.trim() || undefined;
    const projectId = req.query.projectId?.trim() || undefined;
    const timeline = gateway.getAgentTimeline({
      agentId: req.params.agentId,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(projectId ? { projectId } : {}),
    });
    if (!timeline) {
      return reply.code(404).send({ error: "agent not found" });
    }
    return timeline;
  });

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
      /** 任务描述（需求原文）——**必填**：它就是 agent 要干的事。 */
      description?: string;
      /** 任务类型标签（纯分类，不改变行为）；缺省 `general`。 */
      taskType?: string;
      /**
       * 交付目标（**会改变 agent 的动作**）：`merge` 合入主分支 /
       * `deploy` 合入主分支并部署上线。缺省 `merge`。
       */
      goal?: string;
      /**
       * agent 创建路径：`control-plane`（缺省，控制面本地创建 agent 并执行）/
       * `autonomy`（**执行**交给 autonomy：任务仍在我们库里创建，agent 由它的 runtime 创建）。
       */
      agentPath?: string;
    };
  }>("/api/tasks", async (req, reply) => {
    const body = req.body ?? {};
    // 描述必填（和产品约定的"优化流程"）：没有描述就没法把需求投递给 agent，
    // 也就回到了"只有标题、全靠对话猜"的老问题。
    const description = body.description?.trim() ?? "";
    if (!description) {
      return reply
        .code(400)
        .send({ error: "description is required (任务描述必填)" });
    }
    if (description.length > MAX_TASK_DESCRIPTION_CHARS) {
      return reply.code(400).send({
        error: `description too long (max ${MAX_TASK_DESCRIPTION_CHARS} chars)`,
      });
    }
    if (body.taskType !== undefined && !isTaskType(body.taskType)) {
      return reply.code(400).send({
        error: `unknown taskType "${body.taskType}". Supported: ${TASK_TYPE_IDS.join(", ")}`,
      });
    }
    // 目标会改变 agent 的动作，所以非法值必须拦在门外（不能静默回落）。
    if (body.goal !== undefined && !isTaskGoal(body.goal)) {
      return reply.code(400).send({
        error: `unknown goal "${body.goal}". Supported: ${TASK_GOAL_IDS.join(", ")}`,
      });
    }
    // agent 创建路径只有这两个值；写错就报错，别静默按默认路径跑（那会跑错地方）。
    if (body.agentPath !== undefined && !isAgentPath(body.agentPath)) {
      return reply.code(400).send({
        error: `unknown agentPath "${body.agentPath}". Supported: ${AGENT_PATHS.join(", ")}`,
      });
    }
    const agentPath = normalizeAgentPath(body.agentPath);
    try {
      const task = gateway.createTask({
        title: body.title,
        workspace: body.workspace,
        provider: body.provider,
        model: body.model,
        projectId: body.projectId,
        description,
        taskType: body.taskType,
        // 没传 = 用默认目标（合入主分支），保证新建的任务都有明确交付目标。
        goal: body.goal ?? DEFAULT_TASK_GOAL,
        agentPath,
      });
      if (agentPath === "autonomy") {
        // 任务已在我们库里建好 → **执行**交给 autonomy（agent 由它的 runtime 创建）。
        // 交接失败时任务**保留**并标 error + 原文（不静默消失、也不回落成本机执行）。
        const handed = autonomy
          ? await autonomy.createTask({
              description,
              ...(task.projectId ? { projectId: task.projectId } : {}),
            })
          : { ok: false as const, error: "autonomy 未配置（AUTONOMY_API_URL）" };
        if (!handed.ok) {
          gateway.recordTaskExecutorFailure(task.taskId, handed.error);
          const status =
            "httpStatus" in handed &&
            handed.httpStatus != null &&
            handed.httpStatus >= 400 &&
            handed.httpStatus < 500
              ? handed.httpStatus
              : 503;
          return reply.code(status).send({
            error: `交给 autonomy 失败：${handed.error}`,
            taskId: task.taskId,
            task: gateway.getTaskDetail(task.taskId)?.task ?? task,
          });
        }
        const withExecutor = gateway.saveTaskExecutor(task.taskId, {
          taskId: handed.taskId,
          ...(handed.agentId != null ? { agentId: String(handed.agentId) } : {}),
        });
        reply.code(201);
        return withExecutor ?? task;
      }
      // 老路径（agentPath=control-plane）逐字不变：系统自动投递需求 → agent 立刻开跑。
      // 投递失败不回滚任务：任务已创建，用户可以自己在面板上重试/直接发消息。
      try {
        await gateway.dispatchTaskIntent(task.taskId);
      } catch (err) {
        req.log?.warn?.(
          { err, taskId: task.taskId },
          "task intent dispatch failed",
        );
      }
      reply.code(201);
      return task;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  /**
   * 执行方（autonomy）的状态 / 进展 —— 按**我们的** taskId 读，代理它的 `GET /api/tasks/{id}`。
   *
   * 只对 `agentPath=autonomy` 的任务有意义（它们由我们创建、执行在 autonomy）；没有交接记录 → 404。
   * 不可达 → 503（读不到就说读不到，不假装没有进展）。
   */
  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/executor",
    async (req, reply) => {
      const task = gateway.getTaskDetail(req.params.taskId)?.task;
      if (!task) return reply.code(404).send({ error: "task not found" });
      const executorTaskId = task.executorTaskId?.trim();
      if (!executorTaskId) {
        return reply.code(404).send({
          error: "这条任务的 agent 不是 autonomy 创建的（没有执行方记录）",
        });
      }
      if (!autonomy) {
        return reply.code(503).send({ error: "autonomy 未配置（AUTONOMY_API_URL）" });
      }
      const result = await autonomy.getTask(executorTaskId);
      if (result.available && result.task) {
        return {
          ...result.task,
          executorTaskId,
          ...(task.executorAgentId ? { executorAgentId: task.executorAgentId } : {}),
          fetchedAt: result.fetchedAt,
        };
      }
      return reply
        .code(result.status === 404 ? 404 : 503)
        .send({ error: result.error ?? "autonomy 不可达" });
    },
  );

  /**
   * 任务意图（标题 / 类型 / 目标 / 描述）+ PR 链接的统一 PATCH。
   *
   * `prUrl` 是 agent 开完 PR 后回写的（见 BRANCHING.md 的 `prUrl` 约定）；
   * `title/description/taskType/goal` 是「理解随对话变清晰」时用户在面板上就地修正的。
   * 描述是任务的必填属性 → 不允许改成空；目标传 `null` = 清掉目标（回到老行为）。
   */
  app.patch<{
    Params: { taskId: string };
    Body: {
      prUrl?: string | null;
      title?: string;
      description?: string;
      taskType?: string;
      /** `merge` / `deploy`；`null` = 清掉目标（回到「开完 PR 即停」）。 */
      goal?: string | null;
    };
  }>("/api/tasks/:taskId", async (req, reply) => {
    const body = req.body ?? {};
    const hasPrUrl = body.prUrl !== undefined;
    const hasTitle = body.title !== undefined;
    const hasDescription = body.description !== undefined;
    const hasType = body.taskType !== undefined;
    const hasGoal = body.goal !== undefined;
    if (!hasPrUrl && !hasTitle && !hasDescription && !hasType && !hasGoal) {
      return reply.code(400).send({
        error: "prUrl, title, description, taskType or goal is required",
      });
    }
    const description = body.description?.trim() ?? "";
    if (hasDescription && !description) {
      return reply
        .code(400)
        .send({ error: "description cannot be empty (任务描述必填)" });
    }
    if (description.length > MAX_TASK_DESCRIPTION_CHARS) {
      return reply.code(400).send({
        error: `description too long (max ${MAX_TASK_DESCRIPTION_CHARS} chars)`,
      });
    }
    if (hasTitle && !body.title?.trim()) {
      return reply.code(400).send({ error: "title cannot be empty" });
    }
    if (hasType && !isTaskType(body.taskType)) {
      return reply.code(400).send({
        error: `unknown taskType "${body.taskType}". Supported: ${TASK_TYPE_IDS.join(", ")}`,
      });
    }
    // 目标：`null` = 清掉（回到老行为）；字符串必须是已知目标，否则 400。
    if (hasGoal && body.goal !== null && !isTaskGoal(body.goal)) {
      return reply.code(400).send({
        error: `unknown goal "${body.goal}". Supported: ${TASK_GOAL_IDS.join(", ")} (or null to clear)`,
      });
    }
    if (hasPrUrl) {
      const withPr = gateway.updateTaskPrUrl(req.params.taskId, body.prUrl ?? null);
      if (!withPr) return reply.code(404).send({ error: "task not found" });
      // 只回写 prUrl（agent 的常规动作）：无需再走意图更新。
      if (!hasTitle && !hasDescription && !hasType && !hasGoal) return withPr;
    }
    const task = gateway.updateTaskIntent(req.params.taskId, {
      ...(hasTitle ? { title: body.title! } : {}),
      ...(hasDescription ? { description } : {}),
      ...(hasType ? { taskType: body.taskType! } : {}),
      ...(hasGoal ? { goal: body.goal ?? null } : {}),
    });
    if (!task) return reply.code(404).send({ error: "task not found" });
    return task;
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

  /**
   * 上下文将满时的分流：把 task fork 成新 task（继承工作区/模型/PR，带最近历史）。
   * 透明化：原 task 时间线会留一条 `status: forked` 提示。
   */
  app.post<{ Params: { taskId: string }; Body: { title?: string } }>(
    "/api/tasks/:taskId/fork",
    async (req, reply) => {
      const result = gateway.forkTask(req.params.taskId, { title: req.body?.title });
      if (!result) return reply.code(404).send({ error: "task not found" });
      return result;
    },
  );

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
    const detail = gateway.getTaskDetail(req.params.taskId);
    if (!detail) {
      return reply.code(404).send({ error: "task not found" });
    }
    // ---- agent 由 autonomy 创建：这条消息投递给**执行方**（不本机跑 run）----
    //
    // 同一个入口（`POST /api/tasks`）带 `task_id` = 给那只 agent 追加一条指令（忙则排队）——
    // 契约 A2④。三条不假装的口径：
    // ① 图片它只收文字 → 400 且**不投递**（不是「投了但忽略」）；
    // ② 投递前先 `GET` 确认执行方**真有**这条 task —— 否则 autonomy 会把「未知 task_id+指令」
    //    当成**新任务**建出来（src/api_service.go：接受路径就是 task 的创建路径），
    //    那就等于拿错了 id 还悄悄造一条新任务；
    // ③ 不可达 / 被拒 → 503/4xx + 原文，绝不回落成本机 agent 执行。
    if (detail.task.agentPath === "autonomy") {
      const text = message.trim();
      if (validated.images.length > 0) {
        return reply.code(400).send({
          error: "执行方（autonomy）只收文字：这条消息没有投递（请去掉图片附件）",
        });
      }
      if (!text) {
        return reply.code(400).send({
          error: "message text is required（执行方只收文字消息）",
        });
      }
      const parsedMode = parseExecutorInputMode(rawMode);
      if (!parsedMode.ok) {
        return reply.code(400).send({ error: parsedMode.error });
      }
      const executorTaskId = detail.task.executorTaskId?.trim();
      if (!executorTaskId) {
        return reply.code(404).send({
          error: "这条任务的 agent 不是 autonomy 创建的（没有执行方记录）",
        });
      }
      if (!autonomy) {
        return reply.code(503).send({ error: "autonomy 未配置（AUTONOMY_API_URL）" });
      }
      const known = await autonomy.getTask(executorTaskId);
      if (!known.available) {
        return reply
          .code(known.status === 404 ? 404 : 503)
          .send({
            error:
              known.status === 404
                ? `执行方那边没有这条任务（${executorTaskId}）：没有投递`
                : (known.error ?? "autonomy 不可达"),
          });
      }
      const sent = await autonomy.addInstruction({
        taskId: executorTaskId,
        message: text,
        mode: parsedMode.mode,
      });
      if (!sent.ok) {
        return reply
          .code(sent.httpStatus && sent.httpStatus >= 400 && sent.httpStatus < 500 ? sent.httpStatus : 503)
          .send({ error: sent.error });
      }
      reply.code(202);
      return {
        executor: true as const,
        executorTaskId: sent.taskId,
        ...(sent.agentId != null ? { executorAgentId: sent.agentId } : {}),
        ...(sent.status ? { executorStatus: sent.status } : {}),
        ...(sent.messageId != null ? { messageId: sent.messageId } : {}),
        // autonomy 的 `queued` = 「它前面还有几条」（数字）；本机那条 `queued` 是 boolean，
        // 语义不同 → 这里用独立字段名，免得前端两种含义串味。
        ...(sent.queued != null ? { queueAhead: sent.queued } : {}),
        inputMode: parsedMode.mode,
      };
    }
    let mode: "agent" | "plan" = "agent";
    if (rawMode != null) {
      if (rawMode !== "agent" && rawMode !== "plan") {
        return reply.code(400).send({ error: "mode must be \"agent\" or \"plan\"" });
      }
      mode = rawMode;
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
