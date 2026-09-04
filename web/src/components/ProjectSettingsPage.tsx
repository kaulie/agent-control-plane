import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { ProjectSettingsView } from "../types";
import AgentRulesSection from "./settings/AgentRulesSection";
import PlanExportSection from "./settings/PlanExportSection";
import RuntimeDefaultsSection from "./settings/RuntimeDefaultsSection";

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
  const [rules, setRules] = useState("");
  const [savedRules, setSavedRules] = useState("");
  const [exportDir, setExportDir] = useState("");
  const [savedExportDir, setSavedExportDir] = useState("");
  const [defaultProvider, setDefaultProvider] = useState("");
  const [savedDefaultProvider, setSavedDefaultProvider] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [savedDefaultModel, setSavedDefaultModel] = useState("");
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
      setRules(data.project.agent?.rules ?? "");
      setSavedRules(data.project.agent?.rules ?? "");
      setExportDir(data.project.plan?.exportDir ?? "");
      setSavedExportDir(data.project.plan?.exportDir ?? "");
      setDefaultProvider(data.project.runtime?.defaultProvider ?? "");
      setSavedDefaultProvider(data.project.runtime?.defaultProvider ?? "");
      setDefaultModel(data.project.runtime?.defaultModel ?? "");
      setSavedDefaultModel(data.project.runtime?.defaultModel ?? "");
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
        agent: { rules },
        plan: { exportDir: exportDir.trim() || undefined },
        runtime: {
          defaultProvider: defaultProvider.trim(),
          defaultModel: defaultModel.trim(),
        },
      });
      setView(data);
      setSavedRules(rules);
      setSavedExportDir(exportDir);
      setSavedDefaultProvider(defaultProvider);
      setSavedDefaultModel(defaultModel);
      setNotice("已保存");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    rules !== savedRules ||
    exportDir !== savedExportDir ||
    defaultProvider !== savedDefaultProvider ||
    defaultModel !== savedDefaultModel;
  const globalRules = view?.global.agent?.rules ?? "";
  const effectiveRules = view?.effective.agent?.rules ?? "";
  const globalExportDir = view?.global.plan?.exportDir ?? "";
  const effectiveExportDir = view?.effective.plan?.exportDir ?? "";

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
          <AgentRulesSection
            title="全局 Agent Rules（只读）"
            description="继承自全局设置，在本项目中作为基础规则。"
            value={globalRules}
            mode="readonly"
          />
          <AgentRulesSection
            title="项目 Agent Rules"
            description="仅作用于当前项目；与全局规则合并后生效（项目段落在后，优先级更高）。"
            value={rules}
            mode="edit"
            onChange={setRules}
          />
          <AgentRulesSection
            title="生效预览"
            description="合并后的规则（全局 + 项目）。"
            value={dirty ? buildRulesPreview(globalRules, rules) : effectiveRules}
            mode="preview"
          />
          <PlanExportSection
            title="全局 Plan 导出目录（只读）"
            description="继承自全局设置；项目未配置时使用。"
            value={globalExportDir}
            mode="readonly"
          />
          <PlanExportSection
            title="项目 Plan 导出目录"
            description="留空则使用全局目录；填写则覆盖全局。"
            value={exportDir}
            mode="edit"
            onChange={setExportDir}
          />
          <PlanExportSection
            title="生效导出目录"
            description="实际用于 Plan 文档导出的目录。"
            value={
              exportDir !== savedExportDir
                ? exportDir.trim() || globalExportDir
                : effectiveExportDir
            }
            mode="preview"
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

function buildRulesPreview(globalRules: string, projectRules: string): string {
  const parts: string[] = [];
  const g = globalRules.trim();
  const p = projectRules.trim();
  if (g) parts.push(`# Global agent rules\n\n${g}`);
  if (p) parts.push(`# Project agent rules\n\n${p}`);
  return parts.join("\n\n---\n\n");
}
