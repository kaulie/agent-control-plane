import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import type { ModelInfo, ProviderInfo } from "../types";

interface Props {
  open: boolean;
  projectId: string;
  projectDefaultProvider?: string;
  projectDefaultModel?: string;
  onClose: () => void;
  onCreate: (input: {
    title?: string;
    provider?: string;
    model?: string;
  }) => Promise<void>;
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

  const submit = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await onCreate({
        title: title.trim() || undefined,
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
        className="modal-dialog"
        role="dialog"
        aria-labelledby="create-task-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="create-task-title" className="modal-title">
          New Task
        </h2>
        <label className="runtime-field">
          <span className="runtime-field-label">Title</span>
          <input
            className="settings-path-input"
            value={title}
            placeholder="可选标题"
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
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
            disabled={saving}
            onClick={() => void submit()}
          >
            {saving ? "创建中…" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}
