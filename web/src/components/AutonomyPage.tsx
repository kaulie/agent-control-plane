import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "../api";
import { formatDateTime } from "../format";
import type {
  AutonomyMeta,
  AutonomyTaskDetail,
  AutonomyTaskList,
  AutonomyTaskSummary,
} from "../types";

/**
 * 「Autonomy 任务」页：`TASK_ENTRY` 里的新入口执行的任务。
 *
 * ⚠️ **数据源是 autonomy 本身**：控制面只代理（`/api/autonomy/*`），不落库、不缓存业务状态，
 * 也不把它的任务混进侧边栏的本地任务列表。页面标题旁一直写着 autonomy 的地址 / 版本 / LLM 后端，
 * 免得「这条任务到底谁在跑」含糊。
 */
interface Props {
  /** 当前选中的项目（作为列表过滤条件；可切到「全部项目」）。 */
  projectId?: string;
  projectName?: string;
  onBack: () => void;
  /** 刚建好的那条：进页面直接把它展开（从「交给 autonomy」创建后跳过来用）。 */
  highlightTaskId?: string;
}

/** 列表 / 详情轮询间隔（只在有任务在跑时才有意义，见下面的 auto）。 */
const REFRESH_MS = 5000;

/** 状态 → 徽标配色（autonomy 的七态 + stopped）。 */
export function statusClass(status: string | undefined): string {
  const s = (status ?? "").toLowerCase();
  if (s === "running" || s === "pending") return "running";
  if (s === "completed") return "ok";
  if (s === "blocked" || s === "need_input" || s === "unverified") return "warn";
  if (s === "error") return "bad";
  if (s === "stopped") return "stopped";
  return "";
}

/** 详情里要写清「这条任务的世界」（来自 autonomy 的 context_ref / project）。 */
export function worldLine(detail: AutonomyTaskDetail | null): string {
  if (!detail) return "";
  const ref = detail.context_ref ?? {};
  const parts: string[] = [];
  const project = detail.project?.id || (typeof ref.project === "string" ? ref.project : "");
  if (project) parts.push(`project=${project}`);
  const org = detail.project?.organization;
  if (org?.id || org?.name) {
    parts.push(`org=${[org.id, org.name].filter(Boolean).join(" ")}`);
  }
  const repo = detail.project?.git_repo_url;
  if (repo) parts.push(`repo=${repo}`);
  else if (project) parts.push("repo=（未解析出来）");
  return parts.join(" · ");
}

