/**
 * Document sharing and public profile management for Swarm.
 *
 * Uses Swarm's native ACT (Access Control Trie) for cross-user sharing.
 * ACT provides ECDH-based encryption — the Bee node handles encrypt/decrypt
 * transparently using publisher_privkey × grantee_pubkey.
 *
 * Public profiles and share manifests are intentionally unencrypted (discovery).
 */
import type { SwarmClient } from "./swarm-client.js";
import type { SwarmPublicProfile, ShareManifest } from "./types.js";
import { decrypt } from "./swarm-crypto.js";
import { bytesToHex } from "./bytes-utils.js";

export class ShareManager {
  constructor(private readonly client: SwarmClient) {}

  // ─── Public Profile (unencrypted, discoverable by address) ────

  /**
   * Publish the user's public profile to an UNENCRYPTED feed.
   */
  async publishPublicProfile(
    signerAddress: string,
    profile: SwarmPublicProfile,
  ): Promise<void> {
    const payload = JSON.stringify(profile);
    const { reference } = await this.client.uploadData(payload, { skipEncryption: true });
    await this.client.writeFeedPayload(this.client.profileTopic(signerAddress), reference);
  }

  /**
   * Read a user's public profile by their Swarm signer address.
   * Returns null if the user hasn't published a profile yet.
   */
  async readPublicProfile(
    signerAddress: string,
  ): Promise<SwarmPublicProfile | null> {
    try {
      return await this.client.readFeedJson<SwarmPublicProfile>(
        this.client.profileTopic(signerAddress),
        normalizeAddress(signerAddress),
        { skipDecryption: true },
      );
    } catch {
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
  async uploadSharedData(
    data: string | Uint8Array,
    recipientBeeNodePubKey: string,
  ): Promise<{ reference: string; actHistoryAddress: string; actGranteeRef: string }> {
    // Upload with ACT — Bee node encrypts using its own keypair
    const { reference, historyAddress } = await this.client.uploadData(data, {
      act: true,
      skipEncryption: true, // No wallet-key AES — ACT handles encryption
    });
    if (!historyAddress) {
      throw new Error("ACT upload did not return historyAddress — is the Bee node running in full mode?");
    }

    // Grant access to recipient's Bee node
    const { ref: granteeRef } = await this.client.createGrantees([recipientBeeNodePubKey]);

    return {
      reference,
      actHistoryAddress: historyAddress,
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
  async downloadSharedData(
    reference: string,
    publisherBeeNodePubKey: string,
    actHistoryAddress: string,
  ): Promise<Uint8Array> {
    // Bee node handles ECDH decryption transparently
    return this.client.downloadData(reference, {
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
  async legacyDownloadSharedData(
    reference: string,
    senderAddress: string,
    recipientAddress: string,
  ): Promise<Uint8Array> {
    const raw = await this.client.downloadRawData(reference);
    const shareKey = await legacyDeriveShareKey(senderAddress, recipientAddress);
    return decrypt(raw, shareKey);
  }

  // ─── Share Manifest (unencrypted feed — discovery index) ──────

  /**
   * Write a share manifest to the share feed between sender and recipient.
   */
  async writeShareManifest(
    senderAddress: string,
    recipientAddress: string,
    manifest: ShareManifest,
  ): Promise<void> {
    const topic = this.client.shareTopic(senderAddress, recipientAddress);
    const payload = JSON.stringify(manifest);
    const { reference } = await this.client.uploadData(payload, { skipEncryption: true });
    await this.client.writeFeedPayload(topic, reference);
  }

  /**
   * Read the share manifest from another user.
   */
  async readShareManifest(
    senderAddress: string,
    recipientAddress: string,
  ): Promise<ShareManifest | null> {
    const topic = this.client.shareTopic(senderAddress, recipientAddress);
    try {
      return await this.client.readFeedJson<ShareManifest>(
        topic,
        normalizeAddress(senderAddress),
        { skipDecryption: true },
      );
    } catch {
      return null;
    }
  }

  // ─── ACT Grant/Revoke ────────────────────────────────────────

  /**
   * Grant additional users access to previously shared data.
   */
  async grantAccess(
    actGranteeRef: string,
    actHistoryRef: string,
    newGranteePubKeys: string[],
  ): Promise<{ ref: string; historyRef: string }> {
    return this.client.grantAccess(actGranteeRef, actHistoryRef, newGranteePubKeys);
  }

  /**
   * Revoke access from users for previously shared data.
   */
  async revokeAccess(
    actGranteeRef: string,
    actHistoryRef: string,
    revokePubKeys: string[],
  ): Promise<{ ref: string; historyRef: string }> {
    return this.client.revokeAccess(actGranteeRef, actHistoryRef, revokePubKeys);
  }
}

// ─── Helpers ────────────────────────────────────────────────────

/** Normalize an address: strip 0x prefix, lowercase (for bee-js) */
function normalizeAddress(addr: string): string {
  return addr.replace(/^0x/i, "").toLowerCase();
}

/**
 * Legacy key derivation — INSECURE, kept only for v1 share manifest migration.
 * SHA-256(sender_normalized + ":" + recipient_normalized) → 64-char hex string.
 * @deprecated Both addresses are public — any third party can derive this key.
 */
async function legacyDeriveShareKey(
  senderAddress: string,
  recipientAddress: string,
): Promise<string> {
  const material = `${normalizeAddress(senderAddress)}:${normalizeAddress(recipientAddress)}`;
  const encoded = new TextEncoder().encode(material);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return bytesToHex(new Uint8Array(hash));
}
