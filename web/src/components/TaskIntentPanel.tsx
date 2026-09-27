import { useEffect, useState } from "react";
import { errorText } from "../api";
import type { Task, TaskGoal, TaskPromptPreview, TaskType } from "../types";
import {
  DEFAULT_TASK_TYPE,
  TASK_TYPE_OPTIONS,
  taskTypeLabel,
  taskTypeOption,
} from "../task-types";
import { TASK_GOAL_OPTIONS, taskGoalLabel } from "../task-goals";

interface Props {
  task: Task;
  /**
   * 首条「系统投递」事件的时间与状态（来自事件流 / runs）：
   * 面板上直接显示"需求已投递 / 排队中"，用户不用去翻时间线。
   */
  delivery?: { at: string; queued: boolean };
  /**
   * 两份 prompt 的**生效文本**（`GET /api/tasks/:id/prompts`）：拿不到就不显示 system prompt 那块。
   */
  prompts?: TaskPromptPreview | null;
  /**
   * **单独保存初始化 system prompt**（`null` = 恢复模板）。
   * 与下面的 `onSave`（task prompt 那条轴）**互不影响** —— 这是「两块分开独立管理」在面板上的落点。
   */
  onSaveSystemPrompt?: (text: string | null) => Promise<void>;
  /** 保存修改（App 负责调 PATCH 并刷新详情/列表）；抛错则面板内显示。 */
  onSave: (patch: {
    title?: string;
    description: string;
    taskType: TaskType;
    /** `null` = 老任务没设目标（保持「开完 PR 即停」）。 */
    goal: TaskGoal | null;
  }) => Promise<void>;
}

/**
 * 任务意图面板：**pin 在聊天框上方**的独立 panel。
 *
 * 显示 类型 + 目标 + 标题 + 描述（需求原文），并支持就地编辑（创建后理解变清晰时修正）。
 * 折叠态只占一行，不抢聊天区的空间。
 */
