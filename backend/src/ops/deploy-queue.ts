/**
 * Client for the independent deployment HTTP service.
 * Graceful hold/wait still lives in this process; enqueue talks to
 * POST {deploymentApiUrl}/api/deploys (no local deploy-requests files).
 */
import { randomUUID } from "node:crypto";

export type DeployRequestState =
  | "waiting_for_idle"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface DeployRequest {
  requestId: string;
  deployment: string;
  requestedAt: string;
  taskId?: string;
  serviceId: string;
}

export interface DeployStatus {
  requestId: string;
  state: DeployRequestState;
  deployment?: string;
  serviceId?: string;
  version?: string;
  error?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  requestedAt?: string;
  runningCount?: number;
  queuedCount?: number;
  waitUntil?: string;
  maxWaitMs?: number;
  releasedByTimeout?: boolean;
}

export interface DeployQueueOptions {
  /** Base URL of deployment service, e.g. http://127.0.0.1:4220 */
  apiUrl: string;
  /** Default service contract id registered in deployment SQLite. */
  defaultServiceId?: string;
  maxWaitMs?: number;
  onWaitTimeoutRelease?: (status: DeployStatus) => void;
}

export function normalizeDeploymentTag(raw: string): string {
  const s = raw.trim();
  if (!s) throw new Error("deployment is required");
  if (s.startsWith("deployment-")) return s;
  return `deployment-${s.replace(/^deployment-/, "")}`;
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

export class DeployQueue {
  readonly apiUrl: string;
  readonly defaultServiceId: string;
  readonly maxWaitMs: number;
  private onWaitTimeoutRelease?: (status: DeployStatus) => void;
  private held: DeployRequest | null = null;
  private heldWaitUntil: string | null = null;
  private waitTimer: NodeJS.Timeout | undefined;
  /** Last known remote status for held requestId after release. */
  private lastStatus = new Map<string, DeployStatus>();

  constructor(options: DeployQueueOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
    this.defaultServiceId = options.defaultServiceId?.trim() || "web-cursor";
    this.maxWaitMs = Math.max(0, options.maxWaitMs ?? 5 * 60 * 1000);
    this.onWaitTimeoutRelease = options.onWaitTimeoutRelease;
  }

  setOnWaitTimeoutRelease(cb: ((status: DeployStatus) => void) | undefined): void {
    this.onWaitTimeoutRelease = cb;
  }

  getHeld(): DeployRequest | null {
    return this.held ? { ...this.held } : null;
  }

  getHeldWaitUntil(): string | null {
    return this.heldWaitUntil;
  }

  hold(input: {
    deployment: string;
    taskId?: string;
    requestId?: string;
    serviceId?: string;
    runningCount: number;
    queuedCount: number;
  }): DeployStatus {
    if (this.held) {
      throw new Error(
        `deploy already waiting for idle: ${this.held.requestId} (${this.held.deployment})`,
      );
    }
    const deployment = normalizeDeploymentTag(input.deployment);
    const requestId =
      input.requestId?.trim() || `deploy-req-${randomUUID().slice(0, 8)}`;
    const requestedAt = new Date().toISOString();
    const serviceId = input.serviceId?.trim() || this.defaultServiceId;
    const req: DeployRequest = {
      requestId,
      deployment,
      requestedAt,
      serviceId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
    };
    this.held = req;

    let waitUntil: string | undefined;
    if (this.maxWaitMs > 0) {
      waitUntil = new Date(Date.now() + this.maxWaitMs).toISOString();
      this.heldWaitUntil = waitUntil;
      this.clearWaitTimer();
      this.waitTimer = setTimeout(() => void this.onWaitTimeout(), this.maxWaitMs);
      this.waitTimer.unref?.();
    } else {
      this.heldWaitUntil = null;
    }

    const waitHint =
      this.maxWaitMs > 0
        ? `最长等待 ${Math.round(this.maxWaitMs / 1000)}s，超时后将强制放行部署。`
        : "将一直等待至空闲（未设置超时）。";
    const status: DeployStatus = {
      requestId,
      state: "waiting_for_idle",
      deployment,
      serviceId,
      requestedAt,
      runningCount: input.runningCount,
      queuedCount: input.queuedCount,
      maxWaitMs: this.maxWaitMs,
      ...(waitUntil ? { waitUntil } : {}),
      message:
        `当前有 agent 正在运行；已暂停新排队任务的启动。请稍后轮询 GET /api/ops/restart-status。${waitHint}`,
    };
    this.lastStatus.set(requestId, status);
    return status;
  }

  async releaseHeld(opts?: {
    releasedByTimeout?: boolean;
  }): Promise<DeployStatus | null> {
    const held = this.held;
    if (!held) return null;
    this.clearWaitTimer();
    this.held = null;
    this.heldWaitUntil = null;
    const status = await this.enqueue({
      deployment: held.deployment,
      requestId: held.requestId,
      serviceId: held.serviceId,
      ...(held.taskId ? { taskId: held.taskId } : {}),
    });
    if (opts?.releasedByTimeout) {
      const timed: DeployStatus = {
        ...status,
        releasedByTimeout: true,
        message:
          "graceful wait timed out; deploy forced while agents may still be running",
      };
      this.lastStatus.set(timed.requestId, timed);
      return timed;
    }
    return status;
  }

  cancelHeld(): DeployStatus | null {
    const held = this.held;
    if (!held) return null;
    this.clearWaitTimer();
    this.held = null;
    this.heldWaitUntil = null;
    const status: DeployStatus = {
      requestId: held.requestId,
      state: "cancelled",
      deployment: held.deployment,
      serviceId: held.serviceId,
      requestedAt: held.requestedAt,
      finishedAt: new Date().toISOString(),
      message: "held deploy cancelled; queue admission resumed",
    };
    this.lastStatus.set(status.requestId, status);
    return status;
  }

  async enqueue(input: {
    deployment: string;
    taskId?: string;
    requestId?: string;
    serviceId?: string;
  }): Promise<DeployStatus> {
    const deployment = normalizeDeploymentTag(input.deployment);
    const serviceId = input.serviceId?.trim() || this.defaultServiceId;
    const requestId =
      input.requestId?.trim() || `deploy-req-${randomUUID().slice(0, 8)}`;
    if (this.held?.requestId === requestId) {
      this.clearWaitTimer();
      this.held = null;
      this.heldWaitUntil = null;
    }

    const res = await fetch(`${this.apiUrl}/api/deploys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serviceId,
        deployment,
        requestId,
      }),
    });
    const remote = await j<{
      requestId: string;
      state: string;
      deployment: string;
      serviceId: string;
      requestedAt: string;
      message?: string;
    }>(res);

    const status: DeployStatus = {
      requestId: remote.requestId,
      state: (remote.state as DeployRequestState) || "queued",
      deployment: remote.deployment,
      serviceId: remote.serviceId,
      requestedAt: remote.requestedAt,
      message:
        remote.message ||
        `deploy accepted by ${this.apiUrl}; poll GET /api/ops/deploy/${remote.requestId}`,
    };
    this.lastStatus.set(status.requestId, status);
    return status;
  }

  async getStatus(requestId: string): Promise<DeployStatus | undefined> {
    const id = requestId.trim();
    if (!id) return undefined;
    if (this.held?.requestId === id) {
      const remainingMs = this.heldWaitUntil
        ? Math.max(0, Date.parse(this.heldWaitUntil) - Date.now())
        : undefined;
      return {
        requestId: this.held.requestId,
        state: "waiting_for_idle",
        deployment: this.held.deployment,
        serviceId: this.held.serviceId,
        requestedAt: this.held.requestedAt,
        maxWaitMs: this.maxWaitMs,
        ...(this.heldWaitUntil ? { waitUntil: this.heldWaitUntil } : {}),
        message:
          remainingMs != null
            ? `当前有 agent 正在运行；已暂停排队启动。剩余等待约 ${Math.ceil(remainingMs / 1000)}s。`
            : "当前有 agent 正在运行；已暂停新排队任务的启动。",
      };
    }
    try {
      const res = await fetch(`${this.apiUrl}/api/deploys/${encodeURIComponent(id)}`);
      if (res.status === 404) return this.lastStatus.get(id);
      const remote = await j<{
        requestId: string;
        state: string;
        deployment: string;
        serviceId: string;
        requestedAt: string;
        startedAt?: string;
        finishedAt?: string;
        version?: string;
        error?: string;
        message?: string;
      }>(res);
      const status: DeployStatus = {
        requestId: remote.requestId,
        state: remote.state as DeployRequestState,
        deployment: remote.deployment,
        serviceId: remote.serviceId,
        requestedAt: remote.requestedAt,
        ...(remote.startedAt ? { startedAt: remote.startedAt } : {}),
        ...(remote.finishedAt ? { finishedAt: remote.finishedAt } : {}),
        ...(remote.version ? { version: remote.version } : {}),
        ...(remote.error ? { error: remote.error } : {}),
        ...(remote.message ? { message: remote.message } : {}),
      };
      this.lastStatus.set(id, status);
      return status;
    } catch {
      return this.lastStatus.get(id);
    }
  }

  runtimeVersion(_runtimeDir?: string): string | undefined {
    // Version is owned by the target service runtime; gateway may still read locally if needed.
    return undefined;
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

  private async onWaitTimeout(): Promise<void> {
    this.waitTimer = undefined;
    if (!this.held) return;
    console.warn(
      `[deploy-drain] graceful wait timed out (${this.maxWaitMs}ms); forcing release ${this.held.requestId}`,
    );
    try {
      const status = await this.releaseHeld({ releasedByTimeout: true });
      if (status) this.onWaitTimeoutRelease?.(status);
    } catch (err) {
      console.warn(
        "[deploy-drain] timeout release failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  private clearWaitTimer(): void {
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = undefined;
    }
  }
}
