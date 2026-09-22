import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorText } from "../api";
import { roundsTitle, taskRollupText } from "../board-format";
import { formatDateTime, formatDuration, formatTokens, shortAgentId } from "../format";
import type { AgentBoard, AgentBoardRow, AgentBoardScope } from "../types";

interface Props {
  /** 打开某个 task（切到该 task 的对话页）。 */
  onOpenTask: (taskId: string, projectId: string) => void;
  /** 打开该 agent 的时间线（idle / thinking / working + 用户输入）。 */
  onOpenTimeline: (agentId: string) => void;
  onBack: () => void;
}

const AUTO_KEY = "agent-board-auto-refresh";
const INTERVAL_KEY = "agent-board-refresh-ms";
const SCOPE_KEY = "agent-board-scope";

const INTERVAL_OPTIONS: Array<{ ms: number; label: string }> = [
  { ms: 30_000, label: "30 秒" },
  { ms: 60_000, label: "1 分钟" },
  { ms: 300_000, label: "5 分钟" },
];

type SortKey =
  | "agentName"
  | "department"
  | "project"
  | "rounds"
  | "lastActive"
  | "model"
  | "tokens"
  | "duration";

const TEXT_SORTS: SortKey[] = ["agentName", "department", "project", "model"];

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === "0" || v === "false") return false;
    if (v === "1" || v === "true") return true;
  } catch {
    /* ignore */
  }
  return fallback;
}

function readIntervalMs(): number {
  try {
    const n = Number(localStorage.getItem(INTERVAL_KEY));
    if (INTERVAL_OPTIONS.some((o) => o.ms === n)) return n;
  } catch {
    /* ignore */
  }
  return 60_000;
}

