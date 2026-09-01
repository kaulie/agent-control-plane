import type { Project, Task } from "../types";
import { formatTime } from "../format";

interface Props {
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  onCreateProject: () => void;
  onRenameProject: () => void;
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
  tasks,
  selectedId,
  onSelect,
  onCreate,
}: Props) {
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
            title="Rename project"
            onClick={onRenameProject}
            disabled={!selectedProjectId}
          >
            ✎
          </button>
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
              onClick={() => onSelect(t.taskId)}
            >
              <div className="task-title">{t.title || t.taskId}</div>
              <div className="task-meta">
                #{t.taskId.slice(-6)} · {t.status} · {formatTime(t.createdAt)}
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
