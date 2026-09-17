/**
 * 时间线「状态线」的几何：把 idle / working / thinking 折成**一条高低跳动的细折线**
 * （上 = thinking、中 = working、下 = idle），而不是一条铺满的色带。
 *
 * 折叠规则：同一状态连续的段合成一条水平线；状态变化处画一根竖直的「跳线」，
 * 颜色跟着**新状态**走，于是一眼看过去就是一条不断上下跳的时间线。
 *
 * 纯函数、无运行时依赖（只有类型 import），所以能脱离浏览器验证：
 * `node --input-type=module -e 'import(...)'` 或直接把这里当模块跑。
 * 颜色 / tooltip / 命中区留在 `AgentTimelinePage`。
 */

export type TimelineLineState = "idle" | "thinking" | "working";

/** 时间线的三个高度（对应 SVG 的 y；越小越高）。 */
export interface TimelineLineLevels {
  thinking: number;
  working: number;
  idle: number;
}

/** 折线的一段（x 已经是 SVG 坐标；`stalled` = 被「长时间无事件」截断出来的）。 */
export interface TimelineLineStep {
  state: TimelineLineState;
  x0: number;
  x1: number;
  stalled?: boolean;
}

/** 疑似停滞的那一段（画成细虚线盖在同一高度上）。 */
export interface TimelineLineStallSpan {
  state: TimelineLineState;
  x0: number;
  x1: number;
  y: number;
}

export interface TimelineLineShape {
  /** 每个状态一条 path（`d` 里已含状态切换的竖直跳线）。 */
  paths: Array<{ state: TimelineLineState; d: string }>;
  /** 疑似停滞的段（叠在折线上，虚线）。 */
  stalled: TimelineLineStallSpan[];
}

/** 绘制顺序：先 idle（最低），最后 thinking，跳线交叠处不会被低状态盖住。 */
export const TIMELINE_LINE_ORDER: readonly TimelineLineState[] = [
  "idle",
  "working",
  "thinking",
];

/** path 里的坐标保留两位小数：够用，且几万段也不会把 `d` 写爆。 */
function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Number.isFinite(r) ? String(r) : "0";
}

/**
 * 段列表 → 每个状态一条 path。入参按时间升序（后端返回的就是升序）。
 */
export function buildStateLine(
  steps: readonly TimelineLineStep[],
  levels: TimelineLineLevels,
): TimelineLineShape {
  const byState = new Map<TimelineLineState, string[]>();
  const stalled: TimelineLineStallSpan[] = [];
  let prevY: number | null = null;

  for (const step of steps) {
    if (!Number.isFinite(step.x0) || !Number.isFinite(step.x1)) continue;
    const y = levels[step.state];
    const d: string[] = [];
    if (prevY !== null && prevY !== y) {
      // 跳线：从上一段的高度竖直跳到这一段的（颜色属于新状态）。
      d.push(`M ${fmt(step.x0)} ${fmt(prevY)}`, `L ${fmt(step.x0)} ${fmt(y)}`);
    } else {
      d.push(`M ${fmt(step.x0)} ${fmt(y)}`);
    }
    d.push(`L ${fmt(step.x1)} ${fmt(y)}`);
    const list = byState.get(step.state);
    if (list) list.push(d.join(" "));
    else byState.set(step.state, [d.join(" ")]);
    if (step.stalled) {
      stalled.push({ state: step.state, x0: step.x0, x1: step.x1, y });
    }
    prevY = y;
  }

  return {
    paths: TIMELINE_LINE_ORDER.filter((s) => byState.has(s)).map((state) => ({
      state,
      d: byState.get(state)!.join(" "),
    })),
    stalled,
  };
}
