import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "../../api";
import type { ProviderAccount } from "../../types";

const DEFAULT_ROOT = "/Users/gaolei/agent-workspace";

function normalizeRoot(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.replace(/[\\/]+$/, "") || trimmed;
}

interface Draft {
  provider: "cursor" | "cline";
  vendor: string;
  label: string;
  apiKey: string;
  baseUrl: string;
  agentRootWorkspace: string;
  enabled: boolean;
  isDefault: boolean;
}

const emptyDraft = (): Draft => ({
  provider: "cursor",
  vendor: "cursor",
  label: "",
  apiKey: "",
  baseUrl: "",
  agentRootWorkspace: DEFAULT_ROOT,
  enabled: true,
  isDefault: false,
});

export default function AccountPoolSection() {
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [vendors, setVendors] = useState<{ cursor: string[]; cline: string[] }>({
    cursor: ["cursor"],
    cline: ["deepseek", "minimax"],
  });
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listAccounts();
      setAccounts(data.accounts);
      setVendors(data.vendors);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startEdit = (account: ProviderAccount): void => {
    setEditingId(account.accountId);
    setDraft({
      provider: account.provider,
      vendor: account.vendor,
      label: account.label,
      apiKey: "",
      baseUrl: account.baseUrl ?? "",
      agentRootWorkspace: account.agentRootWorkspace,
      enabled: account.enabled,
      isDefault: account.isDefault,
    });
    setNotice(null);
  };

  const cancelEdit = (): void => {
    setEditingId(null);
    setDraft(emptyDraft());
  };

  const save = async (): Promise<void> => {
    const conflict = accounts.find(
      (account) =>
        account.accountId !== editingId &&
        normalizeRoot(account.agentRootWorkspace) ===
          normalizeRoot(draft.agentRootWorkspace),
    );
    if (conflict) {
      setError(
        `工作根目录已被账号「${conflict.label}」占用。不同账号必须使用不同的工作根目录。`,
      );
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const body = {
        provider: draft.provider,
        vendor: draft.provider === "cline" ? draft.vendor : "cursor",
        label: draft.label.trim(),
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        ...(draft.baseUrl.trim() ? { baseUrl: draft.baseUrl.trim() } : {}),
        agentRootWorkspace: draft.agentRootWorkspace.trim(),
        enabled: draft.enabled,
        isDefault: draft.isDefault,
      };
      if (editingId) {
        await api.updateAccount(editingId, body);
        setNotice("账号已更新");
      } else {
        if (!body.apiKey) throw new Error("新增账号必须填写 API key");
        await api.createAccount({ ...body, apiKey: body.apiKey });
        setNotice("账号已添加");
      }
      cancelEdit();
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (account: ProviderAccount): Promise<void> => {
    if (!window.confirm(`删除账号「${account.label}」？进行中的任务会拒绝删除。`)) {
      return;
    }
    setError(null);
    try {
      await api.deleteAccount(account.accountId);
      if (editingId === account.accountId) cancelEdit();
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const verify = async (account: ProviderAccount): Promise<void> => {
    setError(null);
    setNotice(null);
    try {
      const result = await api.verifyAccount(account.accountId);
      setNotice(
        result.ok
          ? `「${account.label}」鉴权通过：${result.detail}`
          : `「${account.label}」鉴权失败：${result.detail}`,
      );
    } catch (e) {
      setError(errorText(e));
    }
  };

  const vendorOptions =
    draft.provider === "cline" ? vendors.cline : vendors.cursor;
  const previewRoot = (draft.agentRootWorkspace.trim() || DEFAULT_ROOT).replace(
    /\/$/,
    "",
  );
  const rootConflict = accounts.find(
    (account) =>
      account.accountId !== editingId &&
      normalizeRoot(account.agentRootWorkspace) ===
        normalizeRoot(draft.agentRootWorkspace),
  );
  const duplicateRoots = new Set(
    accounts
      .map((account) => normalizeRoot(account.agentRootWorkspace))
      .filter((root, _, all) => root && all.filter((item) => item === root).length > 1),
  );

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h2 className="settings-section-title">账号池</h2>
        <p className="settings-section-desc">
          一个账号 = 运行时（Cursor / Cline）+ 厂商 + 这一把 API key。Cursor
          可以同时挂多个账户；Cline 下可以同时挂多把 DeepSeek、多把 MiniMax。
          新建 agent 时选用其中一个，工作区为该账号的{" "}
          <code>agent-root-workspace/{"{agentId}"}</code>
          。每个账号的工作根目录必须互不相同。不再读取环境变量里的 key。
        </p>
      </div>
      {duplicateRoots.size > 0 ? (
        <div className="settings-section-meta account-root-warn">
          有账号共用了同一个工作根目录。请改成互不相同，否则新 agent 会写进同一棵目录。
        </div>
      ) : null}
      {loading ? (
        <div className="settings-section-meta">加载账号…</div>
      ) : accounts.length === 0 ? (
        <div className="settings-section-meta">还没有账号，先在下面添加。</div>
      ) : (
        <table className="account-table">
          <thead>
            <tr>
              <th>账号</th>
              <th>运行时 / 厂商</th>
              <th>Key</th>
              <th>工作区根</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.accountId}>
                <td>
                  {account.label}
                  {account.isDefault ? (
                    <span className="settings-badge">默认</span>
                  ) : null}
                  {!account.enabled ? (
                    <span className="settings-badge account-disabled">停用</span>
                  ) : null}
                </td>
                <td>
                  {account.provider}
                  {account.provider === "cline" ? ` / ${account.vendor}` : ""}
                </td>
                <td className="account-mono">{account.apiKeyMasked || "—"}</td>
                <td className="account-mono" title={account.agentRootWorkspace}>
                  {account.agentRootWorkspace}
                  {duplicateRoots.has(normalizeRoot(account.agentRootWorkspace)) ? (
                    <span className="settings-badge account-root-conflict">根目录冲突</span>
                  ) : null}
                </td>
                <td className="account-actions">
                  <button type="button" className="settings-back" onClick={() => startEdit(account)}>
                    编辑
                  </button>
                  <button type="button" className="settings-back" onClick={() => void verify(account)}>
                    验证
                  </button>
                  <button type="button" className="settings-back" onClick={() => void remove(account)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="account-form">
        <div className="account-form-title">
          {editingId ? "编辑账号" : "新增账号"}
        </div>
        <div className="runtime-fields">
          <label className="runtime-field">
            <span className="runtime-field-label">运行时</span>
            <select
              className="runtime-select"
              value={draft.provider}
              disabled={Boolean(editingId)}
              onChange={(e) => {
                const provider = e.target.value as "cursor" | "cline";
                setDraft((d) => ({
                  ...d,
                  provider,
                  vendor: provider === "cursor" ? "cursor" : vendors.cline[0] || "deepseek",
                }));
              }}
            >
              <option value="cursor">cursor</option>
              <option value="cline">cline</option>
            </select>
          </label>
          {draft.provider === "cline" ? (
            <label className="runtime-field">
              <span className="runtime-field-label">厂商</span>
              <select
                className="runtime-select"
                value={draft.vendor}
                onChange={(e) => setDraft((d) => ({ ...d, vendor: e.target.value }))}
              >
                {vendorOptions.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <label className="runtime-field runtime-field-wide">
          <span className="runtime-field-label">名称</span>
          <input
            className="settings-path-input"
            value={draft.label}
            placeholder={draft.provider === "cline" ? "例如 公司 DeepSeek A" : "例如 个人 Cursor"}
            onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
          />
        </label>
        <label className="runtime-field runtime-field-wide">
          <span className="runtime-field-label">
            API key{editingId ? "（留空则不改）" : ""}
          </span>
          <input
            className="settings-path-input"
            type="password"
            autoComplete="off"
            value={draft.apiKey}
            placeholder={editingId ? "•••• 不修改" : "粘贴 API key"}
            onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
          />
        </label>
        {draft.provider === "cline" ? (
          <label className="runtime-field runtime-field-wide">
            <span className="runtime-field-label">Base URL（可选）</span>
            <input
              className="settings-path-input"
              value={draft.baseUrl}
              placeholder="OpenAI-compatible 才需要"
              onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
            />
          </label>
        ) : null}
        <label className="runtime-field runtime-field-wide">
          <span className="runtime-field-label">agent-root-workspace</span>
          <input
            className="settings-path-input"
            value={draft.agentRootWorkspace}
            placeholder={DEFAULT_ROOT}
            onChange={(e) =>
              setDraft((d) => ({ ...d, agentRootWorkspace: e.target.value }))
            }
          />
          <span className="intent-hint">
            新建 agent 的工作区是 <code>{previewRoot}/{"{agentId}"}</code>
            {rootConflict
              ? `。与账号「${rootConflict.label}」相同，不能保存。`
              : "。不可与其它账号相同。"}
          </span>
        </label>
        <div className="account-checks">
          <label>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
            />{" "}
            启用
          </label>
          <label>
            <input
              type="checkbox"
              checked={draft.isDefault}
              onChange={(e) => setDraft((d) => ({ ...d, isDefault: e.target.checked }))}
            />{" "}
            设为该厂商默认
          </label>
        </div>
        <div className="settings-actions">
          <button
            type="button"
            className="settings-save"
            disabled={saving || !draft.label.trim() || Boolean(rootConflict)}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : editingId ? "保存修改" : "添加账号"}
          </button>
          {editingId ? (
            <button type="button" className="settings-back" onClick={cancelEdit}>
              取消编辑
            </button>
          ) : null}
          {notice ? <span className="settings-notice">{notice}</span> : null}
        </div>
      </div>
      {error ? (
        <div className="settings-error" onClick={() => setError(null)}>
          {error} ✕
        </div>
      ) : null}
    </section>
  );
}
