/**
 * SwarmFile — upload/download raw files to Swarm with ACT protection.
 *
 * Handles any file type: images (PNG, JPG, SVG, WebP), audio (MP3, OGG),
 * video (MP4, WebM), PDFs, and arbitrary files. All files are ACT-encrypted
 * so only granted parties can access them.
 *
 * Uses /bzz endpoint for ACT support (not /bytes).
 *
 * For Powerhouse document models, use the existing document sharing
 * infrastructure (ShareManager + SwarmChannel operations). This module
 * is for raw file sharing in chat.
 */
import type { SwarmClient } from "../swarm-client.js";
import type { FileAttachment, FileCategory } from "./types.js";
import { getFileCategory, INLINE_RENDERABLE } from "./types.js";

/** Maximum file size for inline chat sharing (200 MB) */
const MAX_FILE_SIZE = 200 * 1024 * 1024;

/** Maximum thumbnail dimension (pixels) */
const THUMBNAIL_MAX_DIM = 200;

/** JPEG quality for thumbnails */
const THUMBNAIL_QUALITY = 0.6;

export interface SwarmFileUploadResult {
  attachment: FileAttachment;
  /** Upload duration in milliseconds */
  durationMs: number;
}

export class SwarmFile {
  constructor(
    private readonly client: SwarmClient,
  ) {}

