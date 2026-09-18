import { ClineCore, Llms } from "@cline/sdk";
import type {
  AgentEvent as ClineAgentEvent,
  AgentMode,
  AgentResult,
  ClineCoreStartConfig,
  CoreSessionEvent,
  MessageWithMetadata,
} from "@cline/sdk";
import type { AgentEvent, AgentSuccessionReason, CostInfo, EventType, TokenUsage } from "../../types.js";
import { newId } from "../../store/db.js";
import { bootstrapEventPayload, composePromptWithBootstrap } from "../../task-context.js";
import { estimateMessagesTokenRange, modelContextLimit } from "../../context/index.js";
import { formatRunErrorMessage } from "../../run-errors.js";
import type { BillingService } from "../../billing/service.js";
import type { AgentProvider, ModelInfo, RunInput, RunResultData } from "../types.js";
import { mapAgentEvent, toTokenUsage, type MappedEvent, type UsageLike } from "./mapper.js";
import {
  buildCostWithBilling,
  DEFAULT_PROVIDER_ID,
  DEFAULT_SYSTEM_PROMPT,
  DEEPSEEK_FALLBACK_MODELS,
  type ClineProviderConfig,
} from "./config.js";

export type { ClineProviderConfig } from "./config.js";

/**
 * seed 体量（透明化 PR-5）：条数之外再给 token 估算 —— 以前 `seeded_messages: 1630`
 * 看不出「切模式把 ≈1M 上下文搬进新会话」，现在两个数都写进事件（尾部 UI 直接显示）。
 *
 * `seededTokens` 用实测比（≈6.4 字符/token），`seededTokensUpperBound` 用 SDK 的保守比
 * （3 字符/token，偏早预警）；两者都记，避免以后分不清这个数是哪来的。
 */
function seedPayload(
  messages: MessageWithMetadata[],
  modelId: string,
): Record<string, unknown> {
  const range = estimateMessagesTokenRange(messages);
  const limit = modelContextLimit("cline", modelId);
  const seededOverLimit = limit ? range.tokensUpperBound >= limit : false;
  if (seededOverLimit) {
    console.warn(
      `[cline] succession seed ≈ ${range.tokens} tokens（保守上界 ${range.tokensUpperBound}）` +
        ` 已达到/超过模型窗口 ${limit} —— 新会话很可能一出生就超限`,
    );
  }
  return {
    seededChars: range.chars,
    seededTokens: range.tokens,
    seededTokensUpperBound: range.tokensUpperBound,
    ...(limit ? { contextLimit: limit } : {}),
    seededOverLimit,
  };
}

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

/** In-memory resident Cline session for a Web Cursor task. */
interface ResidentSession {
  sessionId: string;
  /** Cline mode the session was created / last run with (`plan` | `yolo`). */
  mode: AgentMode;
}

interface SuccessionOpts {
  fromAgentId: string;
  fromMode: AgentMode;
  reason: AgentSuccessionReason;
  emit: Emit;
}

/**
 * AgentProvider implementation backed by the Cline SDK (`@cline/sdk`).
 *
 * One Cline session maps to one Web Cursor task (mirroring the cursor adapter):
 * the first message `start`s a session, follow-up messages `send` on the
 * resident session, and the opaque session id is persisted as `task.agentId`.
 *
 * Resident sessions are mode-sticky: `send({ mode })` does not flip plan-bound
 * tools/system prompt into yolo. On mode change we rebuild like the Cline
 * desktop host: seed `initialMessages` from `readLiveMessages`, mint a new
 * session id, stop the old session, and emit `agent_succession` so lineage is
 * explicit (`agent_successions` table + timeline).
 */
export class ClineProvider implements AgentProvider {
  readonly name = "cline";

  private readonly providerId: string;
  private readonly systemPrompt: string;
  private readonly model?: string;
  private readonly apiKey?: string;
  private readonly baseUrl?: string;
  /** 计费模块（数据源 = `billing_rules` 表）；缺省 = 退回本地价目估算。 */
  private readonly billing?: BillingService;

