/**
 * Chat & collaboration types for Swarm-based real-time communication.
 *
 * PSS handles 1-to-1 encrypted messages (2-10s latency).
 * GSOC handles low-latency notifications (< 1s).
 * Feeds + ACT handle persistent, encrypted chat history.
 */

// ─── Chat Messages ─────────────────────────────────────────────

export interface ChatMessage {
  /** Unique message ID (UUID) */
  id: string;
  /** Sender's Swarm signer address */
  from: string;
  /** Recipient's Swarm signer address */
  to: string;
  /** Message text (plain text or markdown) */
  text: string;
  /** Optional document share attachment */
  attachment?: ChatAttachment;
  /** ISO timestamp */
  timestamp: string;
  /** Delivery status (local tracking, not protocol-level) */
  status: "sending" | "sent" | "delivered" | "read";
}

/**
 * Chat attachment — either a raw file (image, audio, video, etc.)
 * or a Powerhouse document model share (operations-based).
 */
export type ChatAttachment = FileAttachment | DocumentShareAttachment;

/**
 * Raw file shared via Swarm — images, audio, video, PDFs, etc.
 * ACT-protected so only the chat participants can access it.
 */
export interface FileAttachment {
  kind: "file";
  /** Original filename */
  fileName: string;
  /** MIME type (e.g., "image/png", "audio/mp3", "video/mp4") */
  mimeType: string;
  /** File size in bytes */
  sizeBytes: number;
  /** Swarm reference to the file content */
  reference: string;
  /** ACT history address — present for chat-uploaded files.
   *  Absent means the content is publicly-addressable (no ACT wrapping). */
  actHistoryAddress?: string;
  /** Publisher's Bee node public key — required pairing for ACT decryption.
   *  Absent means no ACT wrapping (plain /bzz/ download). */
  publisherBeeNodePubKey?: string;
  /** Optional thumbnail reference for images/videos (small preview) */
  thumbnailReference?: string;
}

/**
 * Powerhouse document model share — operations-based sharing
 * using the existing SwarmChannel sync infrastructure.
 */
export interface DocumentShareAttachment {
  kind: "document-share";
  /** Drive containing the shared documents */
  driveId: string;
  driveName: string;
  /** ACT-protected Swarm reference to the operations bundle */
  shareReference: string;
  actHistoryAddress: string;
  publisherBeeNodePubKey: string;
  /** Documents in the bundle */
  documents: Array<{
    id: string;
    name: string;
    type: string;
  }>;
}

// ─── File Type Helpers ─────────────────────────────────────────

export type FileCategory = "image" | "audio" | "video" | "document" | "other";

export function getFileCategory(mimeType: string): FileCategory {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType === "application/pdf" || mimeType.startsWith("text/")) return "document";
  return "other";
}

/** MIME types that can be rendered inline in chat */
export const INLINE_RENDERABLE: Record<FileCategory, string[]> = {
  image: ["image/png", "image/jpeg", "image/gif", "image/svg+xml", "image/webp"],
  audio: ["audio/mpeg", "audio/ogg", "audio/wav", "audio/webm"],
  video: ["video/mp4", "video/webm", "video/ogg"],
  document: ["application/pdf"],
  other: [],
};

// ─── Chat Sessions ─────────────────────────────────────────────

export interface ChatSession {
  /** Peer's Swarm signer address */
  peerAddress: string;
  /** Peer's Bee node overlay address (for PSS targeting) */
  peerOverlay: string;
  /** Peer's Bee node public key (for PSS encryption + ACT grants) */
  peerBeeNodePubKey: string;
  /** Peer's display name (ENS or profile name, if known) */
  peerDisplayName?: string;
  /** PSS topic for this conversation (deterministic from sorted addresses) */
  pssTopic: string;
  /** Feed topic for persistent chat history */
  historyTopic: string;
  /** ACT grantee ref for the chat history feed (both parties granted) */
  actGranteeRef?: string;
  /** ACT history ref for the chat history feed */
  actHistoryRef?: string;
  /** GSOC signer for sending notifications TO this peer */
  gsocSignerForPeer?: string;
  /** GSOC address for receiving notifications FROM this peer */
  gsocListenAddress?: string;
  /** Whether the session is fully initialized (GSOC mined, history ACT created) */
  ready: boolean;
  /** When this session was last active */
  lastActivity: string;
}

// ─── GSOC Notifications ────────────────────────────────────────

export type GsocNotificationType =
  | "typing"
  | "stopped-typing"
  | "presence-online"
  | "presence-offline"
  | "message-delivered"
  | "message-read"
  | "doc-updated"
  | "collab-join"
  | "collab-leave";

export interface GsocNotification {
  type: GsocNotificationType;
  /** Sender's Swarm signer address */
  from: string;
  /** ISO timestamp */
  timestamp: string;
  /** Optional payload (e.g., documentId for doc-updated) */
  data?: Record<string, unknown>;
}

// ─── Chat History Page ─────────────────────────────────────────

export interface ChatHistoryPage {
  /** Messages in chronological order */
  messages: ChatMessage[];
  /** Page number (0-indexed, latest = 0) */
  page: number;
  /** Whether there are older pages */
  hasMore: boolean;
  /** Feed index this page was written to */
  feedIndex?: number;
}

// ─── Conversation Summary (for list UI) ────────────────────────

export interface ConversationSummary {
  /** Peer's Swarm signer address */
  peerAddress: string;
  /** Display name */
  peerDisplayName?: string;
  /** Last message preview */
  lastMessage?: string;
  /** Last message timestamp */
  lastMessageTime?: string;
  /** Number of unread messages */
  unreadCount: number;
  /** Whether peer is online (GSOC presence) */
  isOnline: boolean;
}

// ─── Chat Manager Events ───────────────────────────────────────

export type ChatEventType =
  | "message-received"
  | "message-sent"
  | "notification-received"
  | "session-ready"
  | "session-error"
  | "history-loaded";

export interface ChatEvent {
  type: ChatEventType;
  data: unknown;
}

export type ChatEventHandler = (event: ChatEvent) => void;
