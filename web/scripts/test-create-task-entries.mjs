/**
 * 「新建任务」两个入口的前端口径检查（`web/src/components/CreateTaskDialog.tsx` +
 * `web/src/api.ts` + `web/src/components/AutonomyPage.tsx`）。
 *
 * 守三件事：
 * 1. **老入口不变**：`TASK_ENTRY=gateway` 时对话框与以前逐字一致（类型 / 目标 / Provider /
 *    Model / 「创建并开始」）；两个入口都在时**默认仍落在老入口**。
 * 2. **新入口只说必要的话**：类型 / 目标 / Provider / Model 都不显示（autonomy 有自己的一套，
 *    见契约 A2），并且 `api.createAutonomyTask` 只发 `description` + `projectId`。
 * 3. **不可达就置灰**：autonomy 不可达时按钮 disabled 且写明原因。
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
const { default: AutonomyPage, statusClass, worldLine } = await import(
  "../src/components/AutonomyPage.tsx"
);

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

// ---- 6) Autonomy 页的口径：状态配色 + 「这条任务的世界」+ 空态写明数据源 ----
{
  assert.equal(statusClass("running"), "running");
  assert.equal(statusClass("pending"), "running");
  assert.equal(statusClass("completed"), "ok");
  assert.equal(statusClass("need_input"), "warn");
  assert.equal(statusClass("blocked"), "warn");
  assert.equal(statusClass("unverified"), "warn");
  assert.equal(statusClass("error"), "bad");
  assert.equal(statusClass("stopped"), "stopped");
  assert.equal(statusClass("什么鬼"), "");

  assert.equal(
    worldLine({ context_ref: { project: "project-x" }, project: { id: "project-x", git_repo_url: "" } }),
    "project=project-x · repo=（未解析出来）",
    "仓库没解析出来要写出来（而不是假装没有）"
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

  const html = renderToStaticMarkup(
    React.createElement(AutonomyPage, {
      projectId: "project-59c41b54",
      projectName: "web-cursor",
      onBack: () => {},
    })
  );
  assert.ok(html.includes("Autonomy 任务"), "页面标题");
  assert.ok(html.includes("数据源"), "页面上写明数据源是 autonomy");
  assert.ok(html.includes("交给 autonomy"), "空态指向新入口");
  assert.ok(html.includes("只看当前项目"), "列表可按当前项目过滤（A3 的 project_id 过滤）");
}

console.log("PASS: 新建任务两个入口（老入口不变 / 新入口只说必要的话 / 不可达置灰）");
