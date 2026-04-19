/**
 * Parse + validate helpers for peer addresses entered by the user.
 *
 * Shared between the chat "New conversation" input, the Collab
 * picker, and the detail panel's "Add participant" input so all
 * three accept bulk paste from a spreadsheet / email / chat message
 * (any whitespace-, comma-, semicolon-, or newline-separated list).
 */
/** Length of a valid Ethereum / Swarm signer address (20 bytes hex + "0x"). */
export const ADDRESS_LENGTH = 42;
/** Regex for a syntactically valid hex address (accepts checksum mixed case). */
const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
/**
 * Split a free-form string into address tokens and classify each one.
 *
 * Accepts any combination of commas, semicolons, whitespace, or newlines
 * as separators. Trims surrounding punctuation. Deduplicates case-
 * insensitively — the first occurrence wins, later ones land in
 * `duplicates` so the UI can report them.
 */
export function parseBulkAddresses(raw) {
    if (!raw || typeof raw !== "string") {
        return { valid: [], invalid: [], duplicates: [] };
    }
    const valid = [];
    const invalid = [];
    const duplicates = [];
    const seen = new Set();
    // Split on any run of whitespace, commas, or semicolons.
    const tokens = raw.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
    for (const tok of tokens) {
        // Strip any trailing/leading bracket/quote garbage that survives
        // a copy-paste from markdown / JSON.
        const cleaned = tok.replace(/^["'`<\(\[]+|["'`>\)\]]+$/g, "");
        if (!ADDRESS_RE.test(cleaned)) {
            invalid.push(tok);
            continue;
        }
        const lower = cleaned.toLowerCase();
        if (seen.has(lower)) {
            duplicates.push(tok);
            continue;
        }
        seen.add(lower);
        valid.push(lower);
    }
    return { valid, invalid, duplicates };
}
/** Quick single-address validity check. */
export function isValidAddress(raw) {
    if (!raw)
        return false;
    return ADDRESS_RE.test(raw.trim());
}
//# sourceMappingURL=address-utils.js.map