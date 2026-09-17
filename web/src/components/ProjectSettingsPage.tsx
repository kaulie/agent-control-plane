import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { ProjectSettingsView } from "../types";
import AgentRulesSection from "./settings/AgentRulesSection";
import RuntimeDefaultsSection from "./settings/RuntimeDefaultsSection";
import DepartmentSection from "./settings/DepartmentSection";

interface Props {
  projectId: string;
  projectName: string;
  onBack: () => void;
}

export default function ProjectSettingsPage({
  projectId,
  projectName,
  onBack,
}: Props) {
  const [view, setView] = useState<ProjectSettingsView | null>(null);
  const [defaultProvider, setDefaultProvider] = useState("");
  const [savedDefaultProvider, setSavedDefaultProvider] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [savedDefaultModel, setSavedDefaultModel] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [departmentName, setDepartmentName] = useState("");
  const [savedDepartmentId, setSavedDepartmentId] = useState("");
  const [savedDepartmentName, setSavedDepartmentName] = useState("");
  const [envDefaultProvider, setEnvDefaultProvider] = useState("cursor");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, providers] = await Promise.all([
        api.getProjectSettings(projectId),
        api.listProviders().catch(() => null),
      ]);
      setView(data);
      setDefaultProvider(data.project.runtime?.defaultProvider ?? "");
      setSavedDefaultProvider(data.project.runtime?.defaultProvider ?? "");
      setDefaultModel(data.project.runtime?.defaultModel ?? "");
      setSavedDefaultModel(data.project.runtime?.defaultModel ?? "");
      setDepartmentId(data.project.department?.departmentId ?? "");
      setDepartmentName(data.project.department?.departmentName ?? "");
      setSavedDepartmentId(data.project.department?.departmentId ?? "");
      setSavedDepartmentName(data.project.department?.departmentName ?? "");
      if (providers) setEnvDefaultProvider(providers.defaultProvider);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api.updateProjectSettings(projectId, {
        runtime: {
          defaultProvider: defaultProvider.trim(),
          defaultModel: defaultModel.trim(),
        },
        // Empty id+name clears the department (see patchSettings).
        department: {
          departmentId: departmentId.trim(),
          departmentName: departmentName.trim(),
        },
      });
      setView(data);
      setSavedDefaultProvider(defaultProvider);
      setSavedDefaultModel(defaultModel);
      setSavedDepartmentId(data.project.department?.departmentId ?? "");
      setSavedDepartmentName(data.project.department?.departmentName ?? "");
      setDepartmentId(data.project.department?.departmentId ?? "");
      setDepartmentName(data.project.department?.departmentName ?? "");
      setNotice("已保存");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    defaultProvider !== savedDefaultProvider ||
    defaultModel !== savedDefaultModel ||
    departmentId !== savedDepartmentId ||
    departmentName !== savedDepartmentName;

  return (
    <div className="settings-page">
      <header className="settings-header">
        <button type="button" className="settings-back" onClick={onBack}>
          ← 返回
        </button>
        <h1 className="settings-title">项目设置</h1>
        <p className="settings-subtitle">{projectName}</p>
      </header>
      {loading ? (
        <div className="settings-loading">加载中…</div>
      ) : (
        <div className="settings-body">
          <RuntimeDefaultsSection
            defaultProvider={defaultProvider}
            defaultModel={defaultModel}
            envDefaultProvider={envDefaultProvider}
            onProviderChange={(v) => {
              setDefaultProvider(v);
              setDefaultModel("");
            }}
            onModelChange={setDefaultModel}
          />
          <DepartmentSection
            departmentId={departmentId}
            departmentName={departmentName}
            onChange={({ departmentId: nextId, departmentName: nextName }) => {
              setDepartmentId(nextId);
              setDepartmentName(nextName);
            }}
          />
          {view?.cwdRules && (
            <AgentRulesSection
              title="工作区规则（只读）"
              description="来自项目本地目录（`agent-workspace/<project-name>/<taskId>/`）的 AGENTS.md / .cursor/rules（由 SDK 额外加载）。"
              value={view.cwdRules}
              mode="readonly"
            />
          )}
          <div className="settings-actions">
            <button
              type="button"
              className="settings-save"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              {saving ? "保存中…" : "保存项目设置"}
            </button>
            {dirty && !saving && (
              <span className="settings-dirty">有未保存的更改</span>
            )}
            {notice && <span className="settings-notice">{notice}</span>}
          </div>
        </div>
      )}
      {error && (
        <div className="settings-error" onClick={() => setError(null)}>
          {error} ✕
        </div>
      )}
    </div>
  );
}
