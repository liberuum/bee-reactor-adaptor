import { getFileCategory, INLINE_RENDERABLE } from "./types.js";
/** Maximum file size for inline chat sharing (50 MB) */
const MAX_FILE_SIZE = 50 * 1024 * 1024;
/** Maximum thumbnail dimension (pixels) */
const THUMBNAIL_MAX_DIM = 200;
/** JPEG quality for thumbnails */
const THUMBNAIL_QUALITY = 0.6;
export class SwarmFile {
    client;
    constructor(client) {
        this.client = client;
    }
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
    async upload(file, fileName, mimeType, recipientBeeNodePubKey) {
        const start = Date.now();
        const data = file instanceof ArrayBuffer ? new Uint8Array(file) : file;
        if (data.length > MAX_FILE_SIZE) {
            throw new Error(`File too large: ${(data.length / 1024 / 1024).toFixed(1)} MB exceeds ` +
                `${MAX_FILE_SIZE / 1024 / 1024} MB limit for chat file sharing.`);
        }
        // Create grantee list FIRST (ACT requires grantees before upload)
        const { ref: granteeRef, historyRef: granteeHistRef } = await this.client.createGrantees([recipientBeeNodePubKey]);
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
        let thumbnailReference;
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
            }
            catch {
                // Thumbnail generation is best-effort
            }
        }
        const attachment = {
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
     * Download an ACT-protected file from Swarm.
     *
     * The Bee node handles ECDH decryption transparently.
     *
     * @param attachment - FileAttachment from a chat message
     * @returns File data as Uint8Array
     */
    async download(attachment) {
        return this.client.downloadFile(attachment.reference, {
            actPublisher: attachment.publisherBeeNodePubKey,
            actHistoryAddress: attachment.actHistoryAddress,
            skipDecryption: true, // ACT handles decryption
        });
    }
    /**
     * Download just the thumbnail for chat preview.
     * Returns null if no thumbnail was generated.
     */
    async downloadThumbnail(attachment) {
        if (!attachment.thumbnailReference)
            return null;
        try {
            return await this.client.downloadFile(attachment.thumbnailReference, {
                actPublisher: attachment.publisherBeeNodePubKey,
                actHistoryAddress: attachment.actHistoryAddress,
                skipDecryption: true,
            });
        }
        catch {
            return null;
        }
    }
    /**
     * Create a blob URL for rendering a downloaded file in the browser.
     * Caller is responsible for calling URL.revokeObjectURL() when done.
     */
    createBlobUrl(data, mimeType) {
        const blob = new Blob([data], { type: mimeType });
        return URL.createObjectURL(blob);
    }
    /**
     * Get display info for a file attachment (for chat rendering).
     */
    getDisplayInfo(attachment) {
        const category = getFileCategory(attachment.mimeType);
        const sizeBytes = attachment.sizeBytes;
        const sizeLabel = sizeBytes < 1024
            ? `${sizeBytes} B`
            : sizeBytes < 1024 * 1024
                ? `${(sizeBytes / 1024).toFixed(0)} KB`
                : `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
        const ext = attachment.fileName.split(".").pop()?.toUpperCase() ?? "";
        const label = `${ext} ${category}`;
        const renderableTypes = INLINE_RENDERABLE[category] ?? [];
        const isInlineRenderable = renderableTypes.includes(attachment.mimeType);
        return { category, label, sizeLabel, isInlineRenderable };
    }
    // ─── Private ─────────────────────────────────────────────────
    /**
     * Generate a JPEG thumbnail for an image file.
     * Uses canvas API (browser only).
     */
    async generateThumbnail(imageData, mimeType) {
        if (typeof globalThis.document === "undefined")
            return null;
        return new Promise((resolve) => {
            const blob = new Blob([imageData], { type: mimeType });
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
                if (!ctx) {
                    resolve(null);
                    return;
                }
                ctx.drawImage(img, 0, 0, thumbW, thumbH);
                canvas.toBlob((thumbBlob) => {
                    if (!thumbBlob) {
                        resolve(null);
                        return;
                    }
                    thumbBlob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)));
                }, "image/jpeg", THUMBNAIL_QUALITY);
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                resolve(null);
            };
            img.src = url;
        });
    }
}
//# sourceMappingURL=swarm-file.js.map