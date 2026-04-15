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
export interface SwarmFileUploadResult {
    attachment: FileAttachment;
    /** Upload duration in milliseconds */
    durationMs: number;
}
export declare class SwarmFile {
    private readonly client;
    constructor(client: SwarmClient);
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
    upload(file: Uint8Array | ArrayBuffer, fileName: string, mimeType: string, recipientBeeNodePubKey: string): Promise<SwarmFileUploadResult>;
    /**
     * Download an ACT-protected file from Swarm.
     *
     * The Bee node handles ECDH decryption transparently.
     *
     * @param attachment - FileAttachment from a chat message
     * @returns File data as Uint8Array
     */
    download(attachment: FileAttachment): Promise<Uint8Array>;
    /**
     * Download just the thumbnail for chat preview.
     * Returns null if no thumbnail was generated.
     */
    downloadThumbnail(attachment: FileAttachment): Promise<Uint8Array | null>;
    /**
     * Create a blob URL for rendering a downloaded file in the browser.
     * Caller is responsible for calling URL.revokeObjectURL() when done.
     */
    createBlobUrl(data: Uint8Array, mimeType: string): string;
    /**
     * Get display info for a file attachment (for chat rendering).
     */
    getDisplayInfo(attachment: FileAttachment): {
        category: FileCategory;
        label: string;
        sizeLabel: string;
        isInlineRenderable: boolean;
    };
    /**
     * Generate a JPEG thumbnail for an image file.
     * Uses canvas API (browser only).
     */
    private generateThumbnail;
}
//# sourceMappingURL=swarm-file.d.ts.map