import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import type { ModelInfo, ProviderInfo, TaskType } from "../types";
import {
  DEFAULT_TASK_TYPE,
  TASK_TYPE_OPTIONS,
  taskTypeOption,
} from "../task-types";

export interface CreateTaskInput {
  title?: string;
  description: string;
  taskType: TaskType;
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
}

export default function CreateTaskDialog({
  open,
  projectId,
  projectDefaultProvider,
  projectDefaultModel,
  onClose,
  onCreate,
}: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [taskType, setTaskType] = useState<TaskType>(DEFAULT_TASK_TYPE);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [envDefault, setEnvDefault] = useState("cursor");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [resolved, setResolved] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDescription("");
    setTaskType(DEFAULT_TASK_TYPE);
    setProvider(projectDefaultProvider ?? "");
    setModel(projectDefaultModel ?? "");
    setError(null);
    void api.listProviders().then((r) => {
      setProviders(r.providers);
      setEnvDefault(r.defaultProvider);
    });
  }, [open, projectDefaultProvider, projectDefaultModel, projectId]);

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
  const canSubmit = description.trim().length > 0 && !saving;

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
      await onCreate({
        title: titleOrFallback(),
        description: description.trim(),
        taskType,
        provider: provider.trim() || undefined,
        model: model.trim() || undefined,
      });
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
        <label className="runtime-field runtime-field-wide">
          <span className="runtime-field-label">Title（可选）</span>
          <input
            className="settings-path-input"
            value={title}
            placeholder="留空则用描述首行"
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
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="modal-cancel" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="settings-save"
            disabled={!canSubmit}
            title={canSubmit ? undefined : "任务描述必填"}
            onClick={() => void submit()}
          >
            {saving ? "创建中…" : "创建并开始"}
          </button>
        </div>
      </div>
    </div>
  );
}
