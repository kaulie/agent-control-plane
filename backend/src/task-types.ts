import type { TaskType } from "./types.js";

/**
 * 任务类型目录（唯一事实源）。
 *
 * 设计约定（和产品确认过）：**类型只是分类标签，不改变 agent 的行为** ——
 * 任务怎么干由「描述 + 对话」决定。类型只用在这些地方：
 * 1. 任务列表 / 面板上的徽标；
 * 2. 新建任务时切换「描述模板」（placeholder + 一键插入骨架），引导用户写清需求；
 * 3. 落库，供以后按类型统计（token / 耗时）。
 *
 * 注意：`general` 必须保持为空 playbook / 无模板引导 —— 历史任务全是 `general`，
 * 任何"给 general 加点提示"的改动都会让老任务行为漂移。
 */
export interface TaskTypeInfo {
  id: TaskType;
  /** 中文名（UI / 系统投递消息里都用它）。 */
  label: string;
  /** 列表徽标用的短标签。 */
  short: string;
  /** 一句话说明（新建对话框里给用户看的提示）。 */
  hint: string;
  /**
   * 描述框的 placeholder：不同类型引导用户写不同的东西
   * （"什么算做完"比"要做什么"重要）。
   */
  placeholder: string;
  /**
   * 「插入描述模板」的一键骨架；`general` 为 undefined（不引导，老行为）。
   */
  template?: string;
}

export const DEFAULT_TASK_TYPE: TaskType = "general";

/** 描述长度上限（HTTP 校验）。超过就 400：简报骨架里只留前 2000 字（见 task-context）。 */
export const MAX_TASK_DESCRIPTION_CHARS = 4000;

export const TASK_TYPE_CATALOG: TaskTypeInfo[] = [
  {
    id: "feature",
    label: "新功能开发",
    short: "新功能",
    hint: "从零做一个能力；描述里写清验收标准，避免做偏。",
    placeholder:
      "要做什么？\n什么算做完（验收标准）？\n边界与兼容性（不改什么 / 要兼容谁）？",
    template:
      "## 目标\n\n## 验收标准\n- [ ] \n\n## 边界 / 不改动\n- \n",
  },
  {
    id: "bugfix",
    label: "缺陷修复",
    short: "修复",
    hint: "已知行为不对；描述里带上复现步骤，修完要能回归。",
    placeholder:
      "复现步骤：\n期望行为 vs 实际行为：\n影响范围（谁受影响 / 多严重）：",
    template:
      "## 复现步骤\n1. \n\n## 期望 vs 实际\n- 期望：\n- 实际：\n\n## 影响范围\n- \n",
  },
  {
    id: "diagnose",
    label: "问题定位",
    short: "定位",
    hint: "只要结论和证据；描述里写清现象与已排除的线索。",
    placeholder:
      "现象：\n范围（哪个环境 / 什么时候开始）：\n已排除的线索 / 已知信息：",
    template:
      "## 现象\n\n## 范围\n- 环境：\n- 时间：\n\n## 已排除 / 已知线索\n- \n",
  },
  {
    id: "general",
    label: "通用",
    short: "通用",
    hint: "没有特定形态的任务（缺省）。",
    placeholder: "这个任务要达成什么？什么算做完？",
  },
];

const BY_ID = new Map<TaskType, TaskTypeInfo>(
  TASK_TYPE_CATALOG.map((info) => [info.id, info]),
);

/** 合法类型 id（错误信息里列出来，便于调用方自查）。 */
export const TASK_TYPE_IDS: TaskType[] = TASK_TYPE_CATALOG.map((info) => info.id);

export function isTaskType(value: unknown): value is TaskType {
  return typeof value === "string" && BY_ID.has(value as TaskType);
}

/** 未知 / 空 / 脏值一律回落到 `general`（历史数据的值）。 */
export function normalizeTaskType(value: unknown): TaskType {
  return isTaskType(value) ? value : DEFAULT_TASK_TYPE;
}

export function taskTypeInfo(value: unknown): TaskTypeInfo {
  return BY_ID.get(normalizeTaskType(value))!;
}

/** 给用户看的中文名（系统投递消息里带上它，便于人读）。 */
export function taskTypeLabel(value: unknown): string {
  return taskTypeInfo(value).label;
}
