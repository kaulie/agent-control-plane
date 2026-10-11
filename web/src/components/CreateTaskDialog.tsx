import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import type {
  AutonomyAccount,
  AutonomyTarget,
  AutonomyTargets,
  ModelInfo,
  ProviderAccount,
  ProviderInfo,
  TaskEntry,
  TaskGoal,
  TaskType,
} from "../types";
import {
  DEFAULT_TASK_TYPE,
  TASK_TYPE_OPTIONS,
  taskTypeOption,
} from "../task-types";
import { DEFAULT_TASK_GOAL, TASK_GOAL_OPTIONS } from "../task-goals";

export interface CreateTaskInput {
  title?: string;
  description: string;
  taskType: TaskType;
  /** 交付目标（会改变 agent 的动作：合入主分支 / 合入并部署上线）。 */
  goal: TaskGoal;
  provider?: string;
  model?: string;
  accountId?: string;
}

interface Props {
  open: boolean;
  projectId: string;
  projectDefaultProvider?: string;
  projectDefaultModel?: string;
  onClose: () => void;
  onCreate: (input: CreateTaskInput) => Promise<void>;
  /**
   * 入口开关（`TASK_ENTRY`）：`both`（默认，两个入口）/
   * `autonomy`（只留「交给 autonomy」）/ `gateway`（只留现状入口）。
   */
  entry?: TaskEntry;
  /** autonomy 的可用性 / 当前 LLM 后端（来自 `GET /api/autonomy/meta`；null = 还没探到）。 */
  autonomy?: {
    available: boolean;
    backend?: string;
    model?: string;
    error?: string;
  } | null;
  /** 「交给 autonomy」入口：类型 / 目标 / 描述 + 可选的账号 / provider / model。 */
  onCreateAutonomy?: (input: {
    title?: string;
    description: string;
    taskType: TaskType;
    /** 创建时必须指定：合入主分支 / 合入并部署。 */
    goal: TaskGoal;
    /** autonomy 账号池里的账号 id；不传 = 由它的池子解析。 */
    accountId?: string;
    /** 选中的 harness（cursor / cline / codex / claude）；给控制面任务行记一笔。 */
    provider?: string;
    /** 覆盖该账号默认模型；不传 = 用账号自己的 model。 */
    model?: string;
    /** 本机 / 海外；缺省本机。 */
    autonomyTarget?: AutonomyTarget;
  }) => Promise<void>;
}

