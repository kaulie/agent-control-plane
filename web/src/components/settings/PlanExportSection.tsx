interface Props {
  title: string;
  description?: string;
  value: string;
  mode: "edit" | "readonly" | "preview";
  onChange?: (value: string) => void;
  placeholder?: string;
}

export default function PlanExportSection({
  title,
  description,
  value,
  mode,
  onChange,
  placeholder = "/absolute/path/to/plans",
}: Props) {
  const readOnly = mode !== "edit";

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h2 className="settings-section-title">{title}</h2>
        {description && (
          <p className="settings-section-desc">{description}</p>
        )}
      </div>
      {readOnly ? (
        <pre className={`settings-rules-block settings-rules-${mode}`}>
          {value.trim() || "（未配置，不导出）"}
        </pre>
      ) : (
        <input
          type="text"
          className="settings-path-input"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange?.(e.target.value)}
        />
      )}
      <div className="settings-section-meta">
        Plan 模式 run 成功后自动写入 Markdown；留空表示不导出
      </div>
    </section>
  );
}
