import type { AgentEvent, Project, RunRecord, Task, TaskStats } from "../types.js";
import { Store, newId, DEFAULT_PROJECT_ID } from "../store/db.js";
import type { AgentProvider } from "../providers/types.js";

export type Publish = (message: Record<string, unknown>) => void;

export interface GatewayConfig {
  agentWorkspace: string;
}

export interface TaskDetail {
  task: Task;
  runs: RunRecord[];
  stats: TaskStats;
}

/**
 * Orchestrates the core loop required by the spec:
 *   Task -> Agent Run -> Event Stream -> Usage -> Cost -> Result
 * It depends only on the AgentProvider interface (never a concrete SDK).
 */
export class AgentGateway {
  /** In-flight runId keyed by taskId (at most one active run per task). */
  private activeRuns = new Map<string, string>();

  constructor(
    private store: Store,
    private provider: AgentProvider,
    private config: GatewayConfig,
    private publish: Publish,
  ) {}

  // ---- projects ----

  listProjects(): Project[] {
    return this.store.listProjects();
  }

  createProject(name: string): Project {
    const project = this.store.createProject(name);
    this.publish({ type: "project_created", project });
    return project;
  }

  renameProject(projectId: string, name: string): Project | undefined {
    const project = this.store.renameProject(projectId, name);
    if (project) {
      this.publish({ type: "project_updated", project });
    }
    return project;
  }

  getProject(projectId: string): Project | undefined {
    return this.store.getProject(projectId);
  }

  // ---- tasks ----

  createTask(input: {
    title?: string;
    workspace?: string;
    model?: string;
    projectId?: string;
  }): Task {
    const title = input.title?.trim() || `Task ${new Date().toLocaleString()}`;
    const workspace = input.workspace || this.config.agentWorkspace;
    const projectId = input.projectId?.trim() || DEFAULT_PROJECT_ID;
    if (!this.store.getProject(projectId)) {
      throw new Error(`project ${projectId} not found`);
    }
    const task = this.store.createTask({
      title,
      workspace,
      provider: this.provider.name,
      model: input.model,
      projectId,
    });
    this.publish({ type: "task_created", task });
    return task;
  }

  listTasks(filter?: { projectId?: string }): Task[] {
    return this.store.listTasks(filter);
  }

  getTaskDetail(taskId: string): TaskDetail | undefined {
    const task = this.store.getTask(taskId);
    if (!task) return undefined;
    return {
      task,
      runs: this.store.listRuns(taskId),
      stats: this.store.getTaskStats(taskId),
    };
  }

  listEvents(taskId: string, afterSeq?: number): AgentEvent[] {
    return this.store.listEvents(taskId, afterSeq);
  }

  async sendMessage(taskId: string, message: string): Promise<{ runId: string }> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (this.activeRuns.has(taskId)) {
      throw new Error("A run is already in progress for this task");
    }

    const runId = newId("run");
    this.store.createRun({
      runId,
      taskId,
      agentId: "",
      provider: this.provider.name,
      model: task.model,
    });
    this.activeRuns.set(taskId, runId);
    this.store.updateTaskStatus(taskId, "active");

    const persistAndPublish = (event: AgentEvent): void => {
      this.store.appendEvent(event);
      this.publish({ type: "agent_event", event });
    };

    // Authoritative user message (also ensures the timeline starts immediately).
    persistAndPublish({
      eventId: newId("evt"),
      taskId,
      runId,
      agentId: "",
      timestamp: new Date().toISOString(),
      eventType: "user_message",
      payload: { text: message },
    });

    let agentId = "";

    void (async () => {
      try {
        const result = await this.provider.run({
          taskId,
          runId,
          agentId,
          prompt: message,
          cwd: task.workspace,
          model: task.model,
          onEvent: (event) => {
            if (event.agentId && event.agentId !== agentId) {
              agentId = event.agentId;
              this.store.setRunAgentId(runId, agentId);
            }
            persistAndPublish(event);
          },
        });

        this.store.updateRun(runId, {
          status: result.status,
          completedAt: new Date().toISOString(),
          durationMs: result.durationMs,
          result: result.result,
          error: result.error,
          usage: result.usage,
          cost: result.cost,
          modelCalls: result.modelCalls,
          toolCalls: result.toolCalls,
        });
        this.store.updateTaskStatus(
          taskId,
          result.status === "error"
            ? "error"
            : result.status === "cancelled"
              ? "active"
              : "completed",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.store.updateRun(runId, {
          status: "error",
          completedAt: new Date().toISOString(),
          error: message,
        });
        this.store.updateTaskStatus(taskId, "error");
      } finally {
        if (this.activeRuns.get(taskId) === runId) {
          this.activeRuns.delete(taskId);
        }
        this.publish({
          type: "task_updated",
          task: this.store.getTask(taskId),
          stats: this.store.getTaskStats(taskId),
          runId,
        });
      }
    })();

    return { runId };
  }

  async stopTask(taskId: string): Promise<{ runId: string }> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const runId = this.activeRuns.get(taskId);
    if (!runId) {
      throw new Error("No active run to stop");
    }

    const cancelled = await this.provider.cancel(runId);
    if (!cancelled) {
      throw new Error("Failed to cancel the active run");
    }
    return { runId };
  }
}