  private modelsCache: ModelInfo[] | undefined;
  private client: ClineCore | undefined;
  private clientPromise: Promise<ClineCore> | undefined;
  private active = new Map<string, ActiveHandle>();
  private sessionsByTask = new Map<string, ResidentSession>();

  constructor(config: ClineProviderConfig = {}) {
    this.providerId = (config.providerId ?? DEFAULT_PROVIDER_ID).trim() || DEFAULT_PROVIDER_ID;
    this.systemPrompt = (config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT).trim() || DEFAULT_SYSTEM_PROMPT;
    this.model = config.model?.trim() || undefined;
    this.apiKey = config.apiKey?.trim() || undefined;
    this.baseUrl = config.baseUrl?.trim() || undefined;
    this.billing = config.billing;
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
        {
          name?: string;
          contextWindow?: number;
          maxInputTokens?: number;
          maxTokens?: number;
        }
      >;
      const entries = Object.entries(models);
      if (entries.length) {
        // 上下文窗口一起带上：计费/上下文显示都要用（见 context/limits.ts）。
        this.modelsCache = entries.map(([id, m]) => ({
          id,
          displayName: m.name ?? id,
          ...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
          ...(typeof m.maxInputTokens === "number" ? { maxInputTokens: m.maxInputTokens } : {}),
          ...(typeof m.maxTokens === "number" ? { maxTokens: m.maxTokens } : {}),
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
        ? DEEPSEEK_FALLBACK_MODELS.map((m) => ({ ...m }))
        : [];
    return this.modelsCache;
  }

  async resolveModel(): Promise<string | undefined> {
    if (this.model) return this.model;
    const models = await this.listModels();
    return models[0]?.id;
  }

  async run(input: RunInput): Promise<RunResultData> {
    const mode: AgentMode = input.mode === "plan" ? "plan" : "yolo";
    const prior = this.sessionsByTask.get(input.taskId);
    const sameSession = Boolean(input.agentId && prior?.sessionId === input.agentId);
    const modeMismatch = Boolean(sameSession && prior && prior.mode !== mode);
    const resident = Boolean(sameSession && prior && prior.mode === mode);

    const handle: ActiveHandle = {
      cancelled: false,
      taskId: input.taskId,
      runId: input.runId,
      sessionId: resident && input.agentId ? input.agentId : newId("cls"),
      modelCalls: 0,
      toolCalls: 0,
      seenToolCalls: new Set<string>(),
      onEvent: input.onEvent,
    };
    // Register before any await so a Stop click during startup can find and
    // cancel this run (otherwise cancel() returns false → HTTP 400).
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

    try {
      const cline = await this.getClient();
      const modelId = input.model || (await this.resolveModel());
      if (!modelId) {
        throw new Error(
          `No model available for provider "${this.providerId}". ` +
            `Set CLINE_MODEL or check your provider id.`,
        );
      }

      // A Stop click may have landed while we were resolving the client/model.
      if (handle.cancelled) {
        await emit("run_cancelled", {
          durationMs: Date.now() - startedAt,
          modelCalls: handle.modelCalls,
          toolCalls: handle.toolCalls,
          reason: "user_stop",
        });
        return {
          status: "cancelled",
          durationMs: Date.now() - startedAt,
          modelCalls: handle.modelCalls,
          toolCalls: handle.toolCalls,
          agentId: handle.sessionId,
        };
      }

      await emit("run_started", {
        cwd: input.cwd,
        model: modelId,
        mode: input.mode ?? "agent",
        ...(resident ? {} : { sessionCreated: true, ...bootstrapEventPayload(input.bootstrap) }),
      });
      let result: AgentResult | undefined;
      if (resident) {
        try {
          const userImages = this.buildUserImages(input);
          result = await cline.send({
            sessionId: handle.sessionId,
            prompt: input.prompt.text,
            mode,
            ...(userImages ? { userImages } : {}),
          });
        } catch (err) {
          if (!this.isUnusable(err)) throw err;
          console.warn(
            `[cline] session ${handle.sessionId} unusable; succeeding for task ${input.taskId}`,
          );
          result = await this.succeedSession(cline, input, modelId, mode, handle, {
            fromAgentId: handle.sessionId,
            fromMode: mode,
            reason: "session_unusable",
            emit,
          });
        }
      } else if (modeMismatch && prior) {
        console.warn(
          `[cline] session ${prior.sessionId} mode ${prior.mode} → ${mode}; ` +
            `succeeding with seeded history for task ${input.taskId}`,
        );
        result = await this.succeedSession(cline, input, modelId, mode, handle, {
          fromAgentId: prior.sessionId,
          fromMode: prior.mode,
          reason: "mode_change",
          emit,
        });
      } else {
        // 透明化（PR-5）：task 本来绑了会话，但本进程里没有它（网关重启 / 会话失效）→
        // 这次会以启动简报开新会话。以前这件事**完全无感**：用户只觉得 agent 突然失忆。
        if (input.agentId) {
          await emit("status", {
            status: "session_reset",
            message:
              `之前绑定的会话 ${input.agentId} 不在本进程中（网关重启或会话失效），` +
              `本次以启动简报开新会话；完整对话历史仍在本任务时间线里。`,
            previousAgentId: input.agentId,
            mode: input.mode ?? "agent",
          });
        }
        result = await this.startFresh(cline, input, modelId, mode, handle);
      }
      this.sessionsByTask.set(input.taskId, { sessionId: handle.sessionId, mode });

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

  /**
   * Rebuild into a new session id, seeding conversation history from the prior
   * session. Always mints a new id (never reuses) so succession is visible.
   */
  private async succeedSession(
    cline: ClineCore,
    input: RunInput,
    modelId: string,
    mode: AgentMode,
    handle: ActiveHandle,
    opts: SuccessionOpts,
  ): Promise<AgentResult | undefined> {
    this.sessionsByTask.delete(input.taskId);

    let initialMessages: MessageWithMetadata[] = [];
    try {
      initialMessages = (await cline.readLiveMessages(opts.fromAgentId)) ?? [];
    } catch (err) {
      console.warn(
        `[cline] readLiveMessages failed for ${opts.fromAgentId}:`,
        err instanceof Error ? err.message : err,
      );
    }

    const result = await this.startFresh(cline, input, modelId, mode, handle, {
      initialMessages,
      // History already contains the original bootstrap turn when present.
      prependBootstrap: initialMessages.length === 0,
    });

    try {
      await cline.stop(opts.fromAgentId);
    } catch (err) {
      console.warn(
        `[cline] stop old session ${opts.fromAgentId} failed:`,
        err instanceof Error ? err.message : err,
      );
    }

    await opts.emit("agent_succession", {
      provider: "cline",
      fromAgentId: opts.fromAgentId,
      toAgentId: handle.sessionId,
      reason: opts.reason,
      fromMode: opts.fromMode,
      toMode: mode,
      seededMessages: initialMessages.length,
      ...seedPayload(initialMessages, modelId),
    });

    return result;
  }

  private async startFresh(
    cline: ClineCore,
    input: RunInput,
    modelId: string,
    mode: AgentMode,
    handle: ActiveHandle,
    opts?: {
      initialMessages?: MessageWithMetadata[];
      prependBootstrap?: boolean;
    },
  ): Promise<AgentResult | undefined> {
    const sessionId = newId("cls");
    handle.sessionId = sessionId;
    const config = this.buildConfig(input, modelId, mode, sessionId);
    const prependBootstrap = opts?.prependBootstrap !== false;
    const promptText = prependBootstrap
      ? composePromptWithBootstrap(input.bootstrapText, input.prompt.text)
      : input.prompt.text;
    const userImages = this.buildUserImages(input);
    const initialMessages = opts?.initialMessages;
    const startRes = await cline.start({
      prompt: promptText,
      interactive: true,
      ...(userImages ? { userImages } : {}),
      ...(initialMessages?.length ? { initialMessages } : {}),
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
    // 计费走独立模块（`billing_rules` 表）；SDK 上报值仅作对比。
    const cost = usage
      ? buildCostWithBilling(
          this.billing,
          usage,
          modelId,
          new Date(startedAt).toISOString(),
          usageSource?.totalCost,
        )
      : undefined;

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
