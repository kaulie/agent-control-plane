import fs from "node:fs";
import path from "node:path";
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
  /** e.g. deployment-e11b02cd or bare hash */
  deployment: string;
  requestedAt: string;
  taskId?: string;
}

export interface DeployStatus {
  requestId: string;
  state: DeployRequestState;
  deployment?: string;
  version?: string;
  error?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  requestedAt?: string;
  runningCount?: number;
  queuedCount?: number;
  /** ISO deadline for graceful wait (when held). */
  waitUntil?: string;
  /** Max graceful wait in ms (config). */
  maxWaitMs?: number;
  /** True when released because the wait deadline expired. */
  releasedByTimeout?: boolean;
}

export interface DeployQueueOptions {
  /** Max hold time before forcing release; 0 = wait forever. Default 10 min. */
  maxWaitMs?: number;
  /** Called after a wait-timeout auto-release enqueues the deploy. */
  onWaitTimeoutRelease?: (status: DeployStatus) => void;
}

export function normalizeDeploymentTag(raw: string): string {
  const s = raw.trim();
  if (!s) throw new Error("deployment is required");
  if (s.startsWith("deployment-")) return s;
  return `deployment-${s.replace(/^deployment-/, "")}`;
}

export class DeployQueue {
  readonly deployHome: string;
  readonly requestsDir: string;
  readonly statusDir: string;
  readonly maxWaitMs: number;
  private onWaitTimeoutRelease?: (status: DeployStatus) => void;
  /** Deploy waiting for running agents to finish before writing a request file. */
  private held: DeployRequest | null = null;
  private heldWaitUntil: string | null = null;
  private waitTimer: NodeJS.Timeout | undefined;

