/**
 * Message list — Discord-style stacked messages.
 *
 * Groups consecutive messages from the same author (within 5 min).
 * First message in a group shows avatar + author header + text.
 * Continuation messages show only text (avatar slot reserved for hover timestamp).
 */
import React, { useState } from "react";
import { createPortal } from "react-dom";
import type { ChatMessage, FileAttachment, DocumentShareAttachment } from "./types.js";
import { useAttachmentUrl, downloadAttachmentToDisk } from "./use-attachment-url.js";

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
  if (file.mimeType.startsWith("image/")) {
    return <ImageAttachmentCard file={file} />;
  }
  if (file.mimeType === "application/pdf") {
    return <PdfAttachmentCard file={file} />;
  }
  if (file.mimeType.startsWith("audio/")) {
    return <AudioAttachmentCard file={file} />;
  }
  if (file.mimeType.startsWith("video/")) {
    return <VideoAttachmentCard file={file} />;
  }
  if (isTextLike(file)) {
    return <TextAttachmentCard file={file} />;
  }
  return <GenericFileCard file={file} />;
}

function isTextLike(file: FileAttachment): boolean {
  if (file.mimeType.startsWith("text/")) return true;
  if (file.mimeType === "application/json") return true;
  const name = file.fileName.toLowerCase();
  return /\.(txt|md|json|yml|yaml|xml|csv|log|ini|toml|env)$/.test(name);
}

function ImageAttachmentCard({ file }: { file: FileAttachment }) {
  // Load the FULL file (not thumbnail) so animated GIFs keep animating.
  const state = useAttachmentUrl(file);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const sizeLabel = formatSize(file.sizeBytes);

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await downloadAttachmentToDisk(file);
    } catch (err) {
      console.warn("[Chat] Download failed:", err);
    }
  };

  return (
    <>
      <div className="group relative inline-block max-w-[420px] overflow-hidden rounded-lg border border-gray-200 bg-white">
        {state.status === "ready" ? (
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            className="block cursor-zoom-in bg-black/5"
            title="Click to enlarge"
          >
            <img
              src={state.url}
              alt={file.fileName}
              className="block max-h-[320px] max-w-full object-contain"
              loading="lazy"
            />
          </button>
        ) : state.status === "error" ? (
          <div className="flex h-40 w-[280px] items-center justify-center bg-red-50 px-4 text-center text-[12px] text-red-700">
            Failed to load image
            <br />
            <span className="text-[11px] text-red-500">{state.error}</span>
          </div>
        ) : (
          <div className="flex h-40 w-[280px] items-center justify-center bg-gray-50">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5" className="animate-spin">
              <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
            </svg>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-gray-100 bg-white px-2.5 py-1.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-medium text-gray-700" title={file.fileName}>
              {file.fileName}
            </div>
            <div className="text-[10px] text-gray-400">{sizeLabel}</div>
          </div>
          <button
            type="button"
            onClick={handleDownload}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            title="Download"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>
      </div>

      {lightboxOpen && state.status === "ready" && (
        <Lightbox src={state.url} fileName={file.fileName} onClose={() => setLightboxOpen(false)} />
      )}
    </>
  );
}

function GenericFileCard({ file }: { file: FileAttachment }) {
  const ext = (file.fileName.split(".").pop() ?? "file").toUpperCase().slice(0, 4);
  const sizeLabel = formatSize(file.sizeBytes);
  const iconColor = getIconColor(file.mimeType);

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await downloadAttachmentToDisk(file);
    } catch (err) {
      console.warn("[Chat] Download failed:", err);
    }
  };

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
      <button
        type="button"
        onClick={handleDownload}
        className="flex w-10 shrink-0 items-center justify-center text-gray-400 hover:bg-gray-50 hover:text-gray-700"
        title="Download"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </button>
    </div>
  );
}

