import { useState } from "react";

interface Props {
  onSend: (message: string) => void;
  onStop?: () => void;
  disabled: boolean;
  running: boolean;
  stopping?: boolean;
}

export default function ChatInput({
  onSend,
  onStop,
  disabled,
  running,
  stopping = false,
}: Props) {
  const [text, setText] = useState("");

  const submit = (): void => {
    const m = text.trim();
    if (!m || disabled || running) return;
    onSend(m);
    setText("");
  };

  return (
    <div className="chat-input">
      <textarea
        value={text}
        placeholder={
          running
            ? "Agent is working… click Stop to cancel"
            : "Send an instruction to the agent…"
        }
        disabled={running}
        rows={2}
        onChange={(e) => setText(e.target.value)}
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
      ) : (
        <button onClick={submit} disabled={disabled || !text.trim()}>
          Send
        </button>
      )}
    </div>
  );
}
