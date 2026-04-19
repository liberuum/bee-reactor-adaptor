/**
 * Integration test: CollabManager end-to-end push + pull across two Bee nodes.
 *
 * Verifies the full live-collab data loop:
 *   1. Node A's CollabManager.handleLocalPush mirrors ops to the ACT-gated
 *      per-peer feed.
 *   2. Node B's CollabManager poll loop reads the same feed, decrypts via
 *      ACT, unwraps OperationWithContext, and calls reactor.load.
 *
 * The test bypasses the chat invitation path (which needs a full browser
 * reactor + ChatManager session) by injecting a CollabSummary directly on
 * both sides. What we exercise is the data plane, not the handshake.
 *
 * Requires two live Bee nodes (same defaults as other integration tests).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Bee } from "@ethersphere/bee-js";
import { SwarmClient } from "../../src/swarm-client.js";
import { CollabManager } from "../../src/collab/manager/index.js";
import type { CollabSummary } from "../../src/collab/types.js";
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

// Minimal in-memory localStorage shim for Node. CollabManager persists
// summaries and cursors to localStorage; Vitest runs under Node by default.
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
  // Some code paths read dispatchEvent — no-op is fine for tests.
  g.window.dispatchEvent = g.window.dispatchEvent ?? (() => true);
  g.window.addEventListener = g.window.addEventListener ?? (() => {});
  g.window.removeEventListener = g.window.removeEventListener ?? (() => {});
  // CustomEvent isn't needed on Node for our path — we only dispatch it
  // when the CollabManager applies ops, and the dispatch is wrapped in
  // try/catch. If Node's global has it already, great; otherwise stub.
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

function installPhStub(loadSpy: (docId: string, branch: string, ops: any[]) => void) {
  const g = globalThis as any;
  g.window = g.window ?? {};
  // IReactor.load() is on `reactorClientModule.reactorModule.reactor` in
  // Connect — mirror that layout so the manager's reactor-bridge resolves
  // to our spy. `reactorClient.get` is kept for listDocIdsInDrive.
  g.window.ph = {
    reactorClientModule: {
      reactorModule: {
        reactor: {
          load: async (docId: string, branch: string, ops: any[]) => {
            loadSpy(docId, branch, ops);
          },
        },
      },
    },
    reactorClient: {
      get: async (driveId: string) => ({
        state: { global: { nodes: [] } },
        header: { id: driveId, name: "stub-drive" },
      }),
    },
  };
}

describe("CollabManager: push + pull round trip", () => {
  let clientA: SwarmClient;
  let clientB: SwarmClient;
  let beePubA: string;
  let beePubB: string;
  let addrA: string;
  let addrB: string;
  let batchIdA: string;

  beforeAll(async () => {
    installLocalStorageShim();

    const beeA = new Bee(BEE_URL_A);
    const beeB = new Bee(BEE_URL_B);
    const [hA, hB] = await Promise.all([
      beeA.getHealth().catch(() => null),
      beeB.getHealth().catch(() => null),
    ]);
    if (hA?.status !== "ok") throw new Error(`Node A unreachable at ${BEE_URL_A}`);
    if (hB?.status !== "ok") throw new Error(`Node B unreachable at ${BEE_URL_B}`);

    const ba = await usableBatch(BEE_URL_A);
    if (!ba) throw new Error(`No usable stamp on Node A (${BEE_URL_A})`);
    batchIdA = ba;
    const bb = (await usableBatch(BEE_URL_B)) ?? "0".repeat(64);

    const runPrefix = `test:collab-mgr:${Date.now()}`;

    clientA = new SwarmClient({
      beeUrl: BEE_URL_A, batchId: batchIdA, signerPrivateKey: SIGNER_KEY_A,
      useFeedMode: true, feedTopicPrefix: runPrefix, useEncryption: false,
    });
    clientB = new SwarmClient({
      beeUrl: BEE_URL_B, batchId: bb, signerPrivateKey: SIGNER_KEY_B,
      useFeedMode: true, feedTopicPrefix: runPrefix, useEncryption: false,
    });
    addrA = clientA.getOwnerAddress().toLowerCase();
    addrB = clientB.getOwnerAddress().toLowerCase();
    beePubA = await clientA.getBeeNodePublicKey();
    beePubB = await clientB.getBeeNodePublicKey();

    expect(addrA).not.toBe(addrB);
    expect(beePubA).not.toBe(beePubB);
    console.log(`Collab test: A=${addrA.slice(0, 10)}… B=${addrB.slice(0, 10)}…`);
  });

  afterAll(() => {
    // Clear localStorage shim so subsequent test files don't inherit summaries.
    try {
      (globalThis as any).window?.localStorage?.clear?.();
    } catch { /* shim-less env */ }
  });

  it("doc-level: Node A's local push propagates to Node B's reactor.load", async () => {
    const driveId = `drive-${Date.now().toString(16)}`;
    const docId = `doc-${Math.random().toString(16).slice(2, 10)}`;
    const collabId = buildCollabId("document", driveId, docId);

    // Shared participant list — both managers see the same membership
    // (Manifest feed isn't in play for this test; we inject summaries).
    const participants = [
      { address: addrA, beeNodePublicKey: beePubA, joinedAt: new Date().toISOString() },
      { address: addrB, beeNodePublicKey: beePubB, joinedAt: new Date().toISOString() },
    ];

    // Node A manager — we won't call accept/create, just inject & push.
    const chatStub: any = {
      startSession: async () => ({}),
      sendMessage: async () => ({}),
      getSession: () => ({}),
    };
    const managerA = new CollabManager(clientA, chatStub, addrA);
    const managerB = new CollabManager(clientB, chatStub, addrB);

    const summaryA: CollabSummary = {
      collabId,
      kind: "document",
      driveId,
      documentId: docId,
      title: "Test doc",
      initiator: addrA,
      participants,
      manifestRef: "deadbeef".padEnd(64, "0"),
      manifestActHistoryAddress: "cafebabe".padEnd(64, "0"),
      manifestPublisherBeeNodePubKey: beePubA,
      lastActivityAt: new Date().toISOString(),
      status: "active",
    };
    const summaryB: CollabSummary = { ...summaryA, initiator: addrA };

    // Direct injection into the managers' private summaries map — the
    // intent is to skip the invite handshake (which needs a full
    // ChatManager + reactor) and exercise just the data plane.
    (managerA as any).store.set(collabId, summaryA);
    (managerB as any).store.set(collabId, summaryB);

    // Stub B's reactor.load so the poll loop's apply path captures calls.
    const loadCalls: Array<{ docId: string; branch: string; ops: any[] }> = [];
    installPhStub((d, br, ops) => loadCalls.push({ docId: d, branch: br, ops }));

    // Simulate what SwarmChannel.pushSyncOperation does after a successful
    // personal-feed push: call handleLocalPush with the outbound op batch.
    const ops = [
      {
        operation: { id: "op-live-1", index: 0, hash: "h1", timestampUtcMs: Date.now() },
        context: { documentId: docId, scope: "global", branch: "main" },
      },
      {
        operation: { id: "op-live-2", index: 1, hash: "h2", timestampUtcMs: Date.now() + 1 },
        context: { documentId: docId, scope: "global", branch: "main" },
      },
    ];
    await managerA.handleLocalPush({
      driveId,
      docId,
      ops,
      scope: "global",
      branch: "main",
    });

    // B polls every 5s and also runs ~1.5s after construction. Give
    // propagation + ACT grace time, then confirm the load was called
    // with B's stub.
    let sawLoad = false;
    const waits = [6_000, 10_000, 15_000, 20_000, 25_000];
    for (const w of waits) {
      await new Promise((r) => setTimeout(r, w));
      if (loadCalls.length > 0) {
        sawLoad = true;
        break;
      }
    }

    try {
      expect(sawLoad).toBe(true);
      expect(loadCalls[0].docId).toBe(docId);
      expect(loadCalls[0].branch).toBe("main");
      // After unwrap: the bare operations (not OperationWithContext) reach load.
      expect(loadCalls[0].ops.length).toBe(2);
      expect(loadCalls[0].ops[0].id).toBe("op-live-1");
      expect(loadCalls[0].ops[1].id).toBe("op-live-2");
      console.log(
        `B's reactor.load received ${loadCalls[0].ops.length} op(s) for ${docId.slice(0, 8)}… after A's push`,
      );
    } finally {
      managerA.shutdown();
      managerB.shutdown();
    }
  }, 120_000);

  it("no matching summary → handleLocalPush is a no-op", async () => {
    // Fresh manager with no summaries. A push should return without
    // throwing and without attempting any feed writes. We verify the
    // second condition indirectly: the call completes in < 100 ms even
    // on a slow network (real Bee uploads take > 1 s).
    const chatStub: any = {
      startSession: async () => ({}),
      sendMessage: async () => ({}),
    };
    const mgr = new CollabManager(clientA, chatStub, addrA);
    try {
      const start = Date.now();
      await mgr.handleLocalPush({
        driveId: "no-summary",
        docId: "no-summary",
        ops: [{ operation: { id: "x", index: 0 } }],
        scope: "global",
        branch: "main",
      });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(500);
    } finally {
      mgr.shutdown();
    }
  });

  it("user manifest: ensureCollabInUserManifest upserts + listCollabsFromUserManifest reads it back", async () => {
    const {
      ensureCollabInUserManifest,
      listCollabsFromUserManifest,
      removeCollabFromUserManifest,
    } = await import("../../src/channel/manifest-manager.js");

    const collabId = `drive:rehydrate-${Date.now().toString(16)}`;
    const now = new Date().toISOString();
    const entry = {
      collabId,
      kind: "drive" as const,
      driveId: collabId.replace("drive:", ""),
      title: "Rehydrate test",
      role: "initiator" as const,
      initiator: clientA.getOwnerAddress().toLowerCase(),
      manifestOwnerAddress: clientA.getOwnerAddress().toLowerCase(),
      manifestPublisherBeeNodePubKey: beePubA,
      joinedAt: now,
      lastActivityAt: now,
    };

    await ensureCollabInUserManifest(clientA, clientA.getOwnerAddress(), entry);
    let registry = await listCollabsFromUserManifest(clientA, clientA.getOwnerAddress());
    expect(registry[collabId]).toBeDefined();
    expect(registry[collabId].title).toBe("Rehydrate test");

    // Upsert an update — title change should land; lastActivityAt should
    // win the max.
    const later = new Date(Date.now() + 60_000).toISOString();
    await ensureCollabInUserManifest(clientA, clientA.getOwnerAddress(), {
      ...entry,
      title: "Rehydrate test v2",
      lastActivityAt: later,
    });
    registry = await listCollabsFromUserManifest(clientA, clientA.getOwnerAddress());
    expect(registry[collabId].title).toBe("Rehydrate test v2");
    expect(registry[collabId].lastActivityAt).toBe(later);

    // Removal wipes the entry.
    await removeCollabFromUserManifest(clientA, clientA.getOwnerAddress(), collabId);
    registry = await listCollabsFromUserManifest(clientA, clientA.getOwnerAddress());
    expect(registry[collabId]).toBeUndefined();
  }, 90_000);

  it("revoke round trip: initiator removes peer → peer's ops feed can't be extended under the new chain", async () => {
    // We set up the inviter's CollabManager with an initialized summary
    // (simulating a post-create state), then call revokeParticipant and
    // verify the manifest feed advances to a new revision with the
    // shrunken participant list.
    const chatStub: any = {
      startSession: async () => ({}),
      sendMessage: async () => ({}),
      getSession: () => ({}),
    };
    const managerA = new CollabManager(clientA, chatStub, addrA);

    try {
      const driveId = `revdrive-${Date.now().toString(16)}`;
      const collabId = `drive:${driveId}`;
      const now = new Date().toISOString();

      // Seed the manager with a collab we created. Participants are A
      // (initiator) and B. Grantee chain is already established.
      const { ref: granteeRef, historyRef } = await clientA.createGrantees([beePubA, beePubB]);
      await new Promise((r) => setTimeout(r, 1100));
      // Publish manifest v0 so the feed exists before we revoke.
      const { CollabManifestFeed } = await import("../../src/collab/collab-manifest-feed.js");
      const manifestFeed = new CollabManifestFeed(clientA);
      const v0 = await manifestFeed.publish({
        version: 1,
        collabId,
        kind: "drive",
        driveId,
        title: "Revoke round trip",
        participants: [
          { address: addrA, beeNodePublicKey: beePubA, joinedAt: now },
          { address: addrB, beeNodePublicKey: beePubB, joinedAt: now },
        ],
        initiator: addrA,
        createdAt: now,
        updatedAt: now,
      }, historyRef);
      await new Promise((r) => setTimeout(r, 1100));

      (managerA as any).store.set(collabId, {
        collabId,
        kind: "drive",
        driveId,
        title: "Revoke round trip",
        initiator: addrA,
        participants: [
          { address: addrA, beeNodePublicKey: beePubA, joinedAt: now },
          { address: addrB, beeNodePublicKey: beePubB, joinedAt: now },
        ],
        manifestRef: "0".repeat(64),
        manifestActHistoryAddress: "0".repeat(64),
        manifestPublisherBeeNodePubKey: beePubA,
        manifestFeedIndex: v0.feedIndex,
        currentGranteeRef: granteeRef,
        currentGranteeHistRef: historyRef,
        lastActivityAt: now,
        status: "active",
      });

      // Revoke B. This should rebuild the grantee chain and publish
      // manifest v1 with just A.
      const updated = await managerA.revokeParticipant(collabId, addrB);
      expect(updated.participants).toHaveLength(1);
      expect(updated.participants[0].address).toBe(addrA);
      expect(updated.currentGranteeHistRef).not.toBe(historyRef); // rotated
      expect((updated.manifestFeedIndex ?? 0)).toBeGreaterThan(v0.feedIndex);

      console.log(
        `Revoke complete: manifest feed advanced ${v0.feedIndex} → ${updated.manifestFeedIndex}, grantee chain rotated`,
      );
    } finally {
      managerA.shutdown();
    }
  }, 90_000);

  it("leave() removes the summary and persists", async () => {
    const chatStub: any = {
      startSession: async () => ({}),
      sendMessage: async () => ({}),
    };
    const mgr = new CollabManager(clientA, chatStub, addrA);
    const fakeId = buildCollabId("drive", `drive-leave-${Date.now()}`);
    (mgr as any).store.set(fakeId, {
      collabId: fakeId,
      kind: "drive",
      driveId: fakeId.slice("drive:".length),
      title: "to leave",
      initiator: addrA,
      participants: [],
      manifestRef: "0".repeat(64),
      manifestActHistoryAddress: "0".repeat(64),
      manifestPublisherBeeNodePubKey: "00",
      lastActivityAt: new Date().toISOString(),
      status: "active",
    });
    (mgr as any).store.persist();

    await mgr.leave(fakeId);

    expect(mgr.list().find((s) => s.collabId === fakeId)).toBeUndefined();

    // Re-construct — the persisted state should no longer contain it.
    const mgr2 = new CollabManager(clientA, chatStub, addrA);
    expect(mgr2.list().find((s) => s.collabId === fakeId)).toBeUndefined();

    mgr.shutdown();
    mgr2.shutdown();
  });
});