export default function CreateTaskDialog({
  open,
  projectId,
  projectDefaultProvider,
  projectDefaultModel,
  onClose,
  onCreate,
  entry = "both",
  autonomy = null,
  onCreateAutonomy,
}: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [taskType, setTaskType] = useState<TaskType>(DEFAULT_TASK_TYPE);
  const [goal, setGoal] = useState<TaskGoal>(DEFAULT_TASK_GOAL);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  /** autonomy 的账号池（与上面的 `accounts` 是两个池子）：只在「交给 autonomy」入口用。 */
  const [autonomyAccounts, setAutonomyAccounts] = useState<AutonomyAccount[]>([]);
  const [autonomyAccountsError, setAutonomyAccountsError] = useState<string | null>(null);
  const [autonomyAccountId, setAutonomyAccountId] = useState("");
  /** autonomy 的 provider（harness）：选完才能拉模型目录。 */
  const [autonomyProvider, setAutonomyProvider] = useState("");
  const [autonomyModel, setAutonomyModel] = useState("");
  const [autonomyModels, setAutonomyModels] = useState<string[]>([]);
  const [autonomyModelsLoading, setAutonomyModelsLoading] = useState(false);
  const [autonomyModelsError, setAutonomyModelsError] = useState<string | null>(
    null,
  );
  /** 本机 / 海外：只在「交给 autonomy」时有意义，默认本机。 */
  const [autonomyTarget, setAutonomyTarget] = useState<AutonomyTarget>("local");
  const [autonomyTargets, setAutonomyTargets] = useState<AutonomyTargets | null>(
    null,
  );
  const [envDefault, setEnvDefault] = useState("cursor");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [resolved, setResolved] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 这次用哪个入口建任务（两个入口都在时由用户选，默认现状入口）。 */
  const [entryMode, setEntryMode] = useState<"gateway" | "autonomy">(
    // 首帧就落在正确入口上（只留新入口时别先闪一下老入口的字段）。
    entry === "autonomy" ? "autonomy" : "gateway",
  );

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDescription("");
    setTaskType(DEFAULT_TASK_TYPE);
    setGoal(DEFAULT_TASK_GOAL);
    setProvider(projectDefaultProvider ?? "");
    setModel(projectDefaultModel ?? "");
    setAccountId("");
    setAutonomyAccountId("");
    setAutonomyProvider("");
    setAutonomyModel("");
    setAutonomyModels([]);
    setAutonomyModelsLoading(false);
    setAutonomyModelsError(null);
    setAutonomyTarget("local");
    setError(null);
    // 只留新入口时（TASK_ENTRY=autonomy）直接落在新入口上。
    setEntryMode(entry === "autonomy" ? "autonomy" : "gateway");
    void api.listProviders().then((r) => {
      setProviders(r.providers);
      setEnvDefault(r.defaultProvider);
    });
    void api.listAccounts({ enabled: true }).then((r) => {
      setAccounts(r.accounts);
    }).catch(() => setAccounts([]));
    void api
      .autonomyTargets()
      .then(setAutonomyTargets)
      .catch(() => setAutonomyTargets(null));
  }, [open, projectDefaultProvider, projectDefaultModel, projectId, entry]);

  useEffect(() => {
    if (!open) return;
    // 选哪一台，就读那一台的账号池（两个池子、两套账号）。
    void api
      .autonomyAccounts(autonomyTarget)
      .then((r) => {
        setAutonomyAccounts(r.accounts ?? []);
        setAutonomyAccountsError(r.available ? null : (r.error ?? "读不到 autonomy 的账号池"));
      })
      .catch((e) => {
        setAutonomyAccounts([]);
        setAutonomyAccountsError(errorText(e));
      });
  }, [open, autonomyTarget]);

  const AUTONOMY_HARNESSES = ["cursor", "cline", "codex", "claude"] as const;
  const autonomyProviders = Array.from(
    new Set([
      ...autonomyAccounts.map((a) => a.harness).filter(Boolean),
      ...AUTONOMY_HARNESSES,
    ]),
  );
  const chosenAutonomyAccount = autonomyAccounts.find(
    (a) => a.accountId === autonomyAccountId,
  );
  const autonomyHarness =
    chosenAutonomyAccount?.harness || autonomyProvider || "";
  const autonomyAccountsForProvider = autonomyProvider
    ? autonomyAccounts.filter((a) => a.harness === autonomyProvider)
    : autonomyAccounts;

  useEffect(() => {
    if (!open || entryMode !== "autonomy") return;
    const harness = autonomyHarness;
    if (!harness) {
      setAutonomyModels([]);
      setAutonomyModelsLoading(false);
      setAutonomyModelsError(null);
      return;
    }
    let cancelled = false;
    setAutonomyModelsLoading(true);
    void (async () => {
      let models: string[] = [];
      let catalogueError: string | null = null;
      try {
        const r = await api.autonomyAccountModels(autonomyTarget, {
          harness,
          ...(chosenAutonomyAccount?.vendor
            ? { vendor: chosenAutonomyAccount.vendor }
            : {}),
          ...(chosenAutonomyAccount?.accountId
            ? { accountId: chosenAutonomyAccount.accountId }
            : {}),
        });
        models = (r.models ?? []).map((id) => id.trim()).filter(Boolean);
        if (!r.available) {
          catalogueError = r.error ?? "读不到 autonomy 的模型目录";
        }
      } catch (e) {
        catalogueError = errorText(e);
      }
      // cursor（以及其它 harness 目录为空时）回退到控制面同一套模型目录，
      // 否则下拉只剩「账号默认」，看起来像没加载出来。
      if (models.length === 0) {
        try {
          const fallback = await api.listModels(harness);
          models = (fallback.models ?? [])
            .map((m) => m.id.trim())
            .filter((id) => id && id !== "default");
        } catch {
          /* 控制面没有这个 provider 就保持空，下面再用 harness 默认补 */
        }
      }
      if (models.length === 0 && harness === "cursor") {
        models = ["composer-2", "composer-2.5"];
      }
      if (models.length === 0 && harness === "claude") {
        models = [
          "claude-sonnet-5-5",
          "claude-sonnet-4-6",
          "claude-sonnet-4-5",
          "claude-opus-5-5",
          "claude-opus-4-8",
          "claude-opus-4-6",
          "claude-haiku-5-5",
          "claude-haiku-4-5",
          "claude-fable-5-1",
          "claude-fable-5",
          "sonnet",
          "opus",
          "haiku",
          "fable",
          "opusplan",
        ];
      }
      if (models.length === 0 && harness === "codex") {
        models = [
          "gpt-5.6-sol",
          "gpt-5.6-terra",
          "gpt-5.6-luna",
          "gpt-6.1-sol",
          "gpt-6-sol",
          "gpt-6-luna",
          "gpt-5.5",
          "gpt-5-codex",
          "o3",
          "o4-mini",
        ];
      }
      const accountModel = chosenAutonomyAccount?.model?.trim();
      if (accountModel && !models.includes(accountModel)) {
        models = [accountModel, ...models];
      }
      if (cancelled) return;
      setAutonomyModels(models);
      setAutonomyModelsError(models.length > 0 ? null : catalogueError);
      setAutonomyModelsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, entryMode, autonomyTarget, autonomyHarness, chosenAutonomyAccount]);

  const effectiveProvider =
    provider || projectDefaultProvider || envDefault || "cursor";

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api
      .listModels(effectiveProvider, accountId || undefined)
      .then((r) => {
        if (cancelled) return;
        setModels(r.models);
        setResolved(r.resolved);
      })
      .catch(() => {
        if (!cancelled) {
          setModels([]);
          setResolved(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, effectiveProvider, accountId]);

  if (!open) return null;

  const option = taskTypeOption(taskType);
  const goalOption = TASK_GOAL_OPTIONS.find((g) => g.id === goal)!;
  /** 「交给 autonomy」这一侧：任务由它的 agent 执行。 */
  const autonomyMode = entryMode === "autonomy";
  /** 入口选择器里「交给 autonomy」按钮用（JSX 里名字短一点好读）。 */
  const autoMode0 = autonomyMode;
  const selectedTargetMeta =
    autonomyTarget === "remote"
      ? autonomyTargets?.remote
      : (autonomyTargets?.local ??
        (autonomy
          ? { available: autonomy.available, error: autonomy.error }
          : null));
  const autonomyDown = selectedTargetMeta != null && !selectedTargetMeta.available;
  const selectedBackend =
    autonomyTarget === "remote"
      ? autonomyTargets?.remote?.llmBackend
      : (autonomyTargets?.local?.llmBackend ?? autonomy?.backend);
  const selectedModel =
    autonomyTarget === "remote"
      ? autonomyTargets?.remote?.llmModel
      : (autonomyTargets?.local?.llmModel ?? autonomy?.model);
  const targetLabel = autonomyTarget === "remote" ? "海外" : "本地";
  const autonomyHint = autonomyMode
    ? autonomyDown
      ? `${targetLabel} autonomy 不可达：${selectedTargetMeta?.error ?? "未配置"} —— 先修好它，或改选另一台 / 「本机 agent」入口。`
      : `任务由${targetLabel} autonomy 的 agent 执行。类型是分类标签；目标会写进交给它的需求（合入 / 合入并部署）。当前项目会作为 context_ref.project 带过去。${
          chosenAutonomyAccount
            ? `这条任务跑在 ${chosenAutonomyAccount.harness}/${
                chosenAutonomyAccount.vendor
              } · model ${
                autonomyModel || chosenAutonomyAccount.model || "harness 默认"
              } · 工作目录 ${
                chosenAutonomyAccount.agentRootWorkspace || "运行时默认"
              }。`
            : `账号留空 = 由它的账号池解析（该 harness 的默认账号；进程当前 ${
                selectedBackend ?? "未知"
              }${selectedModel ? ` / ${selectedModel}` : ""}）。`
        }`
    : "";
  const canSubmit =
    description.trim().length > 0 && !saving && !(autonomyMode && autonomyDown);

  /** 标题可选：留空时用描述首行兜底，避免出现 "Task 9/19/2026, …" 这种标题。 */
  const titleOrFallback = (): string | undefined => {
    const t = title.trim();
    if (t) return t;
    const firstLine = description
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (!firstLine) return undefined;
    return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
  };

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      if (autonomyMode) {
        if (!onCreateAutonomy) throw new Error("autonomy 入口未接线");
        const pickedAccountId =
          autonomyAccountId.trim() ||
          (autonomyProvider
            ? (autonomyAccounts.find(
                (a) =>
                  a.harness === autonomyProvider && a.enabled && a.isDefault,
              ) ??
              autonomyAccounts.find(
                (a) => a.harness === autonomyProvider && a.enabled,
              )
            )?.accountId
            : undefined);
        await onCreateAutonomy({
          title: titleOrFallback(),
          description: description.trim(),
          taskType,
          goal,
          accountId: pickedAccountId || undefined,
          provider: autonomyProvider.trim() || chosenAutonomyAccount?.harness,
          model: autonomyModel.trim() || undefined,
          autonomyTarget,
        });
      } else {
        await onCreate({
          title: titleOrFallback(),
          description: description.trim(),
          taskType,
          goal,
          provider: provider.trim() || undefined,
          model: model.trim() || undefined,
          accountId: accountId.trim() || undefined,
        });
      }
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-dialog modal-dialog-wide"
        role="dialog"
        aria-labelledby="create-task-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="create-task-title" className="modal-title">
          New Task
        </h2>
        {entry !== "gateway" && (
          <div className="runtime-field runtime-field-wide">
            <span className="runtime-field-label">入口</span>
            <div className="intent-type-chips">
              {entry === "both" && (
                <button
                  type="button"
                  className={`intent-type-chip ${
                    autoMode0 ? "" : "selected"
                  }`}
                  title="现状入口：在本项目里建任务，由控制面的 agent 执行（行为不变）"
                  onClick={() => setEntryMode("gateway")}
                >
                  本机 agent（现状）
                </button>
              )}
              <button
                type="button"
                className={`intent-type-chip ${autoMode0 ? "selected" : ""}`}
                title={
                  autonomyDown
                    ? `autonomy 不可达：${autonomy?.error ?? "未配置"}`
                    : "把任务指令交给 autonomy，由它自己的 agent 执行（控制面只代理，不落库）"
                }
                onClick={() => setEntryMode("autonomy")}
              >
                交给 autonomy
              </button>
            </div>
            <span className="intent-hint">
              {autoMode0
                ? autonomyHint
                : "在本项目里建任务，由控制面的 agent 执行（现有入口，行为与以前一致）。"}
            </span>
          </div>
        )}
        {autonomyMode && (
          <div className="runtime-field runtime-field-wide">
            <span className="runtime-field-label">执行位置</span>
            <div className="intent-type-chips">
              <button
                type="button"
                className={`intent-type-chip ${
                  autonomyTarget === "local" ? "selected" : ""
                }`}
                title="本地 autonomy（AUTONOMY_API_URL，默认 127.0.0.1:4300）"
                onClick={() => {
                  setAutonomyTarget("local");
                  setAutonomyAccountId("");
                  setAutonomyProvider("");
                  setAutonomyModel("");
                  setAutonomyModels([]);
                }}
              >
                本地
              </button>
              <button
                type="button"
                className={`intent-type-chip ${
                  autonomyTarget === "remote" ? "selected" : ""
                }`}
                title={
                  autonomyTargets && !autonomyTargets.remote.configured
                    ? "海外 autonomy 未配置（AUTONOMY_REMOTE_API_URL）"
                    : "海外机 autonomy（AUTONOMY_REMOTE_API_URL）"
                }
                onClick={() => {
                  setAutonomyTarget("remote");
                  setAutonomyAccountId("");
                  setAutonomyProvider("");
                  setAutonomyModel("");
                  setAutonomyModels([]);
                }}
              >
                海外
              </button>
            </div>
            <span className="intent-hint">
              {autonomyTarget === "remote"
                ? "任务交给海外机上的 autonomy 执行（与本地是两台 runtime、两套账号池）。"
                : "任务交给本地 autonomy 执行。"}
            </span>
          </div>
        )}
        <div className="runtime-field runtime-field-wide">
          <span className="runtime-field-label">类型</span>
          <div className="intent-type-chips">
            {TASK_TYPE_OPTIONS.map((o) => (
              <button
                key={o.id}
                type="button"
                className={`intent-type-chip type-${o.id} ${
                  o.id === taskType ? "selected" : ""
                }`}
                title={o.hint}
                onClick={() => setTaskType(o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <span className="intent-hint">{option.hint}</span>
        </div>
        {/* 目标：和「类型」不同 —— 它会改变 agent 的交付动作（做到哪一步算完），
            所以默认选中「合入主分支」，并把「不部署 / 要部署」写清楚。 */}
        <div className="runtime-field runtime-field-wide">
          <span className="runtime-field-label">目标</span>
          <div className="intent-type-chips">
            {TASK_GOAL_OPTIONS.map((g) => (
              <button
                key={g.id}
                type="button"
                className={`intent-type-chip goal-${g.id} ${
                  g.id === goal ? "selected" : ""
                }`}
                title={g.hint}
                onClick={() => setGoal(g.id)}
              >
                {g.label}
              </button>
            ))}
          </div>
          <span className="intent-hint">
            {goalOption.hint}（会写进投递给 agent 的需求里）
          </span>
        </div>
        <label className="runtime-field runtime-field-wide">
          <span className="runtime-field-label">Title（可选）</span>
          <input
            className="settings-path-input"
            value={title}
            placeholder="留空则用描述首行"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="runtime-field runtime-field-wide">
          <span className="runtime-field-label">
            任务描述 <b className="intent-required">必填</b>
          </span>
          <textarea
            className="intent-textarea"
            value={description}
            placeholder={option.placeholder}
            rows={6}
            autoFocus
            onChange={(e) => setDescription(e.target.value)}
          />
          <span className="intent-hint">
            创建后会作为第一条消息自动投递给 agent，它随即开始工作。
            {option.template ? (
              <button
                type="button"
                className="intent-template-btn"
                onClick={() =>
                  setDescription((prev) => (prev.trim() ? prev : option.template!))
                }
              >
                插入模板
              </button>
            ) : null}
          </span>
        </label>
        {!autonomyMode && (
        <div className="runtime-fields">
          <label className="runtime-field">
            <span className="runtime-field-label">Provider</span>
            <select
              className="runtime-select"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setModel("");
                setAccountId("");
              }}
            >
              <option value="">
                项目/环境默认（
                {projectDefaultProvider || envDefault || "cursor"}）
              </option>
              {(providers.length
                ? providers.map((p) => p.name)
                : ["cursor", "cline"]
              ).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="runtime-field">
            <span className="runtime-field-label">账号</span>
            <select
              className="runtime-select"
              value={accountId}
              onChange={(e) => {
                const next = e.target.value;
                setAccountId(next);
                const hit = accounts.find((a) => a.accountId === next);
                if (hit && hit.provider !== provider) {
                  setProvider(hit.provider);
                  setModel("");
                }
              }}
            >
              <option value="">
                {accounts.some((a) => a.provider === effectiveProvider && a.isDefault)
                  ? "该厂商默认账号"
                  : "自动（该运行时第一条启用账号）"}
              </option>
              {accounts
                .filter((a) => a.provider === effectiveProvider)
                .map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.provider === "cline" ? `${a.vendor} / ${a.label}` : a.label}
                    {a.isDefault ? "（默认）" : ""}
                  </option>
                ))}
            </select>
          </label>
          <label className="runtime-field">
            <span className="runtime-field-label">Model</span>
            <select
              className="runtime-select"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">
                {projectDefaultModel
                  ? `项目默认：${projectDefaultModel}`
                  : resolved
                    ? `自动：${resolved}`
                    : "自动 / 未指定"}
              </option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName || m.id}
                </option>
              ))}
            </select>
          </label>
        </div>
        )}
        {autonomyMode && (
          <div className="runtime-fields">
            <label className="runtime-field">
              <span className="runtime-field-label">Provider</span>
              <select
                className="runtime-select"
                value={autonomyProvider}
                onChange={(e) => {
                  const next = e.target.value;
                  setAutonomyProvider(next);
                  setAutonomyModel("");
                  if (
                    chosenAutonomyAccount &&
                    next &&
                    chosenAutonomyAccount.harness !== next
                  ) {
                    setAutonomyAccountId("");
                  }
                }}
              >
                <option value="">由账号 / 池子决定</option>
                {autonomyProviders.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="runtime-field">
              <span className="runtime-field-label">
                账号{" "}
                <span className="intent-hint">（autonomy 的账号池）</span>
              </span>
              <select
                className="runtime-select"
                value={autonomyAccountId}
                onChange={(e) => {
                  const next = e.target.value;
                  setAutonomyAccountId(next);
                  setAutonomyModel("");
                  const hit = autonomyAccounts.find((a) => a.accountId === next);
                  if (hit && hit.harness !== autonomyProvider) {
                    setAutonomyProvider(hit.harness);
                  }
                }}
              >
                <option value="">
                  由 autonomy 的账号池解析（该 harness 的默认账号）
                </option>
                {autonomyAccountsForProvider.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {`${a.harness} / ${a.vendor}`}
                    {a.model ? ` · ${a.model}` : ""}
                    {` — ${a.label}`}
                    {a.isDefault ? "（默认）" : ""}
                    {a.enabled ? "" : "（已停用）"}
                  </option>
                ))}
              </select>
            </label>
            <label className="runtime-field">
              <span className="runtime-field-label">Model</span>
              <input
                className="runtime-select"
                list="autonomy-model-options"
                value={autonomyModel}
                disabled={!autonomyHarness}
                placeholder={
                  autonomyModelsLoading
                    ? "加载模型中…"
                    : chosenAutonomyAccount?.model
                      ? `账号默认：${chosenAutonomyAccount.model}`
                      : "账号 / harness 默认（可手填）"
                }
                title={
                  autonomyHarness
                    ? "Codex / Claude 可从列表选，也可手填 CLI 认的 id"
                    : "先选 Provider 或账号，再选模型"
                }
                onChange={(e) => setAutonomyModel(e.target.value)}
              />
              <datalist id="autonomy-model-options">
                {autonomyModels.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
            </label>
            {autonomyAccountsError && (
              <span className="intent-hint">
                读不到 autonomy 的账号池：{autonomyAccountsError}（留空仍可建任务，交给它的池子解析）
              </span>
            )}
            {autonomyModelsError && autonomyHarness && (
              <span className="intent-hint">
                读不到模型目录：{autonomyModelsError}（可留空，用账号默认）
              </span>
            )}
          </div>
        )}
        {autonomyMode && autonomyHint && (
          <div className="intent-hint">{autonomyHint}</div>
        )}
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="modal-cancel" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="settings-save"
            disabled={!canSubmit}
            title={
              canSubmit
                ? undefined
                : autonomyMode && autonomyDown
                  ? "autonomy 不可达，先修好它或用「本机 agent」入口"
                  : "任务描述必填"
            }
            onClick={() => void submit()}
          >
            {saving
              ? autonomyMode
                ? "提交中…"
                : "创建中…"
              : autonomyMode
                ? "交给 autonomy 创建"
                : "创建并开始"}
          </button>
        </div>
      </div>
    </div>
  );
}
