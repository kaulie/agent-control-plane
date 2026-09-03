import { ClineCore, Llms } from "@cline/sdk";
import type {
  AgentEvent as ClineAgentEvent,
  AgentMode,
  AgentResult,
  ClineCoreStartConfig,
  CoreSessionEvent,
} from "@cline/sdk";
import type { AgentEvent, CostInfo, EventType, TokenUsage } from "../../types.js";
import { newId } from "../../store/db.js";
import { composePromptWithBootstrap } from "../../task-context.js";
import { formatRunErrorMessage } from "../../run-errors.js";
import type { AgentProvider, ModelInfo, RunInput, RunResultData } from "../types.js";
import { mapAgentEvent, toTokenUsage, type MappedEvent, type UsageLike } from "./mapper.js";
import {
  buildCostInfo,
  DEFAULT_PROVIDER_ID,
  DEFAULT_SYSTEM_PROMPT,
  DEEPSEEK_FALLBACK_MODELS,
  type ClineProviderConfig,
} from "./config.js";

export type { ClineProviderConfig } from "./config.js";

interface ActiveHandle {
  cancelled: boolean;
  taskId: string;
  runId: string;
  sessionId: string;
  lastError?: string;
  modelCalls: number;
  toolCalls: number;
  seenToolCalls: Set<string>;
  onEvent: (event: AgentEvent) => Promise<void> | void;
}

type Emit = (
  eventType: EventType,
  payload: Record<string, unknown>,
  usage?: TokenUsage,
  cost?: CostInfo,
) => Promise<void>;

/**
 * AgentProvider implementation backed by the Cline SDK (`@cline/sdk`).
 *
 * One Cline session maps to one Web Cursor task (mirroring the cursor adapter):
 * the first message `start`s a session, follow-up messages `send` on the
 * resident session, and the opaque session id is persisted as `task.agentId`.
 */
export class ClineProvider implements AgentProvider {
  readonly name = "cline";

  private readonly providerId: string;
  private readonly systemPrompt: string;
  private readonly model?: string;
  private readonly apiKey?: string;
  private readonly baseUrl?: string;

  private modelsCache: ModelInfo[] | undefined;
  private client: ClineCore | undefined;
  private clientPromise: Promise<ClineCore> | undefined;
  private active = new Map<string, ActiveHandle>();
  private sessionsByTask = new Map<string, string>();

  constructor(config: ClineProviderConfig = {}) {
    this.providerId = (config.providerId ?? DEFAULT_PROVIDER_ID).trim() || DEFAULT_PROVIDER_ID;
    this.systemPrompt = (config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT).trim() || DEFAULT_SYSTEM_PROMPT;
    this.model = config.model?.trim() || undefined;
    this.apiKey = config.apiKey?.trim() || undefined;
    this.baseUrl = config.baseUrl?.trim() || undefined;
  }

  // ---- infrastructure ----