  constructor(deployHome: string, options: DeployQueueOptions = {}) {
    this.deployHome = deployHome;
    this.requestsDir = path.join(deployHome, "deploy-requests");
    this.statusDir = path.join(deployHome, "deploy-status");
    this.maxWaitMs = Math.max(0, options.maxWaitMs ?? 10 * 60 * 1000);
    this.onWaitTimeoutRelease = options.onWaitTimeoutRelease;
    fs.mkdirSync(this.requestsDir, { recursive: true });
    fs.mkdirSync(this.statusDir, { recursive: true });
    fs.mkdirSync(path.join(this.requestsDir, "processing"), { recursive: true });
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

  /**
   * Soft-hold a deploy: status is waiting_for_idle, but no request file is
   * written until {@link releaseHeld} (so deploy-agent will not restart yet).
   * After {@link maxWaitMs}, the hold is released automatically (forced).
   */
  hold(input: {
    deployment: string;
    taskId?: string;
    requestId?: string;
    runningCount: number;
    queuedCount: number;
  }): DeployStatus {
    if (this.held) {
      throw new Error(
        `deploy already waiting for idle: ${this.held.requestId} (${this.held.deployment})`,
      );
    }
    const deployment = normalizeDeploymentTag(input.deployment);
    this.assertPackage(deployment);

    const requestId =
      input.requestId?.trim() || `deploy-req-${randomUUID().slice(0, 8)}`;
    const requestedAt = new Date().toISOString();
    const req: DeployRequest = {
      requestId,
      deployment,
      requestedAt,
      ...(input.taskId ? { taskId: input.taskId } : {}),
    };
    this.held = req;

    let waitUntil: string | undefined;
    if (this.maxWaitMs > 0) {
      waitUntil = new Date(Date.now() + this.maxWaitMs).toISOString();
      this.heldWaitUntil = waitUntil;
      this.clearWaitTimer();
      this.waitTimer = setTimeout(() => this.onWaitTimeout(), this.maxWaitMs);
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
      requestedAt,
      runningCount: input.runningCount,
      queuedCount: input.queuedCount,
      maxWaitMs: this.maxWaitMs,
      ...(waitUntil ? { waitUntil } : {}),
      message:
        `当前有 agent 正在运行；已暂停新排队任务的启动。请稍后轮询 GET /api/ops/restart-status。${waitHint}`,
    };
    this.writeStatus(status);
    return status;
  }

  /** Enqueue the held deploy for deploy-agent. Returns null if nothing held. */
  releaseHeld(opts?: { releasedByTimeout?: boolean }): DeployStatus | null {
    const held = this.held;
    if (!held) return null;
    this.clearWaitTimer();
    this.held = null;
    this.heldWaitUntil = null;
    const status = this.enqueue({
      deployment: held.deployment,
      requestId: held.requestId,
      ...(held.taskId ? { taskId: held.taskId } : {}),
    });
    if (opts?.releasedByTimeout) {
      const timed: DeployStatus = {
        ...status,
        releasedByTimeout: true,
        message:
          "graceful wait timed out; deploy forced while agents may still be running",
      };
      this.writeStatus(timed);
      return timed;
    }
    return status;
  }

  /** Cancel a held deploy (does not affect already-queued request files). */
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
      requestedAt: held.requestedAt,
      finishedAt: new Date().toISOString(),
      message: "held deploy cancelled; queue admission resumed",
    };
    this.writeStatus(status);
    return status;
  }

  enqueue(input: {
    deployment: string;
    taskId?: string;
    requestId?: string;
  }): DeployStatus {
    const deployment = normalizeDeploymentTag(input.deployment);
    this.assertPackage(deployment);

    const requestId =
      input.requestId?.trim() || `deploy-req-${randomUUID().slice(0, 8)}`;
    if (this.held?.requestId === requestId) {
      this.clearWaitTimer();
      this.held = null;
      this.heldWaitUntil = null;
    }
    const requestedAt = new Date().toISOString();
    const req: DeployRequest = {
      requestId,
      deployment,
      requestedAt,
      ...(input.taskId ? { taskId: input.taskId } : {}),
    };
    const reqPath = path.join(this.requestsDir, `${requestId}.json`);
    if (fs.existsSync(reqPath)) {
      throw new Error(`deploy request already exists: ${requestId}`);
    }
    const status: DeployStatus = {
      requestId,
      state: "queued",
      deployment,
      requestedAt,
      message:
        "deploy queued for independent deploy-agent; poll GET /api/ops/deploy/:requestId",
    };
    fs.writeFileSync(reqPath, `${JSON.stringify(req, null, 2)}\n`, "utf8");
    this.writeStatus(status);
    return status;
  }

  getStatus(requestId: string): DeployStatus | undefined {
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
        requestedAt: this.held.requestedAt,
        maxWaitMs: this.maxWaitMs,
        ...(this.heldWaitUntil ? { waitUntil: this.heldWaitUntil } : {}),
        message:
          remainingMs != null
            ? `当前有 agent 正在运行；已暂停排队启动。剩余等待约 ${Math.ceil(remainingMs / 1000)}s，或轮询 GET /api/ops/restart-status。`
            : "当前有 agent 正在运行；已暂停新排队任务的启动。请稍后轮询 GET /api/ops/restart-status。",
      };
    }
    const statusPath = path.join(this.statusDir, `${id}.json`);
    if (!fs.existsSync(statusPath)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(statusPath, "utf8")) as DeployStatus;
    } catch {
      return undefined;
    }
  }

  /** Runtime VERSION file, if present. */
  runtimeVersion(runtimeDir = "/Users/gaolei/runtime/web-cursor"): string | undefined {
    try {
      const p = path.join(runtimeDir, "VERSION");
      if (!fs.existsSync(p)) return undefined;
      return fs.readFileSync(p, "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private onWaitTimeout(): void {
    this.waitTimer = undefined;
    if (!this.held) return;
    console.warn(
      `[deploy-drain] graceful wait timed out (${this.maxWaitMs}ms); forcing release ${this.held.requestId}`,
    );
    const status = this.releaseHeld({ releasedByTimeout: true });
    if (status) {
      try {
        this.onWaitTimeoutRelease?.(status);
      } catch (err) {
        console.warn(
          "[deploy-drain] onWaitTimeoutRelease failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  private clearWaitTimer(): void {
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = undefined;
    }
  }

  private assertPackage(deployment: string): void {
    const snap = path.join(this.deployHome, deployment);
    if (!fs.existsSync(path.join(snap, "VERSION"))) {
      throw new Error(`deployment package not found: ${snap}`);
    }
    if (!fs.existsSync(path.join(snap, "scripts", "restart.sh"))) {
      throw new Error(`deployment package incomplete (no scripts/restart.sh): ${snap}`);
    }
  }

  private writeStatus(status: DeployStatus): void {
    fs.writeFileSync(
      path.join(this.statusDir, `${status.requestId}.json`),
      `${JSON.stringify(status, null, 2)}\n`,
      "utf8",
    );
  }
}
