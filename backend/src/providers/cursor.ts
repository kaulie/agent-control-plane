import { Agent, Cursor } from "@cursor/sdk";
import type { AgentOptions, Run, SDKAgent, SDKMessage } from "@cursor/sdk";
import type { CostInfo, EventType, TokenUsage } from "../types.js";
import { mapSdkMessage } from "../events/mapper.js";
import { buildCost, type SdkCostLike } from "../usage/cost.js";
import { newId } from "../store/db.js";
import type { AgentProvider, ModelInfo, RunInput, RunResultData } from "./types.js";

export interface CursorProviderConfig {
  apiKey?: string;
  model?: string;
}

interface ActiveHandle {
  cancelled: boolean;
  agent?: SDKAgent;
  run?: Run;
}

export class CursorProvider implements AgentProvider {
  readonly name = "cursor";
  private modelsCache: ModelInfo[] | undefined;
  private active = new Map<string, ActiveHandle>();

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

  async cancel(runId: string): Promise<boolean> {
    const handle = this.active.get(runId);
    if (!handle) return false;
    handle.cancelled = true;
    try {
      if (handle.run) {
        await handle.run.cancel();
      } else if (handle.agent) {
        handle.agent.close();
      }
    } catch (err) {
      console.warn("[cursor] cancel failed:", err instanceof Error ? err.message : err);
    }
    return true;
  }

  async run(input: RunInput): Promise<RunResultData> {
    const modelId = input.model || (await this.resolveModel());

    const options: AgentOptions = {
      local: { cwd: input.cwd },
    };
    if (modelId) options.model = { id: modelId };
    if (this.config.apiKey) options.apiKey = this.config.apiKey;

    const handle: ActiveHandle = { cancelled: false };
    this.active.set(input.runId, handle);

    const agent = await Agent.create(options);
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
    });

    if (handle.cancelled) {
      const durationMs = Date.now() - startedAt;
      await emit("run_cancelled", { durationMs, modelCalls, toolCalls });
      this.active.delete(input.runId);
      try {
        agent.close();
      } catch {
        /* ignore */
      }
      return { status: "cancelled", durationMs, modelCalls, toolCalls };
    }

    try {
      const run = await agent.send(input.prompt);
      handle.run = run;

      if (handle.cancelled) {
        try {
          await run.cancel();
        } catch {
          /* ignore */
        }
      }

      const seenStarted = new Set<string>();
      for await (const msg of run.stream()) {
        if (handle.cancelled) break;
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
          await emit(mapped.eventType, mapped.payload, mapped.usage);
        }
      }

      const result = await run.wait();
      const durationMs = Date.now() - startedAt;
      const usage = result.usage;

      if (handle.cancelled || result.status === "cancelled") {
        await emit("run_cancelled", {
          durationMs,
          modelCalls,
          toolCalls,
        });
        return { status: "cancelled", durationMs, modelCalls, toolCalls, usage };
      }

      let sdkCost: SdkCostLike | undefined;
      try {
        const agentUsage = await agent.getUsage();
        if (agentUsage?.cost) sdkCost = agentUsage.cost;
      } catch (err) {
        console.warn("[cursor] getUsage failed:", err instanceof Error ? err.message : err);
      }
      const cost = buildCost(usage, modelId, sdkCost);

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
      };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      if (handle.cancelled) {
        await emit("run_cancelled", { durationMs, modelCalls, toolCalls });
        return { status: "cancelled", durationMs, modelCalls, toolCalls };
      }
      const message = err instanceof Error ? err.message : String(err);
      await emit("run_error", { error: message, durationMs, modelCalls, toolCalls });
      return { status: "error", error: message, durationMs, modelCalls, toolCalls };
    } finally {
      this.active.delete(input.runId);
      try {
        agent.close();
      } catch {
        /* ignore */
      }
    }
  }
}
