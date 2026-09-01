import type { Task } from "../types";
import { formatTime } from "../format";

interface Props {
  tasks: Task[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}

export default function TaskList({ tasks, selectedId, onSelect, onCreate }: Props) {
  return (
    <aside className="task-list">
      <button className="new-task" onClick={onCreate}>
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
        {tasks.length === 0 && <div className="task-empty">No tasks yet</div>}
      </div>
    </aside>
  );
}