export default function TaskIntentPanel({
  task,
  delivery,
  prompts,
  onSaveSystemPrompt,
  onSave,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [taskType, setTaskType] = useState<TaskType>(
    task.taskType ?? DEFAULT_TASK_TYPE,
  );
  // 老任务没有目标：草稿为 null（= 不设目标），**不会**因为改了标题就把目标写上。
  const [goal, setGoal] = useState<TaskGoal | null>(task.goal ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 初始化 system prompt 那块：自己的展开 / 编辑 / 草稿 / 保存态（和上面那套**各自独立**）。
  const [sysEditing, setSysEditing] = useState(false);
  const [sysText, setSysText] = useState("");
  const [sysSaving, setSysSaving] = useState(false);
  const [sysError, setSysError] = useState<string | null>(null);

  // 切换任务 / 服务端有更新时，重置草稿与编辑态（不然会拿旧草稿覆盖别的任务）。
  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description ?? "");
    setTaskType(task.taskType ?? DEFAULT_TASK_TYPE);
    setGoal(task.goal ?? null);
    setEditing(false);
    setError(null);
    // 切任务时 system prompt 那块的草稿也重置（不拿旧草稿覆盖别的任务）。
    setSysEditing(false);
    setSysError(null);
  }, [task.taskId, task.title, task.description, task.taskType, task.goal]);

  // 生效文本变了（保存成功 / 换任务）→ 草稿跟着走；正在编辑时**不动**它（别覆盖用户输入）。
  useEffect(() => {
    if (!prompts || sysEditing) return;
    setSysText(prompts.systemPrompt.text);
  }, [prompts, sysEditing]);

  const option = taskTypeOption(taskType);
  const dirty =
    title.trim() !== task.title ||
    description.trim() !== (task.description ?? "") ||
    taskType !== (task.taskType ?? DEFAULT_TASK_TYPE) ||
    goal !== (task.goal ?? null);
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
        goal,
      });
      setEditing(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  /** 只保存**初始化 system prompt** 这一块（`null` = 恢复模板）。 */
  const saveSystemPrompt = async (text: string | null): Promise<void> => {
    if (!onSaveSystemPrompt) return;
    setSysSaving(true);
    setSysError(null);
    try {
      await onSaveSystemPrompt(text);
      setSysEditing(false);
    } catch (e) {
      setSysError(errorText(e));
    } finally {
      setSysSaving(false);
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
        {/* 目标会改变 agent 的交付动作，所以在面板上一眼能看到（老任务显示"仅开 PR"）。 */}
        <span
          className={`task-goal-badge goal-${task.goal ?? "none"}`}
          title={
            task.goal
              ? `交付目标：${taskGoalLabel(task.goal)}`
              : "这个任务没有设交付目标（老任务）：agent 开完 PR 就停，不会合入、不会部署"
          }
        >
          {task.goal ? taskGoalLabel(task.goal) : "仅开 PR"}
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
          title={expanded ? "折叠提示词" : "展开提示词（task prompt / 初始化 system prompt）"}
        >
          {expanded ? "▴ 提示词" : "▾ 提示词"}
        </button>
        <button
          type="button"
          className="intent-btn"
          onClick={() => {
            setEditing((v) => !v);
            setExpanded(true);
          }}
          title="修改类型 / 目标 / 标题 / 描述"
        >
          ✎ 编辑
        </button>
      </div>

      {!editing ? (
        <div className={`task-intent-body ${expanded ? "" : "collapsed"}`}>
          {/* ---- ① task prompt（任务相关提示词：需求原文）---- */}
          <div className="prompt-block">
            <div className="prompt-block-head">
              <span className="prompt-block-name">task prompt</span>
              <span className="prompt-block-hint">
                任务相关：需求原文 + 最近历史，新会话开始时随用户消息送出
              </span>
            </div>
            {task.description ? (
              <p className="task-intent-desc">{task.description}</p>
            ) : (
              <p className="task-intent-desc is-empty">
                这个任务还没有描述（老任务）。补上描述后，agent
                在下次会话里就能直接看到需求。
              </p>
            )}
          </div>

          {/* ---- ② 初始化 system prompt（协议那半）：单独一块、单独保存 ---- */}
          {prompts ? (
            <div className="prompt-block">
              <div className="prompt-block-head">
                <span className="prompt-block-name">初始化 system prompt</span>
                <span className="prompt-block-hint">
                  只讲协议（怎么干活 / 怎么交付），不含这条 task 的具体信息 · 来源：
                  {prompts.systemPrompt.source === "task" ? "这条 task 自己的" : "模板生成"}
                </span>
              </div>
              {!sysEditing ? (
                <>
                  <pre className="prompt-preview">{prompts.systemPrompt.text}</pre>
                  {onSaveSystemPrompt ? (
                    <div className="prompt-block-actions">
                      <button
                        type="button"
                        className="intent-btn"
                        onClick={() => {
                          setSysText(prompts.systemPrompt.text);
                          setSysError(null);
                          setSysEditing(true);
                        }}
                      >
                        ✎ 改这一块
                      </button>
                      {prompts.systemPrompt.source === "task" ? (
                        <button
                          type="button"
                          className="intent-btn"
                          disabled={sysSaving}
                          title="丢掉这条 task 自己的那份，回到模板生成"
                          onClick={() => void saveSystemPrompt(null)}
                        >
                          {sysSaving ? "恢复中…" : "恢复模板"}
                        </button>
                      ) : null}
                      <span className="prompt-block-meta">
                        {prompts.systemPrompt.chars} 字符（上限 {prompts.systemPrompt.maxChars}）· 改了只影响新会话
                      </span>
                    </div>
                  ) : null}
                  {sysError && <div className="modal-error">{sysError}</div>}
                </>
              ) : (
                <>
                  <textarea
                    className="intent-textarea"
                    value={sysText}
                    rows={12}
                    onChange={(e) => setSysText(e.target.value)}
                  />
                  <div className="intent-hint">
                    这里只存这一块（初始化 system prompt）：保存它不会动上面的 task prompt。
                    生效时机是开会话 —— 当前会话要等重建 / 轮转 / fork 才用上。
                  </div>
                  {sysError && <div className="modal-error">{sysError}</div>}
                  <div className="modal-actions">
                    <button
                      type="button"
                      className="modal-cancel"
                      onClick={() => setSysEditing(false)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="settings-save"
                      disabled={sysSaving}
                      onClick={() => void saveSystemPrompt(sysText.trim() || null)}
                    >
                      {sysSaving ? "保存中…" : "保存这一块"}
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : null}
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
          <div className="intent-type-chips">
            {TASK_GOAL_OPTIONS.map((g) => (
              <button
                key={g.id}
                type="button"
                className={`intent-type-chip goal-${g.id} ${
                  g.id === goal ? "selected" : ""
                }`}
                title={g.hint}
                onClick={() => setGoal(g.id)}
              >
                {g.label}
              </button>
            ))}
          </div>
          <div className="intent-hint">
            目标会改变 agent 的交付动作（合入主分支 / 再部署上线）
            {goal ? "" : "。这个老任务还没设目标 —— 选一个才会改变它的行为"}
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
              task prompt · 任务相关（需求原文）{" "}
              <b className="intent-required">必填</b>
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
