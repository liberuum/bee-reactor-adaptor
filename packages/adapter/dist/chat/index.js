/**
 * Swarm Chat — real-time communication between Connect users.
 *
 * PSS for encrypted 1-to-1 messages (2-10s latency).
 * GSOC for sub-second notifications (typing, presence, doc updates).
 * Feeds + ACT for persistent encrypted chat history.
 */
export { ChatManager } from "./chat-manager.js";
export { PssMessenger, chatTopic, makeTarget } from "./pss-messenger.js";
export { ChatHistory, historyTopic } from "./chat-history.js";
export { GsocNotifier } from "./gsoc-notifier.js";
//# sourceMappingURL=index.js.map