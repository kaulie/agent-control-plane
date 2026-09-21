/**
 * 对外 API 契约的**唯一真源**（Node 版的「注解」）。
 *
 * 对等物：别的服务用 swaggo 注解 + `swag init` 生成 OpenAPI；本服务没有代码生成器，
 * 所以把「每个路由的 summary / tags」集中写在这里，由
 * `backend/scripts/gen-openapi.mjs` 和**真实路由表**（`./routes.ts`）合成
 * `api/openapi.json`（= swag 产物的对等物，提交进仓库）。
 *
 * 两个方向都会被检查（等价于服务中心自己的「路由 ↔ 自述契约」一致性检查）：
 * - 路由表里有、这里没写（也没进 `OPENAPI_EXCLUDE`）→ 生成失败（新接口忘了写契约）；
 * - 这里写了、路由表里没有 → 生成失败（契约里留了个不存在的接口）。
 *
 * 改契约 = 改这里 + `npm run openapi:gen`（CI 会跑 `openapi:check` 兜住忘提交）。
 */

export interface RouteMeta {
  /** 一句话说明（服务中心面板上显示的就是它）。 */
  summary: string;
  /** 分组（见 {@link OPENAPI_TAGS}）。 */
  tags: string[];
  /** 可选：更长的说明。 */
  description?: string;
  /** 可选：覆盖自动生成的 operationId。 */
  operationId?: string;
  /** 可选：覆盖默认的成功响应（如创建类接口写 201）。 */
  responses?: Record<string, { description: string }>;
}

export const OPENAPI_INFO = {
  title: "agent-control-plane",
  description:
    "Web Cursor Agent Gateway：任务 / Agent 编排（创建 · 投递需求 · 消息 · fork · PR）+ 看板 / 时间线 + 计费与用量。",
} as const;

/** 分组目录（tags 只允许取这里的 name）。 */
export const OPENAPI_TAGS: Array<{ name: string; description: string }> = [
  { name: "ops", description: "运维：健康检查、优雅重启契约、进程与并发状态" },
  { name: "catalog", description: "运行目录：provider 鉴权状态、provider 列表、模型目录" },
  { name: "settings", description: "全局设置" },
  { name: "projects", description: "项目与项目设置" },
  { name: "org", description: "组织：部门目录（organization 服务）" },
  { name: "tasks", description: "任务：创建 / 详情 / 事件 / 消息 / 停止 / fork / PR / 附件" },
  { name: "agents", description: "Agent 看板与时间线" },
  { name: "billing", description: "计费规则（峰谷价目与时段）" },
  { name: "usage", description: "用量统计" },
  {
    name: "autonomy",
    description:
      "自治系统（「交给 autonomy」入口）：投递指令 / 查任务与进展。数据源是 autonomy 本身，控制面只代理、不落库",
  },
];

/**
 * 路由 → 契约（key = `METHOD /openapi/path`，路径参数写 `{name}`）。
 */
