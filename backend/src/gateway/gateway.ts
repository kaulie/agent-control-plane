import type { AgentEvent, RunRecord, Task, TaskStats } from "../types.js";
import { Store, newId } from "../store/db.js";
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
  constructor(
    private store: Store,
    private provider: AgentProvider,
    private config: GatewayConfig,
    private publish: Publish,
  ) {}

  createTask(input: {
    title?: string;
    workspace?: string;
    model?: string;
  }): Task {
    const title = input.title?.trim() || `Task ${new Date().toLocaleString()}`;
    const workspace = input.workspace || this.config.agentWorkspace;
    const task = this.store.createTask({
      title,
      workspace,
      provider: this.provider.name,
      model: input.model,
    });
    this.publish({ type: "task_created", task });
    return task;
  }

  listTasks(): Task[] {
    return this.store.listTasks();
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

    const runId = newId("run");
    this.store.createRun({
      runId,
      taskId,
      agentId: "",
      provider: this.provider.name,
      model: task.model,
    });

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
          result.status === "error" ? "error" : "completed",
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
}
