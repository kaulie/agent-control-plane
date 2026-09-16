/**
 * Client for the **independent deployment service** (HTTP API + SQLite contracts).
 *
 * This app never initiates a deploy. Deploys / pipelines are always triggered
 * from the deployment platform itself (its UI, or `POST {apiUrl}/api/deploys` /
 * `POST {apiUrl}/api/deploy-notify`). The gateway only talks to the platform for
 * the *service contract* side, so the platform can restart this service
 * gracefully:
 *   - register/update the graceful-restart notify/poll URLs of a service
 *   - list registered services (settings UI)
 */
export interface DeploymentApiOptions {
  /** Base URL of the deployment service, e.g. http://127.0.0.1:4220 */
  apiUrl: string;
  /** Default service contract id registered in deployment SQLite. */
  defaultServiceId?: string;
  /** Graceful-restart max wait advertised to the platform (ms). */
  maxWaitMs?: number;
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export class DeploymentApiClient {
  readonly apiUrl: string;
  readonly defaultServiceId: string;
  readonly maxWaitMs: number;

  constructor(options: DeploymentApiOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
    this.defaultServiceId = options.defaultServiceId?.trim() || "web-cursor";
    this.maxWaitMs = Math.max(0, options.maxWaitMs ?? 5 * 60 * 1000);
  }

  /**
   * Update graceful-restart URLs on an existing deployment-service contract.
   * Requires the service to already be registered (runtimeDir / cmds present).
   */
  async registerServiceGraceful(input: {
    serviceId: string;
    gracefulRestart: boolean;
    restartNotifyUrl?: string;
    restartPollUrl?: string;
    gracefulRestartMaxWaitMs?: number;
  }): Promise<Record<string, unknown>> {
    const serviceId = input.serviceId.trim();
    if (!serviceId) throw new Error("serviceId is required");

    const getRes = await fetch(
      `${this.apiUrl}/api/services/${encodeURIComponent(serviceId)}`,
    );
    if (getRes.status === 404) {
      throw new Error(
        `部署服务中未找到 service「${serviceId}」，请先在 deployment 注册基础契约`,
      );
    }
    const existing = await j<Record<string, unknown>>(getRes);

    let restartNotifyUrl = "";
    let restartPollUrl = "";
    let gracefulRestartMaxWaitMs: number | undefined;
    if (input.gracefulRestart) {
      restartNotifyUrl = input.restartNotifyUrl?.trim() || "";
      restartPollUrl = input.restartPollUrl?.trim() || "";
      if (!restartNotifyUrl || !restartPollUrl) {
        throw new Error("支持 graceful restart 时必须提供 notify / poll URL");
      }
      gracefulRestartMaxWaitMs =
        input.gracefulRestartMaxWaitMs ?? this.maxWaitMs;
    }

    const body: Record<string, unknown> = {
      name: existing.name,
      runtimeDir: existing.runtimeDir,
      healthUrl: existing.healthUrl,
      startCmd: existing.startCmd,
      stopCmd: existing.stopCmd,
      restartCmd: existing.restartCmd,
      restartNotifyUrl,
      restartPollUrl,
    };
    if (gracefulRestartMaxWaitMs != null) {
      body.gracefulRestartMaxWaitMs = gracefulRestartMaxWaitMs;
    } else {
      body.gracefulRestartMaxWaitMs = 0;
    }

    const putRes = await fetch(
      `${this.apiUrl}/api/services/${encodeURIComponent(serviceId)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return j<Record<string, unknown>>(putRes);
  }

  /** List service contracts from the deployment API. */
  async listServices(): Promise<Array<Record<string, unknown>>> {
    const res = await fetch(`${this.apiUrl}/api/services`);
    const body = await j<{ services?: Array<Record<string, unknown>> }>(res);
    return body.services ?? [];
  }
}
