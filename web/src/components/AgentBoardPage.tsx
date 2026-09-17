import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorText } from "../api";
import { formatDateTime, formatDuration, formatTokens, shortAgentId } from "../format";
import type { AgentBoard, AgentBoardRow, AgentBoardScope } from "../types";

interface Props {
  /** 打开某个 task（切到该 task 的对话页）。 */
  onOpenTask: (taskId: string, projectId: string) => void;
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
  | "name"
  | "department"
  | "project"
  | "lastActive"
  | "model"
  | "tokens"
  | "duration";

const TEXT_SORTS: SortKey[] = ["name", "department", "project", "model"];

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
    return localStorage.getItem(SCOPE_KEY) === "all" ? "all" : "current";
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

export default function AgentBoardPage({ onOpenTask, onBack }: Props) {
  const [data, setData] = useState<AgentBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<AgentBoardScope>(() => readScope());
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
        r.name,
        r.taskId,
        r.taskTitle,
        r.agentId,
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
        case "name":
          return dir * a.name.localeCompare(b.name);
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
        case "tokens":
          return dir * (a.tokens.totalTokens - b.tokens.totalTokens);
        case "duration":
          return dir * (a.durationMs - b.durationMs);
        case "lastActive":
        default: {
          const at = a.lastActiveAt ? Date.parse(a.lastActiveAt) || 0 : 0;
          const bt = b.lastActiveAt ? Date.parse(b.lastActiveAt) || 0 : 0;
          if (at !== bt) return dir * (at - bt);
          return a.name.localeCompare(b.name);
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
  const shown = useMemo(
    () => ({
      tokens: rows.reduce((n, r) => n + r.tokens.totalTokens, 0),
      durationMs: rows.reduce((n, r) => n + r.durationMs, 0),
      runs: rows.reduce((n, r) => n + r.runCount, 0),
      running: rows.filter((r) => r.running).length,
      current: rows.filter((r) => r.current).length,
    }),
    [rows],
  );

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
            名称 · 所属部门 · project · task · 最后活跃 · 模型 · token · 工作时长
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
        一个 agent = 绑定在 task 上的一个 SDK agent 实例，「名称」用 task 标题，
        「所属部门」取该 task 所属 project 的部门。「消耗 Token」= input + output
        （与用量统计页同一口径），「累计 Duration」= 该 agent 各次 run 的墙钟时长
        之和 —— 两者都只统计这个 agent 自己的 run。
        {data ? ` 数据时间：${formatDateTime(data.generatedAt)}。` : ""}
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
          <div className="stats-card-label">Agent 数（筛选中）</div>
          <div className="stats-card-value">{rows.length}</div>
          {data && rows.length !== data.rows.length && (
            <div className="stats-card-caption">共 {data.totals.agentCount} 个</div>
          )}
        </div>
        <div className="stats-card">
          <div className="stats-card-label">当前 agent</div>
          <div className="stats-card-value stats-card-value-sm">{shown.current}</div>
        </div>
        <div className="stats-card">
          <div className="stats-card-label">运行中</div>
          <div className="stats-card-value stats-card-value-sm">{shown.running}</div>
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
            ? "当前筛选条件下没有 agent。"
            : "还没有 agent：创建 task 并让它跑起来后，这里会按 agent 列出。"}
        </div>
      ) : (
        <div className="stats-scroll">
          <table className="stats-table board-table">
            <thead>
              <tr>
                <th className="board-head-name" onClick={() => toggleSort("name")}>
                  Agent 名称{sortMark("name")}
                </th>
                <th onClick={() => toggleSort("department")}>
                  所属部门{sortMark("department")}
                </th>
                <th onClick={() => toggleSort("project")}>
                  所属 Project{sortMark("project")}
                </th>
                <th className="board-head-task">所属 Task</th>
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
                    <div className="stats-agent">
                      {r.running && <span className="board-badge running">运行中</span>}
                      {!r.current && <span className="board-badge replaced">已接替</span>}
                      <span className="board-agent-name" title={r.name}>
                        {r.name || r.taskId}
                      </span>
                    </div>
                    <div className="stats-agent-sub" title={r.agentId}>
                      {r.provider} · {shortAgentId(r.agentId)}
                      {r.supersededAt
                        ? ` · 接替于 ${formatDateTime(r.supersededAt)}${
                            r.supersededReason === "mode_change" ? "（模式切换）" : ""
                          }`
                        : ""}
                    </div>
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
                    <button
                      type="button"
                      className="board-task-link"
                      title={`${r.taskTitle}\n${r.taskId}\n点击打开这个 task`}
                      onClick={() => onOpenTask(r.taskId, r.projectId)}
                    >
                      #{r.taskId.slice(-6)}
                    </button>
                    <span className={`board-status ${r.taskStatus}`}>
                      {STATUS_LABEL[r.taskStatus]}
                    </span>
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
                    )} · cache write ${r.tokens.cacheWriteTokens.toLocaleString("en-US")}`}
                  >
                    {formatTokens(r.tokens.totalTokens)}
                  </td>
                  <td
                    className="stats-num"
                    title={`${r.runCount} runs · ${formatDuration(r.durationMs)} · model calls ${r.modelCalls} · tool calls ${r.toolCalls}`}
                  >
                    {formatDuration(r.durationMs)}
                    <span className="board-runs"> · {r.runCount} runs</span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="stats-total-row">
                <td className="stats-total-row-label">合计（{rows.length} 个 agent）</td>
                <td />
                <td />
                <td />
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
