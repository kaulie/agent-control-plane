import { useEffect, useState } from "react";
import { errorText } from "../api";
import type { DepartmentConfig } from "../types";
import DepartmentPicker from "./settings/DepartmentPicker";

export type ProjectDialogMode = "create" | "rename" | "gitRepoUrl";

export interface ProjectDialogResult {
  /** Only meaningful for `create` / `rename`. */
  name: string;
  /** `null` = 清除已配置的 Git 地址. */
  gitRepoUrl: string | null;
  /** Empty id + empty name = 未设置（创建时会被忽略）. */
  department: DepartmentConfig;
}

interface Props {
  open: boolean;
  mode: ProjectDialogMode;
  /** Prefill (rename / git url). */
  initialName?: string;
  initialGitRepoUrl?: string;
  onClose: () => void;
  onSubmit: (input: ProjectDialogResult) => Promise<void>;
}

const TITLES: Record<ProjectDialogMode, string> = {
  create: "新建项目",
  rename: "重命名项目",
  gitRepoUrl: "项目 Git 仓库地址",
};

/**
 * 居中弹框（`.modal-backdrop` + `.modal-dialog`）取代原来的浏览器原生
 * `window.prompt`：原生弹框贴在窗口顶部，且无法承载「所属部门」这类字段。
 */
export default function ProjectDialog({
  open,
  mode,
  initialName,
  initialGitRepoUrl,
  onClose,
  onSubmit,
}: Props) {
  const [name, setName] = useState("");
  const [gitRepoUrl, setGitRepoUrl] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [departmentName, setDepartmentName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(initialName ?? "");
    setGitRepoUrl(initialGitRepoUrl ?? "");
    // 部门只在「新建」时选择，之后在项目设置里维护。
    setDepartmentId("");
    setDepartmentName("");
    setError(null);
  }, [open, mode, initialName, initialGitRepoUrl]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const showName = mode === "create" || mode === "rename";
  const showGit = mode === "create" || mode === "gitRepoUrl";
  /** 新建项目时部门必填：没选就不给点「创建」。 */
  const missingDepartment = mode === "create" && !departmentId.trim();

  const submit = async (): Promise<void> => {
    const trimmedName = name.trim();
    if (showName && !trimmedName) {
      setError("项目名称不能为空");
      return;
    }
    if (missingDepartment) {
      setError("请选择所属部门（必填）");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        name: trimmedName,
        gitRepoUrl: gitRepoUrl.trim() || null,
        department: {
          ...(departmentId.trim() ? { departmentId: departmentId.trim() } : {}),
          ...(departmentName.trim()
            ? { departmentName: departmentName.trim() }
            : {}),
        },
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
      <form
        className="modal-dialog"
        role="dialog"
        aria-labelledby="project-dialog-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 id="project-dialog-title" className="modal-title">
          {TITLES[mode]}
        </h2>
        {showName && (
          <label className="runtime-field">
            <span className="runtime-field-label">名称</span>
            <input
              className="settings-path-input"
              value={name}
              placeholder="例如 web-cursor"
              autoFocus
              onFocus={(e) => e.target.select()}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        {showGit && (
          <label className="runtime-field">
            <span className="runtime-field-label">
              {mode === "create" ? "Git 仓库地址（可选）" : "Git 仓库地址"}
            </span>
            <input
              className="settings-path-input"
              value={gitRepoUrl}
              placeholder="https://github.com/owner/repo.git"
              autoFocus={mode === "gitRepoUrl"}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setGitRepoUrl(e.target.value)}
            />
          </label>
        )}
        {showGit && (
          <p className="modal-hint">
            这里只是项目元数据（列表 / 设置页展示）；<b>agent 的仓库地址不再取这个值</b>：
            由项目「所属部门」（组织）去<b>服务中心</b>查该组织下登记的服务与仓库地址后注入。
          </p>
        )}
        {mode === "gitRepoUrl" ? (
          <p className="modal-hint">
            支持 https / ssh / 本地路径。留空保存 = 清除登记值。
          </p>
        ) : null}
        {mode === "create" && (
          <div className="modal-field-stack">
            <DepartmentPicker
              required
              departmentId={departmentId}
              departmentName={departmentName}
              onChange={({ departmentId: id, departmentName: nm }) => {
                setDepartmentId(id);
                setDepartmentName(nm);
              }}
              hint={
                missingDepartment
                  ? "部门为必填项：选中后「创建」才会可用。"
                  : "创建后可在「项目设置 → 所属部门」里修改。"
              }
            />
          </div>
        )}
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="modal-cancel" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="settings-save"
            disabled={saving || missingDepartment}
          >
            {saving ? "保存中…" : mode === "create" ? "创建" : "保存"}
          </button>
        </div>
      </form>
    </div>
  );
}
