import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type { DepartmentInfo, DepartmentList } from "../../types";

interface Props {
  /** Currently selected department (empty = 未设置). */
  departmentId: string;
  /** Name snapshot of the current selection (used when the row is gone). */
  departmentName: string;
  onChange: (next: { departmentId: string; departmentName: string }) => void;
}

function optionLabel(item: DepartmentInfo): string {
  return item.type ? `${item.name}（${item.type}）` : item.name;
}

/**
 * 项目「所属部门」：选项来自 organization 服务（`GET /api/org/departments`）。
 * 组织服务不可达时不报错、不清空已存值，只提示并允许重试。
 */
export default function DepartmentSection({
  departmentId,
  departmentName,
  onChange,
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
    <section className="settings-section">
      <div className="settings-section-head">
        <h2 className="settings-section-title">所属部门</h2>
        <p className="settings-section-desc">
          部门的可选值来自 organization 服务（
          <code>{list?.source || "http://127.0.0.1:4244"}</code> 的{" "}
          <code>/api/v1/departments</code>）。只保存 部门 ID 与名称快照，不影响
          task 运行。
        </p>
      </div>
      <div className="runtime-fields">
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
                departmentName: picked?.name ?? (id === departmentId ? departmentName : ""),
              });
            }}
          >
            <option value="">（未设置）</option>
            {items.map((d) => (
              <option key={d.id} value={d.id}>
                {optionLabel(d)}
              </option>
            ))}
            {orphan && (
              <option value={orphan.id}>
                {orphan.name}（已不在组织服务列表中）
              </option>
            )}
          </select>
        </label>
      </div>
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
              ；已保存的部门不会被清空。
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
    </section>
  );
}
