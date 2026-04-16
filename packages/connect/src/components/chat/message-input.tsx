/**
 * Composer — text compose + file attach button + send.
 * Discord-style: larger default height, supports multi-line with Shift+Enter,
 * auto-grows up to a max height, and shows hints.
 */
import React, { useState, useRef, useEffect } from "react";

const ACCENT = "#2563eb";

export function MessageInput({
  onSend,
  onSendFile,
  onShareDocument,
  peerLabel,
  disabled,
  isSending,
}: {
  onSend: (text: string) => void;
  onSendFile: (file: File, text?: string) => void;
  onShareDocument?: () => void;
  peerLabel?: string;
  disabled?: boolean;
  isSending?: boolean;
}) {
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow textarea up to max height
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, 240); // 240px max (≈10 lines)
    el.style.height = `${Math.max(next, 60)}px`; // 60px min (≈2 lines)
  }, [text]);

  // Focus the composer on mount (opening a conversation) and whenever sending
  // finishes, so the user can keep typing without re-clicking the box.
  const wasSendingRef = useRef(false);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (disabled) return;

    // Re-focus when sending transitions from true → false
    if (wasSendingRef.current && !isSending) {
      el.focus();
    }
    wasSendingRef.current = !!isSending;
  }, [isSending, disabled]);

  // Initial focus on mount (once the composer is enabled)
  useEffect(() => {
    if (!disabled && !isSending) {
      textareaRef.current?.focus();
    }
    // Only on mount — subsequent focus is handled by the effect above
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const canSend = text.trim().length > 0 && !disabled && !isSending;
  const placeholder = peerLabel ? `Message ${peerLabel}…` : "Type a message…";

  return (
    <form
      onSubmit={handleSubmit}
      className="shrink-0 bg-white px-5 pb-4 pt-2"
    >
      <div className="rounded-lg border border-gray-200 bg-gray-50 transition-colors focus-within:border-blue-300 focus-within:bg-white">
        {/* Top row: textarea spans full width for comfortable typing */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || isSending}
          rows={2}
          className="block w-full resize-none rounded-lg border-0 bg-transparent px-3 py-2.5 text-sm leading-relaxed text-gray-900 outline-none placeholder:text-gray-400 disabled:opacity-40"
          style={{ minHeight: "60px", maxHeight: "240px" }}
        />
        {/* Bottom toolbar: attach + hint + send */}
        <div className="flex items-center justify-between border-t border-gray-100 px-2 py-1.5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={disabled || isSending}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-40"
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
              accept="image/*,audio/*,video/*,.mkv,.mk3d,.3gp,.3g2,.flv,.f4v,.ts,.mts,.m2ts,.vob,.wmv,.asf,.divx,.xvid,.pdf,.doc,.docx,.txt,.md,.json,.yml,.yaml,.xml,.csv,.log"
            />
            {onShareDocument && (
              <button
                type="button"
                onClick={onShareDocument}
                disabled={disabled || isSending}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-40"
                title="Share a Powerhouse document"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="9" y1="13" x2="15" y2="13" />
                  <line x1="9" y1="17" x2="15" y2="17" />
                </svg>
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="select-none text-[10px] text-gray-400">
              <kbd className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[9px] text-gray-500">Enter</kbd> to send ·{" "}
              <kbd className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[9px] text-gray-500">Shift+Enter</kbd> for newline
            </span>
            <button
              type="submit"
              disabled={!canSend}
              className="flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-semibold text-white transition-colors disabled:opacity-40"
              style={{ backgroundColor: ACCENT }}
              onMouseEnter={(e) => {
                if (canSend) e.currentTarget.style.backgroundColor = "#1d4ed8";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = ACCENT;
              }}
              title="Send message (Enter)"
            >
              {isSending ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
                    <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
                  </svg>
                  Sending
                </>
              ) : (
                <>
                  Send
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                  </svg>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