function readScope(): AgentBoardScope {
  try {
    const v = localStorage.getItem(SCOPE_KEY);
    return v === "all" || v === "task" ? v : "current";
  } catch {
    return "current";
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const diff = Date.now() - ms;
  if (diff < 0) return "刚刚";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} 个月前`;
  return `${Math.floor(month / 12)} 年前`;
}

const STATUS_LABEL: Record<AgentBoardRow["taskStatus"], string> = {
  active: "进行中",
  completed: "已完成",
  error: "出错",
};

type StatusFilter = "all" | AgentBoardRow["taskStatus"];

export default function AgentBoardPage({
  onOpenTask,
  onOpenTimeline,
  onBack,
}: Props) {
  const [data, setData] = useState<AgentBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<AgentBoardScope>(() => readScope());
  /** scope=task：一行 = 整个 task（数字跨它历史上所有 agent 实例）。 */
  const isTaskScope = scope === "task";
  const [projectId, setProjectId] = useState<string>("");
  const [departmentId, setDepartmentId] = useState<string>("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("lastActive");
  const [sortAsc, setSortAsc] = useState(false);
  const [auto, setAuto] = useState(() => readBool(AUTO_KEY, true));
  const [intervalMs, setIntervalMs] = useState(() => readIntervalMs());

  const load = useCallback(async () => {
    try {
      const res = await api.getAgentBoard({
        scope,
        ...(projectId ? { projectId } : {}),
      });
      setData(res);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [scope, projectId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    store(AUTO_KEY, auto ? "1" : "0");
  }, [auto]);

  useEffect(() => {
    store(SCOPE_KEY, scope);
  }, [scope]);

  useEffect(() => {
    store(INTERVAL_KEY, String(intervalMs));
  }, [intervalMs]);

  useEffect(() => {
    if (!auto) return;
    const timer = window.setInterval(() => void load(), intervalMs);
    return () => window.clearInterval(timer);
  }, [auto, intervalMs, load]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const filtered = data.rows.filter((r) => {
      if (
        departmentId !== "" &&
        (r.department?.departmentId ?? "") !== departmentId
      ) {
        return false;
      }
      if (status !== "all" && r.taskStatus !== status) return false;
      if (!q) return true;
      return [
        r.agentName,
        r.agentId,
        r.taskId,
        r.taskTitle,
        r.projectName,
        r.department?.departmentName ?? "",
        r.model ?? "",
        r.provider,
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
    const dir = sortAsc ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case "agentName":
          return dir * a.agentName.localeCompare(b.agentName);
        case "department":
          return (
            dir *
            (a.department?.departmentName ?? "").localeCompare(
              b.department?.departmentName ?? "",
            )
          );
        case "project":
          return dir * a.projectName.localeCompare(b.projectName);
        case "model":
          return dir * (a.model ?? "").localeCompare(b.model ?? "");
        case "rounds":
          return dir * (a.completedRounds - b.completedRounds);
        case "tokens":
          return dir * (a.tokens.totalTokens - b.tokens.totalTokens);
        case "duration":
          return dir * (a.durationMs - b.durationMs);
        case "lastActive":
        default: {
          const at = a.lastActiveAt ? Date.parse(a.lastActiveAt) || 0 : 0;
          const bt = b.lastActiveAt ? Date.parse(b.lastActiveAt) || 0 : 0;
          if (at !== bt) return dir * (at - bt);
          return a.agentName.localeCompare(b.agentName);
        }
      }
    });
  }, [data, query, departmentId, status, sortKey, sortAsc]);

  const toggleSort = (key: SortKey): void => {
    if (key === sortKey) {
      setSortAsc((v) => !v);
      return;
    }
    setSortKey(key);
    setSortAsc(TEXT_SORTS.includes(key));
  };

  /** 合计跟随筛选结果（后端 totals 是全量，筛选后要重新算）。 */
  const shown = useMemo(() => {
    const byTask = new Map<string, AgentBoardRow>();
    for (const r of rows) if (!byTask.has(r.taskId)) byTask.set(r.taskId, r);
    return {
      tokens: rows.reduce((n, r) => n + r.tokens.totalTokens, 0),
      durationMs: rows.reduce((n, r) => n + r.durationMs, 0),
      runs: rows.reduce((n, r) => n + r.runCount, 0),
      rounds: rows.reduce((n, r) => n + r.completedRounds, 0),
      running: rows.filter((r) => r.running).length,
      current: rows.filter((r) => r.current).length,
      /** 涉及多少个 task / 这些 task 一共换过多少个 agent 实例。 */
      tasks: byTask.size,
      agents: [...byTask.values()].reduce((n, r) => n + (r.agentCount ?? 0), 0),
    };
  }, [rows]);

  const sortMark = (key: SortKey): string =>
    sortKey === key ? (sortAsc ? " ▲" : " ▼") : "";

  return (
    <main className="stats-page agent-board">
      <div className="stats-head">
        <div className="stats-head-left">
          <button type="button" className="icon-btn" title="返回" onClick={onBack}>
            ←
          </button>
          <h2 className="stats-title">Agent 看板</h2>
          <span className="stats-subtitle">
            agent 名称（独立于 task）· 所属部门 · project · task · 完成轮次 · 最后活跃
            · 模型 · token · 工作时长
          </span>
        </div>
        <div className="stats-head-right">
          <label className="stats-filter stats-filter-inline">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
            />
            <span>自动刷新</span>
          </label>
          <select
            className="board-interval"
            value={intervalMs}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
            disabled={!auto}
            title="自动刷新间隔"
          >
            {INTERVAL_OPTIONS.map((o) => (
              <option key={o.ms} value={o.ms}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="icon-btn"
            title="立即刷新"
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            ⟳
          </button>
        </div>
      </div>

      <p className="stats-note">
        一个 agent = 绑定在 task 上的一个 SDK agent 实例（`agent-…` / `cls-…`）。
        「Agent 名称」是 agent 自己的名字（由 agent id 归一化），和「所属 Task」里的
        task 标题是两列、互不共用；「所属部门」取该 task 所属 project 的部门。
        「累计完成对话轮次」= 这个 agent 跑完的 run 数（一轮 = 一次 run，取消 / 出错 /
        进行中的不算）。「消耗 Token」= input + output（与用量统计页同一口径），
        「累计 Duration」= 该 agent 各次 run 的墙钟时长之和 —— 两者都只统计这个 agent
        自己的 run。
        {data ? ` 数据时间：${formatDateTime(data.generatedAt)}。` : ""}
      </p>

      <p className="stats-note">
        ⚠️ 同一个 task 会因 succession（模式切换 / 会话不可用）换过多个 agent，每个
        agent 只拥有自己那些 run —— 所以单看一行，数字会比 task 的真实工作量小很多
        （task 行「轮次」列里的「task 累计 …」就是整条 task 的数，含它换过的所有
        agent）。想看 task 的累计，把范围切到「<b>task 汇总</b>」：每个 task 一行，
        轮次 / token / 时长都跨它历史上所有 agent 相加。
      </p>

      <div className="stats-filters">
        <label className="stats-filter">
          <span>范围</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as AgentBoardScope)}
          >
            <option value="current">当前 agent（每个 task 一个）</option>
            <option value="all">全部 agent（含已接替）</option>
            <option value="task">task 汇总（每个 task 一行）</option>
          </select>
        </label>
        <label className="stats-filter">
          <span>所属项目</span>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">全部项目</option>
            {(data?.projects ?? []).map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="stats-filter">
          <span>所属部门</span>
          <select
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
          >
            <option value="">全部部门</option>
            {(data?.departments ?? []).map((d) => (
              <option key={d.departmentId || "__none__"} value={d.departmentId}>
                {d.departmentName}（{d.agentCount}）
              </option>
            ))}
          </select>
        </label>
        <label className="stats-filter">
          <span>task 状态</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
          >
            <option value="all">全部</option>
            <option value="active">进行中</option>
            <option value="completed">已完成</option>
            <option value="error">出错</option>
          </select>
        </label>
        <label className="stats-filter stats-filter-grow">
          <span>搜索</span>
          <input
            type="search"
            value={query}
            placeholder="agent / task / project / 部门 / 模型"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>



      <div className="stats-summary">
        <div className="stats-card">
          <div className="stats-card-label">
            {isTaskScope ? "Task 数（筛选中）" : "Agent 数（筛选中）"}
          </div>
          <div className="stats-card-value">{isTaskScope ? shown.tasks : rows.length}</div>
          {data && rows.length !== data.rows.length && (
            <div className="stats-card-caption">共 {data.totals.agentCount} 个</div>
          )}
        </div>
        <div className="stats-card">
          <div className="stats-card-label">
            {isTaskScope ? "涉及 agent 实例" : "当前 agent"}
          </div>
          <div className="stats-card-value stats-card-value-sm">
            {isTaskScope ? shown.agents : shown.current}
          </div>
          {isTaskScope && (
            <div className="stats-card-caption">这些 task 历史上换过的总数</div>
          )}
        </div>
        <div className="stats-card">
          <div className="stats-card-label">运行中</div>
          <div className="stats-card-value stats-card-value-sm">{shown.running}</div>
        </div>
        <div className="stats-card">
          <div className="stats-card-label">
            累计完成对话轮次{isTaskScope ? "（task 口径）" : ""}
          </div>
          <div className="stats-card-value stats-card-value-sm">{shown.rounds}</div>
          <div className="stats-card-caption">
            {data && rows.length !== data.rows.length
              ? `全部 ${data.totals.completedRounds} · 当前筛选 ${shown.rounds}`
              : `共 ${shown.runs} 次 run`}
          </div>
        </div>
        <div className="stats-card">
          <div className="stats-card-label">消耗 Token</div>
          <div className="stats-card-value">{formatTokens(shown.tokens)}</div>
          <div className="stats-card-caption">
            {data && rows.length !== data.rows.length
              ? `全部 ${formatTokens(data.totals.tokens.totalTokens)} · 当前筛选 ${shown.tokens.toLocaleString("en-US")}`
              : shown.tokens.toLocaleString("en-US")}
          </div>
        </div>
        <div className="stats-card">
          <div className="stats-card-label">累计 Duration</div>
          <div className="stats-card-value">{formatDuration(shown.durationMs)}</div>
          {data && rows.length !== data.rows.length && (
            <div className="stats-card-caption">
              全部 {formatDuration(data.totals.durationMs)}
            </div>
          )}
        </div>
        <div className="stats-card">
          <div className="stats-card-label">Run 数</div>
          <div className="stats-card-value stats-card-value-sm">{shown.runs}</div>
        </div>
      </div>

      {error && (
        <div className="stats-error" onClick={() => setError(null)}>
          {error} ✕
        </div>
      )}

      {loading && !data ? (
        <div className="stats-loading">正在读取 agent 列表…</div>
      ) : rows.length === 0 ? (
        <div className="stats-empty">
          {data && data.rows.length > 0
            ? isTaskScope
              ? "当前筛选条件下没有 task。"
              : "当前筛选条件下没有 agent。"
            : isTaskScope
              ? "还没有 task：创建 task 并让它跑起来后，这里会按 task 汇总。"
              : "还没有 agent：创建 task 并让它跑起来后，这里会按 agent 列出。"}
        </div>
      ) : (
        <div className="stats-scroll">
          <table className="stats-table board-table">
            <thead>
              <tr>
                <th
                  className="board-head-name"
                  onClick={() => toggleSort("agentName")}
                >
                  {isTaskScope ? "Task（汇总）" : "Agent 名称"}
                  {sortMark("agentName")}
                </th>
                <th onClick={() => toggleSort("department")}>
                  所属部门{sortMark("department")}
                </th>
                <th onClick={() => toggleSort("project")}>
                  所属 Project{sortMark("project")}
                </th>
                <th className="board-head-task">
                  {isTaskScope ? "Task ID / 状态" : "所属 Task"}
                </th>
                <th className="board-head-rounds" onClick={() => toggleSort("rounds")}>
                  累计完成对话轮次{isTaskScope ? "（task 口径）" : ""}
                  {sortMark("rounds")}
                </th>
                <th onClick={() => toggleSort("lastActive")}>
                  最后活跃时间{sortMark("lastActive")}
                </th>
                <th onClick={() => toggleSort("model")}>模型{sortMark("model")}</th>
                <th onClick={() => toggleSort("tokens")}>
                  消耗 Token{sortMark("tokens")}
                </th>
                <th onClick={() => toggleSort("duration")}>
                  累计 Duration{sortMark("duration")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={`${r.taskId}::${r.agentId}`}
                  className={`${r.current ? "" : "board-row-replaced"}${
                    r.running ? " board-row-running" : ""
                  }`}
                >
                  <td className="board-cell-name">
                    {r.taskScope ? (
                      <>
                        <div className="stats-agent">
                          {r.running && <span className="board-badge running">运行中</span>}
                          <button
                            type="button"
                            className="board-task-link"
                            title={`${r.taskTitle}\n${r.taskId}\n点击打开这个 task`}
                            onClick={() => onOpenTask(r.taskId, r.projectId)}
                          >
                            {r.taskTitle || `#${r.taskId.slice(-6)}`}
                          </button>
                        </div>
                        <div className="stats-agent-sub">
                          汇总 {r.agentCount ?? 0} 个 agent 实例
                          {r.currentAgentId ? (
                            <>
                              {" · 当前 "}
                              <span className="board-agent-name">
                                {shortAgentId(r.currentAgentId)}
                              </span>
                              <button
                                type="button"
                                className="board-timeline-link"
                                title="看当前 agent 的时间线（idle / thinking / working + 用户输入）"
                                onClick={() => onOpenTimeline(r.currentAgentId as string)}
                              >
                                时间线
                              </button>
                            </>
                          ) : (
                            " · 当前没有绑定 agent"
                          )}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="stats-agent">
                          {r.running && <span className="board-badge running">运行中</span>}
                          {!r.current && <span className="board-badge replaced">已接替</span>}
                          <span
                            className="board-agent-name"
                            title={`${r.agentName}\n${r.agentId}\n${r.provider} SDK agent 实例`}
                          >
                            {r.agentName}
                          </span>
                        </div>
                        <div className="stats-agent-sub" title={r.agentId}>
                          {r.provider}
                          {r.accountLabel ? ` · ${r.accountLabel}` : ""} ·{" "}
                          {shortAgentId(r.agentId)}
                          {r.supersededAt
                            ? ` · 接替于 ${formatDateTime(r.supersededAt)}${
                                r.supersededReason === "mode_change"
                                  ? "（模式切换）"
                                  : r.supersededReason === "gateway_restart"
                                    ? "（网关重启续接）"
                                    : r.supersededReason === "context_rotation"
                                      ? "（上下文轮转）"
                                      : ""
                              }`
                            : ""}
                          <button
                            type="button"
                            className="board-timeline-link"
                            title="看这个 agent 的时间线（idle / thinking / working + 用户输入）"
                            onClick={() => onOpenTimeline(r.agentId)}
                          >
                            时间线
                          </button>
                        </div>
                      </>
                    )}
                  </td>
                  <td className="board-cell-dept">
                    {r.department
                      ? r.department.departmentName || r.department.departmentId
                      : "（未设置）"}
                  </td>
                  <td className="board-cell-project" title={r.projectId}>
                    {r.projectName}
                  </td>
                  <td className="board-cell-task">
                    {r.taskScope ? (
                      <>
                        <span className="board-task-id" title={r.taskId}>
                          #{r.taskId.slice(-6)}
                        </span>
                        <span className={`board-status ${r.taskStatus}`}>
                          {STATUS_LABEL[r.taskStatus]}
                        </span>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="board-task-link"
                          title={`${r.taskTitle}\n${r.taskId}\n点击打开这个 task`}
                          onClick={() => onOpenTask(r.taskId, r.projectId)}
                        >
                          {r.taskTitle || `#${r.taskId.slice(-6)}`}
                        </button>
                        <span className="board-task-id">#{r.taskId.slice(-6)}</span>
                        <span className={`board-status ${r.taskStatus}`}>
                          {STATUS_LABEL[r.taskStatus]}
                        </span>
                      </>
                    )}
                  </td>
                  <td className="stats-num" title={roundsTitle(r)}>
                    {r.completedRounds}
                    <span className="board-runs"> · 共 {r.runCount} runs</span>
                    {/* per-agent 的数字会明显小于 task 的真实工作量：把 task 累计摆在明面上 */}
                    {taskRollupText(r) && (
                      <span className="board-runs board-task-rollup">
                        {" "}
                        · {taskRollupText(r)}
                      </span>
                    )}
                  </td>
                  <td
                    className="stats-num"
                    title={r.lastActiveAt ? formatDateTime(r.lastActiveAt) : "从未活跃"}
                  >
                    {relativeTime(r.lastActiveAt)}
                  </td>
                  <td
                    className="board-cell-model"
                    title={r.model ?? "（provider 默认模型）"}
                  >
                    {r.model ?? `（${r.provider} 默认）`}
                  </td>
                  <td
                    className="stats-num"
                    title={`input ${r.tokens.inputTokens.toLocaleString(
                      "en-US",
                    )} · output ${r.tokens.outputTokens.toLocaleString(
                      "en-US",
                    )} · cache read ${r.tokens.cacheReadTokens.toLocaleString(
                      "en-US",
                    )} · cache write ${r.tokens.cacheWriteTokens.toLocaleString("en-US")}${
                      !r.taskScope && r.taskTotals
                        ? `\ntask 累计（所有 agent 相加）：${formatTokens(
                            r.taskTotals.totalTokens,
                          )} tokens`
                        : ""
                    }`}
                  >
                    {formatTokens(r.tokens.totalTokens)}
                  </td>
                  <td
                    className="stats-num"
                    title={`${r.runCount} runs · ${formatDuration(r.durationMs)} · model calls ${r.modelCalls} · tool calls ${r.toolCalls}${
                      !r.taskScope && r.taskTotals
                        ? `\ntask 累计（所有 agent 相加）：${formatDuration(
                            r.taskTotals.durationMs,
                          )} · ${r.taskTotals.completedRounds} 轮`
                        : ""
                    }`}
                  >
                    {formatDuration(r.durationMs)}
                    <span className="board-runs"> · {r.runCount} runs</span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="stats-total-row">
                <td className="stats-total-row-label">
                  合计（{isTaskScope ? `${shown.tasks} 个 task` : `${rows.length} 个 agent`}）
                </td>
                <td />
                <td />
                <td />
                <td
                  className="stats-total-cell stats-num"
                  title={`完成 ${shown.rounds} / 共 ${shown.runs} runs`}
                >
                  {shown.rounds}
                  <span className="board-runs"> · 共 {shown.runs} runs</span>
                </td>
                <td />
                <td />
                <td className="stats-total-cell stats-num">
                  {formatTokens(shown.tokens)}
                </td>
                <td className="stats-total-cell stats-num">
                  {formatDuration(shown.durationMs)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </main>
  );
}
