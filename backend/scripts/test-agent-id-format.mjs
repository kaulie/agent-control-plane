/**
 * Agent 短号口径检查：**同一张用例表**同时跑后端 `agentDisplayName`
 *（`backend/src/agent-id.ts`）和前端 `shortAgentId`（`web/src/format.ts`），
 * 保证两边不会再各写一套（以前后端认 `cls-`、前端只认 `agent-`）。
 *
 * 要求：
 * 1) 定宽 14 字符 = 6 字符标签（`agent-` / `cline-` / `unset-`）+ 8 位 hex，
 *    Cline 不再原样打出 20 字符；
 * 2) 网关**预分配**的占位 id（`agent-` + 16 位 hex，工作区目录名）不再冒充
 *    Cursor 会话，而是 `unset-…`；
 * 3) 认不出的形状也截成等宽（13 字符 + `…`）。
 *
 *   npx tsx backend/scripts/test-agent-id-format.mjs   （或：npm test）
 */
import assert from "node:assert/strict";
import { AGENT_SHORT_WIDTH, agentDisplayName } from "../src/agent-id.ts";
import {
  AGENT_SHORT_WIDTH as WEB_AGENT_SHORT_WIDTH,
  shortAgentId,
} from "../../web/src/format.ts";

/** [原始 agent id, 期望短号, 说明] */
const cases = [
  // Cursor SDK 会话：`agent-<uuid>`（带连线）
  ["agent-7362ceb1-4b5b-4c0d-9e11-2f6a7b8c9d0e", "agent-7362ceb1", "Cursor 会话（uuid）"],
  ["agent-33333333-3333-3333-3333-333333333333", "agent-33333333", "Cursor 会话（uuid）"],
  // Cline SDK 会话：`cls-<hex>`——以前前端不认，会原样打出 20 字符
  ["cls-be74ef2f30124f28", "cline-be74ef2f", "Cline 会话（本任务）"],
  ["cls-4bc71ba2681a4b90", "cline-4bc71ba2", "Cline 会话"],
  ["cls-2222222222222222", "cline-22222222", "Cline 会话"],
  // 网关预分配（还没被 provider 建出会话）= 工作区目录名，16 位 hex 无连线
  ["agent-10d2a0eaa22244d1", "unset-10d2a0ea", "预分配占位（本任务）"],
  ["agent-5f7393dd40a44b06", "unset-5f7393dd", "预分配占位"],
  // 大小写 / 空白
  ["AGENT-10D2A0EAA22244D1", "unset-10d2a0ea", "预分配占位（大写）"],
  ["  cls-be74ef2f30124f28  ", "cline-be74ef2f", "两侧空白先 trim"],
  // 认不出的形状：等宽截断（13 字符 + …）
  ["some-very-long-unknown-agent-id-1234567890", "some-very-lon…", "陌生形状 → 等宽截断"],
  ["agent-unknown", "agent-unknown", "8 位 hex 都不足的短号 → 原样"],
  ["", "", "空 id → 空串，不炸"],
];

let failed = 0;
for (const [input, expected, why] of cases) {
  const backend = agentDisplayName(input);
  const frontend = shortAgentId(input);
  try {
    assert.equal(backend, expected, `后端 ${JSON.stringify(input)} → ${expected}（${why}）`);
    assert.equal(frontend, expected, `前端 ${JSON.stringify(input)} → ${expected}（${why}）`);
    assert.equal(frontend, backend, "前后端必须给出同一个短号");
    // 定宽：凡是「超长被归一化」的输入一律 14 字符；本来就短的陌生 id / 空串原样。
    if (input.trim().length > AGENT_SHORT_WIDTH) {
      assert.equal(
        expected.length,
        AGENT_SHORT_WIDTH,
        `${JSON.stringify(input)} → ${expected} 必须归一到定宽 ${AGENT_SHORT_WIDTH}`,
      );
    }
    assert.ok(
      frontend.length <= AGENT_SHORT_WIDTH,
      `${JSON.stringify(frontend)} 不得超过 ${AGENT_SHORT_WIDTH} 字符`,
    );
    console.log(`  ok   ${JSON.stringify(input).padEnd(48)} → ${frontend}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${why}: ${err.message}`);
  }
}

// 三个标签同宽（6 字符）+ 8 位 hex = 14；看板 / 时间线里一行短号不会长短不齐。
assert.equal(AGENT_SHORT_WIDTH, WEB_AGENT_SHORT_WIDTH, "前后端定宽常量必须一致");
for (const tag of ["agent-", "cline-", "unset-"]) {
  assert.equal(`${tag}${"0".repeat(8)}`.length, AGENT_SHORT_WIDTH, `${tag} 标签必须是 6 字符`);
}

console.log(
  failed
    ? `\n${failed} check(s) failed`
    : "\ntest-agent-id-format: ok（后端 agentDisplayName 与前端 shortAgentId 同一口径）",
);
process.exit(failed ? 1 : 0);
