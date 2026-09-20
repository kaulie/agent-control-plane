/**
 * 时间线 SVG 的渲染检查：把 `TimelineBand` 直接渲染成静态标记（react-dom/server），
 * 确认 idle / working / thinking 画成了**三条互不相连的水平点线**：
 *   - 每个状态一条 `<path class="timeline-line X">`（同一状态的连续段合成一条）；
 *   - 每段都只是「两点、同高、向右」的水平线段 —— **没有竖直连接线**；
 *   - 左侧纵轴把三条线的含义写在轴上（thinking 模型侧 / working 工具侧 / idle 无事件）；
 *   - 三档高度挨得很近（每档只差 9，整条带很扁）；
 *   - 疑似停滞的段单独一根虚线；
 *   - 逐段的 hover 命中区（透明矩形）数量 = 段数；
 *   - 三个高度各有一条基准虚线。
 *
 * 不需要浏览器，也不需要前端构建：
 *   npx tsx web/scripts/test-timeline-render.mjs
 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 组件链路会引到 `web/src/version.ts`，那里读的是 Vite 注入的 `__APP_VERSION__`
// （浏览器里由构建替进来）。在 node 里跑之前先给它一个值。
globalThis.__APP_VERSION__ = "0.0.0-test";
const { TimelineBand, TIMELINE_CHART } = await import(
  "../src/components/AgentTimelinePage.tsx"
);

const BASE_MS = Date.parse("2026-09-17T10:00:00.000Z");
/** 相对 10:00 的第 mm 分钟（mm=60 → 11:00）。 */
const T = (mm) => new Date(BASE_MS + mm * 60_000).toISOString();

/** 一小时的窗口：idle → thinking → working(停滞) → thinking → idle。 */
const data = {
  agentId: "cls-1234567890abcdef",
  agentName: "cline-12345678",
  provider: "cline",
  model: "deepseek-v4-flash",
  taskId: "task-1",
  taskTitle: "timeline render",
  projectId: "project-1",
  projectName: "web-cursor",
  current: true,
  lastActiveAt: T(40),
  agentRunCount: 1,
  agentCompletedRounds: 1,
  from: T(0),
  to: T(60),
  generatedAt: T(60),
  mode: "segments",
  segments: [
    { state: "idle", start: T(0), end: T(10), durationMs: 600_000 },
    {
      state: "thinking",
      start: T(10),
      end: T(20),
      durationMs: 600_000,
      runId: "run-1",
      lastEvent: "agent_response",
    },
    {
      state: "working",
      start: T(20),
      end: T(30),
      durationMs: 600_000,
      runId: "run-1",
      lastEvent: "terminal",
      stalled: true,
    },
    { state: "thinking", start: T(30), end: T(40), durationMs: 600_000, runId: "run-1" },
    { state: "idle", start: T(40), end: T(60), durationMs: 1_200_000 },
  ],
  buckets: [],
  markers: [
    { at: T(10), kind: "user_input", text: "做一个时间线", mode: "agent" },
    {
      at: T(30),
      kind: "stall",
      label: "疑似停滞：超过 5 分钟没有新事件，之后按空闲计",
      runId: "run-1",
    },
  ],
  runs: [
    {
      runId: "run-1",
      status: "finished",
      startedAt: T(10),
      completedAt: T(40),
      durationMs: 1_800_000,
      thinkingMs: 1_200_000,
      workingMs: 600_000,
      modelCalls: 5,
      toolCalls: 4,
      inputText: "做一个时间线",
    },
  ],
  totals: {
    spanMs: 3_600_000,
    thinkingMs: 1_200_000,
    workingMs: 600_000,
    idleMs: 1_800_000,
    activeMs: 1_800_000,
    activeRatio: 0.5,
    runCount: 1,
    userInputCount: 1,
    toolCalls: 4,
    modelCalls: 5,
    eventCounts: { thinking: 3, terminal: 2 },
  },
  note: "状态口径：…",
};

const markup = renderToStaticMarkup(
  React.createElement(TimelineBand, { data, onHover: () => {} }),
);

/** `<path class="timeline-line idle" d="…" />` */
function linePath(state) {
  const m = markup.match(
    new RegExp(`<path class="timeline-line ${state}" d="([^"]+)"`),
  );
  assert.ok(m, `没有找到 ${state} 的状态线`);
  return m[1];
}

