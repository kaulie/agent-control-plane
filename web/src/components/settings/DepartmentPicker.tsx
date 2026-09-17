import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type { DepartmentInfo, DepartmentList } from "../../types";

export interface DepartmentSelection {
  departmentId: string;
  departmentName: string;
}

interface Props {
  /** Currently selected department (empty = 未设置). */
  departmentId: string;
  /** Name snapshot of the current selection (used when the row is gone). */
  departmentName: string;
  onChange: (next: DepartmentSelection) => void;
  /** Optional paragraph rendered under the status line. */
  hint?: string;
}

export function departmentLabel(item: DepartmentInfo): string {
  return item.type ? `${item.name}（${item.type}）` : item.name;
}

/**
 * 部门选择器：选项来自 organization 服务（`GET /api/org/departments`）。
 * 组织服务不可达时不报错、不清空已存值，只提示并允许重试。
 * 项目设置页与「新建项目」弹框共用这一个控件。
 */
export default function DepartmentPicker({
  departmentId,
  departmentName,
  onChange,
  hint,
}: Props) {
  const [list, setList] = useState<DepartmentList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      setList(await api.listDepartments({ refresh }));
    } catch (e) {
      setError(String(e));
      setList(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const items = list?.items ?? [];
  const current = items.find((d) => d.id === departmentId);
  // Keep a stored department that the catalogue no longer lists (renamed or
  // deleted on the organization side) so saving does not silently drop it.
  const orphan =
    departmentId && !current
      ? { id: departmentId, name: departmentName || departmentId }
      : null;
  const unavailable = list !== null && !list.available;

  return (
    <>
      <label className="runtime-field runtime-field-wide">
        <span className="runtime-field-label">部门</span>
        <select
          className="runtime-select"
          value={departmentId}
          disabled={loading}
          onChange={(e) => {
            const id = e.target.value;
            const picked = items.find((d) => d.id === id);
            onChange({
              departmentId: id,
              departmentName:
                picked?.name ?? (id === departmentId ? departmentName : ""),
            });
          }}
        >
          <option value="">（未设置）</option>
          {items.map((d) => (
            <option key={d.id} value={d.id}>
              {departmentLabel(d)}
            </option>
          ))}
          {orphan && (
            <option value={orphan.id}>
              {orphan.name}（已不在组织服务列表中）
            </option>
          )}
        </select>
      </label>
      <div className="settings-section-meta">
        {loading ? (
          <span>正在读取部门列表…</span>
        ) : error && !list ? (
          <>
            <span>读取部门列表失败：{error}</span>
            <button
              type="button"
              className="settings-back"
              onClick={() => void load(true)}
            >
              重试
            </button>
          </>
        ) : unavailable ? (
          <>
            <span>
              组织服务不可达{list?.error ? `（${list.error}）` : ""}
              ；可以留空，稍后在项目设置里再选。
            </span>
            <button
              type="button"
              className="settings-back"
              onClick={() => void load(true)}
            >
              重新加载
            </button>
          </>
        ) : (
          <>
            <span>
              共 {items.length} 个部门
              {list?.source ? ` · 来源 ${list.source}` : ""}
              {list?.types?.length ? ` · 类型：${list.types.join(" / ")}` : ""}
            </span>
            <button
              type="button"
              className="settings-back"
              onClick={() => void load(true)}
            >
              刷新
            </button>
          </>
        )}
      </div>
      {hint && <p className="modal-hint">{hint}</p>}
    </>
  );
}
