import type { Project, TaskListRow } from "../types";
import { agentPathLabel } from "../agent-path";
import { formatDateTime } from "../format";
import { taskTypeLabel, taskTypeOption } from "../task-types";
import { taskGoalLabel, taskGoalOption } from "../task-goals";

interface Props {
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  onCreateProject: () => void;
  onRenameProject: () => void;
  onOpenProjectSettings: () => void;
  /** 本地任务 + agent 由 autonomy 创建的任务，合成的一个列表（见 `../autonomy.ts`）。 */
  tasks: TaskListRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}

export default function TaskList({
  projects,
  selectedProjectId,
  onSelectProject,
  onCreateProject,
  onRenameProject,
  onOpenProjectSettings,
  tasks,
  selectedId,
  onSelect,
  onCreate,
}: Props) {
  const selectedProject = projects.find((p) => p.projectId === selectedProjectId);
  const department = selectedProject?.department;

  return (
    <aside className="task-list">
      <div className="project-section">
        <div className="section-label">Project</div>
        <div className="project-row">
          <select
            className="project-select"
            value={selectedProjectId ?? ""}
            onChange={(e) => onSelectProject(e.target.value)}
            disabled={projects.length === 0}
          >
            {projects.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            className="icon-btn"
            title="项目设置"
            onClick={onOpenProjectSettings}
            disabled={!selectedProjectId}
          >
            ⚙
          </button>
          <button
            className="icon-btn"
            title="Rename project"
            onClick={onRenameProject}
            disabled={!selectedProjectId}
          >
            ✎
          </button>
        </div>
        <div className="project-workspace">
          <div className="project-workspace-label">所属部门</div>
          <div className="project-workspace-row">
            <div
              className={`project-workspace-path project-workspace-dept ${
                department ? "" : "is-empty"
              }`}
              title={
                department
                  ? `部门 ID：${department.departmentId ?? "—"}${
                      department.departmentName ? `（${department.departmentName}）` : ""
                    } · 在「项目设置 → 所属部门」修改`
                  : "该项目没有部门；新建项目时部门必填，可在「项目设置 → 所属部门」补上"
              }
            >
              {department
                ? (department.departmentName || department.departmentId)
                : "（未设置）"}
            </div>
          </div>
        </div>
        <button className="new-project" onClick={onCreateProject}>
          + New Project
        </button>
      </div>

      <div className="tasks-section">
        <div className="section-label">Tasks</div>
        <button className="new-task" onClick={onCreate} disabled={!selectedProjectId}>
          + New Task
        </button>
        <div className="task-items">
          {tasks.map((t) => (
            <button
              key={t.taskId}
              className={`task-item ${t.taskId === selectedId ? "selected" : ""}`}
              aria-current={t.taskId === selectedId ? "true" : undefined}
              onClick={() => onSelect(t.taskId)}
            >
              <div className="task-title">
                {/* 类型/目标是**我们**的分类，agent 由 autonomy 创建的任务没有 → 不显示（不是缺字段）。 */}
                {t.agentPath === "autonomy" ? null : (
                  <span
                    className={`task-type-badge type-${t.taskType ?? "general"}`}
                    title={`任务类型：${taskTypeLabel(t.taskType)}（仅作分类，不改变 agent 行为）`}
                  >
                    {taskTypeOption(t.taskType).short}
                  </span>
                )}
                {/* 目标会改变 agent 的交付动作：列表上也标出来（老任务没有目标 → 不显示）。 */}
                {t.goal ? (
                  <span
                    className={`task-goal-badge goal-${t.goal}`}
                    title={`交付目标：${taskGoalLabel(t.goal)}`}
                  >
                    {taskGoalOption(t.goal)?.short ?? taskGoalLabel(t.goal)}
                  </span>
                ) : null}
                <span className="task-title-text" title={t.description}>
                  {t.title || t.taskId}
                </span>
              </div>
              <div className="task-meta">
                #{t.taskId.slice(-6)} · {agentPathLabel(t.agentPath)}
                {/* provider/model：autonomy 侧拿不到就不显示这一段（留空，不写占位）。 */}
                {t.provider ? ` · ${t.provider}${t.model ? `/${t.model}` : ""}` : ""}
                {" · "}
                {t.status} · {formatDateTime(t.lastUserInputAt ?? t.createdAt)}
              </div>
            </button>
          ))}
          {tasks.length === 0 && (
            <div className="task-empty">No tasks in this project</div>
          )}
        </div>
      </div>
    </aside>
  );
}
