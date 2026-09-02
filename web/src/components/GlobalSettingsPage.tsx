import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { AppSettings } from "../types";
import AgentRulesSection from "./settings/AgentRulesSection";
import PlanExportSection from "./settings/PlanExportSection";

interface Props {
  onBack: () => void;
}

export default function GlobalSettingsPage({ onBack }: Props) {
  const [rules, setRules] = useState("");
  const [savedRules, setSavedRules] = useState("");
  const [exportDir, setExportDir] = useState("");
  const [savedExportDir, setSavedExportDir] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const settings = await api.getGlobalSettings();
      const text = settings.agent?.rules ?? "";
      const dir = settings.plan?.exportDir ?? "";
      setRules(text);
      setSavedRules(text);
      setExportDir(dir);
      setSavedExportDir(dir);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const patch: AppSettings = {
        agent: { rules },
        plan: { exportDir: exportDir.trim() || undefined },
      };
      await api.updateGlobalSettings(patch);
      setSavedRules(rules);
      setSavedExportDir(exportDir);
      setNotice("已保存");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const dirty = rules !== savedRules || exportDir !== savedExportDir;

  return (
    <div className="settings-page">
      <header className="settings-header">
        <button type="button" className="settings-back" onClick={onBack}>
          ← 返回
        </button>
        <h1 className="settings-title">全局设置</h1>
        <p className="settings-subtitle">
          作用于所有项目；项目级配置可覆盖全局。
        </p>
      </header>
      {loading ? (
        <div className="settings-loading">加载中…</div>
      ) : (
        <div className="settings-body">
          <AgentRulesSection
            title="Agent Rules"
            description="全局 Agent 行为约束（Markdown）。新建任务时与项目规则合并后注入 Agent。"
            value={rules}
            mode="edit"
            onChange={setRules}
          />
          <PlanExportSection
            title="Plan 导出"
            description="Plan 模式 run 成功后，自动将计划文档导出到此目录（绝对路径）。"
            value={exportDir}
            mode="edit"
            onChange={setExportDir}
          />
          <div className="settings-actions">
            <button
              type="button"
              className="settings-save"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              {saving ? "保存中…" : "保存"}
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
