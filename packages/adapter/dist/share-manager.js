import { encrypt, decrypt } from "./swarm-crypto.js";
import { bytesToHex } from "./bytes-utils.js";
export class ShareManager {
    client;
    constructor(client) {
        this.client = client;
    }
    // ─── Public Profile (unencrypted, discoverable by address) ────
    /**
     * Publish the user's public profile to an UNENCRYPTED feed.
     */
    async publishPublicProfile(signerAddress, profile) {
        const payload = JSON.stringify(profile);
        const { reference } = await this.client.uploadData(payload, { skipEncryption: true });
        await this.client.writeFeedPayload(this.client.profileTopic(signerAddress), reference);
    }
    /**
     * Read a user's public profile by their Swarm signer address.
     * Returns null if the user hasn't published a profile yet.
     */
    async readPublicProfile(signerAddress) {
        try {
            return await this.client.readFeedJson(this.client.profileTopic(signerAddress), normalizeAddress(signerAddress), { skipDecryption: true });
        }
        catch {
            return null;
        }
    }
    // ─── Document Sharing (encrypted with shared key) ─────────────
    /**
     * Upload data for sharing — encrypted with a key derived from both parties' addresses.
     * Both sender and recipient can derive the same key: SHA-256(sender:recipient).
     */
    async uploadSharedData(data, senderAddress, recipientAddress) {
        const shareKey = await deriveShareKey(senderAddress, recipientAddress);
        const encrypted = await encrypt(data, shareKey);
        // Upload directly via bee (bypasses SwarmClient encryption — uses shareKey instead)
        const result = await this.client.uploadRawData(encrypted);
        return { reference: result.reference };
    }
    /**
     * Download shared data and decrypt with the shared key.
     */
    async downloadSharedData(reference, senderAddress, recipientAddress) {
        const raw = await this.client.downloadRawData(reference);
        const shareKey = await deriveShareKey(senderAddress, recipientAddress);
        return decrypt(raw, shareKey);
    }
    /**
     * Write a share manifest to the share feed between sender and recipient.
     */
    async writeShareManifest(senderAddress, recipientAddress, manifest) {
        const topic = this.client.shareTopic(senderAddress, recipientAddress);
        const payload = JSON.stringify(manifest);
        const { reference } = await this.client.uploadData(payload, { skipEncryption: true });
        await this.client.writeFeedPayload(topic, reference);
    }
    /**
     * Read the share manifest from another user.
     */
    async readShareManifest(senderAddress, recipientAddress) {
        const topic = this.client.shareTopic(senderAddress, recipientAddress);
        try {
            return await this.client.readFeedJson(topic, normalizeAddress(senderAddress), { skipDecryption: true });
        }
        catch {
            return null;
        }
    }
}
// ─── Helpers ────────────────────────────────────────────────────
/** Normalize an address: strip 0x prefix, lowercase (for bee-js) */
function normalizeAddress(addr) {
    return addr.replace(/^0x/i, "").toLowerCase();
}
/**
 * Derive a 32-byte hex key for share encryption from both parties' addresses.
 * SHA-256(sender_normalized + ":" + recipient_normalized) → 64-char hex string.
 * Both sender and recipient can independently derive the same key.
 */
export async function deriveShareKey(senderAddress, recipientAddress) {
    const material = `${normalizeAddress(senderAddress)}:${normalizeAddress(recipientAddress)}`;
    const encoded = new TextEncoder().encode(material);
    const hash = await crypto.subtle.digest("SHA-256", encoded);
    return bytesToHex(new Uint8Array(hash));
}
//# sourceMappingURL=share-manager.js.map