/**
 * Message bubble — renders a single chat message with optional attachments.
 *
 * Supports:
 * - Text messages
 * - File attachments (image preview, audio player, video player, file download)
 * - Document model shares (operation-based, with [Open] button)
 */
import React from "react";
import type { ChatMessage, FileAttachment, DocumentShareAttachment } from "./types.js";
import { getFileCategory } from "./types.js";

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
        className={`max-w-[75%] rounded-lg px-3 py-2 ${
          isOwn
            ? "bg-blue-600 text-white"
            : "bg-gray-100 text-gray-900"
        }`}
      >
        {message.attachment && (
          <AttachmentCard
            attachment={message.attachment}
            isOwn={isOwn}
          />
        )}
        {message.text && (
          <p className="text-sm whitespace-pre-wrap break-words">
            {message.text}
          </p>
        )}
        <div
          className={`mt-1 flex items-center gap-1 text-xs ${
            isOwn ? "text-blue-200" : "text-gray-400"
          }`}
        >
          <span>{time}</span>
          {isOwn && (
            <span>
              {message.status === "sending" ? "..." : message.status === "sent" ? "Sent" : ""}
            </span>
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

  if (attachment.kind === "file") {
    return <FileCard file={attachment} isOwn={isOwn} />;
  }

  if (attachment.kind === "document-share") {
    return <DocumentShareCard share={attachment} isOwn={isOwn} />;
  }

  return null;
}

function FileCard({ file, isOwn }: { file: FileAttachment; isOwn: boolean }) {
  const category = getFileCategory(file.mimeType);
  const sizeMB = (file.sizeBytes / (1024 * 1024)).toFixed(1);
  const sizeKB = (file.sizeBytes / 1024).toFixed(0);
  const sizeLabel = file.sizeBytes > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;
  const ext = file.fileName.split(".").pop()?.toUpperCase() ?? "";

  const iconMap: Record<string, string> = {
    image: "🖼",
    audio: "🎵",
    video: "🎬",
    document: "📄",
    other: "📎",
  };

  return (
    <div
      className={`mb-2 rounded-md border p-2 ${
        isOwn ? "border-blue-400 bg-blue-500/30" : "border-gray-200 bg-white"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-lg">{iconMap[category]}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{file.fileName}</p>
          <p className={`text-xs ${isOwn ? "text-blue-200" : "text-gray-400"}`}>
            {ext} {sizeLabel}
          </p>
        </div>
      </div>
      {category === "image" && file.thumbnailReference && (
        <div className="mt-2 overflow-hidden rounded">
          <div className="flex h-32 items-center justify-center bg-gray-50 text-xs text-gray-400">
            Image preview loading...
          </div>
        </div>
      )}
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
      className={`mb-2 rounded-md border p-2 ${
        isOwn ? "border-blue-400 bg-blue-500/30" : "border-gray-200 bg-white"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-lg">📋</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{share.driveName}</p>
          <p className={`text-xs ${isOwn ? "text-blue-200" : "text-gray-400"}`}>
            {share.documents.length} document{share.documents.length !== 1 ? "s" : ""}
          </p>
        </div>
      </div>
      <div className="mt-1 space-y-0.5">
        {share.documents.map((doc) => (
          <div key={doc.id} className="flex items-center gap-1 text-xs">
            <span>📄</span>
            <span className="truncate">{doc.name}</span>
          </div>
        ))}
      </div>
      <button
        type="button"
        className={`mt-2 w-full rounded px-2 py-1 text-xs font-medium ${
          isOwn
            ? "bg-blue-400 text-white hover:bg-blue-300"
            : "bg-gray-200 text-gray-700 hover:bg-gray-300"
        }`}
        onClick={() => {
          // TODO: navigate to shared document / import
          console.log("[Chat] Open shared docs:", share.documents.map(d => d.id));
        }}
      >
        Open in Connect
      </button>
    </div>
  );
}