function AudioAttachmentCard({ file }: { file: FileAttachment }) {
  // Auto-load the audio bytes — audio files are small and users expect
  // the play control to work immediately.
  const state = useAttachmentUrl(file);
  const sizeLabel = formatSize(file.sizeBytes);

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await downloadAttachmentToDisk(file);
    } catch (err) {
      console.warn("[Chat] Download failed:", err);
    }
  };

  return (
    <div className="flex max-w-[460px] flex-col gap-2 rounded-lg border border-gray-200 bg-white p-3">
      <div className="flex items-center gap-2">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-white"
          style={{ backgroundColor: "#ec4899" }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-gray-900" title={file.fileName}>
            {file.fileName}
          </div>
          <div className="mt-0.5 text-[11px] text-gray-400">
            {sizeLabel} · {file.mimeType}
          </div>
        </div>
        <button
          type="button"
          onClick={handleDownload}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          title="Download"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      </div>
      {state.status === "ready" ? (
        <audio
          src={state.url}
          controls
          preload="metadata"
          className="w-full"
        />
      ) : state.status === "error" ? (
        <div className="rounded bg-red-50 px-3 py-2 text-[12px] text-red-700">
          Failed to load audio — {state.error}
        </div>
      ) : (
        <div className="flex h-10 items-center justify-center rounded bg-gray-50">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5" className="animate-spin">
            <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
          </svg>
        </div>
      )}
    </div>
  );
}

