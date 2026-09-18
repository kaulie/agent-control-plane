/**
 * 上下文（context）体量口径 + 模型窗口。见 ./size.ts 的语义说明（务必先读）。
 */
export * from "./size.js";
export {
  knownModelLimits,
  modelContextLimit,
  rememberModelLimits,
  warmModelLimits,
} from "./limits.js";
