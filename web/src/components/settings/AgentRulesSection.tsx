interface Props {
  title: string;
  description?: string;
  value: string;
  mode: "edit" | "readonly" | "preview";
  onChange?: (value: string) => void;
  placeholder?: string;
}

export default function AgentRulesSection({
  title,
  description,
  value,
  mode,
  onChange,
  placeholder = "Markdown rules for the agent…",
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
          {value.trim() || "（未配置）"}
        </pre>
      ) : (
        <textarea
          className="settings-rules-input"
          value={value}
          placeholder={placeholder}
          rows={12}
          onChange={(e) => onChange?.(e.target.value)}
        />
      )}
      <div className="settings-section-meta">
        {value.length} 字符
        {mode === "preview" && (
          <span className="settings-badge">生效预览</span>
        )}
      </div>
    </section>
  );
}
