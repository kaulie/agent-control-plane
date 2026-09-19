import { useEffect, useState } from "react";
import { errorText } from "../api";
import type { Task, TaskType } from "../types";
import {
  DEFAULT_TASK_TYPE,
  TASK_TYPE_OPTIONS,
  taskTypeLabel,
  taskTypeOption,
} from "../task-types";

interface Props {
  task: Task;
  /**
   * 首条「系统投递」事件的时间与状态（来自事件流 / runs）：
   * 面板上直接显示"需求已投递 / 排队中"，用户不用去翻时间线。
   */
  delivery?: { at: string; queued: boolean };
  /** 保存修改（App 负责调 PATCH 并刷新详情/列表）；抛错则面板内显示。 */
  onSave: (patch: {
    title?: string;
    description: string;
    taskType: TaskType;
  }) => Promise<void>;
}

/**
 * 任务意图面板：**pin 在聊天框上方**的独立 panel。
 *
 * 显示 类型 + 标题 + 描述（需求原文），并支持就地编辑（创建后理解变清晰时修正）。
 * 折叠态只占一行，不抢聊天区的空间。
 */
export default function TaskIntentPanel({ task, delivery, onSave }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [taskType, setTaskType] = useState<TaskType>(
    task.taskType ?? DEFAULT_TASK_TYPE,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 切换任务 / 服务端有更新时，重置草稿与编辑态（不然会拿旧草稿覆盖别的任务）。
  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description ?? "");
    setTaskType(task.taskType ?? DEFAULT_TASK_TYPE);
    setEditing(false);
    setError(null);
  }, [task.taskId, task.title, task.description, task.taskType]);

  const option = taskTypeOption(taskType);
  const dirty =
    title.trim() !== task.title ||
    description.trim() !== (task.description ?? "") ||
    taskType !== (task.taskType ?? DEFAULT_TASK_TYPE);
  const canSave = description.trim().length > 0 && dirty && !saving;

  const save = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        title: title.trim() || undefined,
        description: description.trim(),
        taskType,
      });
      setEditing(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={`task-intent ${expanded || editing ? "expanded" : ""}`}>
      <div className="task-intent-head">
        <span
          className={`task-type-badge type-${taskTypeOption(
            task.taskType,
          ).id}`}
          title={`任务类型：${taskTypeLabel(task.taskType)}（仅作分类，不改变 agent 行为）`}
        >
          {taskTypeLabel(task.taskType)}
        </span>
        <span className="task-intent-title" title={task.description}>
          {task.title}
        </span>
        {delivery ? (
          <span
            className="task-intent-delivery"
            title={`系统已于 ${new Date(delivery.at).toLocaleString()} 自动把需求投递给 agent`}
          >
            {delivery.queued ? "需求已投递 · 排队中" : "需求已投递"}
          </span>
        ) : null}
        <button
          type="button"
          className="intent-btn"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={expanded ? "折叠描述" : "展开描述"}
        >
          {expanded ? "▴ 描述" : "▾ 描述"}
        </button>
        <button
          type="button"
          className="intent-btn"
          onClick={() => {
            setEditing((v) => !v);
            setExpanded(true);
          }}
          title="修改类型 / 标题 / 描述"
        >
          ✎ 编辑
        </button>
      </div>

      {!editing ? (
        <div className={`task-intent-body ${expanded ? "" : "collapsed"}`}>
          {task.description ? (
            <p className="task-intent-desc">{task.description}</p>
          ) : (
            <p className="task-intent-desc is-empty">
              这个任务还没有描述（老任务）。补上描述后，agent
              在下次会话里就能直接看到需求。
            </p>
          )}
        </div>
      ) : (
        <div className="task-intent-editor">
          <div className="intent-type-chips">
            {TASK_TYPE_OPTIONS.map((o) => (
              <button
                key={o.id}
                type="button"
                className={`intent-type-chip type-${o.id} ${
                  o.id === taskType ? "selected" : ""
                }`}
                title={o.hint}
                onClick={() => setTaskType(o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <label className="runtime-field runtime-field-wide">
            <span className="runtime-field-label">Title</span>
            <input
              className="settings-path-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="runtime-field runtime-field-wide">
            <span className="runtime-field-label">
              任务描述 <b className="intent-required">必填</b>
            </span>
            <textarea
              className="intent-textarea"
              value={description}
              placeholder={option.placeholder}
              rows={5}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div className="intent-hint">
            修改只影响「下一次」会话（重启 / 轮转 / fork）的简报；正在跑的 agent
            看不到这次改动，时间线会留一条「任务意图已更新」。
          </div>
          {error && <div className="modal-error">{error}</div>}
          <div className="modal-actions">
            <button
              type="button"
              className="modal-cancel"
              onClick={() => setEditing(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="settings-save"
              disabled={!canSave}
              onClick={() => void save()}
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
