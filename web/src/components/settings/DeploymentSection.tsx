import type { DeploymentServiceConfig } from "../../types";

export type DeploymentServiceDraft = DeploymentServiceConfig & {
  /** Local-only key so React can track rows before serviceId is filled. */
  key: string;
};

interface Props {
  services: DeploymentServiceDraft[];
  onChange: (services: DeploymentServiceDraft[]) => void;
}

function newDraft(serviceId = ""): DeploymentServiceDraft {
  return {
    key: `svc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    serviceId,
    gracefulRestart: false,
  };
}

export default function DeploymentSection({ services, onChange }: Props) {
  const updateAt = (
    index: number,
    patch: Partial<DeploymentServiceDraft>,
  ): void => {
    onChange(
      services.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    );
  };

  const removeAt = (index: number): void => {
    onChange(services.filter((_, i) => i !== index));
  };

  const addService = (serviceId = ""): void => {
    if (
      serviceId &&
      services.some(
        (s) => s.serviceId.trim().toLowerCase() === serviceId.toLowerCase(),
      )
    ) {
      return;
    }
    onChange([...services, newDraft(serviceId)]);
  };

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h2 className="settings-section-title">Deployment</h2>
        <p className="settings-section-desc">
          本项目的部署服务契约（graceful restart 用的 notify / poll URL）。仅保存在本项目设置里；
          契约的登记与启停由部署平台统一管控，app 不再写入 :4220。
        </p>
      </div>

      {services.length === 0 ? (
        <p className="settings-section-meta">尚未添加 service，点击下方添加。</p>
      ) : null}

      {services.map((svc, index) => {
        const graceful = svc.gracefulRestart === true;

        return (
          <div key={svc.key} className="deployment-service-card">
            <div className="runtime-fields">
              <label className="runtime-field runtime-field-wide">
                <span className="runtime-field-label">serviceId</span>
                <input
                  className="settings-path-input"
                  type="text"
                  placeholder="例如 web-cursor"
                  value={svc.serviceId}
                  onChange={(e) =>
                    updateAt(index, { serviceId: e.target.value })
                  }
                />
              </label>
              <label className="runtime-field">
                <span className="runtime-field-label">graceful_restart</span>
                <select
                  className="runtime-select"
                  value={graceful ? "1" : "0"}
                  onChange={(e) =>
                    updateAt(index, {
                      gracefulRestart: e.target.value === "1",
                    })
                  }
                >
                  <option value="0">不支持</option>
                  <option value="1">支持</option>
                </select>
              </label>
            </div>

            {graceful ? (
              <div className="runtime-fields deployment-url-fields">
                <label className="runtime-field runtime-field-wide">
                  <span className="runtime-field-label">重启前通知 URL</span>
                  <input
                    className="settings-path-input"
                    type="url"
                    placeholder="http://127.0.0.1:4211/api/ops/restart-notify"
                    value={svc.restartNotifyUrl ?? ""}
                    onChange={(e) =>
                      updateAt(index, { restartNotifyUrl: e.target.value })
                    }
                  />
                </label>
                <label className="runtime-field runtime-field-wide">
                  <span className="runtime-field-label">可重启轮询 URL</span>
                  <input
                    className="settings-path-input"
                    type="url"
                    placeholder="http://127.0.0.1:4211/api/ops/restart-status"
                    value={svc.restartPollUrl ?? ""}
                    onChange={(e) =>
                      updateAt(index, { restartPollUrl: e.target.value })
                    }
                  />
                </label>
              </div>
            ) : (
              <p className="settings-section-meta">
                不支持时部署可立即重启；本项目的 graceful 契约留空。
              </p>
            )}

            <div className="deployment-register-row">
              <button
                type="button"
                className="deployment-remove-btn"
                onClick={() => removeAt(index)}
              >
                删除
              </button>
            </div>
          </div>
        );
      })}

      <div className="deployment-register-row">
        <button
          type="button"
          className="deployment-add-btn"
          onClick={() => addService()}
        >
          添加 service
        </button>
      </div>

      <p className="settings-section-meta">
        「保存项目设置」写入本项目全部 service（本地记录）。
      </p>
    </section>
  );
}

export { newDraft };
