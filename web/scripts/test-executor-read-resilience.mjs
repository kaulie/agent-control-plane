/**
 * 详情读取的「失败不清内容」口径（需求：端读失败时不要清空当前内容，给出提醒即可）。
 *
 * 覆盖纯状态机 `reduceExecutorRead`（`web/src/autonomy.ts`）：
 * 1) 读成功 → 换成新内容、清掉上一次的失败提醒；
 * 2) 读失败 → **保留**上一次读到的内容（不是 setDetail(null)），只记下原因；
 * 3) 失败后再成功 → 内容更新、提醒清掉（恢复）；
 * 4) 换 task（switch）→ 清空：新 task 首次读失败也不能把旧 task 的内容冒充过来；
 * 5) 起点 `EMPTY_EXECUTOR_READ` 是空的。
 *
 * 用法：npx tsx --tsconfig web/tsconfig.json web/scripts/test-executor-read-resilience.mjs
 */
import assert from "node:assert/strict";

const { EMPTY_EXECUTOR_READ, reduceExecutorRead } = await import("../src/autonomy.ts");

const taskA = { task_id: "task-a", status: "running", plans: [] };
const taskB = { task_id: "task-b", status: "blocked", plans: [] };

// ---- 0) 起点：什么都没读到、也没失败过 ----
assert.deepEqual(EMPTY_EXECUTOR_READ, { detail: null, error: null });

// ---- 1) 首次读失败：没有可保留的内容 → detail 仍为空，原因记下 ----
{
  const s = reduceExecutorRead(EMPTY_EXECUTOR_READ, {
    type: "error",
    error: "autonomy 超时（>5000ms）",
  });
  assert.equal(s.detail, null, "没有上一次内容时保持 null");
  assert.equal(s.error, "autonomy 超时（>5000ms）");
}

// ---- 2) 读到内容后读失败：内容必须还在（这是本次需求的核心）----
{
  const loaded = reduceExecutorRead(EMPTY_EXECUTOR_READ, { type: "ok", detail: taskA });
  assert.equal(loaded.detail, taskA, "读成功 → 显示它");
  assert.equal(loaded.error, null, "读成功 → 没有失败提醒");

  const failed = reduceExecutorRead(loaded, {
    type: "error",
    error: "读执行方失败：autonomy 超时（>5000ms）",
  });
  assert.equal(failed.detail, taskA, "读失败必须保留上一次内容（不清空）");
  assert.equal(failed.error, "读执行方失败：autonomy 超时（>5000ms）", "只多一条提醒");
}

// ---- 3) 失败后再成功：换成新内容并清掉提醒 ----
{
  const loaded = reduceExecutorRead(EMPTY_EXECUTOR_READ, { type: "ok", detail: taskA });
  const failed = reduceExecutorRead(loaded, { type: "error", error: "boom" });
  const recovered = reduceExecutorRead(failed, { type: "ok", detail: taskB });
  assert.equal(recovered.detail, taskB);
  assert.equal(recovered.error, null, "读到就清掉上一次的失败提醒");
}

// ---- 4) 换 task：先清空，失败也不显示上一个 task 的内容 ----
{
  const loaded = reduceExecutorRead(EMPTY_EXECUTOR_READ, { type: "ok", detail: taskA });
  const switched = reduceExecutorRead(loaded, { type: "switch" });
  assert.deepEqual(switched, { detail: null, error: null }, "换 task 先清空旧内容");

  const failed = reduceExecutorRead(switched, { type: "error", error: "boom" });
  assert.equal(failed.detail, null, "新 task 首次读失败不能显示旧 task 的内容");
}

console.log("✅ executor read resilience OK");
