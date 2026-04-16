/**
 * Files tab — shows all files shared in a conversation.
 * Extracts file/document attachments from the message list.
 */
import React, { useState, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import type { ChatMessage, FileAttachment, DocumentShareAttachment } from "./types.js";
import { useAttachmentUrl, downloadAttachmentToDisk } from "./use-attachment-url.js";

type AttachedFile = {
  id: string;
  kind: "file" | "document-share";
  name: string;
  meta: string;
  ext: string;
  iconColor: string;
  from: string;
  timestamp: string;
  /** Present only for kind === "file" — used for image previews + downloads */
  attachment?: FileAttachment;
};

export function FilesTab({
  messages,
  myAddress,
}: {
  messages: ChatMessage[];
  myAddress: string;
}) {
  const [filter, setFilter] = useState<"all" | "documents" | "images" | "audio" | "video">("all");
  const [search, setSearch] = useState("");

  const files = useMemo<AttachedFile[]>(() => {
    const out: AttachedFile[] = [];
    for (const msg of messages) {
      if (!msg.attachment) continue;
      if (msg.attachment.kind === "file") {
        out.push(makeFileEntry(msg, msg.attachment, myAddress));
      } else if (msg.attachment.kind === "document-share") {
        out.push(makeDocShareEntry(msg, msg.attachment, myAddress));
      }
    }
    return out.reverse(); // newest first
  }, [messages, myAddress]);

  const filtered = useMemo(() => {
    return files.filter((f) => {
      const mime = f.attachment?.mimeType ?? "";
      if (filter === "documents" && !isDocumentType(f)) return false;
      if (filter === "images" && !mime.startsWith("image/")) return false;
      if (filter === "audio" && !mime.startsWith("audio/")) return false;
      if (filter === "video" && !mime.startsWith("video/")) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!f.name.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [files, filter, search]);

  return (
    <div className="flex-1 overflow-y-auto px-5 pb-5 pt-4">
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
        All files in this conversation
      </h3>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as typeof filter)}
          className="rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-[13px] text-gray-700 outline-none focus:border-blue-400"
        >
          <option value="all">All types</option>
          <option value="documents">Documents</option>
          <option value="images">Images</option>
          <option value="audio">Audio</option>
          <option value="video">Video</option>
        </select>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name…"
          className="flex min-w-[160px] max-w-[320px] flex-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-[13px] outline-none placeholder:text-gray-400 focus:border-blue-400"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-200 py-12 text-center text-sm text-gray-400">
          {files.length === 0
            ? "No files shared yet in this conversation."
            : "No files match your filter."}
        </div>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
          {filtered.map((f) => (
            <FileGridCard key={f.id} file={f} />
          ))}
        </div>
      )}
    </div>
  );
}

function FileGridCard({ file: f }: { file: AttachedFile }) {
  const mime = f.attachment?.mimeType ?? "";
  const isImage = mime.startsWith("image/");
  const isPdf = mime === "application/pdf";
  const isAudio = mime.startsWith("audio/");
  const isVideo = mime.startsWith("video/");
  const isText = isTextLike(mime, f.name);
  const hasPreview = !!f.attachment && (isImage || isPdf || isAudio || isVideo || isText);

  const [previewOpen, setPreviewOpen] = useState(false);

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!f.attachment) return;
    try {
      await downloadAttachmentToDisk(f.attachment);
    } catch (err) {
      console.warn("[Chat] Download failed:", err);
    }
  };

  return (
    <>
      <div className="flex flex-col gap-2 rounded-lg border border-gray-100 bg-white p-3.5 shadow-sm">
        {isImage && f.attachment ? (
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            className="-m-0.5 block overflow-hidden rounded-md bg-gray-100"
            title="Click to enlarge"
          >
            <ImageThumb attachment={f.attachment} />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => hasPreview && setPreviewOpen(true)}
            disabled={!hasPreview}
            className="-m-0.5 flex aspect-video w-full items-center justify-center overflow-hidden rounded-md text-white transition-opacity hover:opacity-90 disabled:cursor-default"
            style={{ backgroundColor: f.iconColor }}
            title={hasPreview ? "Click to preview" : undefined}
          >
            <FileTypeIcon mime={mime} ext={f.ext} />
          </button>
        )}
        <div className="break-all text-[13px] font-semibold text-gray-900">
          {f.name}
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] text-gray-400">{f.meta}</div>
          <div className="flex shrink-0 items-center gap-1">
            {hasPreview && (
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                className="flex h-6 items-center rounded px-2 text-[11px] font-semibold text-blue-600 hover:bg-blue-50"
                title="Preview"
              >
                Open
              </button>
            )}
            {f.attachment && (
              <button
                type="button"
                onClick={handleDownload}
                className="flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                title="Download"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {previewOpen && f.attachment && (
        <AttachmentPreview
          attachment={f.attachment}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </>
  );
}