export default function AutonomyPage({
  projectId,
  projectName,
  onBack,
  highlightTaskId,
}: Props) {
  const [meta, setMeta] = useState<AutonomyMeta | null>(null);
  const [list, setList] = useState<AutonomyTaskList | null>(null);
  const [onlyProject, setOnlyProject] = useState(Boolean(projectId));
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<AutonomyTaskDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [at, setAt] = useState("");

  const scopeProjectId = onlyProject ? projectId : undefined;

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [m, l] = await Promise.all([
        api.autonomyMeta(),
        api.autonomyTasks(scopeProjectId),
      ]);
      setMeta(m);
      setList(l);
      setAt(new Date().toISOString());
      setError(l.available ? null : (l.error ?? "autonomy 不可达"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [scopeProjectId]);

  const loadDetail = useCallback(async (taskId: string): Promise<void> => {
    try {
      setDetail(await api.autonomyTask(taskId));
      setDetailError(null);
    } catch (e) {
      setDetail(null);
      setDetailError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (selected) void loadDetail(selected);
    else setDetail(null);
  }, [selected, loadDetail]);

  useEffect(() => {
    if (highlightTaskId) setSelected(highlightTaskId);
  }, [highlightTaskId]);

  useEffect(() => {
    if (!auto) return;
    const t = window.setInterval(() => {
      void load();
      if (selected) void loadDetail(selected);
    }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [auto, load, loadDetail, selected]);

  const tasks: AutonomyTaskSummary[] = list?.tasks ?? [];

  return (
    <main className="stats-page">
      <div className="stats-head">
        <div className="stats-head-left">
          <button type="button" className="icon-btn" title="返回" onClick={onBack}>
            ←
          </button>
          <h2 className="stats-title">Autonomy 任务</h2>
          <span className="stats-subtitle">
            数据源：autonomy {meta?.url || "（未配置）"}
            {meta?.version ? ` · v${meta.version}` : ""}
            {meta?.llmBackend
              ? ` · LLM ${meta.llmBackend}${meta.llmModel ? `/${meta.llmModel}` : ""}`
              : ""}
            {at ? ` · 读于 ${formatDateTime(at)}` : ""}
          </span>
        </div>
      </div>

      <div className="auto-scope" role="group" aria-label="过滤与刷新">
        <label className="runtime-refresh-toggle">
          <input
            type="checkbox"
            checked={onlyProject}
            disabled={!projectId}
            onChange={(e) => setOnlyProject(e.target.checked)}
          />
          只看当前项目{projectName ? `（${projectName}）` : ""}
        </label>
        <label className="runtime-refresh-toggle">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
          />
          自动刷新（{REFRESH_MS / 1000}s）
        </label>
        <button
          type="button"
          className="icon-btn"
          title="立即刷新"
          onClick={() => void load()}
        >
          ⟳
        </button>
        <span className="auto-scope-hint">
          控制面只在这里**代理** autonomy 的接口（不落库）：任务与对话数据的唯一真源是它。
          {loading ? " 刷新中…" : ""}
        </span>
      </div>

      {meta && !meta.available && (
        <div className="auto-banner bad" role="status">
          autonomy 不可达（{meta.error ?? "未知原因"}）—— 新建任务的「交给 autonomy」入口会置灰，
          老入口（本机 agent）不受影响。
        </div>
      )}
      {error && meta?.available !== false && (
        <div className="auto-banner bad" role="status">
          读 autonomy 失败：{error}
        </div>
      )}

      {tasks.length === 0 ? (
        <div className="auto-empty">
          还没有任务{onlyProject && projectId ? "（当前项目下）" : ""}。
          在「新建任务」对话框里选「交给 autonomy」建一条 —— 它会由 autonomy 的 agent 执行。
        </div>
      ) : (
        <table className="auto-table">
          <thead>
            <tr>
              <th>状态</th>
              <th>任务</th>
              <th>project</th>
              <th>agent</th>
              <th>轮次</th>
              <th>最后活动</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr
                key={t.id}
                className={`auto-row${selected === t.id ? " selected" : ""}`}
                onClick={() => setSelected(selected === t.id ? "" : t.id)}
              >
                <td>
                  <span className={`auto-status ${statusClass(t.status)}`}>
                    {t.status || "?"}
                  </span>
                </td>
                <td className="auto-cell-task">
                  <div className="auto-task-id">{t.id}</div>
                  <div className="auto-task-desc" title={t.description}>
                    {t.description || "（没有描述）"}
                  </div>
                </td>
                <td className="auto-cell-dim">{t.projectId || "—"}</td>
                <td className="auto-cell-dim">{t.agentId ?? "—"}</td>
                <td className="auto-cell-dim">{t.turns}</td>
                <td className="auto-cell-dim">
                  {t.lastAt ? formatDateTime(t.lastAt) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected && (
        <section className="auto-detail">
          <div className="auto-detail-head">
            <b>{selected}</b>
            <span className={`auto-status ${statusClass(String(detail?.status ?? ""))}`}>
              {String(detail?.status ?? (detailError ? "读不到" : "…"))}
            </span>
            {detail?.updated_at ? (
              <span className="auto-cell-dim">
                更新于 {formatDateTime(String(detail.updated_at))}
              </span>
            ) : null}
            <button
              type="button"
              className="icon-btn"
              title="只看这一条（关掉详情）"
              onClick={() => setSelected("")}
            >
              ✕
            </button>
          </div>
          {detailError && <div className="auto-banner bad">读详情失败：{detailError}</div>}
          {detail && (
            <>
              <div className="auto-detail-row">
                <span>描述</span>
                <span>{detail.description || "（没有描述）"}</span>
              </div>
              <div className="auto-detail-row">
                <span>世界</span>
                <span>{worldLine(detail) || "—"}</span>
              </div>
              {detail.error ? (
                <div className="auto-detail-row">
                  <span>error</span>
                  <span className="auto-err">{String(detail.error)}</span>
                </div>
              ) : null}
              {(detail.plans ?? []).map((plan, pi) => (
                <div className="auto-detail-row" key={plan.id ?? pi}>
                  <span>计划{plan.id != null ? ` #${plan.id}` : ""}</span>
                  <span>
                    {(plan.steps ?? []).length === 0
                      ? "（还没有步骤）"
                      : (plan.steps ?? []).map((s, si) => (
                          <span key={si} className={`auto-step ${statusClass(s.status)}`}>
                            {s.capability || "step"}:{s.status || "?"}
                          </span>
                        ))}
                  </span>
                </div>
              ))}
              <details className="auto-raw">
                <summary>原始响应（排查用）</summary>
                <pre className="auto-pre">{JSON.stringify(detail, null, 2)}</pre>
              </details>
            </>
          )}
        </section>
      )}
    </main>
  );
}
