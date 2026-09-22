import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "../api";
import type { AppSettings } from "../types";
import AccountPoolSection from "./settings/AccountPoolSection";
import WorkspaceRootSection from "./settings/WorkspaceRootSection";

const DEFAULT_WORKSPACE_ROOT = "/Users/gaolei/agent-workspace";

interface Props {
  onBack: () => void;
}

export default function GlobalSettingsPage({ onBack }: Props) {
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [savedWorkspaceRoot, setSavedWorkspaceRoot] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const settings = await api.getGlobalSettings();
      const root = settings.workspace?.root ?? "";
      setWorkspaceRoot(root);
      setSavedWorkspaceRoot(root);
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
        workspace: { root: workspaceRoot.trim() || undefined },
      };
      await api.updateGlobalSettings(patch);
      setSavedWorkspaceRoot(workspaceRoot);
      setNotice("已保存");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const dirty = workspaceRoot !== savedWorkspaceRoot;

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
          <AccountPoolSection />
          <WorkspaceRootSection
            title="WorkspaceRoot（兜底）"
            description="只在账号池为空时，本机 agent 才回落到这个根目录。有账号后，新 agent 用该账号自己的 agent-root-workspace/{agentId}。"
            value={workspaceRoot}
            defaultRoot={DEFAULT_WORKSPACE_ROOT}
            onChange={setWorkspaceRoot}
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
