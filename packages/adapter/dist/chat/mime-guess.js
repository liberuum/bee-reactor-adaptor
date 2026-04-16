/**
 * Best-effort MIME guessing from filenames — used when the browser's File
 * API reports an empty `file.type` (happens for less-common formats like
 * .mkv on some OSes) and when Bee's HEAD /bzz/ response returns a generic
 * fallback Content-Type for externally-uploaded files.
 */
const EXT_TO_MIME = {
    // Images
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".avif": "image/avif",
    // Video
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".ogv": "video/ogg",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    // Audio
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".aac": "audio/aac",
    // Documents
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    // Text
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".xml": "application/xml",
    ".yml": "text/yaml",
    ".yaml": "text/yaml",
    ".csv": "text/csv",
    ".log": "text/plain",
    ".ini": "text/plain",
    ".toml": "text/plain",
    ".env": "text/plain",
};
/**
 * Returns a best-guess MIME type for the given filename, or `null` if the
 * extension is unknown.
 */
export function guessMimeFromFilename(fileName) {
    const idx = fileName.lastIndexOf(".");
    if (idx === -1)
        return null;
    const ext = fileName.slice(idx).toLowerCase();
    return EXT_TO_MIME[ext] ?? null;
}
/**
 * True if the mime is a generic/non-informative fallback that Bee or a
 * browser may return when it couldn't determine the real type. In those
 * cases we prefer a filename-derived guess over the reported mime.
 */
export function isGenericMime(mime) {
    if (!mime)
        return true;
    const m = mime.toLowerCase().split(";")[0].trim();
    return (m === "" ||
        m === "application/octet-stream" ||
        m === "application/x-www-form-urlencoded" ||
        m === "binary/octet-stream" ||
        m === "application/binary");
}
/**
 * Reconcile a reported mime with a filename-derived guess. If the reported
 * mime is generic and the filename hints at a specific type, prefer the
 * guess; otherwise keep the reported mime. Falls back to octet-stream.
 */
export function reconcileMime(reportedMime, fileName) {
    const guess = fileName ? guessMimeFromFilename(fileName) : null;
    if (guess && isGenericMime(reportedMime))
        return guess;
    return reportedMime && reportedMime.trim() !== ""
        ? reportedMime
        : (guess ?? "application/octet-stream");
}
//# sourceMappingURL=mime-guess.js.map