import { decrypt } from "./swarm-crypto.js";
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
    // ─── Document Sharing (ACT-protected) ─────────────────────────
    /**
     * Upload data for sharing — protected by Swarm ACT.
     *
     * The Bee node encrypts the data using its own private key as publisher.
     * The recipient's Bee node public key is added as a grantee, allowing
     * their Bee node to decrypt via ECDH.
     *
     * @param data - Plaintext data to share
     * @param recipientBeeNodePubKey - Recipient's Bee node public key (compressed hex from their profile)
     * @returns ACT metadata needed by recipient to download
     */
    async uploadSharedData(data, recipientBeeNodePubKey) {
        // Step 1: Create grantee list FIRST — this generates the ACT history
        // that the upload will chain into. Order matters: grantees before upload.
        const { ref: granteeRef, historyRef: granteeHistoryRef } = await this.client.createGrantees([recipientBeeNodePubKey]);
        // Step 2: Upload with ACT, chaining the grantee's history.
        // This links the upload's ACT to the grantee list so the recipient
        // can decrypt via ECDH on their Bee node.
        const { reference, historyAddress } = await this.client.uploadFile(data, {
            act: true,
            actHistoryAddress: granteeHistoryRef,
            skipEncryption: true, // No wallet-key AES — ACT handles encryption
        });
        return {
            reference,
            actHistoryAddress: historyAddress ?? granteeHistoryRef,
            actGranteeRef: granteeRef,
        };
    }
    /**
     * Download ACT-protected shared data.
     *
     * The Bee node decrypts transparently using ECDH (our privkey × publisher's pubkey).
     *
     * @param reference - Swarm reference from the share manifest
     * @param publisherBeeNodePubKey - Publisher's Bee node public key (from share manifest)
     * @param actHistoryAddress - ACT history address (from share manifest)
     * @returns Decrypted data
     */
    async downloadSharedData(reference, publisherBeeNodePubKey, actHistoryAddress) {
        // Download via /bzz — required for ACT manifest resolution + ECDH decryption.
        // The /bytes endpoint does NOT handle ACT; /bzz does.
        return this.client.downloadFile(reference, {
            actPublisher: publisherBeeNodePubKey,
            actHistoryAddress,
            skipDecryption: true, // No wallet-key AES — ACT handles decryption
        });
    }
    // ─── Legacy Sharing (v1 — insecure, for backward compatibility) ─
    /**
     * Download data encrypted with the legacy deriveShareKey method.
     * Used only for importing v1 share manifests during migration.
     * @deprecated Will be removed after migration window.
     */
    async legacyDownloadSharedData(reference, senderAddress, recipientAddress) {
        const raw = await this.client.downloadRawData(reference);
        const shareKey = await legacyDeriveShareKey(senderAddress, recipientAddress);
        return decrypt(raw, shareKey);
    }
    // ─── Share Manifest (unencrypted feed — discovery index) ──────
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
    // ─── ACT Grant/Revoke ────────────────────────────────────────
    /**
     * Grant additional users access to previously shared data.
     */
    async grantAccess(actGranteeRef, actHistoryRef, newGranteePubKeys) {
        return this.client.grantAccess(actGranteeRef, actHistoryRef, newGranteePubKeys);
    }
    /**
     * Revoke access from users for previously shared data.
     */
    async revokeAccess(actGranteeRef, actHistoryRef, revokePubKeys) {
        return this.client.revokeAccess(actGranteeRef, actHistoryRef, revokePubKeys);
    }
}
// ─── Helpers ────────────────────────────────────────────────────
/** Normalize an address: strip 0x prefix, lowercase (for bee-js) */
function normalizeAddress(addr) {
    return addr.replace(/^0x/i, "").toLowerCase();
}
/**
 * Legacy key derivation — INSECURE, kept only for v1 share manifest migration.
 * SHA-256(sender_normalized + ":" + recipient_normalized) → 64-char hex string.
 * @deprecated Both addresses are public — any third party can derive this key.
 */
async function legacyDeriveShareKey(senderAddress, recipientAddress) {
    const material = `${normalizeAddress(senderAddress)}:${normalizeAddress(recipientAddress)}`;
    const encoded = new TextEncoder().encode(material);
    const hash = await crypto.subtle.digest("SHA-256", encoded);
    return bytesToHex(new Uint8Array(hash));
}
//# sourceMappingURL=share-manager.js.map