function VideoAttachmentCard({ file }: { file: FileAttachment }) {
  // Video is already click-to-load — we never auto-download. Show a size
  // warning for large files so the user knows what Play will cost them,
  // but never block.
  const LARGE_WARN_LIMIT = 20 * 1024 * 1024;
  const isLarge = file.sizeBytes > LARGE_WARN_LIMIT;

  const [loadRequested, setLoadRequested] = useState(false);
  const state = useAttachmentUrl(file, { enabled: loadRequested });
  const sizeLabel = formatSize(file.sizeBytes);

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await downloadAttachmentToDisk(file);
    } catch (err) {
      console.warn("[Chat] Download failed:", err);
    }
  };

  return (
    <div className="max-w-[460px] overflow-hidden rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center gap-2 px-3 py-2">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-white"
          style={{ backgroundColor: "#f43f5e" }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-gray-900" title={file.fileName}>
            {file.fileName}
          </div>
          <div className="mt-0.5 text-[11px] text-gray-400">
            {sizeLabel} · {file.mimeType}
            {isLarge && !loadRequested && (
              <span className="ml-1 text-amber-600">· large · will take a moment</span>
            )}
          </div>
        </div>
        {!loadRequested && (
          <button
            type="button"
            onClick={() => setLoadRequested(true)}
            className="shrink-0 rounded-md bg-blue-50 px-3 py-1.5 text-[12px] font-semibold text-blue-700 hover:bg-blue-100"
            title={isLarge ? `Download ${sizeLabel} and play inline` : "Play inline"}
          >
            Play
          </button>
        )}
        <button
          type="button"
          onClick={handleDownload}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          title="Download"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      </div>
      {loadRequested && (
        <div className="border-t border-gray-100 bg-black">
          {state.status === "ready" ? (
            <video
              src={state.url}
              controls
              preload="metadata"
              className="block max-h-[360px] w-full bg-black"
            />
          ) : state.status === "error" ? (
            <div className="p-4 text-center text-[12px] text-red-300">
              Failed to load video — {state.error}
            </div>
          ) : (
            <div className="flex h-48 flex-col items-center justify-center gap-2">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2" className="animate-spin">
                <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
              </svg>
              <span className="text-[11px] text-white/70">
                Downloading {sizeLabel} from Swarm…
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PdfAttachmentCard({ file }: { file: FileAttachment }) {
  const [expanded, setExpanded] = useState(false);
  // Only load the PDF bytes once the user expands the preview — don't waste
  // a potentially-large download just because the card rendered.
  const state = useAttachmentUrl(file, { enabled: expanded });
  const sizeLabel = formatSize(file.sizeBytes);

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await downloadAttachmentToDisk(file);
    } catch (err) {
      console.warn("[Chat] Download failed:", err);
    }
  };

  return (
    <div className="max-w-[460px] overflow-hidden rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center">
        <div
          className="flex h-11 w-11 shrink-0 items-center justify-center text-[10px] font-bold tracking-wide text-white"
          style={{ backgroundColor: "#ca8a04" }}
        >
          PDF
        </div>
        <div className="min-w-0 flex-1 px-3 py-2">
          <div className="truncate text-[13px] font-semibold text-gray-900" title={file.fileName}>
            {file.fileName}
          </div>
          <div className="mt-0.5 text-[11px] text-gray-400">
            {sizeLabel} · PDF document
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="shrink-0 px-3 py-2 text-[12px] font-semibold text-blue-600 hover:text-blue-800"
        >
          {expanded ? "Hide" : "Preview"}
        </button>
        <button
          type="button"
          onClick={handleDownload}
          className="flex w-10 shrink-0 items-center justify-center text-gray-400 hover:bg-gray-50 hover:text-gray-700"
          title="Download"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      </div>
      {expanded && (
        <div className="border-t border-gray-100 bg-gray-50">
          {state.status === "ready" ? (
            <iframe
              src={state.url}
              title={file.fileName}
              className="block h-[480px] w-full bg-white"
            />
          ) : state.status === "error" ? (
            <div className="flex h-40 items-center justify-center px-4 text-center text-[12px] text-red-700">
              Failed to load PDF — {state.error}
            </div>
          ) : (
            <div className="flex h-40 items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5" className="animate-spin">
                <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
              </svg>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TextAttachmentCard({ file }: { file: FileAttachment }) {
  const [expanded, setExpanded] = useState(false);
  // Auto-preview only small text files (< 256 KB) so a thread with many
  // CSVs or logs doesn't silently fan-out a fetch storm. Larger files show
  // "Load preview" and only fetch when the user asks.
  const AUTO_PREVIEW_LIMIT = 256 * 1024;
  const tooLargeForAutoPreview = file.sizeBytes > AUTO_PREVIEW_LIMIT;
  const [previewRequested, setPreviewRequested] = useState(!tooLargeForAutoPreview);
  const state = useAttachmentUrl(file, { enabled: previewRequested || expanded });
  const [preview, setPreview] = React.useState<{ lines: string[]; truncated: boolean; error?: string } | null>(null);

  // Fetch the object URL and read it as text for a snippet preview.
  // We re-fetch as text instead of re-downloading because the URL cache
  // already has the blob in memory as an object URL.
  React.useEffect(() => {
    if (state.status !== "ready") return;
    let cancelled = false;
    fetch(state.url)
      .then((r) => r.text())
      .then((text) => {
        if (cancelled) return;
        const PREVIEW_LINES = 15;
        const allLines = text.split(/\r?\n/);
        setPreview({
          lines: allLines.slice(0, PREVIEW_LINES),
          truncated: allLines.length > PREVIEW_LINES,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setPreview({ lines: [], truncated: false, error: String(err) });
      });
    return () => { cancelled = true; };
  }, [state.status === "ready" ? state.url : null, state.status]);

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await downloadAttachmentToDisk(file);
    } catch (err) {
      console.warn("[Chat] Download failed:", err);
    }
  };

  const sizeLabel = formatSize(file.sizeBytes);
  const iconColor = getIconColor(file.mimeType);
  const ext = (file.fileName.split(".").pop() ?? "TXT").toUpperCase().slice(0, 4);

  return (
    <>
      <div className="max-w-[460px] overflow-hidden rounded-lg border border-gray-200 bg-white">
        <div className="flex items-center">
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center text-[10px] font-bold tracking-wide text-white"
            style={{ backgroundColor: iconColor }}
          >
            {ext}
          </div>
          <div className="min-w-0 flex-1 px-3 py-2">
            <div className="truncate text-[13px] font-semibold text-gray-900" title={file.fileName}>
              {file.fileName}
            </div>
            <div className="mt-0.5 text-[11px] text-gray-400">
              {sizeLabel} · {file.mimeType || "text"}
            </div>
          </div>
          {preview && !preview.error && preview.truncated && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="shrink-0 px-3 py-2 text-[12px] font-semibold text-blue-600 hover:text-blue-800"
            >
              View full
            </button>
          )}
          <button
            type="button"
            onClick={handleDownload}
            className="flex w-10 shrink-0 items-center justify-center text-gray-400 hover:bg-gray-50 hover:text-gray-700"
            title="Download"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>
        <div className="border-t border-gray-100 bg-gray-50">
          {!previewRequested ? (
            <button
              type="button"
              onClick={() => setPreviewRequested(true)}
              className="w-full px-3 py-2 text-left text-[12px] font-semibold text-blue-600 hover:bg-blue-50"
            >
              Load preview ({sizeLabel})
            </button>
          ) : preview ? (
            preview.error ? (
              <div className="px-3 py-2 text-[12px] text-red-700">Failed to load — {preview.error}</div>
            ) : (
              <pre className="m-0 max-h-48 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-gray-700">
                {preview.lines.join("\n") || <span className="italic text-gray-400">(empty file)</span>}
                {preview.truncated && (
                  <span className="italic text-gray-400">{"\n…"}</span>
                )}
              </pre>
            )
          ) : (
            <div className="flex h-16 items-center justify-center">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5" className="animate-spin">
                <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
              </svg>
            </div>
          )}
        </div>
      </div>
      {expanded && state.status === "ready" && (
        <TextViewer url={state.url} fileName={file.fileName} onClose={() => setExpanded(false)} />
      )}
    </>
  );
}

function TextViewer({
  url,
  fileName,
  onClose,
}: {
  url: string;
  fileName: string;
  onClose: () => void;
}) {
  const [content, setContent] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prevOverflow; };
  }, []);

  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((r) => r.text())
      .then((text) => !cancelled && setContent(text))
      .catch((err) => !cancelled && setError(String(err)));
    return () => { cancelled = true; };
  }, [url]);

  return createPortal(
    <div
      role="dialog"
      aria-label={`View ${fileName}`}
      data-chat-overlay="true"
      onClick={onClose}
      className="fixed inset-0 z-[999] flex items-center justify-center bg-black/60 p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-gray-200 px-4 py-2.5">
          <h3 className="truncate text-sm font-semibold text-gray-900">{fileName}</h3>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            title="Close (Esc)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        {error ? (
          <div className="p-6 text-sm text-red-700">Failed to load — {error}</div>
        ) : content === null ? (
          <div className="flex h-48 items-center justify-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" className="animate-spin">
              <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
            </svg>
          </div>
        ) : (
          <pre className="m-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12px] leading-relaxed text-gray-800">
            {content}
          </pre>
        )}
      </div>
    </div>,
    document.body,
  );
}

function Lightbox({
  src,
  fileName,
  onClose,
}: {
  src: string;
  fileName: string;
  onClose: () => void;
}) {
  // Body scroll-lock only runs once on mount — if onClose is unstable across
  // parent renders, depending on it here would cause the scroll-lock to
  // flicker every render.
  React.useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prevOverflow; };
  }, []);

  // ESC handler: keep onClose in a ref so the listener never re-registers.
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return createPortal(
    <div
      role="dialog"
      aria-label={`Preview of ${fileName}`}
      data-chat-overlay="true"
      onClick={onClose}
      className="fixed inset-0 z-[999] flex items-center justify-center bg-black/80 p-6"
    >
      <img
        src={src}
        alt={fileName}
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full cursor-default rounded-md shadow-2xl"
      />
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
        title="Close (Esc)"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 truncate rounded bg-black/50 px-3 py-1 text-xs text-white">
        {fileName}
      </div>
    </div>,
    document.body,
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
