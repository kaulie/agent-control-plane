/**
 * 面板上**两块提示词分开管理**（走查式断言）：
 *
 * 1. 「任务意图」面板里 **task prompt**（需求原文）与 **初始化 system prompt** 是**两个块**，
 *    各自标明身份与来源（模板生成 / 这条 task 自己的）。
 * 2. 拿不到 `/prompts` 就不显示 system prompt 那块（**不编内容**）。
 * 3. 两块各走各的接口：`updateTaskIntent`（task prompt 那条轴）/ `updateTaskSystemPrompt`
 *    （只带 `systemPrompt` 一个字段）—— 互不覆盖是接口层就定死的。
 *
 *   npx tsx --tsconfig web/tsconfig.json web/scripts/test-task-prompts-ui.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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

// 两个块的"标题徽标"就是它们的身份标记（折叠按钮的 title 里也提到这两个名字，所以按元素断言）。
const SYS_BLOCK = 'class="prompt-block-name">初始化 system prompt';
const TASK_BLOCK = 'class="prompt-block-name">task prompt';

const render = (props) =>
  renderToStaticMarkup(
    React.createElement(TaskIntentPanel, {
      task,
      onSave: async () => {},
      ...props,
    })
  );

// ---- 1) 两个块都在，各自标明是什么 ----
const withTemplate = render({
  prompts: promptsTemplate,
  onSaveSystemPrompt: async () => {},
});
assert.ok(withTemplate.includes(TASK_BLOCK), "要有 task prompt 那块");
assert.ok(withTemplate.includes(SYS_BLOCK), "要有 system prompt 那块");
assert.ok(withTemplate.includes("任务相关"), "要说明 task prompt 是任务相关那半");
assert.ok(withTemplate.includes("不含这条 task 的具体信息"), "system prompt 那块要写明「只讲协议、不含具体信息」");
assert.ok(withTemplate.includes("模板生成"), "来源要说清（模板生成 / 这条 task 自己的）");
assert.ok(withTemplate.includes(task.description), "task prompt 那块要显示需求原文");
assert.ok(withTemplate.includes(SYSTEM_TEXT.slice(0, 24)), "要显示 system prompt 的生效文本");
assert.ok(withTemplate.includes("改这一块"), "system prompt 能单独改");
assert.ok(!withTemplate.includes("恢复模板"), "没覆盖过 → 没有「恢复模板」这个动作");

// ---- 2) 覆盖过：来源变了，且给出「恢复模板」 ----
const withOwn = render({
  prompts: {
    ...promptsTemplate,
    systemPrompt: { ...promptsTemplate.systemPrompt, text: "自己的那份", source: "task" },
  },
  onSaveSystemPrompt: async () => {},
});
assert.ok(withOwn.includes("这条 task 自己的"), "覆盖过 → 来源写「这条 task 自己的」");
assert.ok(withOwn.includes("恢复模板"), "覆盖过 → 可以恢复模板");
assert.ok(withOwn.includes("自己的那份"), "显示的是覆盖后的生效文本");

// ---- 3) 拿不到 / 执行方是 autonomy：不显示 system prompt 那块（不编内容）----
const withoutPrompts = render({ onSaveSystemPrompt: async () => {} });
assert.ok(withoutPrompts.includes(TASK_BLOCK), "task prompt 那块照旧");
assert.ok(!withoutPrompts.includes(SYS_BLOCK), "拿不到就不显示，不编");

// ---- 4) 接口层就分开（两块互不覆盖）----
const appSrc = fs.readFileSync(path.join(here, "../src/App.tsx"), "utf8");
assert.ok(
  appSrc.includes("api.updateTaskSystemPrompt(taskId, text)"),
  "system prompt 那条轴走 updateTaskSystemPrompt",
);
assert.ok(appSrc.includes("api.updateTaskIntent(input.taskId"), "task prompt 那条轴走 updateTaskIntent");
assert.ok(
  appSrc.includes("onSaveSystemPrompt={(text) =>"),
  "面板接的是**单独的** onSaveSystemPrompt（不是复用 onSave）",
);
const apiSrc = fs.readFileSync(path.join(here, "../src/api.ts"), "utf8");
assert.ok(
  apiSrc.includes("systemPrompt: string | null) =>\n    write<Task>(`/tasks/${taskId}`, { method: \"PATCH\", body: { systemPrompt } })"),
  "updateTaskSystemPrompt 只带 systemPrompt 一个字段",
);
assert.ok(
  apiSrc.includes("getTaskPrompts: (taskId: string) =>"),
  "有拉两份生效文本的接口",
);

console.log("✅ task prompts UI OK（两块分开显示 / 分开保存 / 拿不到不编）");