export const OPENAPI_ROUTE_META: Record<string, RouteMeta> = {
  "GET /health": {
    summary: "健康检查（版本 / 运行时长 / 上次退出原因）",
    tags: ["ops"],
  },
  "GET /api/ops/restart-status": {
    summary: "优雅重启轮询契约（平台轮询 canRestart / ready / canDeploy）",
    tags: ["ops"],
  },
  "POST /api/ops/restart-notify": {
    summary: "优雅重启通知（平台请求排空：暂停新 run，等在跑的跑完）",
    tags: ["ops"],
  },
  "GET /api/ops/runtime": {
    summary: "本进程运行状态（内存 / 并发 / 队列 / drain）",
    tags: ["ops"],
  },
  "GET /api/ops/agent-runtime": {
    summary: "Agent 运行时曲线（并发占用与队列采样）",
    tags: ["ops"],
  },
  "GET /api/auth": { summary: "各 provider 的鉴权状态", tags: ["catalog"] },
  "GET /api/providers": {
    summary: "provider 列表与默认 provider（含可用性）",
    tags: ["catalog"],
  },
  "GET /api/models": {
    summary: "某 provider 的模型目录与默认模型",
    tags: ["catalog"],
  },
  "GET /api/settings/global": { summary: "全局设置", tags: ["settings"] },
  "PATCH /api/settings/global": {
    summary: "改全局设置（工作区根目录 / 运行时默认 / 部门）",
    tags: ["settings"],
  },
  "GET /api/billing/rules": { summary: "计费规则列表", tags: ["billing"] },
  "PUT /api/billing/rules/{ruleId}": {
    summary: "写入一条计费规则（峰谷价目与时段）",
    tags: ["billing"],
  },
  "DELETE /api/billing/rules/{ruleId}": {
    summary: "删除一条计费规则",
    tags: ["billing"],
  },
  "GET /api/projects": {
    summary: "项目列表（含所属部门）",
    tags: ["projects"],
  },
  "GET /api/projects/{projectId}": { summary: "单个项目", tags: ["projects"] },
  "POST /api/projects": {
    summary: "新建项目（所属部门必填）",
    tags: ["projects"],
    responses: { 201: { description: "创建成功，返回项目" } },
  },
  "PATCH /api/projects/{projectId}": {
    summary: "改项目（名字）",
    tags: ["projects"],
  },
  "GET /api/projects/{projectId}/settings": {
    summary: "项目设置（含只读的工作区规则）",
    tags: ["projects"],
  },
  "GET /api/projects/{projectId}/service-repos": {
    summary: "注入 agent 的仓库地址（project → 组织 → 服务中心 /v1/orgs/{orgId}/services）",
    tags: ["projects"],
  },
  "PATCH /api/projects/{projectId}/settings": {
    summary: "改项目设置（运行时默认 / 所属部门）",
    tags: ["projects"],
  },
  "GET /api/org/departments": {
    summary: "部门目录（organization 服务；不可达时 available=false）",
    tags: ["org"],
  },
  "GET /api/autonomy/meta": {
    summary: "autonomy 可用性 / 版本 / 当前 LLM 后端（读不到时 available=false，不是 500）",
    tags: ["autonomy"],
    description:
      "「交给 autonomy」入口能不能点看这里。控制面只代理；url 指向数据源，便于页面上写清。",
  },
  "GET /api/autonomy/tasks": {
    summary: "autonomy 侧的任务列表（只代理；用于对账 / 显示执行方状态）",
    tags: ["autonomy"],
    description:
      "数据全部来自 autonomy 的 `GET /api/tasks`（每行 id / description / status / turns / last_at / project_id / agent_id / updated_at）。控制面用它给 `agentPath=autonomy` 的任务显示执行方状态，也用来把「没在我们这边建过」的行显示出来（对账）。",
  },
  "GET /api/autonomy/tasks/{taskId}": {
    summary: "autonomy 任务详情 / 进展（只代理；404 原样透传）",
    tags: ["autonomy"],
    description:
      "代理 autonomy 的 `GET /api/tasks/{id}`（status / error / context_ref / project / plans[].steps[] / updated_at）。不可达 → 503。",
  },
  "GET /api/tasks": {
    summary: "任务列表（带 stats，可按 projectId 过滤）",
    tags: ["tasks"],
  },
  "POST /api/tasks": {
    summary:
      "新建任务（描述必填；默认创建后自动投递需求并开跑；`agentPath=autonomy` 时改为交给 autonomy 执行）",
    tags: ["tasks"],
    description:
      "任务始终由控制面创建/落库（谁建的就是谁建的）。`agentPath`（`control-plane` 默认 / `autonomy`）" +
      "只决定** agent 由谁创建**：后者把执行交给 autonomy（agent 由它的 runtime 创建），交接结果记在" +
      "`executorTaskId` / `executorAgentId` 上；交接失败 → 任务保留并标 error + 原文，返回 4xx/503。",
    responses: {
      201: { description: "创建成功，返回任务" },
      400: { description: "参数非法 / autonomy 明确拒绝（原文在 error 里）" },
      503: { description: "`agentPath=autonomy` 但 autonomy 不可达 / 超时（任务已创建并标 error）" },
    },
  },
  "GET /api/tasks/{taskId}/executor": {
    summary: "执行方（autonomy）的状态 / 进展（按我们的 taskId 读，只代理）",
    tags: ["tasks"],
    description:
      "只对 `agentPath=autonomy` 的任务有意义：代理 autonomy 的 `GET /api/tasks/{它的 id}`。" +
      "没有交接记录 → 404；不可达 → 503。",
  },
  "GET /api/tasks/{taskId}": {
    summary: "任务详情（task + project + runs + stats + context）",
    tags: ["tasks"],
  },
  "PATCH /api/tasks/{taskId}": {
    summary: "改任务意图（标题 / 类型 / 目标 / 描述）或回写 PR 链接",
    tags: ["tasks"],
  },
  "GET /api/tasks/{taskId}/events": {
    summary: "任务事件时间线（after= 增量拉取）",
    tags: ["tasks"],
  },
  "GET /api/tasks/{taskId}/agent-successions": {
    summary: "这个任务的 agent 替换记录",
    tags: ["tasks"],
  },
  "POST /api/tasks/{taskId}/fork": {
    summary: "fork 新任务（上下文将满时分流，沿用同一个工作区）",
    tags: ["tasks"],
  },
  "POST /api/tasks/{taskId}/pull-request": {
    summary: "用任务工作区开 PR 并回写 prUrl",
    tags: ["tasks"],
  },
  "POST /api/tasks/{taskId}/messages": {
    summary: "给 agent 发消息（起一个 run，mode=agent|plan）",
    tags: ["tasks"],
  },
  "POST /api/tasks/{taskId}/stop": { summary: "停止当前 run", tags: ["tasks"] },
  "POST /api/tasks/{taskId}/runs/{runId}/cancel": {
    summary: "取消排队中的 run",
    tags: ["tasks"],
  },
  "GET /api/tasks/{taskId}/attachments/{attachmentId}": {
    summary: "取任务附件（原图）",
    tags: ["tasks"],
  },
  "GET /api/agents": {
    summary: "Agent 看板（per-agent / per-task 两个口径）",
    tags: ["agents"],
  },
  "GET /api/agents/{agentId}/timeline": {
    summary: "Agent 时间线（idle / thinking / working + 输入与 run 标记）",
    tags: ["agents"],
  },
  "GET /api/stats/token-usage": {
    summary: "跨任务 token 用量序列（按 provider / model 聚合）",
    tags: ["usage"],
  },
};

/**
 * 有意**不**进对外契约的路由（key 同上）：不写进契约必须在这里说明原因，
 * 否则生成脚本会因为「路由没有契约」报错 —— 不给「忘了写」留后门。
 */
export const OPENAPI_EXCLUDE: Record<string, string> = {};
