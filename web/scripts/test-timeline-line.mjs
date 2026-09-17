/**
 * 时间线「状态线」的几何检查（`web/src/timeline-line.ts`）。
 *
 * 这是这次渲染改动的核心：idle / working / thinking **不再是一条铺满的色带**，
 * 而是折成一条高低跳动的细折线 —— 上 = thinking、中 = working、下 = idle。
 * 同一状态连续段连成水平线，状态变化处一根竖直跳线（颜色跟新状态），
 * 疑似停滞的段单独标出来。
 *
 * 纯函数、没有运行时依赖，所以能脱离浏览器跑：
 *   npx tsx web/scripts/test-timeline-line.mjs
 */
import assert from "node:assert/strict";
import {
  buildStateLine,
  TIMELINE_LINE_ORDER,
} from "../src/timeline-line.ts";

const LEVELS = { thinking: 12, working: 32, idle: 52 };

// 1) 典型的来回跳：idle → thinking ×2 → working(停滞) → idle
const shape = buildStateLine(
  [
    { state: "idle", x0: 0, x1: 10 },
    { state: "thinking", x0: 10, x1: 20 },
    { state: "thinking", x0: 20, x1: 25 },
    { state: "working", x0: 25, x1: 30, stalled: true },
    { state: "idle", x0: 30, x1: 40 },
  ],
  LEVELS,
);

// 每个状态一条 path；绘制顺序让最高那条最后画（跳线交叠处不被低状态盖住）。
assert.deepEqual(TIMELINE_LINE_ORDER, ["idle", "working", "thinking"]);
assert.deepEqual(
  shape.paths.map((p) => p.state),
  ["idle", "working", "thinking"],
);

const byState = Object.fromEntries(shape.paths.map((p) => [p.state, p.d]));
// idle 有两段（中间被 thinking/working 隔开），都在最低那条线上。
assert.equal(byState.idle, "M 0 52 L 10 52 M 30 32 L 30 52 L 40 52");
// 从 idle(52) 跳到 thinking(12)：竖直跳线 + 水平线；同状态第二段直接续上。
assert.equal(byState.thinking, "M 10 52 L 10 12 L 20 12 M 20 12 L 25 12");
// 从 thinking(12) 跳到 working(32)。
assert.equal(byState.working, "M 25 12 L 25 32 L 30 32");

// 停滞段单独给出（前端在同一高度上叠一根虚线）。
assert.deepEqual(shape.stalled, [{ state: "working", x0: 25, x1: 30, y: 32 }]);

// 2) 只有一个状态：一条水平细线，没有跳线
const flat = buildStateLine([{ state: "idle", x0: 0, x1: 100 }], LEVELS);
assert.deepEqual(flat.paths, [{ state: "idle", d: "M 0 52 L 100 52" }]);
assert.deepEqual(flat.stalled, []);

// 3) 非法坐标（NaN）不写进 path
const junk = buildStateLine([{ state: "idle", x0: NaN, x1: 5 }], LEVELS);
assert.deepEqual(junk.paths, []);

console.log("PASS: timeline state line geometry (three levels, one jumping line)");
