/**
 * Message bubble with Swarm orange styling.
 */
import React from "react";
import type { ChatMessage, FileAttachment, DocumentShareAttachment } from "./types.js";
import { getFileCategory } from "./types.js";

const SWARM_ORANGE = "#F7931A";

export function MessageBubble({
  message,
  isOwn,
}: {
  message: ChatMessage;
  isOwn: boolean;
}) {
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className={`flex ${isOwn ? "justify-end" : "justify-start"} mb-2`}>
      <div
        className="max-w-[80%] rounded-2xl px-3.5 py-2"
        style={isOwn ? {
          backgroundColor: SWARM_ORANGE,
          color: "white",
          borderBottomRightRadius: 4,
        } : {
          backgroundColor: "white",
          color: "#1F2937",
          border: "1px solid #FED7AA",
          borderBottomLeftRadius: 4,
        }}
      >
        {message.attachment && (
          <AttachmentCard attachment={message.attachment} isOwn={isOwn} />
        )}
        {message.text && (
          <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">
            {message.text}
          </p>
        )}
        <div className={`mt-1 flex items-center gap-1.5 text-[10px] ${isOwn ? "text-white/60" : "text-gray-400"}`}>
          <span>{time}</span>
          {isOwn && message.status === "sending" && <span>Sending...</span>}
          {isOwn && message.status === "sent" && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}

function AttachmentCard({
  attachment,
  isOwn,
}: {
  attachment: ChatMessage["attachment"];
  isOwn: boolean;
}) {
  if (!attachment) return null;
  if (attachment.kind === "file") return <FileCard file={attachment} isOwn={isOwn} />;
  if (attachment.kind === "document-share") return <DocumentShareCard share={attachment} isOwn={isOwn} />;
  return null;
}

function FileCard({ file, isOwn }: { file: FileAttachment; isOwn: boolean }) {
  const category = getFileCategory(file.mimeType);
  const sizeMB = (file.sizeBytes / (1024 * 1024)).toFixed(1);
  const sizeKB = (file.sizeBytes / 1024).toFixed(0);
  const sizeLabel = file.sizeBytes > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;

  const iconMap: Record<string, string> = {
    image: "\uD83D\uDDBC\uFE0F",
    audio: "\uD83C\uDFB5",
    video: "\uD83C\uDFAC",
    document: "\uD83D\uDCC4",
    other: "\uD83D\uDCCE",
  };

  return (
    <div
      className="mb-2 rounded-xl p-2.5"
      style={{
        backgroundColor: isOwn ? "rgba(255,255,255,0.15)" : "#FFF7ED",
        border: isOwn ? "1px solid rgba(255,255,255,0.2)" : "1px solid #FED7AA",
      }}
    >
      <div className="flex items-center gap-2.5">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lg"
          style={{ backgroundColor: isOwn ? "rgba(255,255,255,0.2)" : "#FFEDD5" }}
        >
          {iconMap[category]}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{file.fileName}</p>
          <p className={`text-xs ${isOwn ? "text-white/60" : "text-orange-400"}`}>{sizeLabel}</p>
        </div>
      </div>
    </div>
  );
}

function DocumentShareCard({
  share,
  isOwn,
}: {
  share: DocumentShareAttachment;
  isOwn: boolean;
}) {
  return (
    <div
      className="mb-2 rounded-xl p-2.5"
      style={{
        backgroundColor: isOwn ? "rgba(255,255,255,0.15)" : "#FFF7ED",
        border: isOwn ? "1px solid rgba(255,255,255,0.2)" : "1px solid #FED7AA",
      }}
    >
      <div className="flex items-center gap-2.5">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lg"
          style={{ backgroundColor: isOwn ? "rgba(255,255,255,0.2)" : "#FFEDD5" }}
        >
          {"\uD83D\uDCCB"}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{share.driveName}</p>
          <p className={`text-xs ${isOwn ? "text-white/60" : "text-orange-400"}`}>
            {share.documents.length} document{share.documents.length !== 1 ? "s" : ""}
          </p>
        </div>
      </div>
      {share.documents.length > 0 && (
        <div className="mt-1.5 space-y-0.5 pl-[46px]">
          {share.documents.slice(0, 3).map((doc) => (
            <div key={doc.id} className={`flex items-center gap-1 text-xs ${isOwn ? "text-white/70" : "text-gray-500"}`}>
              <span>{"\uD83D\uDCC4"}</span>
              <span className="truncate">{doc.name}</span>
            </div>
          ))}
          {share.documents.length > 3 && (
            <p className={`text-xs ${isOwn ? "text-white/50" : "text-gray-400"}`}>
              +{share.documents.length - 3} more
            </p>
          )}
        </div>
      )}
      <button
        type="button"
        className="mt-2 w-full rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors"
        style={isOwn ? {
          backgroundColor: "rgba(255,255,255,0.25)",
          color: "white",
        } : {
          backgroundColor: SWARM_ORANGE,
          color: "white",
        }}
        onClick={() => {
          console.log("[Chat] Open shared docs:", share.documents.map(d => d.id));
        }}
      >
        Open in Connect
      </button>
    </div>
  );
}
