import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { PlanDocumentContent, PlanDocumentSummary } from "../types";
import { formatTime } from "../format";

interface Props {
  taskId: string;
  selectedRunId?: string | null;
  onSelectRunId?: (runId: string) => void;
  onOpenSettings?: () => void;
}

function versionLabel(plan: PlanDocumentSummary, index: number): string {
  const time = formatTime(plan.exportedAt);
  const suffix = plan.runId.slice(-6);
  if (index === 0) return `最新 · ${time} · ${suffix}`;
  return `${time} · ${suffix}`;
}

function extractSection(markdown: string, heading: string): string {
  const re = new RegExp(`^## ${heading}\\s*$`, "m");
  const match = re.exec(markdown);
  if (!match || match.index == null) return "";
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const next = rest.search(/^## /m);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

export default function PlanDocumentPanel({
  taskId,
  selectedRunId,
  onSelectRunId,
  onOpenSettings,
}: Props) {
  const [plans, setPlans] = useState<PlanDocumentSummary[]>([]);
  const [activeRunId, setActiveRunId] = useState<string>("");
  const [doc, setDoc] = useState<PlanDocumentContent | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    try {
      const { plans: list } = await api.listPlans(taskId);
      setPlans(list);
      const preferred =
        selectedRunId && list.some((p) => p.runId === selectedRunId)
          ? selectedRunId
          : list[0]?.runId ?? "";
      setActiveRunId((prev) => {
        if (preferred) return preferred;
        if (prev && list.some((p) => p.runId === prev)) return prev;
        return list[0]?.runId ?? "";
      });
    } catch (e) {
      setError(String(e));
      setPlans([]);
      setActiveRunId("");
    } finally {
      setLoadingList(false);
    }
  }, [taskId, selectedRunId]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedRunId && plans.some((p) => p.runId === selectedRunId)) {
      setActiveRunId(selectedRunId);
    }
  }, [selectedRunId, plans]);

  useEffect(() => {
    if (!activeRunId) {
      setDoc(null);
      return;
    }
    let cancelled = false;
    setLoadingDoc(true);
    setError(null);
    void api
      .getPlan(taskId, activeRunId)
      .then((content) => {
        if (!cancelled) setDoc(content);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingDoc(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, activeRunId]);

  const selectRun = (runId: string): void => {
    setActiveRunId(runId);
    onSelectRunId?.(runId);
  };

  const copyPath = async (): Promise<void> => {
    const text = doc?.path ?? doc?.fileName;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  if (loadingList) {
    return <div className="plan-panel plan-panel-loading">加载 Plan 列表…</div>;
  }

  if (!plans.length) {
    return (
      <div className="plan-panel plan-panel-empty">
        <p>暂无 Plan 文档</p>
        <p className="plan-panel-hint">
          使用 <strong>Plan</strong> 模式发送消息，run 成功完成后会出现在这里。
        </p>
        <p className="plan-panel-hint">
          若需自动导出到磁盘，请在
          {onOpenSettings ? (
            <>
              {" "}
              <button type="button" className="plan-link-btn" onClick={onOpenSettings}>
                项目/全局设置
              </button>
            </>
          ) : (
            " 项目/全局设置"
          )}{" "}
          配置 Plan 导出目录。
        </p>
      </div>
    );
  }

  const userRequest = doc ? extractSection(doc.markdown, "User request") : "";
  const planBody = doc ? extractSection(doc.markdown, "Plan") : "";

  return (
    <div className="plan-panel">
      <header className="plan-panel-header">
        <label className="plan-version-label" htmlFor="plan-version-select">
          版本
        </label>
        <select
          id="plan-version-select"
          className="plan-version-select"
          value={activeRunId}
          onChange={(e) => selectRun(e.target.value)}
        >
          {plans.map((p, i) => (
            <option key={p.runId} value={p.runId}>
              {versionLabel(p, i)}
            </option>
          ))}
        </select>
        {doc?.path && (
          <div className="plan-export-meta">
            <span className="plan-export-label">已导出:</span>
            <code className="plan-export-path" title={doc.path}>
              {doc.fileName ?? doc.path}
            </code>
            <button type="button" className="plan-copy-btn" onClick={() => void copyPath()}>
              {copied ? "已复制" : "复制路径"}
            </button>
          </div>
        )}
        {doc && !doc.path && doc.source === "synthesized" && (
          <div className="plan-export-meta plan-export-meta-muted">
            未配置导出目录，内容为运行时合成预览
          </div>
        )}
      </header>

      {error && <div className="plan-panel-error">{error}</div>}

      {loadingDoc ? (
        <div className="plan-panel-loading">加载 Plan 正文…</div>
      ) : doc ? (
        <article className="plan-document">
          <section className="plan-section">
            <h2 className="plan-section-title">用户需求</h2>
            <div className="plan-section-body">
              {userRequest || plans.find((p) => p.runId === activeRunId)?.userText || "（空）"}
            </div>
          </section>
          <section className="plan-section">
            <h2 className="plan-section-title">计划</h2>
            <pre className="plan-section-body plan-section-pre">
              {planBody || doc.markdown}
            </pre>
          </section>
        </article>
      ) : null}
    </div>
  );
}
