import { useState } from "react";

interface Props {
  onSend: (message: string) => void;
  disabled: boolean;
}

export default function ChatInput({ onSend, disabled }: Props) {
  const [text, setText] = useState("");

  const submit = (): void => {
    const m = text.trim();
    if (!m || disabled) return;
    onSend(m);
    setText("");
  };

  return (
    <div className="chat-input">
      <textarea
        value={text}
        placeholder={
          disabled ? "Agent is working…" : "Send an instruction to the agent…"
        }
        disabled={disabled}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button onClick={submit} disabled={disabled || !text.trim()}>
        Send
      </button>
    </div>
  );
}
