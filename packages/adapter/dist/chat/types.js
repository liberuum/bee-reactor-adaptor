/**
 * Chat & collaboration types for Swarm-based real-time communication.
 *
 * PSS handles 1-to-1 encrypted messages (2-10s latency).
 * GSOC handles low-latency notifications (< 1s).
 * Feeds + ACT handle persistent, encrypted chat history.
 */
export function getFileCategory(mimeType) {
    if (mimeType.startsWith("image/"))
        return "image";
    if (mimeType.startsWith("audio/"))
        return "audio";
    if (mimeType.startsWith("video/"))
        return "video";
    if (mimeType === "application/pdf" || mimeType.startsWith("text/"))
        return "document";
    return "other";
}
/** MIME types that can be rendered inline in chat */
export const INLINE_RENDERABLE = {
    image: ["image/png", "image/jpeg", "image/gif", "image/svg+xml", "image/webp"],
    audio: ["audio/mpeg", "audio/ogg", "audio/wav", "audio/webm"],
    video: ["video/mp4", "video/webm", "video/ogg"],
    document: ["application/pdf"],
    other: [],
};
//# sourceMappingURL=types.js.map