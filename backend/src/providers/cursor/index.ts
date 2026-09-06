import { Agent, AgentBusyError, Cursor } from "@cursor/sdk";
import type { AgentOptions, Run, SDKAgent, SDKMessage, SDKUserMessage } from "@cursor/sdk";
import type { CostInfo, EventType, TokenUsage } from "../../types.js";
import { mapSdkMessage } from "./mapper.js";
import { buildCost, type SdkCostLike } from "../../usage/cost.js";
import { normalizeTokenUsage } from "../../usage/tokens.js";
import { newId } from "../../store/db.js";
import { composePromptWithBootstrap } from "../../task-context.js";
import { formatRunErrorMessage } from "../../run-errors.js";
import type { AgentProvider, ModelInfo, RunInput, RunResultData } from "../types.js";

export interface CursorProviderConfig {
  apiKey?: string;
  model?: string;
  /** When set with mcpServerPath, inject git-via-proxy MCP into Agent.create. */
  gitViaProxyUrl?: string;
  gitViaProxyMcp?: boolean;
  gitViaProxyServerPath?: string;
}

interface ActiveHandle {
  cancelled: boolean;
  agent?: SDKAgent;
  run?: Run;
  cwd: string;
}

function isAgentBusy(err: unknown): boolean {
  if (err instanceof AgentBusyError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /already has active run/i.test(msg);
}

export class CursorProvider implements AgentProvider {
  readonly name = "cursor";
  private modelsCache: ModelInfo[] | undefined;
  private active = new Map<string, ActiveHandle>();
  /** Long-lived SDK agents keyed by taskId (1 task = 1 agent). */
  private agentsByTask = new Map<string, SDKAgent>();

  constructor(private config: CursorProviderConfig) {}

  async verifyAuth(): Promise<{ ok: boolean; detail: string }> {
    try {
      const me = await Cursor.me(this.config.apiKey ? { apiKey: this.config.apiKey } : undefined);
      const who = me.userEmail ?? me.apiKeyName ?? "unknown";
      return { ok: true, detail: `authenticated as ${who}` };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelsCache) return this.modelsCache;
    try {
      const models = await Cursor.models.list(
        this.config.apiKey ? { apiKey: this.config.apiKey } : undefined,
      );
      this.modelsCache = models.map((m) => ({ id: m.id, displayName: m.displayName }));
      return this.modelsCache;
    } catch (err) {
      console.warn("[cursor] listModels failed:", err instanceof Error ? err.message : err);
      return [];
    }
  }

  async resolveModel(): Promise<string | undefined> {
    if (this.config.model) return this.config.model;
    const models = await this.listModels();
    return models[0]?.id;
  }

  /**
   * Cancel any SDK runs still marked running for this agent.
   * Needed after our process dies while a local agent run is in flight —
   * the SDK keeps that run active and rejects the next send with AgentBusyError.
   */
  private async cancelRunningSdkRuns(agentId: string, cwd: string): Promise<number> {
    if (!agentId) return 0;
    let cancelled = 0;
    try {
      const listed = await Agent.listRuns(agentId, { runtime: "local", cwd });
      for (const run of listed.items) {
        if (run.status !== "running") continue;
        try {
          await Agent.cancelRun(run.id, { runtime: "local", cwd });
          cancelled += 1;
        } catch (err) {
          try {
            await run.cancel();
            cancelled += 1;
          } catch (err2) {
            console.warn(
              "[cursor] failed to cancel orphaned run",
              run.id,
              err2 instanceof Error ? err2.message : err2,
            );
          }
        }
      }
    } catch (err) {
      console.warn(
        "[cursor] listRuns for orphan cancel failed:",
        err instanceof Error ? err.message : err,
      );
    }
    if (cancelled > 0) {
      console.warn(
        `[cursor] cancelled ${cancelled} orphaned SDK run(s) on ${agentId}`,
      );
    }
    return cancelled;
  }

  async reconcileAfterRestart(
    orphans: Array<{ agentId: string; cwd: string }>,
  ): Promise<void> {
    const seen = new Set<string>();
    for (const { agentId, cwd } of orphans) {
      const key = `${agentId}::${cwd}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await this.cancelRunningSdkRuns(agentId, cwd);
    }
  }

  async cancel(runId: string): Promise<boolean> {
    const handle = this.active.get(runId);
    if (!handle) return false;
    handle.cancelled = true;
    try {
      if (handle.run) {
        await handle.run.cancel();
      } else if (handle.agent) {
        // send() may not have returned yet, or the handle was lost after a
        // partial failure — cancel via the SDK run store instead.
        await this.cancelRunningSdkRuns(handle.agent.agentId, handle.cwd);
      }
    } catch (err) {
      console.warn("[cursor] cancel failed:", err instanceof Error ? err.message : err);
    }
    return true;
  }

  dispose(): void {
    for (const agent of this.agentsByTask.values()) {
      try {
        agent.close();
      } catch {
        /* ignore */
      }
    }
    this.agentsByTask.clear();
  }

  private buildOptions(input: RunInput, modelId: string | undefined): AgentOptions {
    const options: AgentOptions = {
      local: {
        cwd: input.cwd,
        // Load project rules (`.cursor/rules`, AGENTS.md / AGENT.md) from cwd.
        settingSources: ["project"],
      },
    };
    if (modelId) options.model = { id: modelId };
    if (this.config.apiKey) options.apiKey = this.config.apiKey;
    if (input.mode === "plan" || input.mode === "agent") {
      options.mode = input.mode;
    }
    if (input.agentName?.trim()) {
      options.name = input.agentName.trim();
    }
    const proxyUrl = this.config.gitViaProxyUrl?.trim();
    const serverPath = this.config.gitViaProxyServerPath?.trim();
    if (this.config.gitViaProxyMcp && proxyUrl && serverPath) {
      options.mcpServers = {
        "git-via-proxy": {
          command: "node",
          args: [serverPath],
          env: { GIT_VIA_PROXY_URL: proxyUrl },
        },
      };
    }
    return options;
  }

  private async obtainAgent(
    input: RunInput,
    options: AgentOptions,
  ): Promise<{ agent: SDKAgent; created: boolean }> {
    const cached = this.agentsByTask.get(input.taskId);
    if (cached && (!input.agentId || cached.agentId === input.agentId)) {
      return { agent: cached, created: false };
    }

    let agent: SDKAgent | undefined;
    let created = false;
    if (input.agentId) {
      try {
        agent = await Agent.resume(input.agentId, options);
      } catch (err) {
        console.warn(
          "[cursor] resume failed, creating new agent:",
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (!agent) {
      agent = await Agent.create(options);
      created = true;
    }

    if (cached && cached.agentId !== agent.agentId) {
      try {
        cached.close();
      } catch {
        /* ignore */
      }
    }
    this.agentsByTask.set(input.taskId, agent);
    return { agent, created };
  }

  private buildSendPayload(
    input: RunInput,
    prependBootstrap: boolean,
  ): string | SDKUserMessage {
    const text = prependBootstrap
      ? composePromptWithBootstrap(input.bootstrapText, input.prompt.text)
      : input.prompt.text;
    if (!input.prompt.images?.length) return text;
    return {
      text,
      images: input.prompt.images.map((img) => ({
        data: img.data,
        mimeType: img.mimeType,
        ...(img.width != null && img.height != null
          ? { dimension: { width: img.width, height: img.height } }
          : {}),
      })),
    };
  }

  /**
   * agent.send, with recovery when the SDK still holds an active run from a
   * previous (crashed / interrupted) gateway process.
   */
  private async sendPrompt(
    agent: SDKAgent,
    input: RunInput,
    options: AgentOptions,
    prependBootstrap: boolean,
  ): Promise<{ agent: SDKAgent; run: Run }> {
    const trySend = (a: SDKAgent, withBootstrap: boolean) =>
      a.send(
        this.buildSendPayload(input, withBootstrap),
        input.mode ? { mode: input.mode } : undefined,
      );

    try {
      return { agent, run: await trySend(agent, prependBootstrap) };
    } catch (err) {
      if (!isAgentBusy(err)) throw err;
    }

    console.warn(
      `[cursor] agent ${agent.agentId} busy; cancelling orphaned runs and retrying`,
    );
    await this.cancelRunningSdkRuns(agent.agentId, input.cwd);

    try {
      return { agent, run: await trySend(agent, prependBootstrap) };
    } catch (err) {
      if (!isAgentBusy(err)) throw err;
    }

    // Last resort: abandon the stuck agent and start a fresh conversation.
    // Prefer unblocking the user over preserving a dead session.
    console.warn(
      `[cursor] agent ${agent.agentId} still busy after cancel; creating a fresh agent`,
    );
    try {
      agent.close();
    } catch {
      /* ignore */
    }
    this.agentsByTask.delete(input.taskId);
    const fresh = await Agent.create(options);
    this.agentsByTask.set(input.taskId, fresh);
    // Fresh agent has no memory — inject bootstrap again.
    return { agent: fresh, run: await trySend(fresh, true) };
  }

  async run(input: RunInput): Promise<RunResultData> {
    const modelId = input.model || (await this.resolveModel());
    const options = this.buildOptions(input, modelId);

    const handle: ActiveHandle = { cancelled: false, cwd: input.cwd };
    this.active.set(input.runId, handle);

    const obtained = await this.obtainAgent(input, options);
    let agent = obtained.agent;
    handle.agent = agent;

    const startedAt = Date.now();
    let modelCalls = 0;
    let toolCalls = 0;

    const emit = async (
      eventType: EventType,
      payload: Record<string, unknown>,
      usage?: TokenUsage,
      cost?: CostInfo,
    ): Promise<void> => {
      await input.onEvent({
        eventId: newId("evt"),
        taskId: input.taskId,
        runId: input.runId,
        agentId: agent.agentId,
        timestamp: new Date().toISOString(),
        eventType,
        payload,
        usage,
        cost,
      });
    };

    await emit("run_started", {
      cwd: input.cwd,
      model: modelId,
      sdkAgentId: agent.agentId,
      mode: input.mode ?? "agent",
      ...(obtained.created ? { agentCreated: true } : {}),
    });

    if (handle.cancelled) {
      const durationMs = Date.now() - startedAt;
      await emit("run_cancelled", {
        durationMs,
        modelCalls,
        toolCalls,
        reason: "user_stop",
      });
      this.active.delete(input.runId);
      return {
        status: "cancelled",
        durationMs,
        modelCalls,
        toolCalls,
        agentId: agent.agentId,
      };
    }

    try {
      const sent = await this.sendPrompt(
        agent,
        input,
        options,
        obtained.created,
      );
      agent = sent.agent;
      handle.agent = agent;
      const run = sent.run;
      handle.run = run;

      if (handle.cancelled) {
        try {
          await run.cancel();
        } catch {
          /* ignore */
        }
      }

      const seenStarted = new Set<string>();
      let lastActivityAt = Date.now();
      const HEARTBEAT_MS = 15_000;
      const heartbeat = setInterval(() => {
        if (handle.cancelled) return;
        const silentFor = Date.now() - lastActivityAt;
        if (silentFor < HEARTBEAT_MS) return;
        const elapsedMs = Date.now() - startedAt;
        void emit("status", {
          status: "working",
          message: `仍在执行中（可能在跑长命令），已运行 ${Math.round(elapsedMs / 1000)} 秒`,
          elapsedMs,
        });
      }, HEARTBEAT_MS);

      try {
        for await (const msg of run.stream()) {
          if (handle.cancelled) break;
          lastActivityAt = Date.now();
          if (msg.type === "usage") modelCalls += 1;
          if (msg.type === "tool_call" && msg.status === "running") {
            const callId = msg.call_id;
            // The SDK can re-notify the same tool call as its args stream in;
            // emit a single "tool_call_started" per call and count it once.
            if (callId && seenStarted.has(callId)) continue;
            if (callId) seenStarted.add(callId);
            toolCalls += 1;
          }
          for (const mapped of mapSdkMessage(msg as SDKMessage)) {
            const usage = mapped.usage
              ? normalizeTokenUsage(mapped.usage, "cursor")
              : undefined;
            await emit(mapped.eventType, mapped.payload, usage);
          }
        }
      } finally {
        clearInterval(heartbeat);
      }

      const result = await run.wait();
      const durationMs = Date.now() - startedAt;
      const usage = result.usage
        ? normalizeTokenUsage(result.usage, "cursor")
        : undefined;

      if (handle.cancelled || result.status === "cancelled") {
        await emit("run_cancelled", {
          durationMs,
          modelCalls,
          toolCalls,
          reason: handle.cancelled ? "user_stop" : "sdk_cancelled",
        });
        return {
          status: "cancelled",
          durationMs,
          modelCalls,
          toolCalls,
          usage,
          agentId: agent.agentId,
        };
      }

      let sdkCost: SdkCostLike | undefined;
      try {
        const agentUsage = await agent.getUsage();
        if (agentUsage?.cost) sdkCost = agentUsage.cost;
      } catch (err) {
        console.warn("[cursor] getUsage failed:", err instanceof Error ? err.message : err);
      }
      const cost = buildCost(usage, modelId, sdkCost, "cursor");

      const status: RunResultData["status"] =
        result.status === "error" ? "error" : "finished";
      await emit(
        status === "error" ? "run_error" : "run_completed",
        {
          status,
          result: result.result,
          error: result.error?.message,
          durationMs,
          modelCalls,
          toolCalls,
        },
        usage,
        cost,
      );

      return {
        status,
        result: result.result,
        error: result.error?.message,
        durationMs,
        usage,
        cost,
        modelCalls,
        toolCalls,
        agentId: agent.agentId,
      };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      if (handle.cancelled) {
        await emit("run_cancelled", {
          durationMs,
          modelCalls,
          toolCalls,
          reason: "user_stop",
        });
        return {
          status: "cancelled",
          durationMs,
          modelCalls,
          toolCalls,
          agentId: agent.agentId,
        };
      }
      const message = formatRunErrorMessage(
        err instanceof Error ? err.message : String(err),
      );
      await emit("run_error", { error: message, durationMs, modelCalls, toolCalls });
      return {
        status: "error",
        error: message,
        durationMs,
        modelCalls,
        toolCalls,
        agentId: agent.agentId,
      };
    } finally {
      this.active.delete(input.runId);
      // Keep the task-scoped agent alive for follow-up messages.
    }
  }
}
