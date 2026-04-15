/**
 * Integration test: PSS messaging + GSOC notifications
 *
 * Tests the Swarm chat infrastructure against two live Bee nodes:
 * - PSS: send/receive encrypted 1-to-1 messages
 * - GSOC: mine signers, send/receive sub-second notifications
 * - ChatManager: session lifecycle, message flow, event handlers
 *
 * Requires TWO full Bee nodes:
 *   BEE_URL_A="https://node-a:1633" BEE_URL_B="http://node-b:1633" bun test chat-pss-gsoc
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Bee, Topic } from "@ethersphere/bee-js";
import { SwarmClient } from "../../src/swarm-client.js";
import { PssMessenger, chatTopic, makeTarget } from "../../src/chat/pss-messenger.js";
import { GsocNotifier } from "../../src/chat/gsoc-notifier.js";
import { ChatManager } from "../../src/chat/chat-manager.js";
import type { ChatMessage, GsocNotification } from "../../src/chat/types.js";

const BEE_URL_A = process.env.BEE_URL_A || process.env.BEE_URL || "https://dappnode-tailscale.tailcbc470.ts.net:1633";
const BEE_URL_B = process.env.BEE_URL_B || "http://172.22.208.1:1633";

const SIGNER_KEY_A = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const SIGNER_KEY_B = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

let beeA: Bee;
let beeB: Bee;
let clientA: SwarmClient;
let clientB: SwarmClient;
let batchIdA: string;
let addressA: string;
let addressB: string;
let pubKeyA: string;
let pubKeyB: string;
let overlayA: string;
let overlayB: string;

describe("Chat: PSS + GSOC", () => {
  beforeAll(async () => {
    beeA = new Bee(BEE_URL_A);
    beeB = new Bee(BEE_URL_B);

    const [healthA, healthB] = await Promise.all([
      beeA.getHealth().catch(() => null),
      beeB.getHealth().catch(() => null),
    ]);
    if (!healthA || healthA.status !== "ok") throw new Error(`Node A not reachable at ${BEE_URL_A}`);
    if (!healthB || healthB.status !== "ok") throw new Error(`Node B not reachable at ${BEE_URL_B}`);

    const stampsA = await beeA.getAllPostageBatch();
    const usableA = stampsA.find(s => s.usable);
    if (!usableA) throw new Error(`No usable stamp on Node A`);
    batchIdA = usableA.batchID.toHex();

    clientA = new SwarmClient({
      beeUrl: BEE_URL_A, batchId: batchIdA, signerPrivateKey: SIGNER_KEY_A,
      useFeedMode: true, feedTopicPrefix: "test:chat", useEncryption: false,
    });
    clientB = new SwarmClient({
      beeUrl: BEE_URL_B, batchId: "0".repeat(64), signerPrivateKey: SIGNER_KEY_B,
      useFeedMode: true, feedTopicPrefix: "test:chat", useEncryption: false,
    });

    addressA = clientA.getOwnerAddress();
    addressB = clientB.getOwnerAddress();

    const [addrA, addrB] = await Promise.all([
      fetch(`${BEE_URL_A}/addresses`).then(r => r.json()) as Promise<{ publicKey: string; overlay: string }>,
      fetch(`${BEE_URL_B}/addresses`).then(r => r.json()) as Promise<{ publicKey: string; overlay: string }>,
    ]);
    pubKeyA = addrA.publicKey;
    pubKeyB = addrB.publicKey;
    overlayA = addrA.overlay;
    overlayB = addrB.overlay;

    console.log(`Node A: ${BEE_URL_A} — overlay ${overlayA.slice(0, 12)}...`);
    console.log(`Node B: ${BEE_URL_B} — overlay ${overlayB.slice(0, 12)}...`);
  });

  // ─── Utility Tests ───────────────────────────────────────────

  describe("Topic derivation", () => {
    it("should produce deterministic topics regardless of address order", () => {
      const t1 = chatTopic(addressA, addressB);
      const t2 = chatTopic(addressB, addressA);
      expect(t1).toBe(t2);
    });

    it("should produce 4-char targets from overlay addresses", () => {
      const target = makeTarget(overlayA);
      expect(target).toHaveLength(4);
      expect(/^[0-9a-f]{4}$/i.test(target)).toBe(true);
    });
  });

  // ─── PSS Tests ───────────────────────────────────────────────

  describe("PSS messaging", () => {
    it("should send a PSS message from Node A and receive on Node A (same node)", async () => {
      const pss = new PssMessenger(beeA, batchIdA, addressA);

      const received: ChatMessage[] = [];
      const topic = chatTopic(addressA, addressB);

      // Subscribe first
      const sub = beeA.pssSubscribe(Topic.fromString(topic), {
        onMessage: (data: any) => {
          const bytes = typeof data.toUint8Array === "function" ? data.toUint8Array() : new Uint8Array(data);
          const msg = JSON.parse(new TextDecoder().decode(bytes)) as ChatMessage;
          received.push(msg);
        },
        onError: () => {},
        onClose: () => {},
      });

      // Send to ourselves (same-node test — message routed internally)
      const message: ChatMessage = {
        id: crypto.randomUUID(),
        from: addressA,
        to: addressB,
        text: "Hello from PSS!",
        timestamp: new Date().toISOString(),
        status: "sent",
      };

      await pss.send(overlayA, pubKeyA, addressB, message);

      // Wait for delivery (PSS mining takes 2-10s)
      await new Promise(r => setTimeout(r, 12_000));

      sub.cancel();
      pss.shutdown();

      // On same-node, the message should be delivered
      expect(received.length).toBeGreaterThanOrEqual(1);
      expect(received[0].text).toBe("Hello from PSS!");
      expect(received[0].from).toBe(addressA);

      console.log(`PSS same-node: sent + received "${received[0].text}"`);
    }, 20_000);
  });

  // ─── GSOC Tests ──────────────────────────────────────────────

  describe("GSOC notifications", () => {
    it("should mine a GSOC signer targeting Node A's overlay", () => {
      const gsoc = new GsocNotifier(beeA, batchIdA, addressA);
      const signer = gsoc.mineSigner(overlayA, 8); // lower proximity = faster mining
      expect(signer).toBeTruthy();
      console.log(`GSOC signer mined for overlay ${overlayA.slice(0, 12)}`);
      gsoc.shutdown();
    });

    it("should send a GSOC notification without error", async () => {
      const gsoc = new GsocNotifier(beeA, batchIdA, addressA);
      gsoc.mineSigner(overlayA, 8);

      // Send a notification — verifies the full mine + send flow works
      await gsoc.send(overlayA, "typing");
      await gsoc.send(overlayA, "presence-online");
      await gsoc.send(overlayA, "doc-updated", { documentId: "test-doc-123" });

      console.log("GSOC notifications sent: typing, online, doc-updated");
      gsoc.shutdown();
    });
  });

  // ─── ChatManager Tests ───────────────────────────────────────

  describe("ChatManager", () => {
    it("should create a ChatManager and publish profiles for session init", async () => {
      // Publish profiles so startSession can resolve them
      await clientA.publishPublicProfile(addressA, {
        address: addressA,
        beeNodePublicKey: pubKeyA,
        overlayAddress: overlayA,
        updatedAt: new Date().toISOString(),
      });

      // Wait for feed propagation
      await new Promise(r => setTimeout(r, 5_000));

      const chat = new ChatManager(clientA, beeA, batchIdA, addressA);

      // Start session with self (same-node — both addresses resolve to same profiles)
      // In production this would be a different peer
      const session = await chat.startSession(addressA, { skipGsoc: true });

      expect(session.ready).toBe(true);
      expect(session.peerBeeNodePubKey).toBe(pubKeyA);
      expect(session.peerOverlay).toBe(overlayA);
      expect(session.pssTopic).toBeTruthy();
      expect(session.historyTopic).toBeTruthy();

      console.log(`ChatManager session ready: topic=${session.pssTopic.slice(0, 20)}...`);

      chat.shutdown();
    }, 15_000);

    it("should send a message through ChatManager and fire events", async () => {
      await clientA.publishPublicProfile(addressA, {
        address: addressA,
        beeNodePublicKey: pubKeyA,
        overlayAddress: overlayA,
        updatedAt: new Date().toISOString(),
      });
      await new Promise(r => setTimeout(r, 3_000));

      const chat = new ChatManager(clientA, beeA, batchIdA, addressA);
      const events: string[] = [];
      chat.onEvent((e) => events.push(e.type));

      const session = await chat.startSession(addressA, { skipGsoc: true });
      const msg = await chat.sendMessage(session, "Test from ChatManager");

      expect(msg.text).toBe("Test from ChatManager");
      expect(msg.status).toBe("sent");
      expect(msg.from).toBe(addressA);
      expect(events).toContain("session-ready");
      expect(events).toContain("message-sent");

      console.log(`ChatManager sent: "${msg.text}", events: [${events.join(", ")}]`);

      chat.shutdown();
    }, 20_000);
  });
});
