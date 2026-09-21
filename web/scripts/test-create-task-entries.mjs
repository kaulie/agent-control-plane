/**
 * 「agent 由谁创建」这条轴的前端口径检查（对话框 + 列表 + 详情 + api 层）。
 *
 * 任务只有一套（都是 web-cursor 的任务），区别只在 **agent 创建路径**：
 * `control-plane`（控制面在本地工作区创建，现状）或 `autonomy`（它的 runtime 创建并执行）。
 *
 * 守四件事：
 * 1. **老入口 / 老行不变**：`TASK_ENTRY=gateway` 时对话框与以前逐字一致；两个入口都在时默认仍落在老入口。
 * 2. **新入口只说必要的话**：类型 / 目标 / Provider / Model 都不显示（autonomy 有自己的一套），
 *    并且 `api.createAutonomyTask` 只发 `description` + `projectId`。
 * 3. **一个列表、一个外壳**：agent 由 autonomy 创建的任务并进同一个 `TaskList`（同一套行 class），
 *    详情走同一个 `<main>` + 同一个 `TaskIdsBar`；**没有独立页面**（无 `🛰` / 无 `AutonomyPage`
 *    / `AppView` 里没有 `"autonomy"`）。
 * 4. **拿不到就不显示**：autonomy 接口暂时给不了的字段（provider、组织、repo、步骤…）留空不渲染，
 *    **不写占位文案**。
 *
 *   npx tsx --tsconfig web/tsconfig.json web/scripts/test-create-task-entries.mjs
 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.__APP_VERSION__ = "0.0.0-test";

const { default: CreateTaskDialog } = await import(
  "../src/components/CreateTaskDialog.tsx"
);
const { api } = await import("../src/api.ts");
const { default: AutonomyTaskPanel } = await import(
  "../src/components/AutonomyTaskPanel.tsx"
);
const { default: TaskList } = await import("../src/components/TaskList.tsx");
const {
  autonomyTaskToRow,
  localTaskToRow,
  mergeTaskRows,
  planSteps,
  statusClass,
  titleFromDescription,
  worldLine,
} = await import("../src/autonomy.ts");
const { agentPathLabel, agentPathHint } = await import("../src/agent-path.ts");

const render = (props) =>
  renderToStaticMarkup(
    React.createElement(CreateTaskDialog, {
      open: true,
      projectId: "project-59c41b54",
      onClose: () => {},
      onCreate: async () => {},
      onCreateAutonomy: async () => {},
      ...props,
    })
  );

// ---- 1) 只留老入口（TASK_ENTRY=gateway）：对话框和以前一样 ----
{
  const html = render({ entry: "gateway" });
  assert.ok(!html.includes("交给 autonomy"), "只留老入口时不显示新入口");
  assert.ok(html.includes("类型") && html.includes("目标"), "老入口的类型 / 目标照旧");
  assert.ok(html.includes("Provider") && html.includes("Model"), "老入口的 Provider / Model 照旧");
  assert.ok(html.includes("创建并开始"), "老入口按钮文案不变");
}

// ---- 2) 两个入口都在：默认落在老入口（行为不变）----
{
  const html = render({
    entry: "both",
    autonomy: { available: true, backend: "cline", model: "deepseek-v4-flash" },
  });
  assert.ok(html.includes("本机 agent（现状）"), "两个入口都显示");
  assert.ok(html.includes("交给 autonomy"));
  assert.match(
    html,
    /intent-type-chip selected[^>]*>\s*本机 agent（现状）/,
    "默认选中的是老入口"
  );
  assert.ok(html.includes("创建并开始"), "默认按钮仍是老入口文案");
  assert.ok(html.includes("Provider"), "默认显示 Provider");
}

// ---- 3) 只留新入口（TASK_ENTRY=autonomy）：不该出现的一律不出现 ----
{
  const html = render({
    entry: "autonomy",
    autonomy: { available: true, backend: "cline", model: "deepseek-v4-flash" },
  });
  assert.ok(!html.includes("本机 agent（现状）"), "只留新入口时不显示老入口");
  assert.ok(html.includes("交给 autonomy 创建"), "按钮换成新入口文案");
  // 注意：提示文案里会出现「Provider / Model」这几个字，所以按**控件**断言（下拉框）。
  assert.ok(!html.includes("runtime-select"), "新入口不显示 Provider / Model 下拉框");
  assert.ok(!html.includes("runtime-fields"), "新入口不显示 Provider / Model 那一组");
  assert.ok(!html.includes(">类型<"), "新入口不显示类型");
  assert.ok(!html.includes(">目标<"), "新入口不显示目标");
  assert.ok(html.includes("context_ref.project"), "提示里写清项目会作为 context_ref.project 带过去");
  assert.ok(html.includes("cline"), "提示里写清 autonomy 当前的 LLM 后端");
  assert.ok(html.includes("任务描述"), "描述仍然必填（唯一的输入）");
}

// ---- 4) autonomy 不可达：置灰 + 写明原因 ----
{
  const html = render({
    entry: "both",
    autonomy: { available: false, error: "connect ECONNREFUSED 127.0.0.1:4300" },
  });
  assert.ok(html.includes("disabled"), "不可达时「交给 autonomy」按钮 disabled");
  assert.ok(html.includes("ECONNREFUSED"), "把原因写出来");
}

// ---- 5) api 层：写请求只发 description + projectId，并且带 UI 版本头 ----
{
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/health")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: "0.0.0-test" }),
        clone() {
          return this;
        },
      };
    }
    return {
      ok: true,
      status: 202,
      json: async () => ({
        taskId: "task-x",
        agentId: 10000,
        queued: 0,
        url: "http://127.0.0.1:4300",
        entry: "both",
      }),
      clone() {
        return this;
      },
    };
  };
  const accepted = await api.createAutonomyTask({
    description: "写个 demo",
    projectId: "project-59c41b54",
  });
  assert.equal(accepted.taskId, "task-x");
  const post = calls.find((c) => c.init.method === "POST");
  assert.ok(post, "发出了 POST");
  assert.equal(post.url, "/api/autonomy/tasks");
  const body = JSON.parse(post.init.body);
  assert.deepEqual(body, {
    description: "写个 demo",
    projectId: "project-59c41b54",
  });
  assert.ok(!("provider" in body) && !("goal" in body), "不带 provider / goal（新入口不适用）");
  assert.equal(
    post.init.headers["x-ui-version"],
    "0.0.0-test",
    "写请求带 UI 版本（写守卫）"
  );
}

// ---- 6) 适配层：autonomy 任务 → 和老任务同一个行模型（区别只有 agentPath）----
{
  const summary = {
    id: "task-45b7a5ac83298ecb",
    description: "冒烟测试：只需要回复一句话 ok\n第二行不该当标题",
    status: "running",
    turns: 3,
    lastAt: "2026-09-21T01:47:14.238Z",
    projectId: "project-59c41b54",
    agentId: 10001,
    updatedAt: "2026-09-21T01:47:13.853Z",
  };
  const row = autonomyTaskToRow(summary, { llmBackend: "cline" });
  assert.equal(row.taskId, summary.id);
  assert.equal(row.agentPath, "autonomy", "这条 task 的 agent 由 autonomy 创建");
  assert.equal(row.title, "冒烟测试：只需要回复一句话 ok", "标题取描述首行（老任务口径）");
  assert.equal(row.description, summary.description);
  assert.equal(row.status, "running", "状态原文直接用它的（不映射成我们的三态）");
  assert.equal(row.provider, "cline", "provider 用它的 LLM 后端（能拿到才给）");
  assert.equal(row.agentId, "10001", "agent id 要带上（TaskIdsBar 的 Agent chip）");
  assert.equal(row.turns, 3);
  assert.equal(row.projectId, "project-59c41b54");
  assert.equal(
    row.lastUserInputAt,
    summary.lastAt,
    "时间用最后活动 → 与老列表同一个排序口径"
  );
  assert.equal(row.taskType, undefined, "它没有我们的类型分类 → 不显示类型徽标");

  const noBackend = autonomyTaskToRow(summary);
  assert.equal(noBackend.provider, "", "拿不到 LLM 后端就留空（不写占位）");

  assert.equal(titleFromDescription("短"), "短");
  assert.equal(titleFromDescription("x".repeat(80)).length, 61, "过长截断 + 省略号");
}

// ---- 7) 合并成一个列表：与后端同排序口径；没有 autonomy 行时原样返回 ----
{
  const local = [
    localTaskToRow({
      taskId: "task-local-old",
      projectId: "project-59c41b54",
      title: "老任务（早）",
      createdAt: "2026-09-21T00:00:00.000Z",
      status: "active",
      workspace: "/tmp/ws",
      provider: "cursor",
      model: "gpt-5",
      taskType: "general",
    }),
    localTaskToRow({
      taskId: "task-local-new",
      projectId: "project-59c41b54",
      title: "老任务（晚）",
      createdAt: "2026-09-21T02:00:00.000Z",
      status: "active",
      workspace: "/tmp/ws",
      provider: "cursor",
      taskType: "general",
    }),
  ];
  assert.equal(local[0].agentPath, "control-plane", "本地任务的 agent 由控制面创建");

  const autonomy = [
    autonomyTaskToRow({
      id: "task-auto-mid",
      description: "中间那条",
      status: "pending",
      turns: 0,
      lastAt: "2026-09-21T01:00:00.000Z",
      projectId: "project-59c41b54",
      agentId: 10001,
    }),
  ];
  const merged = mergeTaskRows(local, autonomy);
  assert.deepEqual(
    merged.map((r) => r.taskId),
    ["task-local-new", "task-auto-mid", "task-local-old"],
    "两条路径的任务混在一个列表里，按最后活动倒序"
  );
  assert.equal(
    mergeTaskRows(local, []),
    local,
    "没有 autonomy 行时**原样返回**（老列表逐字不变，连顺序都不动）"
  );
}

// ---- 8) 列表：同一个 TaskList、同一套行 class，只差 agent 创建路径 ----
{
  const rows = [
    localTaskToRow({
      taskId: "task-aaaaaaaa1111",
      projectId: "project-59c41b54",
      title: "老任务",
      createdAt: "2026-09-21T00:00:00.000Z",
      status: "active",
      workspace: "/tmp/ws",
      provider: "cursor",
      model: "gpt-5",
      taskType: "feature",
      goal: "merge",
    }),
    autonomyTaskToRow(
      {
        id: "task-45b7a5ac83298ecb",
        description: "由 autonomy 创建 agent 的任务",
        status: "running",
        turns: 2,
        lastAt: "2026-09-21T01:47:14.238Z",
        projectId: "project-59c41b54",
        agentId: 10001,
      },
      { llmBackend: "cline" }
    ),
  ];
  const html = renderToStaticMarkup(
    React.createElement(TaskList, {
      projects: [],
      selectedProjectId: "project-59c41b54",
      onSelectProject: () => {},
      onCreateProject: () => {},
      onRenameProject: () => {},
      onOpenProjectSettings: () => {},
      tasks: rows,
      selectedId: null,
      onSelect: () => {},
      onCreate: () => {},
    })
  );
  assert.ok(html.includes("老任务"), "老任务照常在同一个列表里");
  assert.ok(html.includes("由 autonomy 创建 agent 的任务"), "autonomy 的任务也在同一个列表里");
  // 注意别把容器 `task-items` 也算进去：只数行（渲染出来是 `task-item ` / `task-item selected`）。
  assert.equal(
    (html.match(/task-item /g) ?? []).length,
    2,
    "两行用同一套行 class（task-item），不是两张表"
  );
  assert.ok(html.includes("控制面"), "老行的 meta 里有 agent 创建路径：控制面");
  assert.ok(html.includes("cursor/gpt-5"), "老行照旧显示 provider/model");
  assert.ok(html.includes("task-type-badge"), "老行照旧有类型徽标");
  assert.ok(html.includes("autonomy"), "新行写明 agent 创建路径：autonomy");
  assert.ok(html.includes("cline"), "新行显示它的 LLM 后端");
  assert.equal(
    (html.match(/task-type-badge/g) ?? []).length,
    1,
    "autonomy 的行不显示类型徽标（那是我们的分类，它没有）"
  );
}

// ---- 9) 详情：同一个外壳（TaskIdsBar + 状态条），拿不到的字段不渲染 ----
{
  const row = autonomyTaskToRow(
    {
      id: "task-45b7a5ac83298ecb",
      description: "冒烟任务",
      status: "running",
      turns: 4,
      lastAt: "2026-09-21T01:47:14.238Z",
      projectId: "project-59c41b54",
      agentId: 10001,
    },
    { llmBackend: "cline" }
  );
  const html = renderToStaticMarkup(
    React.createElement(AutonomyTaskPanel, {
      taskId: row.taskId,
      row,
      meta: {
        available: true,
        url: "http://127.0.0.1:4300",
        version: "ff9899c0",
        llmBackend: "cline",
        fetchedAt: "2026-09-21T01:47:11.503Z",
        entry: "both",
      },
      orgId: "D0005",
      orgName: "AI研发部",
    })
  );
  // 和老详情同一套 chip：Task / Project / Org / Agent（这里 agent id 只有 10001）
  assert.ok(html.includes("task-ids"), "和老详情同一套 chip 条");
  assert.ok(html.includes(row.taskId), "Task chip");
  assert.ok(html.includes("project-59c41b54"), "Project chip");
  assert.ok(html.includes("D0005"), "Org chip");
  assert.ok(html.includes("10001"), "Agent chip");
  assert.ok(html.includes("Agent 创建路径"), "同一位置上写清 agent 是谁创建的");
  assert.ok(html.includes("autonomy"), "路径值：autonomy");
  assert.ok(html.includes("http://127.0.0.1:4300"), "数据源写进悬停（不占版面）");
  assert.ok(html.includes("轮次"), "轮次是它给的，就显示");
  assert.ok(html.includes("running"), "状态");
  assert.ok(html.includes("冒烟任务"), "描述先用列表里那行渲染，不空窗");
  // 拿不到的字段：**不渲染**（也不写占位）
  assert.ok(!html.includes("Timeline"), "没有它给不了的时间线");
  assert.ok(!html.includes("chat-input"), "没有输入框（继续对话要等它的接口）");
  assert.ok(!html.includes("usage-bar"), "没有 token 用量");
  assert.ok(!html.includes("context-meter"), "没有上下文占用");
  assert.ok(!html.includes("未解析出来"), "缺字段不写占位文案");
  assert.ok(!html.includes("计划步骤"), "它还没给步骤 → 这一行整段不显示");

  // provider 拿不到时：列表行留空，不写占位
  const bare = autonomyTaskToRow({
    id: "task-x",
    description: "d",
    status: "pending",
    turns: 0,
    lastAt: "",
  });
  assert.equal(bare.provider, "");
  assert.equal(bare.projectId, "");
  assert.equal(bare.agentId, undefined);
}

// ---- 10) 没有独立页面（防回归）：AppView / 组件 / 导航都不再给 autonomy 单开一个入口 ----
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const here = path.dirname(new URL(import.meta.url).pathname);
  const read = (rel) => fs.readFileSync(path.join(here, "..", rel), "utf8");

  const types = read("src/types.ts");
  const viewStart = types.indexOf("export type AppView");
  const appView = types.slice(viewStart, types.indexOf(";", viewStart));
  assert.ok(
    !appView.includes('"autonomy"'),
    "AppView 里不再有单独的 autonomy 视图"
  );
  assert.ok(
    !fs.existsSync(path.join(here, "../src/components/AutonomyPage.tsx")),
    "独立页面 AutonomyPage 已删除"
  );
  const app = read("src/App.tsx");
  assert.ok(!app.includes("🛰"), "导航里不再有单独的 autonomy 入口");
  assert.ok(!app.includes('setView("autonomy")'), "代码里不再跳转到独立视图");
  assert.ok(app.includes("<AutonomyTaskPanel"), "详情用同一个主区里的面板");
  assert.ok(app.includes("tasks={taskRows}"), "列表用的是合并后的行");
}

// ---- 11) agent 创建路径的显示口径（列表和详情共用）----
{
  assert.equal(agentPathLabel("control-plane"), "控制面");
  assert.equal(agentPathLabel("autonomy"), "autonomy");
  assert.ok(agentPathHint("control-plane").includes("控制面"));
  assert.ok(agentPathHint("autonomy").includes("autonomy"));
}

// ---- 12) 状态配色 / 「这条任务的世界」/ 步骤摊平 ----
{
  assert.equal(statusClass("running"), "running");
  assert.equal(statusClass("completed"), "ok");
  assert.equal(statusClass("need_input"), "warn");
  assert.equal(statusClass("unverified"), "warn");
  assert.equal(statusClass("error"), "bad");
  assert.equal(statusClass("stopped"), "stopped");

  assert.equal(
    worldLine({
      context_ref: { project: "project-x" },
      project: { id: "project-x", git_repo_url: "" },
    }),
    "project=project-x",
    "repo 是空的 → 整段不显示（不写「未解析出来」占位）"
  );
  assert.equal(
    worldLine({
      project: {
        id: "p",
        git_repo_url: "https://github.com/kaulie/agent-control-plane.git",
        organization: { id: "D0005", name: "AI研发部" },
      },
    }),
    "project=p · org=D0005 AI研发部 · repo=https://github.com/kaulie/agent-control-plane.git"
  );
  assert.equal(worldLine(null), "");
  assert.deepEqual(planSteps(null), []);
  assert.deepEqual(planSteps({ plans: [] }), []);
  assert.deepEqual(
    planSteps({
      plans: [
        { id: 7, steps: [{ capability: "write_code", status: "succeeded" }, { status: "running" }] },
      ],
    }),
    [
      { planId: 7, step: 1, capability: "write_code", status: "succeeded" },
      { planId: 7, step: 2, capability: "step", status: "running" },
    ]
  );
}

console.log(
  "PASS: agent 创建路径（老入口不变 / 一个列表一个外壳 / 拿不到就不显示 / 无独立页面）"
);
