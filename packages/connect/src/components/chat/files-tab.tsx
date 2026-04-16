/**
 * Files tab — shows all files shared in a conversation.
 * Extracts file/document attachments from the message list.
 */
import React, { useState, useMemo } from "react";
import type { ChatMessage, FileAttachment, DocumentShareAttachment } from "./types.js";

type AttachedFile = {
  id: string;
  kind: "file" | "document-share";
  name: string;
  meta: string;
  ext: string;
  iconColor: string;
  from: string;
  timestamp: string;
};

export function FilesTab({
  messages,
  myAddress,
}: {
  messages: ChatMessage[];
  myAddress: string;
}) {
  const [filter, setFilter] = useState<"all" | "documents" | "images">("all");
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
      if (filter === "documents" && !isDocumentType(f)) return false;
      if (filter === "images" && f.ext !== "PNG" && f.ext !== "JPG" && f.ext !== "GIF" && f.ext !== "SVG" && f.ext !== "WEBP") return false;
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
            <div
              key={f.id}
              className="flex flex-col gap-2 rounded-lg border border-gray-100 bg-white p-3.5 shadow-sm"
            >
              <div
                className="flex h-11 w-10 items-center justify-center rounded-md text-[10px] font-bold tracking-wide text-white"
                style={{ backgroundColor: f.iconColor }}
              >
                {f.ext}
              </div>
              <div className="break-all text-[13px] font-semibold text-gray-900">
                {f.name}
              </div>
              <div className="text-[11px] text-gray-400">{f.meta}</div>
            </div>
          ))}
        </div>
      )}
    </div>
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
