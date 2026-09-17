/**
 * 时间线「状态线」的几何：把 idle / working / thinking 折成**三条各自独立的横向线**
 * （上 = thinking、中 = working、下 = idle），而不是一条铺满的色带、
 * 也不是一条连来连去、上下跳动的折线。
 *
 * 折叠规则：同一状态的连续段是一根水平线；**三条线之间不画任何竖直连接线** ——
 * x 位置就是时间、高度就是状态，谁也不用拖着谁（连接线只会让图看着乱）。
 * 同一状态首尾相接的段并成一条，点距（虚线样式）才不会在接缝处乱掉。
 *
 * 纯函数、无运行时依赖（只有类型 import），所以能脱离浏览器验证：
 * `node --input-type=module -e 'import(...)'` 或直接把这里当模块跑。
 * 颜色 / 点距 / tooltip / 命中区留在 `AgentTimelinePage`。
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
  /**
   * 每个状态一条 path：`d` 里是若干条**水平线段**（`M x0 y L x1 y`）。
   * 里面**没有竖直段** —— 状态之间不连线，这也是这个视图不会再显得杂乱的关键。
   */
  paths: Array<{ state: TimelineLineState; d: string }>;
  /** 疑似停滞的段（叠在水平线上，虚线）。 */
  stalled: TimelineLineStallSpan[];
}

/** 绘制顺序：先 idle（最低），最后 thinking。 */
export const TIMELINE_LINE_ORDER: readonly TimelineLineState[] = [
  "idle",
  "working",
  "thinking",
];

/**
 * 同状态、首尾相接的两段并成一条的容差：小于 0.05 用户单位（≈千分之一个绘图宽）
 * 的缝肉眼看不见，直接并掉，免得点距在接缝处多出一个空档。
 */
const PART_GAP = 0.05;

/** path 里的坐标保留两位小数：够用，且几万段也不会把 `d` 写爆。 */
function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Number.isFinite(r) ? String(r) : "0";
}

/**
 * 段列表 → 每个状态一条 path（每条 path 里是若干条水平线段，彼此不相连）。
 * 入参按时间升序（后端返回的就是升序）。
 */
export function buildStateLine(
  steps: readonly TimelineLineStep[],
  levels: TimelineLineLevels,
): TimelineLineShape {
  /** 折出来的水平段（同状态、首尾相接的已经在下面并掉了）。 */
  const parts: Array<{ state: TimelineLineState; x0: number; x1: number }> = [];
  const stalled: TimelineLineStallSpan[] = [];

  for (const step of steps) {
    if (!Number.isFinite(step.x0) || !Number.isFinite(step.x1)) continue;
    const x0 = step.x0;
    const x1 = Math.max(step.x0, step.x1);
    const last = parts[parts.length - 1];
    if (last && last.state === step.state && x0 - last.x1 <= PART_GAP) {
      // 同状态且接着上一条 → 往右延伸，而不是另起一条（点距才连续）。
      last.x1 = Math.max(last.x1, x1);
    } else {
      parts.push({ state: step.state, x0, x1 });
    }
    if (step.stalled) {
      // 停滞段用**原始**这一段的范围（合并不会把它拉长）。
      stalled.push({ state: step.state, x0, x1, y: levels[step.state] });
    }
  }

  const byState = new Map<TimelineLineState, string[]>();
  for (const part of parts) {
    const y = fmt(levels[part.state]);
    const d = `M ${fmt(part.x0)} ${y} L ${fmt(part.x1)} ${y}`;
    const list = byState.get(part.state);
    if (list) list.push(d);
    else byState.set(part.state, [d]);
  }

  return {
    paths: TIMELINE_LINE_ORDER.filter((s) => byState.has(s)).map((state) => ({
      state,
      d: byState.get(state)!.join(" "),
    })),
    stalled,
  };
}
