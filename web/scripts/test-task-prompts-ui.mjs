/**
 * 主界面不再摊开两块提示词（走查式断言）：
 *
 * 1. 「任务意图」面板折叠态只留类型 / 标题 / 目标 / 编辑，**没有**
 *    【task prompt】和【初始化 system prompt】预览块。
 * 2. 即便调用方仍塞 `prompts` / `onSaveSystemPrompt`，面板也不渲染它们
 *    （Props 已删，主界面不编这两块）。
 * 3. App 不再拉 `/prompts`、不再接 `onSaveSystemPrompt`；描述仍走
 *    `updateTaskIntent`。接口层两块仍然分开（改描述不动 system prompt）。
 *
 *   npx tsx --tsconfig web/tsconfig.json web/scripts/test-task-prompts-ui.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.__APP_VERSION__ = "0.0.0-test";

const { default: TaskIntentPanel } = await import(
  "../src/components/TaskIntentPanel.tsx"
);

const here = path.dirname(new URL(import.meta.url).pathname);

const task = {
  taskId: "task-prompts-ui",
  projectId: "project-1",
  title: "两条 prompt 分开管理",
  createdAt: "2026-09-26T00:00:00.000Z",
  status: "active",
  workspace: "/tmp/ws/agent-1",
  provider: "cursor",
  taskType: "feature",
  goal: "merge",
  description: "把 system prompt 与 task prompt 分开独立管理。",
  lastUserInputAt: "2026-09-26T01:00:00.000Z",
};

const SYSTEM_TEXT = "## 这份提示词是什么（协议）\n- 只讲协议，不含这条 task 的具体信息。";
const promptsTemplate = {
  systemPrompt: {
    text: SYSTEM_TEXT,
    source: "template",
    chars: SYSTEM_TEXT.length,
    template: SYSTEM_TEXT,
    maxChars: 8000,
  },
  taskPrompt: { text: "## Task identity\n- taskId: task-prompts-ui", description: task.description, chars: 40 },
};

const SYS_BLOCK = 'class="prompt-block-name">初始化 system prompt';
const TASK_BLOCK = 'class="prompt-block-name">task prompt';

const html = renderToStaticMarkup(
  React.createElement(TaskIntentPanel, {
    task,
    onSave: async () => {},
    // 旧调用方可能还塞这两项；面板必须忽略，不能把预览摊回主界面。
    prompts: promptsTemplate,
    onSaveSystemPrompt: async () => {},
  }),
);

assert.ok(html.includes("新功能开发"), "折叠态要有类型徽标");
assert.ok(html.includes(task.title), "折叠态要有标题");
assert.ok(html.includes("合入主分支"), "折叠态要有目标徽标");
assert.ok(html.includes("✎ 编辑"), "折叠态要有编辑入口");
assert.ok(!html.includes(TASK_BLOCK), "主界面不再摊开 task prompt 预览块");
assert.ok(!html.includes(SYS_BLOCK), "主界面不再摊开初始化 system prompt 预览块");
assert.ok(!html.includes("改这一块"), "主界面没有单独改 system prompt 的入口");
assert.ok(!html.includes("恢复模板"), "主界面没有恢复模板动作");
assert.ok(
  !html.includes(SYSTEM_TEXT.slice(0, 24)),
  "主界面不显示 system prompt 原文（哪怕调用方塞了 prompts）",
);

const panelSrc = fs.readFileSync(
  path.join(here, "../src/components/TaskIntentPanel.tsx"),
  "utf8",
);
assert.ok(panelSrc.includes("任务描述"), "编辑态用「任务描述」改需求原文");
assert.ok(!panelSrc.includes("prompt-block-name"), "面板源码不再渲染提示词预览块");

const appSrc = fs.readFileSync(path.join(here, "../src/App.tsx"), "utf8");
assert.ok(appSrc.includes("api.updateTaskIntent(input.taskId"), "描述仍走 updateTaskIntent");
assert.ok(
  !appSrc.includes("onSaveSystemPrompt="),
  "App 不再把 system prompt 编辑接到主面板",
);
assert.ok(
  !appSrc.includes("getTaskPrompts"),
  "App 不再为了主界面预览去拉 /prompts",
);

const apiSrc = fs.readFileSync(path.join(here, "../src/api.ts"), "utf8");
assert.ok(
  apiSrc.includes("systemPrompt: string | null) =>\n    write<Task>(`/tasks/${taskId}`, { method: \"PATCH\", body: { systemPrompt } })"),
  "updateTaskSystemPrompt 只带 systemPrompt 一个字段（与描述互不覆盖）",
);
assert.ok(
  apiSrc.includes("getTaskPrompts: (taskId: string) =>"),
  "拉两份生效文本的接口还在（给别的入口用，主界面不再摊开）",
);

console.log("✅ task prompts UI OK（主界面不摊开两块提示词 / 描述仍走 updateTaskIntent）");
