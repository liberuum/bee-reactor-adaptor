/**
 * Integration test: end-to-end change-propagation latency.
 *
 * Measures the wall-clock delay from "Node A commits ops" to "Node B's
 * reactor.load is called with those ops" across two real Bee nodes,
 * exercising the full CollabManager pipeline on both sides:
 *
 *    A: handleLocalPush
 *       └─ opsFeed.appendBatch           (ACT upload + wrapper chunk + feed write)
 *       └─ pingPeersForCollab            (GSOC send)
 *    B: GSOC subscription fires          (handlePeerPing)
 *       └─ pollOnce → pollSummary        (read feed latest, download wrappers, ACT decrypt)
 *       └─ reactor.load(docId, branch, ops[])
 *
 * We report two numbers:
 *   - "poll-only" latency: GSOC deliberately disabled → B relies on the
 *     5s periodic poll. This is the floor we see today without pings.
 *   - "GSOC-triggered" latency: both sides share GSOC signers → B gets
 *     a ping and runs pollSummary immediately.
 *
 * Both sides use their own CollabManager with a stubbed reactor.load
 * on the receive side; the adapter-side code is the real pipeline.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Bee } from "@ethersphere/bee-js";
import { SwarmClient } from "../../src/swarm-client.js";
import { CollabManager } from "../../src/collab/collab-manager.js";
import { GsocNotifier } from "../../src/chat/gsoc-notifier.js";
import { CollabManifestFeed } from "../../src/collab/collab-manifest-feed.js";
import type { CollabSummary, CollabParticipant } from "../../src/collab/types.js";
import { buildCollabId } from "../../src/collab/types.js";

const BEE_URL_A = process.env.BEE_URL_A || process.env.BEE_URL || "https://dappnode-tailscale.tailcbc470.ts.net:1633";
const BEE_URL_B = process.env.BEE_URL_B || "http://172.22.208.1:1633";

const SIGNER_KEY_A = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const SIGNER_KEY_B = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

async function usableBatch(url: string): Promise<string | null> {
  const bee = new Bee(url);
  const stamps = await bee.getAllPostageBatch();
  return stamps.find((s) => s.usable)?.batchID.toHex() ?? null;
}

function installLocalStorageShim() {
  const g = globalThis as any;
  if (g.window?.localStorage) return;
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
  g.window = g.window ?? {};
  g.window.localStorage = ls;
  g.window.dispatchEvent = g.window.dispatchEvent ?? (() => true);
  g.window.addEventListener = g.window.addEventListener ?? (() => {});
  g.window.removeEventListener = g.window.removeEventListener ?? (() => {});
  if (typeof g.CustomEvent === "undefined") {
    g.CustomEvent = class CustomEvent<T> {
      type: string;
      detail: T;
      constructor(type: string, init?: { detail?: T }) {
        this.type = type;
        this.detail = (init?.detail ?? undefined) as T;
      }
    };
  }
}

describe("Collab end-to-end latency", () => {
  let beeA: Bee;
  let beeB: Bee;
  let clientA: SwarmClient;
  let clientB: SwarmClient;
  let batchIdA: string;
  let addrA: string;
  let addrB: string;
  let beePubA: string;
  let beePubB: string;
  let overlayA: string;
  let overlayB: string;

  beforeAll(async () => {
    installLocalStorageShim();

    beeA = new Bee(BEE_URL_A);
    beeB = new Bee(BEE_URL_B);
    const [hA, hB] = await Promise.all([
      beeA.getHealth().catch(() => null),
      beeB.getHealth().catch(() => null),
    ]);
    if (hA?.status !== "ok") throw new Error(`Node A unreachable at ${BEE_URL_A}`);
    if (hB?.status !== "ok") throw new Error(`Node B unreachable at ${BEE_URL_B}`);

    const batch = await usableBatch(BEE_URL_A);
    if (!batch) throw new Error(`No usable stamp on Node A`);
    batchIdA = batch;
    const batchB = (await usableBatch(BEE_URL_B)) ?? "0".repeat(64);

    const runPrefix = `test:collablatency:${Date.now()}`;
    clientA = new SwarmClient({
      beeUrl: BEE_URL_A, batchId: batchIdA, signerPrivateKey: SIGNER_KEY_A,
      useFeedMode: true, feedTopicPrefix: runPrefix, useEncryption: false,
    });
    clientB = new SwarmClient({
      beeUrl: BEE_URL_B, batchId: batchB, signerPrivateKey: SIGNER_KEY_B,
      useFeedMode: true, feedTopicPrefix: runPrefix, useEncryption: false,
    });

    addrA = clientA.getOwnerAddress().toLowerCase();
    addrB = clientB.getOwnerAddress().toLowerCase();
    beePubA = await clientA.getBeeNodePublicKey();
    beePubB = await clientB.getBeeNodePublicKey();
    const [addrInfoA, addrInfoB] = await Promise.all([
      fetch(`${BEE_URL_A}/addresses`).then((r) => r.json() as Promise<{ overlay: string }>),
      fetch(`${BEE_URL_B}/addresses`).then((r) => r.json() as Promise<{ overlay: string }>),
    ]);
    overlayA = addrInfoA.overlay;
    overlayB = addrInfoB.overlay;

    // Publish profiles so each side can look up the other for overlay +
    // beeNodePublicKey during GSOC provisioning.
    await clientA.publishPublicProfile(addrA, {
      address: addrA,
      beeNodePublicKey: beePubA,
      overlayAddress: overlayA,
      updatedAt: new Date().toISOString(),
    });
    await clientB.publishPublicProfile(addrB, {
      address: addrB,
      beeNodePublicKey: beePubB,
      overlayAddress: overlayB,
      updatedAt: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 3_000));
  });

  /** Helper: build a fresh (manager A, manager B) pair with a pre-seeded
   *  collab summary on both sides. `withGsoc` toggles whether each
   *  manager gets a GsocNotifier (enabling ping-based triggers). */
  async function buildPair(withGsoc: boolean, collabId: string, driveId: string, docId: string) {
    // Clear the shim storage so summaries from a previous test don't
    // leak into this one.
    (globalThis as any).window?.localStorage?.clear?.();
    const chatStub: any = {
      startSession: async () => ({}),
      sendMessage: async () => ({}),
      getSession: () => ({}),
    };
    const gsocA = withGsoc ? new GsocNotifier(beeA, batchIdA, addrA) : null;
    const gsocB = withGsoc ? new GsocNotifier(beeB, "0".repeat(64), addrB) : null;
    const managerA = new CollabManager(clientA, chatStub, addrA, gsocA);
    const managerB = new CollabManager(clientB, chatStub, addrB, gsocB);

    // Set up the manifest feed + grantee chain so both managers can
    // operate against a real collab. We do this on A's side
    // (initiator) and let B's manager learn membership via the
    // pre-seeded summary below — same shape the accept() path produces.
    const { ref: granteeRef, historyRef: granteeHist } =
      await clientA.createGrantees([beePubA, beePubB]);
    await new Promise((r) => setTimeout(r, 1100));

    const manifestFeed = new CollabManifestFeed(clientA);
    const now = new Date().toISOString();
    const participants: CollabParticipant[] = [
      { address: addrA, beeNodePublicKey: beePubA, joinedAt: now },
      { address: addrB, beeNodePublicKey: beePubB, joinedAt: now },
    ];
    const { feedIndex } = await manifestFeed.publish(
      {
        version: 1,
        collabId,
        kind: "document",
        driveId,
        documentId: docId,
        title: "Latency test",
        participants,
        initiator: addrA,
        createdAt: now,
        updatedAt: now,
      },
      granteeHist,
    );
    await new Promise((r) => setTimeout(r, 1100));

    const summaryA: CollabSummary = {
      collabId, kind: "document", driveId, documentId: docId,
      title: "Latency test",
      initiator: addrA,
      participants,
      manifestRef: "0".repeat(64),
      manifestActHistoryAddress: "0".repeat(64),
      manifestPublisherBeeNodePubKey: beePubA,
      manifestFeedIndex: feedIndex,
      currentGranteeRef: granteeRef,
      currentGranteeHistRef: granteeHist,
      lastActivityAt: now,
      status: "active",
    };
    const summaryB: CollabSummary = { ...summaryA };
    (managerA as any).summaries.set(collabId, summaryA);
    (managerB as any).summaries.set(collabId, summaryB);

    return { managerA, managerB };
  }

  it("poll-only floor: A commits → B reactor.load (no GSOC, 5s timer)", async () => {
    const driveId = `pollfloor-${Date.now().toString(16)}`;
    const docId = `doc-${Math.random().toString(16).slice(2, 10)}`;
    const collabId = buildCollabId("document", driveId, docId);

    const { managerA, managerB } = await buildPair(false, collabId, driveId, docId);
    try {
      let loadCalledAt = 0;
      (globalThis as any).window.ph = {
        reactorClient: {
          load: async (d: string, br: string, ops: any[]) => {
            loadCalledAt = Date.now();
            void d; void br; void ops;
          },
          get: async () => ({ state: { global: { nodes: [] } } }),
        },
      };

      const ops = [
        { operation: { id: "op-poll-1", index: 0, hash: "h1", timestampUtcMs: Date.now() },
          context: { documentId: docId, scope: "global", branch: "main" } },
      ];

      const startedAt = Date.now();
      await managerA.handleLocalPush({ driveId, docId, ops, scope: "global", branch: "main" });
      // handleLocalPush finishes when A's ACT feed write completes; B
      // will now either hit its 5s poll tick or wait for next one.
      while (loadCalledAt === 0 && Date.now() - startedAt < 40_000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(loadCalledAt).toBeGreaterThan(0);
      const latencyMs = loadCalledAt - startedAt;
      console.log(`poll-only latency: ${latencyMs}ms (A commit → B reactor.load)`);
      // Hard ceiling: one poll interval + a round-trip worth of slack.
      // Poll loop runs ~1.5s after boot then every 5s, so we expect
      // <12s in the p50 but guard at 40s to avoid flakes.
      expect(latencyMs).toBeLessThan(40_000);
    } finally {
      managerA.shutdown();
      managerB.shutdown();
    }
  }, 90_000);

  it("GSOC-triggered: A commits → GSOC ping → B reactor.load (real-time)", async () => {
    const driveId = `gsoclat-${Date.now().toString(16)}`;
    const docId = `doc-${Math.random().toString(16).slice(2, 10)}`;
    const collabId = buildCollabId("document", driveId, docId);

    const { managerA, managerB } = await buildPair(true, collabId, driveId, docId);
    try {
      let loadCalledAt = 0;
      (globalThis as any).window.ph = {
        reactorClient: {
          load: async (d: string, br: string, ops: any[]) => {
            loadCalledAt = Date.now();
            void d; void br; void ops;
          },
          get: async () => ({ state: { global: { nodes: [] } } }),
        },
      };

      // Give GSOC provisioning time to complete on both sides before
      // measuring. provisionOutboundGsoc is kicked off by the pair
      // setup indirectly — but to be thorough, call it explicitly here
      // so mining + profile publish happen before the test body runs.
      await (managerA as any).provisionOutboundGsoc(collabId, [
        { address: addrA, beeNodePublicKey: beePubA, joinedAt: "" },
        { address: addrB, beeNodePublicKey: beePubB, joinedAt: "" },
      ]);
      await (managerB as any).provisionOutboundGsoc(collabId, [
        { address: addrA, beeNodePublicKey: beePubA, joinedAt: "" },
        { address: addrB, beeNodePublicKey: beePubB, joinedAt: "" },
      ]);
      // Let profile writes propagate cross-node so subscribe reads
      // find the counterparty's outbound address.
      await new Promise((r) => setTimeout(r, 8_000));

      // B subscribes to A's outbound-to-B GSOC.
      const summaryB = (managerB as any).summaries.get(collabId);
      await (managerB as any).subscribeToPeerGsoc(summaryB);
      // Brief wait so the WebSocket is established.
      await new Promise((r) => setTimeout(r, 2_000));

      const ops = [
        { operation: { id: "op-gsoc-1", index: 0, hash: "h1", timestampUtcMs: Date.now() },
          context: { documentId: docId, scope: "global", branch: "main" } },
      ];

      const startedAt = Date.now();
      await managerA.handleLocalPush({ driveId, docId, ops, scope: "global", branch: "main" });
      const committedAt = Date.now();
      console.log(`A handleLocalPush completed in ${committedAt - startedAt}ms`);

      while (loadCalledAt === 0 && Date.now() - startedAt < 60_000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(loadCalledAt).toBeGreaterThan(0);
      const totalLatencyMs = loadCalledAt - startedAt;
      const postCommitLatencyMs = loadCalledAt - committedAt;
      console.log(`GSOC-triggered latency:`);
      console.log(`  A commit → B reactor.load TOTAL: ${totalLatencyMs}ms`);
      console.log(`  A write DONE → B reactor.load: ${postCommitLatencyMs}ms (propagation + pull)`);
      // With GSOC working we expect post-commit propagation well under
      // the 5s poll interval. Total includes A's own write time.
      expect(totalLatencyMs).toBeLessThan(60_000);
    } finally {
      managerA.shutdown();
      managerB.shutdown();
    }
  }, 240_000);
});
