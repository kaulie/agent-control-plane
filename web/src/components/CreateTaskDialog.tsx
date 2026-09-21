import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import type {
  ModelInfo,
  ProviderInfo,
  TaskEntry,
  TaskGoal,
  TaskType,
} from "../types";
import {
  DEFAULT_TASK_TYPE,
  TASK_TYPE_OPTIONS,
  taskTypeOption,
} from "../task-types";
import { DEFAULT_TASK_GOAL, TASK_GOAL_OPTIONS } from "../task-goals";

export interface CreateTaskInput {
  title?: string;
  description: string;
  taskType: TaskType;
  /** 交付目标（会改变 agent 的动作：合入主分支 / 合入并部署上线）。 */
  goal: TaskGoal;
  provider?: string;
  model?: string;
}

interface Props {
  open: boolean;
  projectId: string;
  projectDefaultProvider?: string;
  projectDefaultModel?: string;
  onClose: () => void;
  onCreate: (input: CreateTaskInput) => Promise<void>;
  /**
   * 入口开关（`TASK_ENTRY`）：`both`（默认，两个入口）/
   * `autonomy`（只留「交给 autonomy」）/ `gateway`（只留现状入口）。
   */
  entry?: TaskEntry;
  /** autonomy 的可用性 / 当前 LLM 后端（来自 `GET /api/autonomy/meta`；null = 还没探到）。 */
  autonomy?: {
    available: boolean;
    backend?: string;
    model?: string;
    error?: string;
  } | null;
  /** 「交给 autonomy」入口：只传描述（provider/model/类型/目标都不适用，见契约）。 */
  onCreateAutonomy?: (input: { description: string }) => Promise<void>;
}

