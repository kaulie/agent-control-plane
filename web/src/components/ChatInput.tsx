import { useRef, useState } from "react";

export type AgentMode = "agent" | "plan";

const MODE_STORAGE_KEY = "web-cursor:agentMode";

function loadStoredMode(): AgentMode {
  try {
    const v = localStorage.getItem(MODE_STORAGE_KEY);
    if (v === "plan" || v === "agent") return v;
  } catch {
    /* ignore */
  }
  return "agent";
}

function storeMode(mode: AgentMode): void {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

export interface ChatImage {
  /** Local preview object URL / data URL for UI. */
  previewUrl: string;
  /** Raw base64 without data: prefix. */
  data: string;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface ChatPayload {
  text: string;
  images: ChatImage[];
  mode: AgentMode;
}

interface Props {
  onSend: (payload: ChatPayload) => void;
  onStop?: () => void;
  disabled: boolean;
  running: boolean;
  /** Mode of the currently executing run (not queued messages). */
  activeRunMode?: AgentMode;
  queueLength?: number;
  stopping?: boolean;
}

const ALLOWED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGES = 5;
const MAX_BYTES = 4 * 1024 * 1024;

function readFileAsImage(file: File): Promise<ChatImage> {
  return new Promise((resolve, reject) => {
    if (!ALLOWED.has(file.type)) {
      reject(new Error(`Unsupported type: ${file.type || file.name}`));
      return;
    }
    if (file.size > MAX_BYTES) {
      reject(new Error(`Each image must be ≤ ${MAX_BYTES / (1024 * 1024)}MB`));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const m = /^data:([^;]+);base64,(.+)$/s.exec(result);
      if (!m) {
        reject(new Error("Invalid image data"));
        return;
      }
      const mimeType = m[1];
      const data = m[2];
      const img = new Image();
      img.onload = () => {
        resolve({
          previewUrl: result,
          data,
          mimeType,
          width: img.naturalWidth || undefined,
          height: img.naturalHeight || undefined,
        });
      };
      img.onerror = () => {
        resolve({ previewUrl: result, data, mimeType });
      };
      img.src = result;
    };
    reader.readAsDataURL(file);
  });
}

export default function ChatInput({
  onSend,
  onStop,
  disabled,
  running,
  activeRunMode,
  queueLength = 0,
  stopping = false,
}: Props) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ChatImage[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  // The mode is always user-chosen; it is never forced by the workflow state.
  // Only the user's last selection is remembered (localStorage).
  const [mode, setMode] = useState<AgentMode>(loadStoredMode);

  const fileRef = useRef<HTMLInputElement>(null);
  const effectiveMode: AgentMode = mode;

  const canSend =
    (!!text.trim() || images.length > 0) && !disabled && !stopping;

  const selectMode = (next: AgentMode): void => {
    setMode(next);
    storeMode(next);
  };

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    setAttachError(null);
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!list.length) {
      setAttachError("Only PNG, JPEG, GIF, or WebP images are supported");
      return;
    }
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      setAttachError(`At most ${MAX_IMAGES} images per message`);
      return;
    }
    const toAdd = list.slice(0, room);
    try {
      const loaded = await Promise.all(toAdd.map(readFileAsImage));
      setImages((prev) => [...prev, ...loaded]);
      if (list.length > room) {
        setAttachError(`Only ${MAX_IMAGES} images allowed; extras ignored`);
      }
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeImage = (idx: number): void => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  };

  const submit = (): void => {
    if (!canSend) return;
    onSend({ text: text.trim(), images, mode: effectiveMode });
    setText("");
    setImages([]);
    setAttachError(null);
  };

  const placeholder = running
    ? queueLength > 0
      ? `Agent 工作中，另有 ${queueLength} 条消息排队…`
      : "Agent 工作中，消息将加入队列…"
    : effectiveMode === "plan"
      ? "Describe what to plan… (read-only planning mode)"
      : "Send an instruction… (paste or attach images)";

  const modeSelectTitle = running
    ? "切换模式不会中断当前任务，仅影响下一条排队消息"
    : "Agent 可编辑代码；Plan 只读规划（由模型运行时控制，与工作流阶段无关）";

  return (
    <div className="chat-input">
      {images.length > 0 && (
        <div className="chat-image-previews">
          {images.map((img, i) => (
            <div key={`${img.mimeType}-${i}`} className="chat-image-thumb">
              <img src={img.previewUrl} alt={`Attachment ${i + 1}`} />
              <button
                type="button"
                className="chat-image-remove"
                aria-label="Remove image"
                disabled={disabled || stopping}
                onClick={() => removeImage(i)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {attachError && <div className="chat-attach-error">{attachError}</div>}
      {running && activeRunMode && (
        <div className="chat-mode-hint">
          当前{" "}
          <span className={`event-mode event-mode-${activeRunMode}`}>
            {activeRunMode === "plan" ? "Plan" : "Agent"}
          </span>{" "}
          运行中；切换模式不会中断当前任务，仅影响下一条排队消息
        </div>
      )}
      <div className="chat-input-row">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="btn-attach"
          title="Attach images"
          aria-label="Attach images"
          disabled={disabled || stopping || images.length >= MAX_IMAGES}
          onClick={() => fileRef.current?.click()}
        >
          📎
        </button>
        <select
          className="mode-select"
          value={effectiveMode}
          disabled={disabled || stopping}
          aria-label="Conversation mode"
          title={modeSelectTitle}
          onChange={(e) => selectMode(e.target.value as AgentMode)}
        >
          <option value="agent">Agent</option>
          <option value="plan">Plan</option>
        </select>
        <textarea
          value={text}
          placeholder={placeholder}
          disabled={disabled || stopping}
          rows={4}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            const files: File[] = [];
            for (const item of items) {
              if (item.kind === "file" && item.type.startsWith("image/")) {
                const f = item.getAsFile();
                if (f) files.push(f);
              }
            }
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          onDragOver={(e) => {
            if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            if (!e.dataTransfer?.files?.length) return;
            e.preventDefault();
            if (!disabled && !stopping) void addFiles(e.dataTransfer.files);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {running ? (
          <button
            className="btn-stop"
            onClick={() => onStop?.()}
            disabled={stopping || !onStop}
          >
            {stopping ? "Stopping…" : "Stop"}
          </button>
        ) : null}
        <button onClick={submit} disabled={!canSend}>
          {running ? "Queue" : "Send"}
        </button>
      </div>
    </div>
  );
}
