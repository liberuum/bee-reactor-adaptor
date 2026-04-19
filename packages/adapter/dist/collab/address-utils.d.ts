/**
 * Parse + validate helpers for peer addresses entered by the user.
 *
 * Shared between the chat "New conversation" input, the Collab
 * picker, and the detail panel's "Add participant" input so all
 * three accept bulk paste from a spreadsheet / email / chat message
 * (any whitespace-, comma-, semicolon-, or newline-separated list).
 */
/** Length of a valid Ethereum / Swarm signer address (20 bytes hex + "0x"). */
export declare const ADDRESS_LENGTH = 42;
export interface ParseBulkAddressesResult {
    /** Unique, lowercased, validated addresses — order preserved. */
    valid: string[];
    /** Input tokens that didn't parse as addresses. */
    invalid: string[];
    /** Input tokens that parsed but were exact duplicates of earlier ones. */
    duplicates: string[];
}
/**
 * Split a free-form string into address tokens and classify each one.
 *
 * Accepts any combination of commas, semicolons, whitespace, or newlines
 * as separators. Trims surrounding punctuation. Deduplicates case-
 * insensitively — the first occurrence wins, later ones land in
 * `duplicates` so the UI can report them.
 */
export declare function parseBulkAddresses(raw: string): ParseBulkAddressesResult;
/** Quick single-address validity check. */
export declare function isValidAddress(raw: string): boolean;
//# sourceMappingURL=address-utils.d.ts.map