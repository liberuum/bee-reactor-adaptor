/**
 * GSOC Notifier — sub-second notifications over Swarm.
 *
 * GSOC (Graffiti Single Owner Chunks) provides many-to-one notifications
 * with < 1 second latency. A signer key is mined whose SOC address falls
 * in the target node's neighborhood, then shared with writers.
 *
 * Used for: typing indicators, presence, delivery receipts,
 * document update signals, collaboration join/leave.
 *
 * Requirement: receiver must run a FULL Bee node.
 */
import type { Bee } from "@ethersphere/bee-js";
import { PrivateKey } from "@ethersphere/bee-js";
import type { GsocNotification, GsocNotificationType } from "./types.js";

const NOTIFY_IDENTIFIER_PREFIX = "ph:v2:notify:";

/**
 * Deterministic 32-byte identifier from an arbitrary string. XOR-folds
 * UTF-8 bytes into a 32-byte buffer and emits the hex representation.
 *
 * Not collision-resistant in the cryptographic sense — two strings
 * that are byte-level permutations produce the same identifier — but
 * our identifier inputs are fixed-namespace templates (e.g.
 * `ph:v2:collab-notify:<address>:<collabId>`), so permutation
 * collisions don't arise in practice.
 */
function makeIdentifierHexSync(value: string): string {
  const bytes = new Uint8Array(32);
  const encoded = new TextEncoder().encode(value);
  for (let i = 0; i < encoded.length; i++) {
    bytes[i % 32] ^= encoded[i];
  }
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export interface GsocSubscription {
  cancel: () => void;
}

export class GsocNotifier {
  /** Cache of mined signers per peer overlay (mining takes 10-30s) */
  private minedSigners = new Map<string, string>();
  /** Cache for mineSignerWithIdentifier, keyed by `${overlay}:${identifierRaw}`.
   *  Mining is deterministic per (overlay, identifier) + proximity,
   *  and the output is stable — no point re-mining within a session. */
  private minedWithIdentifier = new Map<string, { signerHex: string; listenAddress: string; identifierHex: string }>();
  private subscriptions = new Map<string, GsocSubscription>();

  constructor(
    private readonly bee: Bee,
    private readonly batchId: string,
    private readonly myAddress: string,
  ) {}

  /**
   * Mine a GSOC signer targeting a peer's overlay address.
   *
   * Mining takes 10-30 seconds. Results are cached per overlay so
   * subsequent sends are instant. Call this during session init.
   *
   * @param targetOverlay - Peer's Bee node overlay address
   * @param proximity - Mining depth (default 12 — ~1-5s mining)
   * @returns The mined signer private key (hex)
   */
  mineSigner(targetOverlay: string, proximity = 12): string {
    const cached = this.minedSigners.get(targetOverlay);
    if (cached) return cached;

    const identifierHex = makeIdentifierHexSync(`${NOTIFY_IDENTIFIER_PREFIX}${this.myAddress.toLowerCase()}`);
    const signer = this.bee.gsocMine(targetOverlay, identifierHex, proximity);
    const signerHex = typeof signer === "string"
      ? signer
      : (signer as { toHex?: () => string }).toHex?.() ?? String(signer);

    this.minedSigners.set(targetOverlay, signerHex);
    return signerHex;
  }

  /**
   * Hash an identifier string into a 32-byte hex identifier. Exposed
   * so subscribers can derive the same identifier the sender mined
   * under, without paying for a fresh signer mine.
   */
  static hashIdentifier(raw: string): string {
    return makeIdentifierHexSync(raw);
  }

  /**
   * Mine a GSOC signer with a caller-chosen identifier. Used by
   * subsystems (e.g. CollabManager) that need multiple independent
   * notification channels per (sender, receiver) pair — each
   * identifier produces a distinct SOC address, so chat and collab
   * pings don't cross-talk.
   *
   * Returns the signer hex and the listen address derived from the
   * signer's pubkey. The listen address is what subscribers use with
   * `gsocSubscribe`.
   */
  mineSignerWithIdentifier(
    targetOverlay: string,
    identifierRaw: string,
    proximity = 12,
  ): { signerHex: string; listenAddress: string; identifierHex: string } {
    const cacheKey = `${targetOverlay}:${identifierRaw}`;
    const cached = this.minedWithIdentifier.get(cacheKey);
    if (cached) return cached;

    const identifierHex = makeIdentifierHexSync(identifierRaw);
    const signer = this.bee.gsocMine(targetOverlay, identifierHex, proximity);
    // Normalize the signer to a PrivateKey object so we can derive the
    // listen address. bee-js may return a PrivateKey already or a hex
    // string; construct one either way.
    const pk = signer instanceof PrivateKey ? signer : new PrivateKey(
      typeof signer === "string" ? signer : (signer as any).toHex?.() ?? String(signer),
    );
    const result = {
      signerHex: pk.toHex(),
      listenAddress: pk.publicKey().address().toHex(),
      identifierHex,
    };
    this.minedWithIdentifier.set(cacheKey, result);
    return result;
  }

  /**
   * Low-level send that targets an explicit identifier + signer. Used by
   * CollabManager so multiple independent signer chains can coexist per
   * peer pair without crashing into each other via the shared mining
   * cache.
   */
  async sendWithSigner(
    signerHex: string,
    identifierHex: string,
    notificationType: GsocNotificationType,
    data?: Record<string, unknown>,
  ): Promise<void> {
    const notification: GsocNotification = {
      type: notificationType,
      from: this.myAddress,
      timestamp: new Date().toISOString(),
      data,
    };
    await this.bee.gsocSend(
      this.batchId,
      signerHex,
      identifierHex,
      JSON.stringify(notification),
    );
  }

  /**
   * Subscribe using an explicit identifier + listen address. Mirror of
   * sendWithSigner for the receive side.
   */
  subscribeWithIdentifier(
    subscriptionKey: string,
    listenAddress: string,
    identifierHex: string,
    handler: {
      onNotification: (notification: GsocNotification) => void;
      onError?: (error: Error) => void;
      onClose?: () => void;
    },
  ): GsocSubscription {
    const existing = this.subscriptions.get(subscriptionKey);
    if (existing) existing.cancel();

    const sub = this.bee.gsocSubscribe(listenAddress, identifierHex, {
      onMessage: (data: any) => {
        try {
          const bytes = typeof data.toUint8Array === "function"
            ? data.toUint8Array()
            : data instanceof Uint8Array ? data : new Uint8Array(data);
          const text = new TextDecoder().decode(bytes);
          const notification = JSON.parse(text) as GsocNotification;
          handler.onNotification(notification);
        } catch (err) {
          handler.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      },
      onError: (error: Error) => handler.onError?.(error),
      onClose: () => {
        this.subscriptions.delete(subscriptionKey);
        handler.onClose?.();
      },
    });

    const subscription: GsocSubscription = {
      cancel: () => {
        sub.cancel();
        this.subscriptions.delete(subscriptionKey);
      },
    };
    this.subscriptions.set(subscriptionKey, subscription);
    return subscription;
  }

  /**
   * Send a notification to a peer via GSOC.
   *
   * The signer must have been mined first via `mineSigner()`.
   * Notifications are small (< 4KB) and arrive in < 1 second.
   *
   * @param targetOverlay - Peer's Bee node overlay address
   * @param notificationType - Type of notification
   * @param data - Optional payload data
   */
  async send(
    targetOverlay: string,
    notificationType: GsocNotificationType,
    data?: Record<string, unknown>,
  ): Promise<void> {
    const signerHex = this.minedSigners.get(targetOverlay);
    if (!signerHex) {
      throw new Error(
        `No GSOC signer mined for overlay ${targetOverlay.slice(0, 12)}. Call mineSigner() first.`,
      );
    }

    const identifier = makeIdentifierHexSync(`${NOTIFY_IDENTIFIER_PREFIX}${this.myAddress.toLowerCase()}`);
    const notification: GsocNotification = {
      type: notificationType,
      from: this.myAddress,
      timestamp: new Date().toISOString(),
      data,
    };

    await this.bee.gsocSend(
      this.batchId,
      signerHex,
      identifier,
      JSON.stringify(notification),
    );
  }

  /**
   * Subscribe to incoming GSOC notifications from a peer.
   *
   * The peer must have mined a signer targeting OUR overlay.
   * We subscribe using the address derived from their signer.
   *
   * @param peerAddress - Peer's Swarm signer address
   * @param gsocAddress - GSOC address to listen on (from peer's mined signer)
   * @param handler - Callback for incoming notifications
   * @returns Subscription handle with cancel()
   */
  subscribe(
    peerAddress: string,
    gsocAddress: string,
    handler: {
      onNotification: (notification: GsocNotification) => void;
      onError?: (error: Error) => void;
      onClose?: () => void;
    },
  ): GsocSubscription {
    const identifier = makeIdentifierHexSync(`${NOTIFY_IDENTIFIER_PREFIX}${peerAddress.toLowerCase()}`);
    const existingSub = this.subscriptions.get(peerAddress);
    if (existingSub) existingSub.cancel();

    const sub = this.bee.gsocSubscribe(gsocAddress, identifier, {
      onMessage: (data: any) => {
        try {
          const bytes = typeof data.toUint8Array === "function"
            ? data.toUint8Array()
            : data instanceof Uint8Array ? data : new Uint8Array(data);
          const text = new TextDecoder().decode(bytes);
          const notification = JSON.parse(text) as GsocNotification;
          handler.onNotification(notification);
        } catch (err) {
          handler.onError?.(
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      },
      onError: (error: Error) => {
        handler.onError?.(error);
      },
      onClose: () => {
        this.subscriptions.delete(peerAddress);
        handler.onClose?.();
      },
    });

    const subscription: GsocSubscription = {
      cancel: () => {
        sub.cancel();
        this.subscriptions.delete(peerAddress);
      },
    };

    this.subscriptions.set(peerAddress, subscription);
    return subscription;
  }

  /**
   * Convenience: send a typing indicator.
   */
  async sendTyping(targetOverlay: string): Promise<void> {
    return this.send(targetOverlay, "typing");
  }

  /**
   * Convenience: send a stopped-typing indicator.
   */
  async sendStoppedTyping(targetOverlay: string): Promise<void> {
    return this.send(targetOverlay, "stopped-typing");
  }

  /**
   * Convenience: send an online presence signal.
   */
  async sendOnline(targetOverlay: string): Promise<void> {
    return this.send(targetOverlay, "presence-online");
  }

  /**
   * Convenience: send an offline presence signal.
   */
  async sendOffline(targetOverlay: string): Promise<void> {
    return this.send(targetOverlay, "presence-offline");
  }

  /**
   * Convenience: notify that a document was updated.
   */
  async sendDocUpdated(
    targetOverlay: string,
    documentId: string,
    driveId: string,
  ): Promise<void> {
    return this.send(targetOverlay, "doc-updated", { documentId, driveId });
  }

  /**
   * Shut down all GSOC subscriptions.
   */
  shutdown(): void {
    for (const sub of this.subscriptions.values()) {
      sub.cancel();
    }
    this.subscriptions.clear();
  }
}
