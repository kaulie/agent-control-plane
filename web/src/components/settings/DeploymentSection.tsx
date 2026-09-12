import type { DeploymentServiceConfig } from "../../types";

export type DeploymentServiceDraft = DeploymentServiceConfig & {
  /** Local-only key so React can track rows before serviceId is filled. */
  key: string;
};

interface KnownService {
  serviceId: string;
  name?: string;
}

interface Props {
  services: DeploymentServiceDraft[];
  knownServices: KnownService[];
  registeringServiceId: string | null;
  registerNotice: string | null;
  onChange: (services: DeploymentServiceDraft[]) => void;
  onRegister: (service: DeploymentServiceDraft) => void;
}

function newDraft(serviceId = ""): DeploymentServiceDraft {
  return {
    key: `svc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    serviceId,
    gracefulRestart: false,
  };
}

export default function DeploymentSection({
  services,
  knownServices,
  registeringServiceId,
  registerNotice,
  onChange,
  onRegister,
}: Props) {
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
          一个项目可绑定多个部署服务契约；每条独立配置 graceful restart，并分别注册到
          deployment。
        </p>
      </div>

      {services.length === 0 ? (
        <p className="settings-section-meta">尚未添加 service，点击下方添加。</p>
      ) : null}

      {services.map((svc, index) => {
        const graceful = svc.gracefulRestart === true;
        const registering = registeringServiceId === svc.serviceId.trim();
        const registerDisabled =
          registering ||
          !svc.serviceId.trim() ||
          (graceful &&
            (!svc.restartNotifyUrl?.trim() || !svc.restartPollUrl?.trim()));

        return (
          <div key={svc.key} className="deployment-service-card">
            <div className="runtime-fields">
              <label className="runtime-field runtime-field-wide">
                <span className="runtime-field-label">serviceId</span>
                <input
                  className="settings-path-input"
                  type="text"
                  placeholder="例如 web-cursor"
                  list="deployment-known-services"
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
                不支持时部署可立即重启；注册会清空该 service 的 notify / poll。
              </p>
            )}

            <div className="deployment-register-row">
              <button
                type="button"
                className="settings-save deployment-register-btn"
                disabled={registerDisabled}
                onClick={() => onRegister(svc)}
              >
                {registering ? "注册中…" : "注册到 deployment"}
              </button>
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

      <datalist id="deployment-known-services">
        {knownServices.map((s) => (
          <option key={s.serviceId} value={s.serviceId}>
            {s.name ? `${s.serviceId} · ${s.name}` : s.serviceId}
          </option>
        ))}
      </datalist>

      <div className="deployment-register-row">
        <button
          type="button"
          className="deployment-add-btn"
          onClick={() => addService()}
        >
          添加 service
        </button>
        {knownServices
          .filter(
            (k) =>
              !services.some(
                (s) =>
                  s.serviceId.trim().toLowerCase() ===
                  k.serviceId.toLowerCase(),
              ),
          )
          .slice(0, 6)
          .map((k) => (
            <button
              key={k.serviceId}
              type="button"
              className="deployment-add-btn deployment-add-known"
              onClick={() => addService(k.serviceId)}
            >
              + {k.serviceId}
            </button>
          ))}
      </div>

      {registerNotice ? (
        <p className="settings-notice">{registerNotice}</p>
      ) : (
        <p className="settings-section-meta">
          「保存项目设置」写入全部 service；「注册到 deployment」同步单条契约到
          :4220。
        </p>
      )}
    </section>
  );
}

export { newDraft };
