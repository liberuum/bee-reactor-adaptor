/**
 * Derive shared attachment entries from a DM message list for the Files tab.
 */
import type { ChatMessage, ChatAttachment } from "./types.js";

export type SharedFileListItem =
  | {
      key: string;
      kind: "file";
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      from: string;
      timestamp: string;
      messageId: string;
    }
  | {
      key: string;
      kind: "document-share";
      driveName: string;
      documentCount: number;
      documents: Array<{ id: string; name: string; type: string }>;
      from: string;
      timestamp: string;
      messageId: string;
    };

function attachmentKey(messageId: string, att: ChatAttachment): string {
  if (att.kind === "file") return `${messageId}:${att.reference}`;
  return `${messageId}:${att.shareReference}`;
}

export function listSharedAttachments(messages: ChatMessage[]): SharedFileListItem[] {
  const out: SharedFileListItem[] = [];
  for (const msg of messages) {
    const att = msg.attachment;
    if (!att) continue;
    const key = attachmentKey(msg.id, att);
    if (att.kind === "file") {
      out.push({
        key,
        kind: "file",
        fileName: att.fileName,
        mimeType: att.mimeType,
        sizeBytes: att.sizeBytes,
        from: msg.from,
        timestamp: msg.timestamp,
        messageId: msg.id,
      });
    } else {
      out.push({
        key,
        kind: "document-share",
        driveName: att.driveName,
        documentCount: att.documents.length,
        documents: att.documents,
        from: msg.from,
        timestamp: msg.timestamp,
        messageId: msg.id,
      });
    }
  }
  return out;
}
