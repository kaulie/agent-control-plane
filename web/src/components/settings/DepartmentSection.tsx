import DepartmentPicker from "./DepartmentPicker";

interface Props {
  /** Currently selected department (empty = 未设置). */
  departmentId: string;
  /** Name snapshot of the current selection (used when the row is gone). */
  departmentName: string;
  onChange: (next: { departmentId: string; departmentName: string }) => void;
}

/**
 * 项目「所属部门」设置区块：选择器本身见 `DepartmentPicker`
 * （「新建项目」弹框复用同一个控件）。
 */
export default function DepartmentSection({
  departmentId,
  departmentName,
  onChange,
}: Props) {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h2 className="settings-section-title">所属部门</h2>
        <p className="settings-section-desc">
          部门的可选值来自 organization 服务（
          <code>/api/v1/departments</code>）。只保存 部门 ID 与名称快照，不影响
          task 运行。
        </p>
      </div>
      <div className="runtime-fields">
        <DepartmentPicker
          departmentId={departmentId}
          departmentName={departmentName}
          onChange={onChange}
          hint={
            departmentId
              ? undefined
              : "该项目还没有部门（新建项目时部门必填）；可以在这里补上。"
          }
        />
      </div>
    </section>
  );
}
