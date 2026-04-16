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
  // Detect Swarm references embedded in the message text (bzz:// URIs,
  // gateway URLs, bare hashes) so externally-uploaded files pasted into
  // chat render inline previews just like ACT-uploaded attachments.
  // Dedupe so a ref repeated in text doesn't render twice.
  const detectedRefs = React.useMemo(() => {
    if (!message.text) return [] as DetectedSwarmRef[];
    const refs = detectSwarmRefs(message.text);
    // Exclude the attachment's reference (if any) to avoid duplicate rendering
    const attachmentRef = message.attachment && "reference" in message.attachment
      ? message.attachment.reference
      : undefined;
    return refs.filter((r) => r.reference !== attachmentRef);
  }, [message.text, message.attachment]);

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
      {detectedRefs.map((r) => (
        <div key={r.reference} className="mt-1.5">
          <SwarmLinkPreview hint={r} />
        </div>
      ))}
    </>
  );
}

// ─── External Swarm-link preview (hashes pasted into chat) ─────

type DetectedSwarmRef = {
  reference: string;
  /** Filename hint extracted from the URL path (e.g. /bzz/<ref>/video.mp4) */
  fileName?: string;
};

// Match three patterns with unambiguous prefixes only:
//   bzz://<64hex>[/path]
//   https://<host>/bzz/<64hex>[/path]
//   http://<host>/bzz/<64hex>[/path]
// A bare "/bzz/<hex>" anywhere in text would cause too many false positives
// (e.g. accidental substrings in filenames), so we require an explicit scheme.
const SWARM_REF_RE =
  /(?:bzz:\/\/|https?:\/\/[^\s"'<>]+?\/bzz\/)([0-9a-f]{64})(?:\/([^\s"'<>]+))?/gi;

function detectSwarmRefs(text: string): DetectedSwarmRef[] {
  const out: DetectedSwarmRef[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  SWARM_REF_RE.lastIndex = 0;
  while ((m = SWARM_REF_RE.exec(text)) !== null) {
    const reference = m[1].toLowerCase();
    if (seen.has(reference)) continue;
    seen.add(reference);
    const rawPath = m[2];
    const fileName = rawPath ? decodeURIComponent(rawPath.split("/").pop() ?? "") : undefined;
    out.push({ reference, fileName });
  }
  return out;
}

function SwarmLinkPreview({ hint }: { hint: DetectedSwarmRef }) {
  const [meta, setMeta] = useState<
    | { status: "loading" }
    | { status: "ready"; mimeType: string; sizeBytes: number; fileName: string }
    | { status: "error"; message: string }
  >({ status: "loading" });

  React.useEffect(() => {
    let cancelled = false;
    const manager = (globalThis as any).window?.ph?.swarm?.chat?.manager;
    if (!manager) {
      setMeta({ status: "error", message: "Chat not initialized" });
      return;
    }
    manager
      .probeSwarmReference(hint.reference)
      .then((probe: { mimeType: string; sizeBytes: number; fileName?: string }) => {
        if (cancelled) return;
        const fileName =
          hint.fileName ||
          probe.fileName ||
          `${hint.reference.slice(0, 8)}.${guessExtension(probe.mimeType)}`;
        setMeta({ status: "ready", mimeType: probe.mimeType, sizeBytes: probe.sizeBytes, fileName });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMeta({ status: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
  }, [hint.reference]);

  if (meta.status === "loading") {
    return (
      <div className="flex max-w-[420px] items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-[12px] text-gray-500">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="animate-spin">
          <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
        </svg>
        Probing Swarm link…
      </div>
    );
  }

  if (meta.status === "error") {
    return (
      <div className="max-w-[420px] rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
        <div className="font-semibold">Swarm link unavailable</div>
        <div className="mt-0.5 font-mono text-[10px] text-amber-700">{hint.reference.slice(0, 12)}…</div>
        <div className="mt-0.5 text-[11px] text-amber-700">{meta.message}</div>
      </div>
    );
  }

  // Construct a FileAttachment with no ACT fields — SwarmFile.download will
  // fall through to a plain /bzz/ fetch. The rendering layer treats this
  // identically to a chat-uploaded file.
  const pseudoAttachment: FileAttachment = {
    kind: "file",
    reference: hint.reference,
    fileName: meta.fileName,
    mimeType: meta.mimeType,
    sizeBytes: meta.sizeBytes,
  };

  return (
    <div>
      <div className="mb-0.5 inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
        </svg>
        Swarm link · public
      </div>
      <FileAttachmentCard file={pseudoAttachment} />
    </div>
  );
}

function guessExtension(mime: string): string {
  if (mime.startsWith("image/")) return mime.split("/")[1] || "img";
  if (mime.startsWith("video/")) return mime.split("/")[1] || "mp4";
  if (mime.startsWith("audio/")) return mime.split("/")[1] || "audio";
  if (mime === "application/pdf") return "pdf";
  if (mime === "application/json") return "json";
  if (mime.startsWith("text/")) return mime.split("/")[1] || "txt";
  return "bin";
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

function canBrowserPlay(mimeType: string): boolean {
  if (typeof document === "undefined") return true;
  const v = document.createElement("video");
  const result = v.canPlayType(mimeType);
  // "" = definitely no, "maybe" / "probably" = give it a try.
  return result !== "";
}

function VideoAttachmentCard({ file }: { file: FileAttachment }) {
  // Video is already click-to-load — we never auto-download. Show a size
  // warning for large files so the user knows what Play will cost them,
  // but never block.
  const LARGE_WARN_LIMIT = 20 * 1024 * 1024;
  const isLarge = file.sizeBytes > LARGE_WARN_LIMIT;
  // Pre-flight codec check. If the browser admits it can't play this mime
  // at all (e.g. MKV in Firefox/Safari, HEVC in non-Safari), surface that
  // up front so users don't download hundreds of MB only to hit Chromium's
  // "save file" fallback after playback fails.
  const playable = canBrowserPlay(file.mimeType);

  const [loadRequested, setLoadRequested] = useState(false);
  const [playbackFailed, setPlaybackFailed] = useState(false);
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
            {!playable && (
              <span className="ml-1 text-amber-600">· not playable in this browser</span>
            )}
            {playable && isLarge && !loadRequested && (
              <span className="ml-1 text-amber-600">· large · will take a moment</span>
            )}
          </div>
        </div>
        {playable && !loadRequested && !playbackFailed && (
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
      {!playable && (
        <div className="border-t border-gray-100 bg-gray-50 px-4 py-3 text-[12px] text-gray-600">
          Your browser can't play <code className="font-mono text-[11px]">{file.mimeType}</code>.
          Try Chrome/Chromium, or use the Download button to watch it locally.
        </div>
      )}
      {playable && playbackFailed && (
        <div className="border-t border-gray-100 bg-amber-50 px-4 py-3 text-[12px] text-amber-800">
          This video couldn't be decoded (likely an unsupported codec inside the container).
          Use the Download button to watch it locally.
        </div>
      )}
      {playable && loadRequested && !playbackFailed && (
        <div className="border-t border-gray-100 bg-black">
          {state.status === "ready" ? (
            <video
              src={state.url}
              controls
              preload="metadata"
              onError={() => setPlaybackFailed(true)}
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