  private async getClient(): Promise<ClineCore> {
    if (this.client) return this.client;
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const client = await ClineCore.create({
          clientName: "web-cursor",
          backendMode: "local",
        });
        client.subscribe(this.handleCoreEvent);
        return client;
      })();
    }
    this.client = await this.clientPromise;
    return this.client;
  }

  private handleCoreEvent = (event: CoreSessionEvent): void => {
    const sessionId = event.payload.sessionId;
    for (const handle of this.active.values()) {
      if (handle.sessionId === sessionId) {
        void this.dispatchCoreEvent(handle, event);
      }
    }
  };

  private async dispatchCoreEvent(handle: ActiveHandle, event: CoreSessionEvent): Promise<void> {
    if (event.type === "agent_event") {
      await this.dispatchAgentEvent(handle, event.payload.event);
    }
  }

  private async dispatchAgentEvent(handle: ActiveHandle, event: ClineAgentEvent): Promise<void> {
    if (event.type === "usage") handle.modelCalls += 1;
    if (event.type === "error") {
      handle.lastError = formatRunErrorMessage(
        event.error instanceof Error ? event.error.message : String(event.error),
      );
      return;
    }
    for (const mapped of mapAgentEvent(event)) {
      await this.emitMapped(handle, mapped);
    }
  }

  private async emitMapped(handle: ActiveHandle, mapped: MappedEvent): Promise<void> {
    if (mapped.eventType === "tool_call_started") {
      const callId = typeof mapped.payload.callId === "string" ? mapped.payload.callId : undefined;
      if (callId && handle.seenToolCalls.has(callId)) return;
      if (callId) handle.seenToolCalls.add(callId);
      handle.toolCalls += 1;
    }
    await handle.onEvent({
      eventId: newId("evt"),
      taskId: handle.taskId,
      runId: handle.runId,
      agentId: handle.sessionId,
      timestamp: new Date().toISOString(),
      eventType: mapped.eventType,
      payload: mapped.payload,
      ...(mapped.usage ? { usage: mapped.usage } : {}),
    });
  }

  // ---- AgentProvider ----

  async verifyAuth(): Promise<{ ok: boolean; detail: string }> {
    if (!this.apiKey) {
      return {
        ok: false,
        detail: `missing API key for provider "${this.providerId}" (set DEEPSEEK_API_KEY)`,
      };
    }
    const known = Llms.getProviderIds().includes(this.providerId);
    return known
      ? { ok: true, detail: `provider "${this.providerId}" configured (key present)` }
      : { ok: false, detail: `unknown provider "${this.providerId}"` };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelsCache) return this.modelsCache;
    try {
      const models = (await Llms.getModelsForProvider(this.providerId)) as Record<
        string,
        { name?: string }
      >;
      const entries = Object.entries(models);
      if (entries.length) {
        this.modelsCache = entries.map(([id, m]) => ({
          id,
          displayName: m.name ?? id,
        }));
        return this.modelsCache;
      }
    } catch (err) {
      console.warn(
        `[cline] listModels failed for "${this.providerId}":`,
        err instanceof Error ? err.message : err,
      );
    }
    this.modelsCache =
      this.providerId === DEFAULT_PROVIDER_ID
        ? DEEPSEEK_FALLBACK_MODELS.map((m) => ({ id: m.id, displayName: m.displayName }))
        : [];
    return this.modelsCache;
  }

  async resolveModel(): Promise<string | undefined> {
    if (this.model) return this.model;
    const models = await this.listModels();
    return models[0]?.id;
  }

  async run(input: RunInput): Promise<RunResultData> {
    const cline = await this.getClient();
    const modelId = input.model || (await this.resolveModel());
    if (!modelId) {
      throw new Error(
        `No model available for provider "${this.providerId}". ` +
          `Set CLINE_MODEL or check your provider id.`,
      );
    }

    const mode: AgentMode = input.mode === "plan" ? "plan" : "yolo";
    const resident = Boolean(
      input.agentId && this.sessionsByTask.get(input.taskId) === input.agentId,
    );

    const handle: ActiveHandle = {
      cancelled: false,
      taskId: input.taskId,
      runId: input.runId,
      sessionId: resident ? input.agentId : newId("cls"),
      modelCalls: 0,
      toolCalls: 0,
      seenToolCalls: new Set<string>(),
      onEvent: input.onEvent,
    };
    this.active.set(input.runId, handle);

    const startedAt = Date.now();
    const emit: Emit = async (eventType, payload, usage, cost) => {
      await input.onEvent({
        eventId: newId("evt"),
        taskId: input.taskId,
        runId: input.runId,
        agentId: handle.sessionId,
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
      mode: input.mode ?? "agent",
      ...(resident ? {} : { sessionCreated: true }),
    });

    try {
      let result: AgentResult | undefined;
      if (resident) {
        try {
          const userImages = this.buildUserImages(input);
          result = await cline.send({
            sessionId: input.agentId,
            prompt: input.prompt.text,
            mode,
            ...(userImages ? { userImages } : {}),
          });
        } catch (err) {
          if (!this.isUnusable(err)) throw err;
          console.warn(`[cline] session ${input.agentId} unusable; recreating for task ${input.taskId}`);
          this.sessionsByTask.delete(input.taskId);
          result = await this.startFresh(cline, input, modelId, mode, handle);
        }
      } else {
        result = await this.startFresh(cline, input, modelId, mode, handle);
      }
      this.sessionsByTask.set(input.taskId, handle.sessionId);

      if (handle.cancelled) {
        const durationMs = Date.now() - startedAt;
        await emit("run_cancelled", {
          durationMs,
          modelCalls: handle.modelCalls,
          toolCalls: handle.toolCalls,
          reason: "user_stop",
        });
        return {
          status: "cancelled",
          durationMs,
          modelCalls: handle.modelCalls,
          toolCalls: handle.toolCalls,
          agentId: handle.sessionId,
        };
      }

      return this.buildResult(handle, modelId, result, startedAt, emit);
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const message = formatRunErrorMessage(err instanceof Error ? err.message : String(err));
      await emit("run_error", {
        error: message,
        durationMs,
        modelCalls: handle.modelCalls,
        toolCalls: handle.toolCalls,
      });
      return {
        status: "error",
        error: message,
        durationMs,
        modelCalls: handle.modelCalls,
        toolCalls: handle.toolCalls,
        agentId: handle.sessionId,
      };
    } finally {
      this.active.delete(input.runId);
    }
  }

  async cancel(runId: string): Promise<boolean> {
    const handle = this.active.get(runId);
    if (!handle) return false;
    handle.cancelled = true;
    try {
      await this.client?.stop(handle.sessionId);
    } catch (err) {
      console.warn("[cline] stop failed:", err instanceof Error ? err.message : err);
    }
    this.sessionsByTask.delete(handle.taskId);
    return true;
  }

  async reconcileAfterRestart(): Promise<void> {
    // Local Cline sessions live in-process; after a restart there is nothing
    // still running to cancel. Clear in-memory state so tasks recreate sessions.
    this.active.clear();
    this.sessionsByTask.clear();
  }

  dispose(): void {
    this.active.clear();
    this.sessionsByTask.clear();
    if (this.client) {
      void this.client.dispose().catch((err: unknown) => {
        console.warn("[cline] dispose failed:", err instanceof Error ? err.message : err);
      });
    }
    this.client = undefined;
    this.clientPromise = undefined;
  }

  // ---- internals ----

  /**
   * Convert Web Cursor prompt images into the Cline SDK `userImages` format:
   * `data:<mime>;base64,<data>`. The model behind the provider decides whether
   * it can consume them — if it cannot, it throws and the gateway surfaces the
   * error to the frontend (we intentionally do not pre-reject images here).
   */
  private buildUserImages(input: RunInput): string[] | undefined {
    const images = input.prompt.images;
    if (!images?.length) return undefined;
    return images.map((img) => `data:${img.mimeType};base64,${img.data}`);
  }

  private buildConfig(
    input: RunInput,
    modelId: string,
    mode: AgentMode,
    sessionId: string,
  ): ClineCoreStartConfig {
    return {
      providerId: this.providerId,
      modelId,
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
      ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
      cwd: input.cwd,
      enableTools: true,
      enableSpawnAgent: false,
      enableAgentTeams: false,
      mode,
      systemPrompt: this.systemPrompt,
      sessionId,
    };
  }

  private async startFresh(
    cline: ClineCore,
    input: RunInput,
    modelId: string,
    mode: AgentMode,
    handle: ActiveHandle,
  ): Promise<AgentResult | undefined> {
    const sessionId = newId("cls");
    handle.sessionId = sessionId;
    const config = this.buildConfig(input, modelId, mode, sessionId);
    const promptText = composePromptWithBootstrap(input.bootstrapText, input.prompt.text);
    const userImages = this.buildUserImages(input);
    const startRes = await cline.start({
      prompt: promptText,
      interactive: true,
      ...(userImages ? { userImages } : {}),
      config,
    });
    handle.sessionId = startRes.sessionId ?? sessionId;
    return startRes.result;
  }

  private isUnusable(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /session_not_found|session .*not found|unusable/i.test(msg);
  }

  private async buildResult(
    handle: ActiveHandle,
    modelId: string,
    result: AgentResult | undefined,
    startedAt: number,
    emit: Emit,
  ): Promise<RunResultData> {
    const durationMs = Date.now() - startedAt;

    const usageSource: UsageLike | undefined =
      result?.usage ?? (await this.accumulatedUsage(handle.sessionId));
    const usage = usageSource ? toTokenUsage(usageSource) : undefined;
    const cost = usage ? buildCostInfo(usage, modelId, usageSource?.totalCost) : undefined;

    const status: RunResultData["status"] =
      !result
        ? "finished"
        : result.finishReason === "error"
          ? "error"
          : result.finishReason === "aborted"
            ? "cancelled"
            : "finished";

    const errorMessage = status === "error" ? handle.lastError ?? "agent run failed" : undefined;

    await emit(
      status === "error" ? "run_error" : status === "cancelled" ? "run_cancelled" : "run_completed",
      {
        status,
        result: result?.text,
        ...(errorMessage ? { error: errorMessage } : {}),
        durationMs,
        modelCalls: handle.modelCalls,
        toolCalls: handle.toolCalls,
      },
      usage,
      cost,
    );

    return {
      status,
      result: result?.text,
      ...(errorMessage ? { error: errorMessage } : {}),
      durationMs,
      usage,
      cost,
      modelCalls: handle.modelCalls,
      toolCalls: handle.toolCalls,
      agentId: handle.sessionId,
    };
  }

  private async accumulatedUsage(sessionId: string): Promise<UsageLike | undefined> {
    try {
      const summary = await this.client?.getAccumulatedUsage(sessionId);
      return summary?.usage;
    } catch {
      return undefined;
    }
  }
}
