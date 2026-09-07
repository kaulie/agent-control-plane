import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type DeployRequestState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

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
  startedAt?: string;
  finishedAt?: string;
  requestedAt?: string;
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

  constructor(deployHome: string) {
    this.deployHome = deployHome;
    this.requestsDir = path.join(deployHome, "deploy-requests");
    this.statusDir = path.join(deployHome, "deploy-status");
    fs.mkdirSync(this.requestsDir, { recursive: true });
    fs.mkdirSync(this.statusDir, { recursive: true });
    fs.mkdirSync(path.join(this.requestsDir, "processing"), { recursive: true });
  }

  enqueue(input: {
    deployment: string;
    taskId?: string;
    requestId?: string;
  }): DeployStatus {
    const deployment = normalizeDeploymentTag(input.deployment);
    const snap = path.join(this.deployHome, deployment);
    if (!fs.existsSync(path.join(snap, "VERSION"))) {
      throw new Error(`deployment package not found: ${snap}`);
    }
    if (!fs.existsSync(path.join(snap, "scripts", "restart.sh"))) {
      throw new Error(`deployment package incomplete (no scripts/restart.sh): ${snap}`);
    }

    const requestId =
      input.requestId?.trim() || `deploy-req-${randomUUID().slice(0, 8)}`;
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
    };
    fs.writeFileSync(reqPath, `${JSON.stringify(req, null, 2)}\n`, "utf8");
    fs.writeFileSync(
      path.join(this.statusDir, `${requestId}.json`),
      `${JSON.stringify(status, null, 2)}\n`,
      "utf8",
    );
    return status;
  }

  getStatus(requestId: string): DeployStatus | undefined {
    const id = requestId.trim();
    if (!id) return undefined;
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
}