const idle = linePath("idle");
const working = linePath("working");
const thinking = linePath("thinking");

/** path 的 `d` → 子路径（每个 `M` 起一段），每段是一串 [x, y]。 */
function parsePath(d) {
  const subs = [];
  for (const m of d.matchAll(/([ML]) ([\d.]+) ([\d.]+)/g)) {
    if (m[1] === "M") subs.push([]);
    subs[subs.length - 1].push([Number(m[2]), Number(m[3])]);
  }
  return subs;
}

// 三档高度直接取自组件导出的布局：thinking 最高、working 中间、idle 最低。
const LEVEL = TIMELINE_CHART.levels;
for (const [state, d] of Object.entries({ idle, working, thinking })) {
  const subs = parsePath(d);
  assert.ok(subs.length > 0, `${state} 的 path 是空的`);
  for (const pts of subs) {
    // 只允许「两点、同高、向右」的水平段：出现第三个点就是一根竖直连接线。
    assert.equal(
      pts.length,
      2,
      `${state} 的每段只能是水平线段（状态之间不连线），实际 ${JSON.stringify(pts)}`,
    );
    const [[x0, y0], [x1, y1]] = pts;
    assert.equal(
      y0,
      LEVEL[state],
      `${state} 的水平线必须落在自己的高度上（${LEVEL[state]}），实际 ${y0}`,
    );
    assert.equal(y1, y0, "水平段两端同高（没有上下跳线）");
    assert.ok(x1 > x0, "水平段向右延伸");
  }
}

// 三档挨得很近：每档只差 12（原来是 20），整条带才扁。
assert.equal(LEVEL.working - LEVEL.thinking, 12);
assert.equal(LEVEL.idle - LEVEL.working, 12);
assert.ok(
  LEVEL.idle - LEVEL.thinking <= 24,
  "三档加起来不超过 24 高（压缩线的高度，原来 40）",
);

// 同一状态的连续段合成一条：idle 被中间的活动分成 2 段，thinking 也是 2 段，working 1 段。
assert.equal(parsePath(idle).length, 2, "idle 的两段各是一条水平线（中间隔开又回来）");
assert.equal(parsePath(thinking).length, 2, "thinking 的两段");
assert.equal(parsePath(working).length, 1, "working 只有一段");

// 左侧纵轴：三条线的含义写在轴上（text-anchor=end，颜色跟线一致，由 CSS 决定）。
const labels = [...markup.matchAll(
  /<text class="timeline-axis-label (\w+)" x="([\d.]+)" y="([\d.]+)" text-anchor="end">([^<]+)<\/text>/g,
)].map((m) => ({ state: m[1], x: Number(m[2]), y: Number(m[3]), text: m[4] }));
assert.deepEqual(
  labels.map((l) => l.state),
  ["idle", "working", "thinking"],
  "三个状态各有一个纵轴标签",
);
assert.deepEqual(
  labels.map((l) => l.text),
  ["idle 无事件", "working 工具侧", "thinking 模型侧"],
  "纵轴上写清每条横线是什么（不是只有一个英文名）",
);
for (const l of labels) {
  assert.equal(l.y, LEVEL[l.state] + 3.3, "纵轴标签贴在自己那条线的高度上");
  assert.ok(
    l.x < TIMELINE_CHART.padL,
    "纵轴标签在绘图区左侧（横线从 padL 才开始）",
  );
}
assert.ok(
  TIMELINE_CHART.padL >= 80,
  "左边给纵轴标签留出足够宽度",
);

// 停滞段：同一高度上多一根虚线；命中区 = 段数；三条基准线。
assert.equal([...markup.matchAll(/timeline-line-stall/g)].length, 1);
assert.equal([...markup.matchAll(/class="timeline-hit"/g)].length, 5);
assert.equal([...markup.matchAll(/timeline-guide/g)].length, 3);
// hover 文案仍然逐段给出（原生 <title>）。
assert.ok(markup.includes("<title>thinking · 10:00 分</title>") === false);
assert.ok(markup.includes("疑似停滞：超过阈值没有新事件"));

console.log(
  "PASS: timeline SVG renders three flat dotted rails, labelled on the left axis, no connectors",
);
