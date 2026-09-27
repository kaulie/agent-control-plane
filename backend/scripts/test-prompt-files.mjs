/**
 * **初始化 system prompt 的模板是文件**（`backend/src/agent_policy/PROTOCOL.md`）：
 *
 * 1. 渲染结果**就是**文件内容（尾部换行裁掉）—— 措辞不在代码里；
 * 2. **改文件 → 渲染结果跟着变**（每次调用读盘、没有缓存）：这一条是「模板是文件」的唯一证据；
 * 3. 空文件 / 缺文件 → **大声失败**（报错里给绝对路径），不静默给一份空模板；
 * 4. 真仓库里那份存在、且仍然是「只讲协议」的全文。
 *
 * 接线（面板 / `GET /api/tasks/:id/prompts` 用同一份模板）由 `test-task-prompts.mjs` 覆盖。
 *
 *   npx tsx --tsconfig backend/tsconfig.json backend/scripts/test-prompt-files.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REL = "agent_policy/PROTOCOL.md"; // 相对 prompt-files 模块目录（dev=src / 部署=dist）
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-prompt-files-"));
const file = path.join(dir, REL);
fs.mkdirSync(path.dirname(file), { recursive: true });

// 模板基点可覆盖（默认 = 模块自己所在目录）；这里指到临时目录，里面放同名相对路径 ——
// 与真实布局（src/agent_policy、dist/agent_policy）一致。
process.env.PROMPT_FILES_ROOT = dir;

const { buildInitSystemPrompt } = await import("../src/task-context.ts");

// ---- 1) 渲染结果 = 文件内容（尾部换行不算数）----
fs.writeFileSync(file, "## 协议模板（来自文件）\n- 只有这两行。\n\n");
assert.equal(
  buildInitSystemPrompt(),
  "## 协议模板（来自文件）\n- 只有这两行。",
  "渲染出来的就是文件里那份，尾部的空行被裁掉",
);

// ---- 2) 改文件 → 跟着变（不重启、不缓存）----
fs.writeFileSync(file, "改过的协议。\n");
assert.equal(buildInitSystemPrompt(), "改过的协议。", "改了文件，下一次渲染就该是新文案");

// ---- 3) 读不到 / 空 → 大声失败，别给一份空模板 ----
fs.writeFileSync(file, "   \n\n");
assert.throws(() => buildInitSystemPrompt(), /prompt template file is empty/);
fs.rmSync(file);
assert.throws(
  () => buildInitSystemPrompt(),
  (err) => {
    assert.match(err.message, /prompt template file is missing/);
    assert.ok(err.message.includes(file), "报错里要有绝对路径，才知道该建哪个文件");
    return true;
  },
);

// ---- 4) 真仓库里那份 ----
delete process.env.PROMPT_FILES_ROOT;
const real = buildInitSystemPrompt();
assert.ok(real.startsWith("[Web Cursor task bootstrap"), "保留老文案：agent 靠它认出「这不是用户消息」");
assert.ok(real.includes("## 这份提示词是什么（协议）"), "说清这块是什么");
assert.ok(real.includes("BRANCHING.md"), "仓库 / PR 协议在");
assert.ok(real.includes("Delivery goal"), "交付目标的规则在");
assert.ok(real.includes("deployment platform"), "部署协议在");
assert.ok(!/- taskId:|Injected git repositories/.test(real), "协议那半不含这条 task 的具体信息");
assert.ok(real.split("\n").length >= 25, `真模板要有完整协议（实际 ${real.split("\n").length} 行）`);

console.log("✅ prompt files OK（模板是文件 / 改文件即生效 / 缺文件大声失败）");
