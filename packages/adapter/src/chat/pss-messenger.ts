/**
 * PSS Messenger — 1-to-1 encrypted messaging over Swarm.
 *
 * Uses Trojan chunks: sender mines a chunk whose address falls in the
 * recipient's neighborhood. Only the recipient can decrypt. Third parties
 * see encrypted noise indistinguishable from regular Swarm traffic.
 *
 * Latency: 2-10 seconds (Trojan chunk mining + push-sync).
 * Offline delivery: messages persist as chunks until stamp TTL expires.
 * Requirement: recipient must run a FULL Bee node.
 */
import { type Bee, Topic } from "@ethersphere/bee-js";
import type { ChatMessage } from "./types.js";

const TOPIC_PREFIX = "ph:v2:chat:";

export interface PssSubscription {
  cancel: () => void;
}

export interface PssMessageHandler {
  onMessage: (raw: Uint8Array) => void;
  onError: (error: Error) => void;
  onClose: () => void;
}

/**
 * Derive a deterministic PSS topic for a 1-to-1 conversation.
 * Sorting ensures both parties derive the same topic.
 */
export function chatTopic(addressA: string, addressB: string): string {
  const sorted = [addressA.toLowerCase(), addressB.toLowerCase()].sort();
  return `${TOPIC_PREFIX}${sorted[0]}:${sorted[1]}`;
}

/**
 * Derive the PSS target prefix from an overlay address.
 * Uses up to 4 hex chars for maximum targeting precision.
 */
export function makeTarget(overlayAddress: string): string {
  const clean = overlayAddress.replace(/^0x/i, "");
  return clean.slice(0, 4);
}

export class PssMessenger {
  private subscriptions = new Map<string, PssSubscription>();

  constructor(
    private readonly bee: Bee,
    private readonly batchId: string,
    private readonly myAddress: string,
  ) {}

  /**
   * Send a chat message via PSS.
   *
   * @param peerOverlay - Recipient's Bee node overlay address
   * @param peerBeeNodePubKey - Recipient's Bee node public key (for encryption)
   * @param peerAddress - Recipient's Swarm signer address (for topic derivation)
   * @param message - The message to send
   */
  async send(
    peerOverlay: string,
    peerBeeNodePubKey: string,
    peerAddress: string,
    message: ChatMessage,
  ): Promise<void> {
    const topic = chatTopic(this.myAddress, peerAddress);
    const target = makeTarget(peerOverlay);
    const payload = JSON.stringify(message);

    await this.bee.pssSend(
      this.batchId,
      Topic.fromString(topic),
      target,
      payload,
      peerBeeNodePubKey,
    );
  }

  /**
   * Subscribe to incoming PSS messages from a specific peer.
   *
   * Opens a WebSocket connection to the Bee node's PSS subscription
   * endpoint. Messages arrive as raw bytes (decrypted by the Bee node).
   *
   * @param peerAddress - Peer's Swarm signer address (for topic derivation)
   * @param handler - Callbacks for message, error, close events
   * @returns Subscription handle with cancel() method
   */
  subscribe(
    peerAddress: string,
    handler: {
      onMessage: (message: ChatMessage) => void;
      onError?: (error: Error) => void;
      onClose?: () => void;
    },
  ): PssSubscription {
    const topic = chatTopic(this.myAddress, peerAddress);
    const existingSub = this.subscriptions.get(topic);
    if (existingSub) existingSub.cancel();

    const sub = this.bee.pssSubscribe(Topic.fromString(topic), {
      onMessage: (data: any) => {
        try {
          const bytes = typeof data.toUint8Array === "function"
            ? data.toUint8Array()
            : data instanceof Uint8Array ? data : new Uint8Array(data);
          const text = new TextDecoder().decode(bytes);
          const message = JSON.parse(text) as ChatMessage;
          handler.onMessage(message);
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
        this.subscriptions.delete(topic);
        handler.onClose?.();
      },
    });

    const subscription: PssSubscription = {
      cancel: () => {
        sub.cancel();
        this.subscriptions.delete(topic);
      },
    };

    this.subscriptions.set(topic, subscription);
    return subscription;
  }

  /**
   * Subscribe to ALL incoming PSS messages (any peer).
   * Useful for listening to new conversations.
   *
   * Uses a wildcard-like approach: subscribes to the prefix topic
   * and routes by sender address in the message.
   */
  subscribeAll(handler: {
    onMessage: (message: ChatMessage) => void;
    onError?: (error: Error) => void;
  }): PssSubscription {
    // PSS doesn't support wildcard topics natively.
    // Instead, we subscribe to a "broadcast" topic that all users
    // send an initial ping to when starting a conversation.
    const broadcastTopic = `${TOPIC_PREFIX}broadcast:${this.myAddress.toLowerCase()}`;

    const sub = this.bee.pssSubscribe(Topic.fromString(broadcastTopic), {
      onMessage: (data: any) => {
        try {
          const bytes = typeof data.toUint8Array === "function"
            ? data.toUint8Array()
            : data instanceof Uint8Array ? data : new Uint8Array(data);
          const text = new TextDecoder().decode(bytes);
          const message = JSON.parse(text) as ChatMessage;
          handler.onMessage(message);
        } catch (err) {
          handler.onError?.(
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      },
      onError: (error: Error) => {
        handler.onError?.(error);
      },
      onClose: () => {},
    });

    return { cancel: () => sub.cancel() };
  }

  /**
   * Send an initial ping to a peer's broadcast topic.
   * This notifies them that a new conversation has started.
   */
  async sendBroadcastPing(
    peerOverlay: string,
    peerBeeNodePubKey: string,
    peerAddress: string,
    introMessage: ChatMessage,
  ): Promise<void> {
    const broadcastTopic = `${TOPIC_PREFIX}broadcast:${peerAddress.toLowerCase()}`;
    const target = makeTarget(peerOverlay);
    const payload = JSON.stringify(introMessage);

    await this.bee.pssSend(
      this.batchId,
      Topic.fromString(broadcastTopic),
      target,
      payload,
      peerBeeNodePubKey,
    );
  }

  /**
   * Shut down all active PSS subscriptions.
   */
  shutdown(): void {
    for (const sub of this.subscriptions.values()) {
      sub.cancel();
    }
    this.subscriptions.clear();
  }
}
