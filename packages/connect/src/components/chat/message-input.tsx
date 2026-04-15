/**
 * Message input with Swarm orange styling.
 */
import React, { useState, useRef } from "react";

const SWARM_ORANGE = "#F7931A";

export function MessageInput({
  onSend,
  onSendFile,
  disabled,
  isSending,
}: {
  onSend: (text: string) => void;
  onSendFile: (file: File, text?: string) => void;
  disabled?: boolean;
  isSending?: boolean;
}) {
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || disabled || isSending) return;
    onSend(trimmed);
    setText("");
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    onSendFile(file, text.trim() || undefined);
    setText("");
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-2 border-t border-orange-100 bg-white px-3 py-2.5">
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={disabled || isSending}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-orange-50 disabled:opacity-40"
        style={{ color: SWARM_ORANGE }}
        title="Attach file"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
        </svg>
      </button>
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={handleFileSelect}
        accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.txt"
      />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a message..."
        disabled={disabled || isSending}
        rows={1}
        className="min-h-[36px] max-h-[120px] flex-1 resize-none rounded-xl border border-orange-200 bg-orange-50/30 px-3 py-2 text-sm outline-none placeholder:text-gray-400 focus:border-orange-400 focus:bg-white disabled:opacity-40"
      />
      <button
        type="submit"
        disabled={!text.trim() || disabled || isSending}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white transition-all hover:brightness-110 disabled:opacity-40"
        style={{ backgroundColor: SWARM_ORANGE }}
        title="Send"
      >
        {isSending ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
            <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        )}
      </button>
    </form>
  );
}
