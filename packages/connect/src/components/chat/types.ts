/**
 * UI-specific types for the chat panel.
 * Extends the adapter's chat types with React state.
 */
export type { ChatMessage, ChatSession, ChatAttachment, FileAttachment, DocumentShareAttachment, ConversationSummary, GsocNotification } from "../../../../adapter/src/chat/types.js";
export { getFileCategory, INLINE_RENDERABLE } from "../../../../adapter/src/chat/types.js";
export type { FileCategory } from "../../../../adapter/src/chat/types.js";
export type {
  CollabInviteAttachment,
  CollabSummary,
  CollabKind,
  CollabParticipant,
} from "../../../../adapter/src/collab/types.js";

/** Chat panel view state */
export type ChatView = "conversations" | "thread" | "collaborate";
