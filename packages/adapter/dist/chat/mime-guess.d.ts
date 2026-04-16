/**
 * Best-effort MIME guessing from filenames — used when the browser's File
 * API reports an empty `file.type` (happens for less-common formats like
 * .mkv on some OSes) and when Bee's HEAD /bzz/ response returns a generic
 * fallback Content-Type for externally-uploaded files.
 */
/**
 * Returns a best-guess MIME type for the given filename, or `null` if the
 * extension is unknown.
 */
export declare function guessMimeFromFilename(fileName: string): string | null;
/**
 * True if the mime is a generic/non-informative fallback that Bee or a
 * browser may return when it couldn't determine the real type. In those
 * cases we prefer a filename-derived guess over the reported mime.
 */
export declare function isGenericMime(mime: string | undefined | null): boolean;
/**
 * Reconcile a reported mime with a filename-derived guess. If the reported
 * mime is generic and the filename hints at a specific type, prefer the
 * guess; otherwise keep the reported mime. Falls back to octet-stream.
 */
export declare function reconcileMime(reportedMime: string | undefined | null, fileName: string | undefined): string;
//# sourceMappingURL=mime-guess.d.ts.map