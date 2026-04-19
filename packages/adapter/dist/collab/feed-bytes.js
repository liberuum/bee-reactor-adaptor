/**
 * Shared low-level helpers used by CollabOpsFeed and CollabManifestFeed.
 *
 * - Feed index parsing that tolerates both `FeedIndex` objects (newer
 *   bee-js) and string/number forms (older builds).
 * - 32-byte hex ↔ Uint8Array conversion for the wrapper chunk format
 *   (64 bytes = actRef || actHist).
 *
 * These used to be duplicated per-file; consolidated here so a bug fix
 * lands in one place.
 */
/** Size of the wrapper chunk we upload to /bytes to carry `actRef ||
 *  actHistoryAddress` behind a 32-byte feed reference. */
export const WRAPPER_BYTES = 64;
export function parseFeedIndex(raw) {
    if (raw == null)
        return 0;
    if (typeof raw === "number")
        return raw;
    // bee-js's FeedIndex instances expose `.toBigInt()` in newer builds.
    if (typeof raw === "object" && raw !== null && typeof raw.toBigInt === "function") {
        try {
            return Number(raw.toBigInt());
        }
        catch { /* fall through */ }
    }
    const asString = typeof raw === "string" ? raw : String(raw);
    const hex = asString.startsWith("0x") ? asString.slice(2) : asString;
    if (!/^[0-9a-f]+$/i.test(hex))
        return 0;
    try {
        return Number(BigInt("0x" + hex));
    }
    catch {
        return 0;
    }
}
export function hexToBytes32(hex) {
    const clean = hex.replace(/^0x/i, "");
    if (clean.length !== 64) {
        throw new Error(`expected 32-byte hex, got length ${clean.length}`);
    }
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}
export function bytes32ToHex(bytes, offset = 0) {
    let out = "";
    for (let i = 0; i < 32; i++) {
        out += bytes[offset + i].toString(16).padStart(2, "0");
    }
    return out;
}
//# sourceMappingURL=feed-bytes.js.map