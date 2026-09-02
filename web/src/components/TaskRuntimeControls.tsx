import { useEffect, useState } from "react";
import { api } from "../api";
import type { ModelInfo, ProviderInfo, Task } from "../types";

interface Props {
  task: Task;
  busy: boolean;
  onUpdated: (task: Task) => void;
  onError: (message: string) => void;
}

export default function TaskRuntimeControls({
  task,
  busy,
  onUpdated,
  onError,
}: Props) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.listProviders().then((r) => setProviders(r.providers)).catch(() => {
      setProviders([
        { name: "cursor", ok: true, detail: "", isDefault: true },
        { name: "cline", ok: true, detail: "", isDefault: false },
      ]);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api
      .listModels(task.provider)
      .then((r) => {
        if (!cancelled) setModels(r.models);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [task.provider]);

  const apply = async (patch: {
    provider?: string;
    model?: string | null;
  }): Promise<void> => {
    setSaving(true);
    try {
      const updated = await api.updateTask(task.taskId, patch);
      onUpdated(updated);
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const disabled = busy || saving;

  return (
    <>
      <div className="usage-item usage-runtime">
        <span className="usage-label">Provider</span>
        <select
          className="runtime-select runtime-select-compact"
          value={task.provider}
          disabled={disabled}
          title={
            busy
              ? "有活跃或排队中的 run 时不可更改"
              : "空闲时可切换；换 provider 会解绑旧 session"
          }
          onChange={(e) => {
            const next = e.target.value;
            if (next === task.provider) return;
            void apply({ provider: next });
          }}
        >
          {(providers.length
            ? providers.map((p) => p.name)
            : [task.provider]
          ).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div className="usage-item usage-runtime">
        <span className="usage-label">Model</span>
        <select
          className="runtime-select runtime-select-compact"
          value={task.model ?? ""}
          disabled={disabled}
          title={busy ? "有活跃或排队中的 run 时不可更改" : "空闲时可更改 model"}
          onChange={(e) => {
            const next = e.target.value;
            const current = task.model ?? "";
            if (next === current) return;
            void apply({ model: next || null });
          }}
        >
          <option value="">（自动）</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName || m.id}
            </option>
          ))}
          {task.model && !models.some((m) => m.id === task.model) && (
            <option value={task.model}>{task.model}</option>
          )}
        </select>
      </div>
    </>
  );
}