export default function CreateTaskDialog({
  open,
  projectId,
  projectDefaultProvider,
  projectDefaultModel,
  onClose,
  onCreate,
  entry = "both",
  autonomy = null,
  onCreateAutonomy,
}: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [taskType, setTaskType] = useState<TaskType>(DEFAULT_TASK_TYPE);
  const [goal, setGoal] = useState<TaskGoal>(DEFAULT_TASK_GOAL);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [envDefault, setEnvDefault] = useState("cursor");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [resolved, setResolved] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 这次用哪个入口建任务（两个入口都在时由用户选，默认现状入口）。 */
  const [entryMode, setEntryMode] = useState<"gateway" | "autonomy">(
    // 首帧就落在正确入口上（只留新入口时别先闪一下老入口的字段）。
    entry === "autonomy" ? "autonomy" : "gateway",
  );

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDescription("");
    setTaskType(DEFAULT_TASK_TYPE);
    setGoal(DEFAULT_TASK_GOAL);
    setProvider(projectDefaultProvider ?? "");
    setModel(projectDefaultModel ?? "");
    setError(null);
    // 只留新入口时（TASK_ENTRY=autonomy）直接落在新入口上。
    setEntryMode(entry === "autonomy" ? "autonomy" : "gateway");
    void api.listProviders().then((r) => {
      setProviders(r.providers);
      setEnvDefault(r.defaultProvider);
    });
  }, [open, projectDefaultProvider, projectDefaultModel, projectId, entry]);

  const effectiveProvider =
    provider || projectDefaultProvider || envDefault || "cursor";

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api
      .listModels(effectiveProvider)
      .then((r) => {
        if (cancelled) return;
        setModels(r.models);
        setResolved(r.resolved);
      })
      .catch(() => {
        if (!cancelled) {
          setModels([]);
          setResolved(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, effectiveProvider]);

  if (!open) return null;

  const option = taskTypeOption(taskType);
  const goalOption = TASK_GOAL_OPTIONS.find((g) => g.id === goal)!;
  /** 「交给 autonomy」这一侧：任务由它的 agent 执行，我们只能填描述。 */
  const autonomyMode = entryMode === "autonomy";
  /** 入口选择器里「交给 autonomy」按钮用（JSX 里名字短一点好读）。 */
  const autoMode0 = autonomyMode;
  const autonomyDown = autonomy != null && !autonomy.available;
  const autonomyHint = autonomyMode
    ? autonomyDown
      ? `autonomy 不可达：${autonomy?.error ?? "未配置"} —— 先修好它，或改用「本机 agent」入口。`
      : `任务由 autonomy 的 agent 执行：Provider / Model 由 autonomy 进程决定（当前 ${
          autonomy?.backend ?? "未知"
        }${autonomy?.model ? ` / ${autonomy.model}` : ""}），类型与目标不适用（它有自己的一套 goal_type / 完成契约）；当前项目会作为 context_ref.project 带过去。`
    : "";
  const canSubmit =
    description.trim().length > 0 && !saving && !(autonomyMode && autonomyDown);

  /** 标题可选：留空时用描述首行兜底，避免出现 "Task 9/19/2026, …" 这种标题。 */
  const titleOrFallback = (): string | undefined => {
    const t = title.trim();
    if (t) return t;
    const firstLine = description
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (!firstLine) return undefined;
    return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
  };

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      if (autonomyMode) {
        if (!onCreateAutonomy) throw new Error("autonomy 入口未接线");
        // 只交描述 + 项目上下文：类型/目标/provider/model 都不适用（契约第 2 节 A2）。
        await onCreateAutonomy({ description: description.trim() });
      } else {
        await onCreate({
          title: titleOrFallback(),
          description: description.trim(),
          taskType,
          goal,
          provider: provider.trim() || undefined,
          model: model.trim() || undefined,
        });
      }
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-dialog modal-dialog-wide"
        role="dialog"
        aria-labelledby="create-task-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="create-task-title" className="modal-title">
          New Task
        </h2>
        {entry !== "gateway" && (
          <div className="runtime-field runtime-field-wide">
            <span className="runtime-field-label">入口</span>
            <div className="intent-type-chips">
              {entry === "both" && (
                <button
                  type="button"
                  className={`intent-type-chip ${
                    autoMode0 ? "" : "selected"
                  }`}
                  title="现状入口：在本项目里建任务，由控制面的 agent 执行（行为不变）"
                  onClick={() => setEntryMode("gateway")}
                >
                  本机 agent（现状）
                </button>
              )}
              <button
                type="button"
                className={`intent-type-chip ${autoMode0 ? "selected" : ""}`}
                title={
                  autonomyDown
                    ? `autonomy 不可达：${autonomy?.error ?? "未配置"}`
                    : "把任务指令交给 autonomy，由它自己的 agent 执行（控制面只代理，不落库）"
                }
                onClick={() => setEntryMode("autonomy")}
              >
                交给 autonomy
              </button>
            </div>
            <span className="intent-hint">
              {autoMode0
                ? autonomyHint
                : "在本项目里建任务，由控制面的 agent 执行（现有入口，行为与以前一致）。"}
            </span>
          </div>
        )}
        {!autonomyMode && (
          <>
        <div className="runtime-field runtime-field-wide">
          <span className="runtime-field-label">类型</span>
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
          <span className="intent-hint">{option.hint}</span>
        </div>
        {/* 目标：和「类型」不同 —— 它会改变 agent 的交付动作（做到哪一步算完），
            所以默认选中「合入主分支」，并把「不部署 / 要部署」写清楚。 */}
        <div className="runtime-field runtime-field-wide">
          <span className="runtime-field-label">目标</span>
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
          <span className="intent-hint">
            {goalOption.hint}（会写进投递给 agent 的需求里）
          </span>
        </div>
        <label className="runtime-field runtime-field-wide">
          <span className="runtime-field-label">Title（可选）</span>
          <input
            className="settings-path-input"
            value={title}
            placeholder="留空则用描述首行"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
          </>
        )}
        <label className="runtime-field runtime-field-wide">
          <span className="runtime-field-label">
            任务描述 <b className="intent-required">必填</b>
          </span>
          <textarea
            className="intent-textarea"
            value={description}
            placeholder={option.placeholder}
            rows={6}
            autoFocus
            onChange={(e) => setDescription(e.target.value)}
          />
          <span className="intent-hint">
            创建后会作为第一条消息自动投递给 agent，它随即开始工作。
            {option.template ? (
              <button
                type="button"
                className="intent-template-btn"
                onClick={() =>
                  setDescription((prev) => (prev.trim() ? prev : option.template!))
                }
              >
                插入模板
              </button>
            ) : null}
          </span>
        </label>
        {!autonomyMode && (
        <div className="runtime-fields">
          <label className="runtime-field">
            <span className="runtime-field-label">Provider</span>
            <select
              className="runtime-select"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setModel("");
              }}
            >
              <option value="">
                项目/环境默认（
                {projectDefaultProvider || envDefault || "cursor"}）
              </option>
              {(providers.length
                ? providers.map((p) => p.name)
                : ["cursor", "cline"]
              ).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="runtime-field">
            <span className="runtime-field-label">Model</span>
            <select
              className="runtime-select"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">
                {projectDefaultModel
                  ? `项目默认：${projectDefaultModel}`
                  : resolved
                    ? `自动：${resolved}`
                    : "自动 / 未指定"}
              </option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName || m.id}
                </option>
              ))}
            </select>
          </label>
        </div>
        )}
        {autonomyMode && autonomyHint && (
          <div className="intent-hint">{autonomyHint}</div>
        )}
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="modal-cancel" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="settings-save"
            disabled={!canSubmit}
            title={
              canSubmit
                ? undefined
                : autonomyMode && autonomyDown
                  ? "autonomy 不可达，先修好它或用「本机 agent」入口"
                  : "任务描述必填"
            }
            onClick={() => void submit()}
          >
            {saving
              ? autonomyMode
                ? "提交中…"
                : "创建中…"
              : autonomyMode
                ? "交给 autonomy 创建"
                : "创建并开始"}
          </button>
        </div>
      </div>
    </div>
  );
}
