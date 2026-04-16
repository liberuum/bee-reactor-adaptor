/**
 * Best-effort MIME guessing from filenames — used when the browser's File
 * API reports an empty `file.type` (happens for less-common formats like
 * .mkv on some OSes) and when Bee's HEAD /bzz/ response returns a generic
 * fallback Content-Type for externally-uploaded files.
 */

const EXT_TO_MIME: Record<string, string> = {
  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  // Video — broadly, to cover anything a browser might attempt. The UI
  // does a canPlayType pre-flight and falls back to "download to watch"
  // for unplayable formats, so being generous here is safe.
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mp4v": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".ogm": "video/ogg",
  ".mov": "video/quicktime",
  ".qt": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".mk3d": "video/x-matroska",
  ".mka": "audio/x-matroska",
  ".avi": "video/x-msvideo",
  ".3gp": "video/3gpp",
  ".3g2": "video/3gpp2",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".mpe": "video/mpeg",
  ".m1v": "video/mpeg",
  ".m2v": "video/mpeg",
  ".ts": "video/mp2t",
  ".mts": "video/mp2t",
  ".m2ts": "video/mp2t",
  ".m2t": "video/mp2t",
  ".flv": "video/x-flv",
  ".f4v": "video/mp4",
  ".wmv": "video/x-ms-wmv",
  ".asf": "video/x-ms-asf",
  ".vob": "video/dvd",
  ".divx": "video/x-msvideo",
  ".xvid": "video/x-msvideo",
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
export function guessMimeFromFilename(fileName: string): string | null {
  const idx = fileName.lastIndexOf(".");
  if (idx === -1) return null;
  const ext = fileName.slice(idx).toLowerCase();
  return EXT_TO_MIME[ext] ?? null;
}

/**
 * True if the mime is a generic/non-informative fallback that Bee or a
 * browser may return when it couldn't determine the real type. In those
 * cases we prefer a filename-derived guess over the reported mime.
 */
export function isGenericMime(mime: string | undefined | null): boolean {
  if (!mime) return true;
  const m = mime.toLowerCase().split(";")[0].trim();
  return (
    m === "" ||
    m === "application/octet-stream" ||
    m === "application/x-www-form-urlencoded" ||
    m === "binary/octet-stream" ||
    m === "application/binary"
  );
}

/**
 * Reconcile a reported mime with a filename-derived guess. If the reported
 * mime is generic and the filename hints at a specific type, prefer the
 * guess; otherwise keep the reported mime. Falls back to octet-stream.
 */
export function reconcileMime(
  reportedMime: string | undefined | null,
  fileName: string | undefined,
): string {
  const guess = fileName ? guessMimeFromFilename(fileName) : null;
  if (guess && isGenericMime(reportedMime)) return guess;
  return reportedMime && reportedMime.trim() !== ""
    ? reportedMime
    : (guess ?? "application/octet-stream");
}