function isTextLike(mime: string, name: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json") return true;
  return /\.(txt|md|json|yml|yaml|xml|csv|log|ini|toml|env)$/i.test(name);
}

function FileTypeIcon({ mime, ext }: { mime: string; ext: string }) {
  // Lightweight SVG icons by category; falls back to the extension badge.
  if (mime === "application/pdf") {
    return (
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <text x="12" y="17" fontSize="5" fontFamily="sans-serif" fontWeight="700" fill="currentColor" textAnchor="middle" stroke="none">PDF</text>
      </svg>
    );
  }
  if (mime.startsWith("audio/")) {
    return (
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
    );
  }
  if (mime.startsWith("video/")) {
    return (
      <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
        <polygon points="5 3 19 12 5 21 5 3" />
      </svg>
    );
  }
  return <span className="text-[11px] font-bold tracking-wide">{ext}</span>;
}

// ─── Universal preview modal ──────────────────────────────────

function AttachmentPreview({
  attachment,
  onClose,
}: {
  attachment: FileAttachment;
  onClose: () => void;
}) {
  const mime = attachment.mimeType;
  const isImage = mime.startsWith("image/");
  const isPdf = mime === "application/pdf";
  const isAudio = mime.startsWith("audio/");
  const isVideo = mime.startsWith("video/");
  const isText = isTextLike(mime, attachment.fileName);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const onCloseRef = React.useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Images get their own chromeless overlay
  if (isImage) {
    return (
      <FilesTabLightbox
        attachment={attachment}
        fileName={attachment.fileName}
        onClose={onClose}
      />
    );
  }

  const handleDownload = async () => {
    try {
      await downloadAttachmentToDisk(attachment);
    } catch (err) {
      console.warn("[Chat] Download failed:", err);
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-label={`Preview ${attachment.fileName}`}
      data-chat-overlay="true"
      onClick={onClose}
      className="fixed inset-0 z-[999] flex items-center justify-center bg-black/70 p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 px-4 py-2.5">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-gray-900">{attachment.fileName}</h3>
            <p className="text-[11px] text-gray-400">{formatSize(attachment.sizeBytes)} · {mime}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={handleDownload}
              className="flex h-8 items-center gap-1.5 rounded px-3 text-[12px] font-semibold text-blue-600 hover:bg-blue-50"
              title="Download"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-700"
              title="Close (Esc)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center bg-gray-50">
          {isPdf && <PdfPane attachment={attachment} />}
          {isAudio && <AudioPane attachment={attachment} />}
          {isVideo && <VideoPane attachment={attachment} />}
          {isText && <TextPane attachment={attachment} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PdfPane({ attachment }: { attachment: FileAttachment }) {
  const state = useAttachmentUrl(attachment);
  if (state.status === "ready") {
    return (
      <iframe
        src={state.url}
        title={attachment.fileName}
        className="block h-[70vh] w-full bg-white"
      />
    );
  }
  if (state.status === "error") {
    return <div className="p-6 text-sm text-red-700">Failed to load PDF — {state.error}</div>;
  }
  return <SpinnerPane />;
}

function AudioPane({ attachment }: { attachment: FileAttachment }) {
  const state = useAttachmentUrl(attachment);
  if (state.status === "ready") {
    return (
      <div className="w-full px-6 py-8">
        <audio src={state.url} controls autoPlay className="w-full" />
      </div>
    );
  }
  if (state.status === "error") {
    return <div className="p-6 text-sm text-red-700">Failed to load audio — {state.error}</div>;
  }
  return <SpinnerPane />;
}

function VideoPane({ attachment }: { attachment: FileAttachment }) {
  const state = useAttachmentUrl(attachment);
  if (state.status === "ready") {
    return (
      <video
        src={state.url}
        controls
        autoPlay
        className="block max-h-[70vh] w-full bg-black"
      />
    );
  }
  if (state.status === "error") {
    return <div className="p-6 text-sm text-red-700">Failed to load video — {state.error}</div>;
  }
  return (
    <div className="flex h-[50vh] w-full flex-col items-center justify-center gap-2 bg-black">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2" className="animate-spin">
        <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
      </svg>
      <span className="text-[11px] text-white/70">
        Downloading {formatSize(attachment.sizeBytes)} from Swarm…
      </span>
    </div>
  );
}

function TextPane({ attachment }: { attachment: FileAttachment }) {
  const state = useAttachmentUrl(attachment);
  const [content, setContent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (state.status !== "ready") return;
    let cancelled = false;
    fetch(state.url)
      .then((r) => r.text())
      .then((t) => !cancelled && setContent(t))
      .catch((e) => !cancelled && setErr(String(e)));
    return () => { cancelled = true; };
  }, [state.status === "ready" ? state.url : null, state.status]);

  if (state.status === "error") {
    return <div className="p-6 text-sm text-red-700">Failed to load — {state.error}</div>;
  }
  if (err) {
    return <div className="p-6 text-sm text-red-700">Failed to read — {err}</div>;
  }
  if (content === null) return <SpinnerPane />;
  return (
    <pre className="m-0 h-[70vh] w-full overflow-auto whitespace-pre-wrap break-words bg-white px-4 py-3 font-mono text-[12px] leading-relaxed text-gray-800">
      {content || <span className="italic text-gray-400">(empty file)</span>}
    </pre>
  );
}

function SpinnerPane() {
  return (
    <div className="flex h-48 items-center justify-center">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" className="animate-spin">
        <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
      </svg>
    </div>
  );
}

function ImageThumb({ attachment }: { attachment: FileAttachment }) {
  // Prefer the smaller server-side thumbnail for grid previews. Fall back
  // to the full image if the thumbnail is unavailable (non-image uploads
  // don't get one; some older messages might be missing it).
  const hasThumb = !!attachment.thumbnailReference;
  const state = useAttachmentUrl(attachment, { thumbnail: hasThumb });

  if (state.status === "ready") {
    return (
      <img
        src={state.url}
        alt={attachment.fileName}
        loading="lazy"
        className="block aspect-video w-full object-cover"
      />
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex aspect-video w-full items-center justify-center bg-red-50 text-[11px] text-red-600">
        Failed to load
      </div>
    );
  }
  return (
    <div className="flex aspect-video w-full items-center justify-center bg-gray-100">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5" className="animate-spin">
        <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
      </svg>
    </div>
  );
}

function FilesTabLightbox({
  attachment,
  fileName,
  onClose,
}: {
  attachment: FileAttachment;
  fileName: string;
  onClose: () => void;
}) {
  // Lightbox loads the FULL image (not the thumbnail) so GIFs animate.
  const state = useAttachmentUrl(attachment);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prevOverflow; };
  }, []);

  const onCloseRef = React.useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
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
      {state.status === "ready" ? (
        <img
          src={state.url}
          alt={fileName}
          onClick={(e) => e.stopPropagation()}
          className="max-h-full max-w-full cursor-default rounded-md shadow-2xl"
        />
      ) : state.status === "error" ? (
        <div className="rounded-md bg-white px-6 py-4 text-sm text-red-700">Failed to load image</div>
      ) : (
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2" className="animate-spin">
          <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
        </svg>
      )}
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

function makeFileEntry(msg: ChatMessage, file: FileAttachment, myAddress: string): AttachedFile {
  const ext = (file.fileName.split(".").pop() ?? "FILE").toUpperCase().slice(0, 4);
  const size = formatSize(file.sizeBytes);
  const fromLabel = msg.from.toLowerCase() === myAddress.toLowerCase()
    ? "You"
    : `${msg.from.slice(0, 8)}…`;
  return {
    id: msg.id,
    kind: "file",
    name: file.fileName,
    meta: `${size} · ${fromLabel} · ${formatDate(msg.timestamp)}`,
    ext,
    iconColor: getIconColor(file.mimeType),
    from: msg.from,
    timestamp: msg.timestamp,
    attachment: file,
  };
}

function makeDocShareEntry(msg: ChatMessage, share: DocumentShareAttachment, myAddress: string): AttachedFile {
  const fromLabel = msg.from.toLowerCase() === myAddress.toLowerCase()
    ? "You"
    : `${msg.from.slice(0, 8)}…`;
  return {
    id: msg.id,
    kind: "document-share",
    name: share.driveName,
    meta: `${share.documents.length} doc${share.documents.length !== 1 ? "s" : ""} · ${fromLabel} · ${formatDate(msg.timestamp)}`,
    ext: "DOC",
    iconColor: "#7c3aed",
    from: msg.from,
    timestamp: msg.timestamp,
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

function isDocumentType(f: AttachedFile): boolean {
  return f.kind === "document-share" || ["PDF", "DOC", "DOCX", "JSON", "TXT", "XML"].includes(f.ext);
}
