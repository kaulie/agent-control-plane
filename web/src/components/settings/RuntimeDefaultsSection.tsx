import { useEffect, useState } from "react";
import { api } from "../../api";
import type { ModelInfo, ProviderInfo } from "../../types";

interface Props {
  defaultProvider: string;
  defaultModel: string;
  envDefaultProvider: string;
  onProviderChange: (value: string) => void;
  onModelChange: (value: string) => void;
}

export default function RuntimeDefaultsSection({
  defaultProvider,
  defaultModel,
  envDefaultProvider,
  onProviderChange,
  onModelChange,
}: Props) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [resolved, setResolved] = useState<string | undefined>();
  const [loadingModels, setLoadingModels] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveProvider = defaultProvider || envDefaultProvider || "cursor";

  useEffect(() => {
    void api
      .listProviders()
      .then((r) => setProviders(r.providers))
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadingModels(true);
    setError(null);
    void api
      .listModels(effectiveProvider)
      .then((r) => {
        if (cancelled) return;
        setModels(r.models);
        setResolved(r.resolved);
      })
      .catch((e) => {
        if (!cancelled) {
          setModels([]);
          setResolved(undefined);
          setError(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveProvider]);

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h2 className="settings-section-title">默认 Agent Runtime</h2>
        <p className="settings-section-desc">
          新建 Task 时的默认 provider / model；创建时可覆盖，创建后锁定（便于按
          task 统计）。留空 provider 则回退到环境变量{" "}
          <code>AGENT_PROVIDER</code>（当前默认：{envDefaultProvider || "cursor"}）。
        </p>
      </div>
      <div className="runtime-fields">
        <label className="runtime-field">
          <span className="runtime-field-label">Provider</span>
          <select
            className="runtime-select"
            value={defaultProvider}
            onChange={(e) => onProviderChange(e.target.value)}
          >
            <option value="">（使用环境默认：{envDefaultProvider || "cursor"}）</option>
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
            value={defaultModel}
            onChange={(e) => onModelChange(e.target.value)}
            disabled={loadingModels}
          >
            <option value="">
              {resolved ? `（自动：${resolved}）` : "（自动 / 未指定）"}
            </option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName || m.id}
              </option>
            ))}
            {defaultModel &&
              !models.some((m) => m.id === defaultModel) && (
                <option value={defaultModel}>{defaultModel}</option>
              )}
          </select>
        </label>
      </div>
      {error && <div className="settings-section-meta">{error}</div>}
    </section>
  );
}
