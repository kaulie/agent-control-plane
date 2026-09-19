import type { TaskType } from "./types";

/**
 * 任务类型目录（前端）。后端有一份对应的 `backend/src/task-types.ts`
 * —— 两个 workspace 不共享代码，所以两边各一份，靠 `web/scripts/test-task-types.mjs`
 * 与 `backend/scripts/test-task-intent.mjs` 守住口径一致。
 *
 * 约定（产品确认）：**类型只是分类标签，不改变 agent 的行为**。
 * 它的用处：列表/面板上的徽标、新建任务时切换描述模板、落库供以后按类型统计。
 */
export interface TaskTypeOption {
  id: TaskType;
  label: string;
  short: string;
  hint: string;
  placeholder: string;
  /** 「插入描述模板」的一键骨架（general 没有）。 */
  template?: string;
}

export const DEFAULT_TASK_TYPE: TaskType = "general";

export const TASK_TYPE_OPTIONS: TaskTypeOption[] = [
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
    template: "## 现象\n\n## 范围\n- 环境：\n- 时间：\n\n## 已排除 / 已知线索\n- \n",
  },
  {
    id: "general",
    label: "通用",
    short: "通用",
    hint: "没有特定形态的任务（缺省）。",
    placeholder: "这个任务要达成什么？什么算做完？",
  },
];

const BY_ID = new Map<TaskType, TaskTypeOption>(
  TASK_TYPE_OPTIONS.map((option) => [option.id, option]),
);

export function isTaskType(value: unknown): value is TaskType {
  return typeof value === "string" && BY_ID.has(value as TaskType);
}

/** 未知 / 空值一律回落到 `general`（历史任务的值）。 */
export function normalizeTaskType(value: unknown): TaskType {
  return isTaskType(value) ? value : DEFAULT_TASK_TYPE;
}

export function taskTypeOption(value: unknown): TaskTypeOption {
  return BY_ID.get(normalizeTaskType(value))!;
}

export function taskTypeLabel(value: unknown): string {
  return taskTypeOption(value).label;
}
