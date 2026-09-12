interface Props {
  gracefulRestart: boolean;
  restartNotifyUrl: string;
  restartPollUrl: string;
  onGracefulRestartChange: (supported: boolean) => void;
  onNotifyUrlChange: (value: string) => void;
  onPollUrlChange: (value: string) => void;
}

export default function DeploymentSection({
  gracefulRestart,
  restartNotifyUrl,
  restartPollUrl,
  onGracefulRestartChange,
  onNotifyUrlChange,
  onPollUrlChange,
}: Props) {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h2 className="settings-section-title">Deployment</h2>
        <p className="settings-section-desc">
          配置本项目运行时是否支持 graceful restart，以及部署侧通知 / 轮询地址。
        </p>
      </div>

      <div className="runtime-fields">
        <label className="runtime-field">
          <span className="runtime-field-label">graceful_restart</span>
          <select
            className="runtime-select"
            value={gracefulRestart ? "1" : "0"}
            onChange={(e) => onGracefulRestartChange(e.target.value === "1")}
          >
            <option value="0">不支持</option>
            <option value="1">支持</option>
          </select>
        </label>
      </div>

      {gracefulRestart ? (
        <div className="runtime-fields deployment-url-fields">
          <label className="runtime-field runtime-field-wide">
            <span className="runtime-field-label">重启前通知 URL</span>
            <input
              className="settings-path-input"
              type="url"
              placeholder="http://127.0.0.1:4211/api/ops/restart-notify"
              value={restartNotifyUrl}
              onChange={(e) => onNotifyUrlChange(e.target.value)}
            />
          </label>
          <label className="runtime-field runtime-field-wide">
            <span className="runtime-field-label">可重启轮询 URL</span>
            <input
              className="settings-path-input"
              type="url"
              placeholder="http://127.0.0.1:4211/api/ops/restart-status"
              value={restartPollUrl}
              onChange={(e) => onPollUrlChange(e.target.value)}
            />
          </label>
          <p className="settings-section-meta">
            支持时两项均必填，且须为 http(s) 地址。部署方在重启前调用通知
            URL，并轮询可重启 URL 直至允许重启。
          </p>
        </div>
      ) : (
        <p className="settings-section-meta">
          不支持时部署可立即重启，无需等待 drain。
        </p>
      )}
    </section>
  );
}
