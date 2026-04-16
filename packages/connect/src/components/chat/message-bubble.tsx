/**
 * Message list — Discord-style stacked messages.
 *
 * Groups consecutive messages from the same author (within 5 min).
 * First message in a group shows avatar + author header + text.
 * Continuation messages show only text (avatar slot reserved for hover timestamp).
 */
import React from "react";
import type { ChatMessage, FileAttachment, DocumentShareAttachment } from "./types.js";

const ACCENT = "#2563eb";
const GROUP_WINDOW_MS = 5 * 60_000; // Group messages within 5 minutes

interface MessageItemProps {
  message: ChatMessage;
  isOwn: boolean;
  isContinuation: boolean;
  authorDisplay: string;
}

export function MessageItem({
  message,
  isOwn,
  isContinuation,
  authorDisplay,
}: MessageItemProps) {
  const time = formatTime(message.timestamp);

  if (isContinuation) {
    return (
      <div className="group relative flex gap-3 px-5 py-0.5 hover:bg-gray-50">
        <div className="relative w-9 shrink-0">
          <span className="invisible absolute left-0 top-1 w-9 text-right font-mono text-[10px] text-gray-400 group-hover:visible">
            {time}
          </span>
        </div>
        <div className="flex-1 min-w-0 py-px">
          <MessageBody message={message} />
        </div>
      </div>
    );
  }

  // First message in group
  const initials = getInitials(authorDisplay);
  const avatarStyle: React.CSSProperties = isOwn
    ? { backgroundColor: "#dbeafe", color: "#1e40af" }
    : { backgroundColor: "#e5e7eb", color: "#6b7280" };

  return (
    <div className="group flex gap-3 px-5 py-1.5 mt-2 hover:bg-gray-50">
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
        style={avatarStyle}
      >
        {initials}
      </div>
      <div className="flex-1 min-w-0">
        <div className="mb-0.5 flex items-baseline gap-2">
          <span
            className="text-sm font-semibold"
            style={{ color: isOwn ? ACCENT : "#111827" }}
          >
            {isOwn ? "You" : authorDisplay}
          </span>
          <span className="text-[11px] text-gray-400">{time}</span>
        </div>
        <MessageBody message={message} />
      </div>
    </div>
  );
}

function MessageBody({ message }: { message: ChatMessage }) {
  return (
    <>
      {message.text && (
        <p className="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-900">
          {message.text}
        </p>
      )}
      {message.attachment && (
        <div className="mt-1.5">
          {message.attachment.kind === "file" && (
            <FileAttachmentCard file={message.attachment} />
          )}
          {message.attachment.kind === "document-share" && (
            <DocumentShareCard share={message.attachment} />
          )}
        </div>
      )}
    </>
  );
}

function FileAttachmentCard({ file }: { file: FileAttachment }) {
  const ext = (file.fileName.split(".").pop() ?? "file").toUpperCase().slice(0, 4);
  const sizeLabel = formatSize(file.sizeBytes);
  const iconColor = getIconColor(file.mimeType);

  return (
    <div className="flex max-w-[420px] overflow-hidden rounded border border-gray-200 bg-white">
      <div
        className="flex w-11 shrink-0 items-center justify-center text-[10px] font-bold tracking-wide text-white"
        style={{ backgroundColor: iconColor }}
      >
        {ext}
      </div>
      <div className="min-w-0 flex-1 px-3 py-2">
        <div className="truncate text-[13px] font-semibold text-gray-900">
          {file.fileName}
        </div>
        <div className="mt-0.5 text-[11px] text-gray-400">
          {sizeLabel} · {file.mimeType}
        </div>
      </div>
    </div>
  );
}

function DocumentShareCard({ share }: { share: DocumentShareAttachment }) {
  return (
    <div className="max-w-[420px] overflow-hidden rounded border border-gray-200 bg-white">
      <div className="flex">
        <div
          className="flex w-11 shrink-0 items-center justify-center text-[10px] font-bold tracking-wide text-white"
          style={{ backgroundColor: "#7c3aed" }}
        >
          DOC
        </div>
        <div className="min-w-0 flex-1 px-3 py-2">
          <div className="truncate text-[13px] font-semibold text-gray-900">
            {share.driveName}
          </div>
          <div className="mt-0.5 text-[11px] text-gray-400">
            {share.documents.length} document{share.documents.length !== 1 ? "s" : ""}
          </div>
        </div>
      </div>
      {share.documents.length > 0 && (
        <div className="border-t border-gray-100 bg-gray-50 px-3 py-1.5">
          {share.documents.slice(0, 3).map((doc) => (
            <div key={doc.id} className="truncate text-[11px] text-gray-500">
              · {doc.name}
            </div>
          ))}
          {share.documents.length > 3 && (
            <div className="text-[11px] text-gray-400">
              +{share.documents.length - 3} more
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        className="w-full border-t border-gray-100 bg-white px-3 py-1.5 text-[11px] font-semibold hover:bg-gray-50"
        style={{ color: ACCENT }}
        onClick={() => {
          console.log("[Chat] Open shared docs:", share.documents.map(d => d.id));
        }}
      >
        Open in Connect
      </button>
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────

function formatTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getInitials(name: string): string {
  if (name.startsWith("0x")) return name.slice(2, 4).toUpperCase();
  const parts = name.split(/[.\s]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function getIconColor(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "#16a34a";
  if (mimeType === "application/pdf") return "#ca8a04";
  if (mimeType.includes("word") || mimeType.includes("document")) return "#7c3aed";
  if (mimeType.includes("json") || mimeType.includes("javascript")) return "#2563eb";
  if (mimeType.startsWith("audio/")) return "#ec4899";
  if (mimeType.startsWith("video/")) return "#f43f5e";
  return "#6b7280";
}

// ─── Grouping logic ────────────────────────────────────────────

interface GroupedMessage {
  message: ChatMessage;
  isContinuation: boolean;
}

export function groupMessages(
  messages: ChatMessage[],
  myAddress: string,
  activePeer: string | null,
): Array<{ dateLabel: string; messages: GroupedMessage[] }> {
  const sections: Array<{ dateLabel: string; messages: GroupedMessage[] }> = [];
  let lastDate = "";
  let lastAuthor = "";
  let lastTimestamp = 0;

  const isOwn = (msg: ChatMessage): boolean => {
    // `msg.to` may be missing on older stored messages or feed-loaded ones,
    // so fall back to sender comparison.
    if (activePeer && msg.to) return msg.to.toLowerCase() === activePeer.toLowerCase();
    return msg.from.toLowerCase() === myAddress.toLowerCase();
  };

  for (const msg of messages) {
    const msgDate = new Date(msg.timestamp);
    const dateLabel = formatDateLabel(msgDate);
    const msgTime = msgDate.getTime();
    const authorKey = isOwn(msg) ? "__self__" : msg.from.toLowerCase();

    if (dateLabel !== lastDate) {
      sections.push({ dateLabel, messages: [] });
      lastDate = dateLabel;
      lastAuthor = "";
      lastTimestamp = 0;
    }

    const isContinuation =
      authorKey === lastAuthor &&
      msgTime - lastTimestamp < GROUP_WINDOW_MS;

    sections[sections.length - 1].messages.push({ message: msg, isContinuation });
    lastAuthor = authorKey;
    lastTimestamp = msgTime;
  }

  return sections;
}

function formatDateLabel(date: Date): string {
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return "Today";

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";

  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}
