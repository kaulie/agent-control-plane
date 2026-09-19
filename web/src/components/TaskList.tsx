import type { Project, Task } from "../types";
import { formatDateTime } from "../format";
import { taskTypeLabel, taskTypeOption } from "../task-types";

interface Props {
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  onCreateProject: () => void;
  onRenameProject: () => void;
  onSetGitRepoUrl: () => void;
  onOpenProjectSettings: () => void;
  tasks: Task[];
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
  onSetGitRepoUrl,
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
          <div className="project-workspace-label">Git 仓库地址</div>
          <div className="project-workspace-row">
            <div
              className="project-workspace-path"
              title={
                selectedProject?.gitRepoUrl ??
                "未配置；agent 将自行选择要 clone 的仓库"
              }
            >
              {selectedProject?.gitRepoUrl ?? "（未配置）"}
            </div>
            <button
              className="icon-btn"
              title="Set git repository URL"
              onClick={onSetGitRepoUrl}
              disabled={!selectedProjectId}
            >
              🔗
            </button>
          </div>
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
                <span
                  className={`task-type-badge type-${t.taskType ?? "general"}`}
                  title={`任务类型：${taskTypeLabel(t.taskType)}（仅作分类，不改变 agent 行为）`}
                >
                  {taskTypeOption(t.taskType).short}
                </span>
                <span className="task-title-text" title={t.description}>
                  {t.title || t.taskId}
                </span>
              </div>
              <div className="task-meta">
                #{t.taskId.slice(-6)} · {t.provider}
                {t.model ? `/${t.model}` : ""} · {t.status} ·{" "}
                {formatDateTime(t.lastUserInputAt ?? t.createdAt)}
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
