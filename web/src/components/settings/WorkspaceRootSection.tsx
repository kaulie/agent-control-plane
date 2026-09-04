interface Props {
  title: string;
  description?: string;
  value: string;
  defaultRoot: string;
  onChange: (value: string) => void;
}

export default function WorkspaceRootSection({
  title,
  description,
  value,
  defaultRoot,
  onChange,
}: Props) {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h2 className="settings-section-title">{title}</h2>
        {description && (
          <p className="settings-section-desc">{description}</p>
        )}
      </div>
      <input
        type="text"
        className="settings-path-input"
        value={value}
        placeholder={defaultRoot}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="settings-section-meta">
        Agent 初始目录为{" "}
        <code>
          {(value.trim() || defaultRoot).replace(/\/$/, "")}
          /{"{project_name}"}/{"{task_id}"}
        </code>
        ；留空则使用默认 {defaultRoot}
      </div>
    </section>
  );
}
