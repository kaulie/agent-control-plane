/**
 * 主界面不再摊开两块提示词（走查式断言）：
 *
 * 1. 折叠态只显示类型 + 标题 + 目标，没有 task prompt / system prompt 块。
 * 2. 描述与协议提示词不占聊天区；点「编辑」才出现描述输入。
 *
 *   npx tsx --tsconfig web/tsconfig.json web/scripts/test-task-prompts-ui.mjs
 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.__APP_VERSION__ = "0.0.0-test";

const { default: TaskIntentPanel } = await import(
  "../src/components/TaskIntentPanel.tsx"
);

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

const SYS_BLOCK = 'class="prompt-block-name">初始化 system prompt';
const TASK_BLOCK = 'class="prompt-block-name">task prompt';

const html = renderToStaticMarkup(
  React.createElement(TaskIntentPanel, {
    task,
    onSave: async () => {},
  }),
);

assert.ok(!html.includes(TASK_BLOCK), "主界面不再摊开 task prompt 那块");
assert.ok(!html.includes(SYS_BLOCK), "主界面不再摊开 system prompt 那块");
assert.ok(html.includes(task.title), "折叠态要显示标题");
assert.ok(html.includes("合入主分支"), "折叠态要显示交付目标");
assert.ok(!html.includes("intent-textarea"), "折叠态不摊开描述输入框");
assert.ok(!html.includes("prompt-block-name"), "主界面没有提示词块");
assert.ok(html.includes("✎ 编辑"), "要能展开编辑类型 / 目标 / 标题 / 描述");

console.log("✅ task prompts UI OK（主界面不摊开提示词块）");
