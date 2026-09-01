import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { ProjectSettingsView } from "../types";
import AgentRulesSection from "./settings/AgentRulesSection";

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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getProjectSettings(projectId);
      setView(data);
      const text = data.project.agent?.rules ?? "";
      setRules(text);
      setSavedRules(text);
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
      });
      setView(data);
      setSavedRules(rules);
      setNotice("已保存");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const dirty = rules !== savedRules;
  const globalRules = view?.global.agent?.rules ?? "";
  const effectiveRules = view?.effective.agent?.rules ?? "";

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
            value={dirty ? buildPreview(globalRules, rules) : effectiveRules}
            mode="preview"
          />
          {view?.cwdRules && (
            <AgentRulesSection
              title="工作区规则（只读）"
              description="来自项目文件主目录或默认仓库的 AGENTS.md / .cursor/rules（由 SDK 额外加载）。"
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
              {saving ? "保存中…" : "保存项目规则"}
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

function buildPreview(globalRules: string, projectRules: string): string {
  const parts: string[] = [];
  const g = globalRules.trim();
  const p = projectRules.trim();
  if (g) parts.push(`# Global agent rules\n\n${g}`);
  if (p) parts.push(`# Project agent rules\n\n${p}`);
  return parts.join("\n\n---\n\n");
}