  /**
   * Upload a raw file to Swarm with ACT protection.
   *
   * The file is uploaded via /bzz with ACT enabled. A grantee list
   * is created for the recipient's Bee node public key so they can
   * download and decrypt it.
   *
   * For images, an optional thumbnail is generated and uploaded
   * separately for chat preview rendering.
   *
   * @param file - File data (Uint8Array or ArrayBuffer)
   * @param fileName - Original filename with extension
   * @param mimeType - MIME type (e.g., "image/png")
   * @param recipientBeeNodePubKey - Recipient's Bee node public key for ACT grant
   * @returns FileAttachment with Swarm references and metadata
   */
  async upload(
    file: Uint8Array | ArrayBuffer,
    fileName: string,
    mimeType: string,
    recipientBeeNodePubKey: string,
  ): Promise<SwarmFileUploadResult> {
    const start = Date.now();
    const data = file instanceof ArrayBuffer ? new Uint8Array(file) : file;

    if (data.length > MAX_FILE_SIZE) {
      throw new Error(
        `File too large: ${(data.length / 1024 / 1024).toFixed(1)} MB exceeds ` +
        `${MAX_FILE_SIZE / 1024 / 1024} MB limit for chat file sharing.`,
      );
    }

    // Create grantee list FIRST (ACT requires grantees before upload)
    const { ref: granteeRef, historyRef: granteeHistRef } =
      await this.client.createGrantees([recipientBeeNodePubKey]);

    // Wait for ACT 1-second rule
    await new Promise(r => setTimeout(r, 1100));

    // Upload file with ACT, chained to grantee history
    const { reference, historyAddress } = await this.client.uploadFile(data, {
      act: true,
      actHistoryAddress: granteeHistRef,
      skipEncryption: true, // ACT handles encryption
    });

    const publisherPubKey = await this.client.getBeeNodePublicKey();

    // Generate thumbnail for images (non-blocking, best-effort)
    let thumbnailReference: string | undefined;
    const category = getFileCategory(mimeType);
    if (category === "image" && typeof globalThis.document !== "undefined") {
      try {
        const thumb = await this.generateThumbnail(data, mimeType);
        if (thumb) {
          // Upload thumbnail with same ACT grantee
          const thumbResult = await this.client.uploadFile(thumb, {
            act: true,
            actHistoryAddress: granteeHistRef,
            skipEncryption: true,
          });
          thumbnailReference = thumbResult.reference;
        }
      } catch {
        // Thumbnail generation is best-effort
      }
    }

    const attachment: FileAttachment = {
      kind: "file",
      fileName,
      mimeType,
      sizeBytes: data.length,
      reference,
      actHistoryAddress: historyAddress ?? granteeHistRef,
      publisherBeeNodePubKey: publisherPubKey,
      thumbnailReference,
    };

    return {
      attachment,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Download a file from Swarm. ACT-wrapped if `actHistoryAddress` and
   * `publisherBeeNodePubKey` are set (Bee handles ECDH decryption
   * transparently); otherwise a plain /bzz/ download — used for external
   * hashes pasted into chat that were uploaded outside the chat flow.
   *
   * @param attachment - FileAttachment from a chat message
   * @returns File data as Uint8Array
   */
  async download(attachment: FileAttachment): Promise<Uint8Array> {
    if (attachment.actHistoryAddress && attachment.publisherBeeNodePubKey) {
      return this.client.downloadFile(attachment.reference, {
        actPublisher: attachment.publisherBeeNodePubKey,
        actHistoryAddress: attachment.actHistoryAddress,
        skipDecryption: true, // ACT handles decryption
      });
    }
    return this.client.downloadFile(attachment.reference);
  }

  /**
   * Download just the thumbnail for chat preview.
   * Returns null if no thumbnail was generated.
   */
  async downloadThumbnail(attachment: FileAttachment): Promise<Uint8Array | null> {
    if (!attachment.thumbnailReference) return null;
    try {
      if (attachment.actHistoryAddress && attachment.publisherBeeNodePubKey) {
        return await this.client.downloadFile(attachment.thumbnailReference, {
          actPublisher: attachment.publisherBeeNodePubKey,
          actHistoryAddress: attachment.actHistoryAddress,
          skipDecryption: true,
        });
      }
      return await this.client.downloadFile(attachment.thumbnailReference);
    } catch {
      return null;
    }
  }

  /**
   * Create a blob URL for rendering a downloaded file in the browser.
   * Caller is responsible for calling URL.revokeObjectURL() when done.
   */
  createBlobUrl(data: Uint8Array, mimeType: string): string {
    const blob = new Blob([data as BlobPart], { type: mimeType });
    return URL.createObjectURL(blob);
  }

  /**
   * Get display info for a file attachment (for chat rendering).
   */
  getDisplayInfo(attachment: FileAttachment): {
    category: FileCategory;
    label: string;
    sizeLabel: string;
    isInlineRenderable: boolean;
  } {
    const category = getFileCategory(attachment.mimeType);
    const sizeBytes = attachment.sizeBytes;
    const sizeLabel = sizeBytes < 1024
      ? `${sizeBytes} B`
      : sizeBytes < 1024 * 1024
        ? `${(sizeBytes / 1024).toFixed(0)} KB`
        : `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;

    const ext = attachment.fileName.split(".").pop()?.toUpperCase() ?? "";
    const label = `${ext} ${category}`;

    const renderableTypes: string[] = INLINE_RENDERABLE[category] ?? [];
    const isInlineRenderable = renderableTypes.includes(attachment.mimeType);

    return { category, label, sizeLabel, isInlineRenderable };
  }

  // ─── Private ─────────────────────────────────────────────────

  /**
   * Generate a JPEG thumbnail for an image file.
   * Uses canvas API (browser only).
   */
  private async generateThumbnail(
    imageData: Uint8Array,
    mimeType: string,
  ): Promise<Uint8Array | null> {
    if (typeof globalThis.document === "undefined") return null;

    return new Promise((resolve) => {
      const blob = new Blob([imageData as BlobPart], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const img = new Image();

      img.onload = () => {
        URL.revokeObjectURL(url);

        // Calculate thumbnail dimensions
        const { width, height } = img;
        let thumbW = width;
        let thumbH = height;
        if (width > THUMBNAIL_MAX_DIM || height > THUMBNAIL_MAX_DIM) {
          const ratio = Math.min(THUMBNAIL_MAX_DIM / width, THUMBNAIL_MAX_DIM / height);
          thumbW = Math.round(width * ratio);
          thumbH = Math.round(height * ratio);
        }

        const canvas = document.createElement("canvas");
        canvas.width = thumbW;
        canvas.height = thumbH;
        const ctx = canvas.getContext("2d");
        if (!ctx) { resolve(null); return; }

        ctx.drawImage(img, 0, 0, thumbW, thumbH);
        canvas.toBlob(
          (thumbBlob) => {
            if (!thumbBlob) { resolve(null); return; }
            thumbBlob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)));
          },
          "image/jpeg",
          THUMBNAIL_QUALITY,
        );
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };

      img.src = url;
    });
  }
}
