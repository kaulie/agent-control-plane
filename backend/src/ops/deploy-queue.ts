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
  /** Deploy waiting for running agents to finish before writing a request file. */
  private held: DeployRequest | null = null;

  constructor(deployHome: string) {
    this.deployHome = deployHome;
    this.requestsDir = path.join(deployHome, "deploy-requests");
    this.statusDir = path.join(deployHome, "deploy-status");
    fs.mkdirSync(this.requestsDir, { recursive: true });
    fs.mkdirSync(this.statusDir, { recursive: true });
    fs.mkdirSync(path.join(this.requestsDir, "processing"), { recursive: true });
  }

  getHeld(): DeployRequest | null {
    return this.held ? { ...this.held } : null;
  }

  /**
   * Soft-hold a deploy: status is waiting_for_idle, but no request file is
   * written until {@link releaseHeld} (so deploy-agent will not restart yet).
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
    const status: DeployStatus = {
      requestId,
      state: "waiting_for_idle",
      deployment,
      requestedAt,
      runningCount: input.runningCount,
      queuedCount: input.queuedCount,
      message:
        "当前有 agent 正在运行；已暂停新排队任务的启动。请稍后轮询 GET /api/ops/restart-status，空闲后再继续部署。",
    };
    this.writeStatus(status);
    return status;
  }

  /** Enqueue the held deploy for deploy-agent. Returns null if nothing held. */
  releaseHeld(): DeployStatus | null {
    const held = this.held;
    if (!held) return null;
    this.held = null;
    return this.enqueue({
      deployment: held.deployment,
      requestId: held.requestId,
      ...(held.taskId ? { taskId: held.taskId } : {}),
    });
  }

  /** Cancel a held deploy (does not affect already-queued request files). */
  cancelHeld(): DeployStatus | null {
    const held = this.held;
    if (!held) return null;
    this.held = null;
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
      this.held = null;
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
      return {
        requestId: this.held.requestId,
        state: "waiting_for_idle",
        deployment: this.held.deployment,
        requestedAt: this.held.requestedAt,
        message:
          "当前有 agent 正在运行；已暂停新排队任务的启动。请稍后轮询 GET /api/ops/restart-status。",
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
