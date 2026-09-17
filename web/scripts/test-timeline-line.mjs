/**
 * 时间线「状态线」的几何检查（`web/src/timeline-line.ts`）。
 *
 * 这是这次渲染改动的核心：idle / working / thinking **不是一条铺满的色带**，也不是
 * 一条上下相连的折线，而是**三条各自独立的水平线** —— 上 = thinking、中 = working、
 * 下 = idle。三条线之间**不画竖直连接线**（连接线只会让图看着乱）；
 * 同一状态首尾相接的段并成一条，疑似停滞的段单独标出来。
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

/** `d` → 每段的点列表（每个 `M` 起一段）。 */
function parsePath(d) {
  const subs = [];
  for (const m of d.matchAll(/([ML]) ([\d.]+) ([\d.]+)/g)) {
    if (m[1] === "M") subs.push([]);
    subs[subs.length - 1].push([Number(m[2]), Number(m[3])]);
  }
  return subs;
}

/** 每一段都必须是「两点、同高、向右」的水平线段 —— 出现竖直段就说明有连接线了。 */
function assertHorizontalOnly(state, d) {
  const subs = parsePath(d);
  assert.ok(subs.length > 0, `${state} 的 path 是空的`);
  for (const pts of subs) {
    assert.equal(
      pts.length,
      2,
      `${state} 的每段只能是两个点的水平线段，实际 ${JSON.stringify(pts)}`,
    );
    const [[x0, y0], [x1, y1]] = pts;
    assert.equal(y0, LEVELS[state], `${state} 的水平线在自己的高度上`);
    assert.equal(y1, y0, "水平段两端同高（没有上下跳线）");
    assert.ok(x1 > x0, "水平段向右延伸");
  }
}

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

// 每个状态一条 path（顺序固定，方便前端按序绘制）。
assert.deepEqual(TIMELINE_LINE_ORDER, ["idle", "working", "thinking"]);
assert.deepEqual(
  shape.paths.map((p) => p.state),
  ["idle", "working", "thinking"],
);

const byState = Object.fromEntries(shape.paths.map((p) => [p.state, p.d]));
// idle 有两段（中间被 thinking/working 隔开），都在最低那条线上；两段之间没有连线。
assert.equal(byState.idle, "M 0 52 L 10 52 M 30 52 L 40 52");
// 同状态首尾相接的两段（10→20、20→25）并成一条，点距才不会在接缝处乱掉。
assert.equal(byState.thinking, "M 10 12 L 25 12");
assert.equal(byState.working, "M 25 32 L 30 32");

for (const [state, d] of Object.entries(byState)) {
  assertHorizontalOnly(state, d);
}

// 停滞段单独给出（前端在同一高度上叠一根虚线）；范围用原始那一段，不因合并变长。
assert.deepEqual(shape.stalled, [{ state: "working", x0: 25, x1: 30, y: 32 }]);

// 2) 只有一个状态：一条水平点线，没有任何跳线
const flat = buildStateLine([{ state: "idle", x0: 0, x1: 100 }], LEVELS);
assert.deepEqual(flat.paths, [{ state: "idle", d: "M 0 52 L 100 52" }]);
assert.deepEqual(flat.stalled, []);

// 3) 同状态但中间有缝（缺了一段）不合并：还是两条独立的点线
const gapped = buildStateLine(
  [
    { state: "idle", x0: 0, x1: 10 },
    { state: "idle", x0: 12, x1: 20 },
  ],
  LEVELS,
);
assert.equal(gapped.paths[0].d, "M 0 52 L 10 52 M 12 52 L 20 52");

// 4) 浮点造成的极小缝（< 0.05）算首尾相接，照样并成一条
const hairline = buildStateLine(
  [
    { state: "idle", x0: 0, x1: 10 },
    { state: "idle", x0: 10.02, x1: 20 },
  ],
  LEVELS,
);
assert.equal(hairline.paths[0].d, "M 0 52 L 20 52");

// 5) 非法坐标（NaN）不写进 path
const junk = buildStateLine([{ state: "idle", x0: NaN, x1: 5 }], LEVELS);
assert.deepEqual(junk.paths, []);

// 6) 来回横跳时三条线之间没有任何竖直连接线（整条 path 全是水平段）
const zigzag = buildStateLine(
  [
    { state: "thinking", x0: 0, x1: 5 },
    { state: "idle", x0: 5, x1: 8 },
    { state: "working", x0: 8, x1: 10 },
    { state: "thinking", x0: 10, x1: 12 },
  ],
  LEVELS,
);
assert.equal(zigzag.paths.length, 3);
for (const [state, d] of zigzag.paths.map((p) => [p.state, p.d])) {
  assertHorizontalOnly(state, d);
}
// thinking 在两端各有一段（中间被 idle / working 隔开），两段之间也是断开的。
assert.deepEqual(
  zigzag.paths.map((p) => [p.state, p.d]),
  [
    ["idle", "M 5 52 L 8 52"],
    ["working", "M 8 32 L 10 32"],
    ["thinking", "M 0 12 L 5 12 M 10 12 L 12 12"],
  ],
);

console.log(
  "PASS: timeline state line geometry (three independent dotted rails, no connectors)",
);

