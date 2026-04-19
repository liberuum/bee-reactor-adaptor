/**
 * Unit tests for CollabManager — pure logic only (state management,
 * event emission, persistence, cursor advancement, ping routing).
 *
 * Network-dependent flows (create, accept, revoke, provisionOutbound,
 * poll-loop's real feed reads) live in integration tests. This file
 * runs with zero Bee dependency so it can ship in CI without a node.
 *
 * The manager is now composed of sub-components (store, applyPipeline,
 * gsoc, pollLoop, events). Tests reach into those via `(mgr as any).
 * <component>` to exercise the internal contract directly — this is a
 * deliberate design choice: they test the orchestration surface the
 * facade exposes to its collaborators, not the facade's public API
 * only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CollabManager } from "../../src/collab/manager/index.js";
import type { CollabSummary, CollabParticipant } from "../../src/collab/types.js";
import { buildCollabId } from "../../src/collab/types.js";

// ─── Lightweight globals shim (browser-only APIs used by manager) ───

const TEST_ADDRESS = "0x1111111111111111111111111111111111111111";
const PEER_ADDRESS = "0x2222222222222222222222222222222222222222";
const THIRD_ADDRESS = "0x3333333333333333333333333333333333333333";

function installGlobals(reactorLoad?: (docId: string, branch: string, ops: unknown[]) => void) {
  const g = globalThis as any;
  const store = new Map<string, string>();
  const listeners = new Map<string, Set<(e: any) => void>>();
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
  g.window.addEventListener = (name: string, fn: (e: any) => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(fn);
  };
  g.window.removeEventListener = (name: string, fn: (e: any) => void) => {
    listeners.get(name)?.delete(fn);
  };
  g.window.dispatchEvent = (evt: any) => {
    for (const fn of listeners.get(evt?.type) ?? []) {
      try { fn(evt); } catch { /* ignore */ }
    }
    return true;
  };
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
  // IReactor.load() lives at ph.reactorClientModule.reactorModule.reactor in
  // Connect. Keep the reactorClient with `.get` for listDocIdsInDrive.
  g.window.ph = reactorLoad
    ? {
        reactorClientModule: {
          reactorModule: {
            reactor: {
              load: async (d: string, br: string, ops: unknown[]) => {
                reactorLoad(d, br, ops);
              },
            },
          },
        },
        reactorClient: {
          get: async (id: string) => ({
            state: { global: { nodes: [] } },
            header: { id, name: "stub" },
          }),
        },
      }
    : undefined;
  return { store, listeners };
}

function teardownGlobals() {
  const g = globalThis as any;
  g.window?.localStorage?.clear?.();
  g.window.ph = undefined;
}

// ─── Stubs for CollabManager's constructor deps ──────────────────

function makeStubClient(overrides: Partial<Record<string, any>> = {}): any {
  return {
    getOwnerAddress: () => TEST_ADDRESS,
    getBeeNodePublicKey: async () => "02aa".padEnd(66, "0"),
    readPublicProfile: async () => null,
    readUserManifest: async () => null,
    publishPublicProfile: async () => {},
    createGrantees: async () => ({ ref: "grantee", historyRef: "hist" }),
    grantAccess: async () => ({ ref: "grantee2", historyRef: "hist2" }),
    uploadFile: async () => ({ reference: "ref", historyAddress: "hist" }),
    uploadData: async () => ({ reference: "wrapref" }),
    downloadFile: async () => new Uint8Array(),
    writeFeedPayloadAtIndex: async () => {},
    bee: {
      makeFeedReader: () => ({
        downloadReference: async () => { throw new Error("feed not found"); },
      }),
    },
    ...overrides,
  };
}

function makeStubChat(): any {
  return {
    startSession: async () => ({}),
    sendMessage: async () => ({}),
    getSession: () => undefined,
  };
}

function mkSummary(overrides: Partial<CollabSummary> = {}): CollabSummary {
  const now = new Date().toISOString();
  const participants: CollabParticipant[] = overrides.participants ?? [
    { address: TEST_ADDRESS, beeNodePublicKey: "02aa".padEnd(66, "0"), joinedAt: now },
    { address: PEER_ADDRESS, beeNodePublicKey: "02bb".padEnd(66, "0"), joinedAt: now },
  ];
  return {
    collabId: overrides.collabId ?? buildCollabId("drive", "drive-xyz"),
    kind: overrides.kind ?? "drive",
    driveId: overrides.driveId ?? "drive-xyz",
    documentId: overrides.documentId,
    title: overrides.title ?? "Test collab",
    initiator: overrides.initiator ?? TEST_ADDRESS,
    participants,
    manifestRef: "0".repeat(64),
    manifestActHistoryAddress: "0".repeat(64),
    manifestPublisherBeeNodePubKey: "02aa".padEnd(66, "0"),
    lastActivityAt: overrides.lastActivityAt ?? now,
    status: overrides.status ?? "active",
    ...overrides,
  };
}

/** Shorthand for reaching the internal store from tests. */
function storeOf(mgr: CollabManager) {
  return (mgr as any).store as {
    set(id: string, s: CollabSummary): void;
    persist(): void;
  };
}

// ─── State management ─────────────────────────────────────────────

describe("CollabManager — state + persistence", () => {
  beforeEach(() => installGlobals());
  afterEach(() => teardownGlobals());

  it("list() is empty on fresh construction (no storage, no rehydrate data)", () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    expect(mgr.list()).toEqual([]);
    mgr.shutdown();
  });

  it("installs itself on __swarmCollabManager__ for SwarmChannel lookup", () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    expect((globalThis as any).__swarmCollabManager__).toBe(mgr);
    mgr.shutdown();
    expect((globalThis as any).__swarmCollabManager__).toBeNull();
  });

  it("persists summaries to localStorage and loads them back on reconstruction", () => {
    const mgr1 = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const s = mkSummary({ collabId: "drive:persist-test", title: "Persisted" });
    storeOf(mgr1).set(s.collabId, s);
    storeOf(mgr1).persist();
    mgr1.shutdown();

    const mgr2 = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const recovered = mgr2.get("drive:persist-test");
    expect(recovered).toBeDefined();
    expect(recovered!.title).toBe("Persisted");
    mgr2.shutdown();
  });

  it("list() returns summaries sorted by lastActivityAt descending", () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const old = mkSummary({ collabId: "drive:old", lastActivityAt: "2020-01-01T00:00:00.000Z" });
    const mid = mkSummary({ collabId: "drive:mid", lastActivityAt: "2025-01-01T00:00:00.000Z" });
    const recent = mkSummary({ collabId: "drive:recent", lastActivityAt: "2026-01-01T00:00:00.000Z" });
    storeOf(mgr).set(old.collabId, old);
    storeOf(mgr).set(recent.collabId, recent);
    storeOf(mgr).set(mid.collabId, mid);

    const list = mgr.list();
    expect(list.map((s) => s.collabId)).toEqual([
      "drive:recent",
      "drive:mid",
      "drive:old",
    ]);
    mgr.shutdown();
  });

  it("get() returns undefined for unknown collabId", () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    expect(mgr.get("drive:does-not-exist")).toBeUndefined();
    mgr.shutdown();
  });
});

// ─── Event emission ───────────────────────────────────────────────

describe("CollabManager — events", () => {
  beforeEach(() => installGlobals());
  afterEach(() => teardownGlobals());

  function emit(mgr: CollabManager, event: { type: string; collabId: string }) {
    (mgr as any).events.emit(event);
  }

  it("on('*') receives all event types", () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const events: string[] = [];
    mgr.on("*", (e) => events.push(e.type));

    emit(mgr, { type: "collab-created", collabId: "a" });
    emit(mgr, { type: "collab-updated", collabId: "a" });
    emit(mgr, { type: "collab-removed", collabId: "a" });

    expect(events).toEqual(["collab-created", "collab-updated", "collab-removed"]);
    mgr.shutdown();
  });

  it("on('collab-created') receives only the matching type", () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const events: string[] = [];
    mgr.on("collab-created", (e) => events.push(e.type));

    emit(mgr, { type: "collab-created", collabId: "a" });
    emit(mgr, { type: "collab-updated", collabId: "a" });

    expect(events).toEqual(["collab-created"]);
    mgr.shutdown();
  });

  it("returned unsubscriber stops delivery", () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const events: string[] = [];
    const unsub = mgr.on("*", (e) => events.push(e.type));

    emit(mgr, { type: "collab-created", collabId: "a" });
    unsub();
    emit(mgr, { type: "collab-updated", collabId: "a" });

    expect(events).toEqual(["collab-created"]);
    mgr.shutdown();
  });

  it("event handler errors don't stop delivery to other subscribers", () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const received: string[] = [];
    mgr.on("*", () => { throw new Error("kaboom"); });
    mgr.on("*", (e) => received.push(e.type));

    emit(mgr, { type: "collab-created", collabId: "a" });

    expect(received).toEqual(["collab-created"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    mgr.shutdown();
  });
});

// ─── ApplyPipeline: shared reactor.load tail ─────────────────────

describe("ApplyPipeline — applyAndAdvance", () => {
  let loadCalls: Array<{ docId: string; branch: string; ops: unknown[] }>;

  beforeEach(() => {
    loadCalls = [];
    installGlobals((d, br, ops) => {
      loadCalls.push({ docId: d, branch: br, ops });
    });
  });
  afterEach(() => teardownGlobals());

  function pipelineOf(mgr: CollabManager) {
    return (mgr as any).applyPipeline;
  }

  it("returns false when reactor.load is unavailable", async () => {
    teardownGlobals();
    installGlobals(); // no reactor
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const ok = await pipelineOf(mgr).applyAndAdvance({
      collabId: "drive:x",
      writer: PEER_ADDRESS,
      docId: "doc-1",
      branch: "main",
      ops: [{ operation: { id: "op1" } }],
      feedIndex: 0,
    });
    expect(ok).toBe(false);
    mgr.shutdown();
  });

  it("returns true and skips reactor.load for empty ops", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const ok = await pipelineOf(mgr).applyAndAdvance({
      collabId: "drive:x",
      writer: PEER_ADDRESS,
      docId: "doc-1",
      branch: "main",
      ops: [],
      feedIndex: 0,
    });
    expect(ok).toBe(true);
    expect(loadCalls).toHaveLength(0);
    mgr.shutdown();
  });

  it("unwraps OperationWithContext entries to bare operations before reactor.load", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const wrapped = [
      { operation: { id: "op1", index: 0 }, context: { docId: "doc-1" } },
      { operation: { id: "op2", index: 1 }, context: { docId: "doc-1" } },
    ];
    await pipelineOf(mgr).applyAndAdvance({
      collabId: "drive:x",
      writer: PEER_ADDRESS,
      docId: "doc-1",
      branch: "main",
      ops: wrapped,
      feedIndex: 0,
    });
    expect(loadCalls).toHaveLength(1);
    expect(loadCalls[0].ops).toEqual([
      { id: "op1", index: 0 },
      { id: "op2", index: 1 },
    ]);
    mgr.shutdown();
  });

  it("passes already-flat operations through unchanged", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const flat = [{ id: "op1", index: 0 }, { id: "op2", index: 1 }];
    await pipelineOf(mgr).applyAndAdvance({
      collabId: "drive:x",
      writer: PEER_ADDRESS,
      docId: "doc-1",
      branch: "main",
      ops: flat,
      feedIndex: 0,
    });
    expect(loadCalls[0].ops).toEqual(flat);
    mgr.shutdown();
  });

  it("advances cursor in localStorage and bumps it monotonically", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const collabId = "drive:cursor-test";
    const docId = "doc-1";
    const writer = PEER_ADDRESS;
    const ls = (globalThis as any).window.localStorage;
    const cursorKey = `swarm:collabPeerCursor:${collabId}:${writer}:${docId}`;

    await pipelineOf(mgr).applyAndAdvance({
      collabId, writer, docId, branch: "main",
      ops: [{ id: "op1" }], feedIndex: 3,
    });
    expect(ls.getItem(cursorKey)).toBe("4");

    // feedIndex 2 < stored 4 → cursor shouldn't regress.
    await pipelineOf(mgr).applyAndAdvance({
      collabId, writer, docId, branch: "main",
      ops: [{ id: "op2" }], feedIndex: 2,
    });
    expect(ls.getItem(cursorKey)).toBe("4");

    // feedIndex 5 → cursor advances to 6.
    await pipelineOf(mgr).applyAndAdvance({
      collabId, writer, docId, branch: "main",
      ops: [{ id: "op3" }], feedIndex: 5,
    });
    expect(ls.getItem(cursorKey)).toBe("6");
    mgr.shutdown();
  });

  it("updates summary.lastActivityAt on successful apply", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const s = mkSummary({ collabId: "drive:activity", lastActivityAt: "2020-01-01T00:00:00.000Z" });
    storeOf(mgr).set(s.collabId, s);

    await pipelineOf(mgr).applyAndAdvance({
      collabId: s.collabId,
      writer: PEER_ADDRESS,
      docId: "doc-1",
      branch: "main",
      ops: [{ id: "op1" }],
      feedIndex: 0,
    });

    const updated = mgr.get(s.collabId)!;
    expect(updated.lastActivityAt).not.toBe("2020-01-01T00:00:00.000Z");
    expect(new Date(updated.lastActivityAt).getTime()).toBeGreaterThan(
      new Date("2020-01-01T00:00:00.000Z").getTime(),
    );
    mgr.shutdown();
  });

  it("emits 'op-applied' event and dispatches swarm:collab:op-applied DOM event", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const events: string[] = [];
    mgr.on("op-applied", (e) => events.push(e.collabId));

    const domEvents: string[] = [];
    (globalThis as any).window.addEventListener(
      "swarm:collab:op-applied",
      (e: any) => domEvents.push(e.detail?.collabId),
    );

    await pipelineOf(mgr).applyAndAdvance({
      collabId: "drive:events",
      writer: PEER_ADDRESS,
      docId: "doc-1",
      branch: "main",
      ops: [{ id: "op1" }],
      feedIndex: 0,
    });

    expect(events).toEqual(["drive:events"]);
    expect(domEvents).toEqual(["drive:events"]);
    mgr.shutdown();
  });
});

// ─── GsocCoordinator: handlePing tier routing ────────────────────

describe("GsocCoordinator — handlePing tier routing", () => {
  let loadCalls: Array<{ docId: string; branch: string; ops: unknown[] }>;

  beforeEach(() => {
    loadCalls = [];
    installGlobals((d, br, ops) => loadCalls.push({ docId: d, branch: br, ops }));
  });
  afterEach(() => teardownGlobals());

  function gsocOf(mgr: CollabManager) {
    return (mgr as any).gsoc;
  }
  function pipelineOf(mgr: CollabManager) {
    return (mgr as any).applyPipeline;
  }
  function pollLoopOf(mgr: CollabManager) {
    return (mgr as any).pollLoop;
  }

  it("inline tier: inlineOps in ping → applied immediately (no Swarm fetch)", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const s = mkSummary();
    storeOf(mgr).set(s.collabId, s);
    const notification = {
      type: "doc-updated",
      data: {
        collabId: s.collabId,
        writerAddress: PEER_ADDRESS,
        driveId: s.driveId,
        documentId: "doc-1",
        feedIndex: 0,
        actRef: "ignored-on-inline-path",
        actHistoryAddress: "ignored",
        publisherBeeNodePubKey: "02bb".padEnd(66, "0"),
        inlineOps: [{ operation: { id: "op-fast", index: 0 } }],
        inlineScope: "global",
        inlineBranch: "main",
      },
    };
    gsocOf(mgr).handlePing(s, PEER_ADDRESS, notification);
    await new Promise((r) => setTimeout(r, 20));

    expect(loadCalls).toHaveLength(1);
    expect(loadCalls[0].ops).toEqual([{ id: "op-fast", index: 0 }]);
    mgr.shutdown();
  });

  it("refs tier: refs only → applyFromPing triggered (no inline)", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const s = mkSummary();
    storeOf(mgr).set(s.collabId, s);
    const spy = vi
      .spyOn(pipelineOf(mgr), "applyFromPing")
      .mockResolvedValue(undefined);

    const notification = {
      type: "doc-updated",
      data: {
        collabId: s.collabId,
        writerAddress: PEER_ADDRESS,
        driveId: s.driveId,
        documentId: "doc-1",
        feedIndex: 0,
        actRef: "aa".repeat(32),
        actHistoryAddress: "bb".repeat(32),
        publisherBeeNodePubKey: "02bb".padEnd(66, "0"),
      },
    };
    gsocOf(mgr).handlePing(s, PEER_ADDRESS, notification);
    await new Promise((r) => setTimeout(r, 20));

    expect(spy).toHaveBeenCalledTimes(1);
    mgr.shutdown();
  });

  it("feed tier: no refs, no inline → triggers poll-loop kick", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const s = mkSummary();
    storeOf(mgr).set(s.collabId, s);
    const spy = vi.spyOn(pollLoopOf(mgr), "kick").mockImplementation(() => {});

    const notification = {
      type: "doc-updated",
      data: { collabId: s.collabId, writerAddress: PEER_ADDRESS },
    };
    gsocOf(mgr).handlePing(s, PEER_ADDRESS, notification);
    await new Promise((r) => setTimeout(r, 20));

    expect(spy).toHaveBeenCalled();
    mgr.shutdown();
  });

  it("ignores pings for a different collab", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const s = mkSummary({ collabId: "drive:mine" });
    storeOf(mgr).set(s.collabId, s);
    const applyInline = vi
      .spyOn(pipelineOf(mgr), "applyInlineOps")
      .mockResolvedValue(undefined);

    const notification = {
      type: "doc-updated",
      data: {
        collabId: "drive:someone-else",
        writerAddress: PEER_ADDRESS,
        documentId: "doc-1",
        inlineOps: [{ id: "op" }],
      },
    };
    gsocOf(mgr).handlePing(s, PEER_ADDRESS, notification);
    await new Promise((r) => setTimeout(r, 20));

    expect(applyInline).not.toHaveBeenCalled();
    mgr.shutdown();
  });

  it("'collab-join' announce ping seeds peerActivity with opsApplied=0", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const s = mkSummary({ collabId: "drive:joined" });
    storeOf(mgr).set(s.collabId, s);

    gsocOf(mgr).handlePing(s, PEER_ADDRESS, {
      type: "collab-join",
      data: { collabId: s.collabId, writerAddress: PEER_ADDRESS },
    });

    const updated = mgr.get(s.collabId)!;
    const entry = updated.peerActivity?.[PEER_ADDRESS.toLowerCase()];
    expect(entry).toBeDefined();
    expect(entry!.opsApplied).toBe(0);
    expect(entry!.lastAppliedAt).toBeDefined();
    mgr.shutdown();
  });
});

// ─── handleLocalPush routing ─────────────────────────────────────

describe("CollabManager — handleLocalPush routing", () => {
  beforeEach(() => installGlobals());
  afterEach(() => teardownGlobals());

  function opsFeedOf(mgr: CollabManager) {
    return (mgr as any).opsFeed;
  }

  /**
   * Build an op-with-context payload authored by the test's signer.
   * PushHook filters out ops whose `action.context.signer.user.address`
   * differs from the manager's address — so simpler `{operation:{id,
   * index}}` shapes get dropped as "not mine". Use this helper for
   * push tests that expect `appendBatch` to fire.
   */
  function mkAuthoredOp(id: string, index: number, author: string = TEST_ADDRESS) {
    return {
      operation: {
        id,
        index,
        action: {
          context: {
            signer: { user: { address: author } },
          },
        },
      },
    };
  }

  it("no-op when no summary matches the driveId", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const spy = vi.spyOn(opsFeedOf(mgr), "appendBatch");
    await mgr.handleLocalPush({
      driveId: "unrelated-drive",
      docId: "doc-x",
      ops: [mkAuthoredOp("op1", 0)],
      scope: "global",
      branch: "main",
    });
    expect(spy).not.toHaveBeenCalled();
    mgr.shutdown();
  });

  it("no-op for empty ops array", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const s = mkSummary({
      driveId: "drive-xyz",
      currentGranteeHistRef: "hist",
    });
    storeOf(mgr).set(s.collabId, s);
    const spy = vi.spyOn(opsFeedOf(mgr), "appendBatch");
    await mgr.handleLocalPush({
      driveId: "drive-xyz",
      docId: "doc-x",
      ops: [],
      scope: "global",
      branch: "main",
    });
    expect(spy).not.toHaveBeenCalled();
    mgr.shutdown();
  });

  it("drive-level collab catches any doc in the drive", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const s = mkSummary({
      kind: "drive",
      driveId: "drive-shared",
      currentGranteeHistRef: "hist",
      currentGranteeRef: "grantee",
    });
    storeOf(mgr).set(s.collabId, s);
    const spy = vi
      .spyOn(opsFeedOf(mgr), "appendBatch")
      .mockResolvedValue({ actRef: "r", actHistoryAddress: "h", feedIndex: 0 });

    await mgr.handleLocalPush({
      driveId: "drive-shared",
      docId: "any-doc-inside",
      ops: [mkAuthoredOp("op1", 0)],
      scope: "global",
      branch: "main",
    });

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][1]).toBe("drive-shared"); // driveId
    expect(spy.mock.calls[0][2]).toBe("any-doc-inside"); // docId
    mgr.shutdown();
  });

  it("document-level collab only mirrors pushes for its specific doc", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const s = mkSummary({
      kind: "document",
      driveId: "drive-x",
      documentId: "doc-watched",
      collabId: buildCollabId("document", "drive-x", "doc-watched"),
      currentGranteeHistRef: "hist",
      currentGranteeRef: "grantee",
    });
    storeOf(mgr).set(s.collabId, s);
    const spy = vi
      .spyOn(opsFeedOf(mgr), "appendBatch")
      .mockResolvedValue({ actRef: "r", actHistoryAddress: "h", feedIndex: 0 });

    await mgr.handleLocalPush({
      driveId: "drive-x",
      docId: "doc-other", // not the watched doc
      ops: [mkAuthoredOp("op1", 0)],
      scope: "global",
      branch: "main",
    });
    expect(spy).not.toHaveBeenCalled();

    await mgr.handleLocalPush({
      driveId: "drive-x",
      docId: "doc-watched",
      ops: [mkAuthoredOp("op2", 0)],
      scope: "global",
      branch: "main",
    });
    expect(spy).toHaveBeenCalledOnce();
    mgr.shutdown();
  });

  it("mirror-push failure is logged but doesn't throw to the caller", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const s = mkSummary({
      driveId: "drive-fail",
      currentGranteeHistRef: "hist",
      currentGranteeRef: "grantee",
    });
    storeOf(mgr).set(s.collabId, s);
    vi.spyOn(opsFeedOf(mgr), "appendBatch").mockRejectedValue(new Error("nope"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      mgr.handleLocalPush({
        driveId: "drive-fail",
        docId: "doc",
        ops: [mkAuthoredOp("op1", 0)],
        scope: "global",
        branch: "main",
      }),
    ).resolves.not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    mgr.shutdown();
  });

  it("skips ops authored by other participants (don't echo peer ops back to the collab feed)", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const s = mkSummary({
      driveId: "drive-no-echo",
      currentGranteeHistRef: "hist",
      currentGranteeRef: "grantee",
    });
    storeOf(mgr).set(s.collabId, s);
    const spy = vi
      .spyOn(opsFeedOf(mgr), "appendBatch")
      .mockResolvedValue({ actRef: "r", actHistoryAddress: "h", feedIndex: 0 });

    // SwarmChannel pushes peer-authored ops too (they land in the
    // reactor's outbox after a sync apply). We must not mirror them or
    // the original author sees their own op echoed back.
    await mgr.handleLocalPush({
      driveId: "drive-no-echo",
      docId: "doc-1",
      ops: [mkAuthoredOp("peer-op", 0, PEER_ADDRESS)],
      scope: "global",
      branch: "main",
    });
    expect(spy).not.toHaveBeenCalled();

    // Mixed batch: one peer op, one mine — only mine should make it through.
    await mgr.handleLocalPush({
      driveId: "drive-no-echo",
      docId: "doc-1",
      ops: [
        mkAuthoredOp("peer-op-2", 1, PEER_ADDRESS),
        mkAuthoredOp("my-op", 2),
      ],
      scope: "global",
      branch: "main",
    });
    expect(spy).toHaveBeenCalledOnce();
    // Batch appended should contain only the authored op.
    const appendedBatch = spy.mock.calls[0][3] as { opsJson: string };
    const serialized = JSON.parse(appendedBatch.opsJson) as Array<{ operation: { id: string } }>;
    expect(serialized).toHaveLength(1);
    expect(serialized[0].operation.id).toBe("my-op");

    mgr.shutdown();
  });
});

// ─── peerActivity + recentActivity (current-state tracking) ──────

describe("CollabManager — per-peer activity + recent-activity feed", () => {
  let loadCalls: Array<{ docId: string; branch: string; ops: unknown[] }>;

  beforeEach(() => {
    loadCalls = [];
    installGlobals((d, br, ops) => loadCalls.push({ docId: d, branch: br, ops }));
  });
  afterEach(() => teardownGlobals());

  function pipelineOf(mgr: CollabManager) {
    return (mgr as any).applyPipeline;
  }

  it("applyAndAdvance bumps peerActivity.lastAppliedAt and opsApplied", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const s = mkSummary({ collabId: "drive:peer-activity" });
    storeOf(mgr).set(s.collabId, s);

    await pipelineOf(mgr).applyAndAdvance({
      collabId: s.collabId,
      writer: PEER_ADDRESS,
      docId: "doc-1",
      branch: "main",
      ops: [{ id: "op-1" }, { id: "op-2" }, { id: "op-3" }],
      feedIndex: 0,
    });

    const updated = mgr.get(s.collabId)!;
    expect(updated.peerActivity?.[PEER_ADDRESS.toLowerCase()]).toBeDefined();
    expect(updated.peerActivity![PEER_ADDRESS.toLowerCase()].opsApplied).toBe(3);
    expect(updated.peerActivity![PEER_ADDRESS.toLowerCase()].lastAppliedAt).toBeDefined();
    mgr.shutdown();
  });

  it("opsApplied accumulates across batches from the same peer", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const s = mkSummary({ collabId: "drive:accum" });
    storeOf(mgr).set(s.collabId, s);

    await pipelineOf(mgr).applyAndAdvance({
      collabId: s.collabId, writer: PEER_ADDRESS, docId: "doc-1",
      branch: "main", ops: [{ id: "op-1" }, { id: "op-2" }], feedIndex: 0,
    });
    await pipelineOf(mgr).applyAndAdvance({
      collabId: s.collabId, writer: PEER_ADDRESS, docId: "doc-1",
      branch: "main", ops: [{ id: "op-3" }], feedIndex: 1,
    });

    expect(mgr.get(s.collabId)!.peerActivity![PEER_ADDRESS.toLowerCase()].opsApplied).toBe(3);
    mgr.shutdown();
  });

  it("tracks peerActivity independently per peer", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const s = mkSummary({
      collabId: "drive:multi-peer",
      participants: [
        { address: TEST_ADDRESS, beeNodePublicKey: "02aa".padEnd(66, "0"), joinedAt: "now" },
        { address: PEER_ADDRESS, beeNodePublicKey: "02bb".padEnd(66, "0"), joinedAt: "now" },
        { address: THIRD_ADDRESS, beeNodePublicKey: "02cc".padEnd(66, "0"), joinedAt: "now" },
      ],
    });
    storeOf(mgr).set(s.collabId, s);

    await pipelineOf(mgr).applyAndAdvance({
      collabId: s.collabId, writer: PEER_ADDRESS, docId: "doc-1",
      branch: "main", ops: [{ id: "a" }], feedIndex: 0,
    });
    await pipelineOf(mgr).applyAndAdvance({
      collabId: s.collabId, writer: THIRD_ADDRESS, docId: "doc-1",
      branch: "main", ops: [{ id: "b" }, { id: "c" }], feedIndex: 0,
    });

    const updated = mgr.get(s.collabId)!;
    expect(updated.peerActivity![PEER_ADDRESS.toLowerCase()].opsApplied).toBe(1);
    expect(updated.peerActivity![THIRD_ADDRESS.toLowerCase()].opsApplied).toBe(2);
    expect(updated.peerActivity![TEST_ADDRESS.toLowerCase()]).toBeUndefined();
    mgr.shutdown();
  });

  it("recentActivity gains an 'ops-applied' entry per apply", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const s = mkSummary({ collabId: "drive:activity-feed", recentActivity: [] });
    storeOf(mgr).set(s.collabId, s);

    await pipelineOf(mgr).applyAndAdvance({
      collabId: s.collabId, writer: PEER_ADDRESS, docId: "doc-1",
      branch: "main", ops: [{ id: "a" }, { id: "b" }], feedIndex: 0,
    });

    const entries = mgr.get(s.collabId)!.recentActivity ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("ops-applied");
    expect(entries[0].actor).toBe(PEER_ADDRESS.toLowerCase());
    expect(entries[0].opsCount).toBe(2);
    expect(entries[0].docId).toBe("doc-1");
    mgr.shutdown();
  });

  it("recentActivity ring-buffers at RECENT_ACTIVITY_MAX entries", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const s = mkSummary({ collabId: "drive:ringbuffer", recentActivity: [] });
    storeOf(mgr).set(s.collabId, s);

    const N = 25; // > RECENT_ACTIVITY_MAX (20)
    for (let i = 0; i < N; i++) {
      await pipelineOf(mgr).applyAndAdvance({
        collabId: s.collabId, writer: PEER_ADDRESS, docId: "doc-1",
        branch: "main", ops: [{ id: `op-${i}` }], feedIndex: i,
      });
    }

    const entries = mgr.get(s.collabId)!.recentActivity ?? [];
    expect(entries.length).toBeLessThanOrEqual(20);
    // Newest entry should be last.
    const last = entries[entries.length - 1];
    expect(last.kind).toBe("ops-applied");
    mgr.shutdown();
  });
});

// ─── leave() + shutdown() ────────────────────────────────────────

describe("CollabManager — leave + shutdown", () => {
  beforeEach(() => installGlobals());
  afterEach(() => teardownGlobals());

  it("leave() removes the summary from local state", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const s = mkSummary({ collabId: "drive:leaveme" });
    storeOf(mgr).set(s.collabId, s);
    await mgr.leave(s.collabId);
    expect(mgr.get(s.collabId)).toBeUndefined();
    mgr.shutdown();
  });

  it("leave() emits 'collab-removed'", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const s = mkSummary({ collabId: "drive:leaveme" });
    storeOf(mgr).set(s.collabId, s);
    const events: string[] = [];
    mgr.on("collab-removed", (e) => events.push(e.collabId));
    await mgr.leave(s.collabId);
    expect(events).toEqual(["drive:leaveme"]);
    mgr.shutdown();
  });

  it("leave() on unknown collab is a no-op", async () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const events: string[] = [];
    mgr.on("*", (e) => events.push(e.type));
    await mgr.leave("drive:never-added");
    expect(events).toEqual([]);
    mgr.shutdown();
  });

  it("shutdown() clears the global hook + stops the poll loop", () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    expect((globalThis as any).__swarmCollabManager__).toBe(mgr);
    expect((mgr as any).pollLoop.timer).not.toBeNull();
    mgr.shutdown();
    expect((globalThis as any).__swarmCollabManager__).toBeNull();
    expect((mgr as any).pollLoop.timer).toBeNull();
    expect((mgr as any).shuttingDown).toBe(true);
  });

  it("shutdown() cancels inbound GSOC subscriptions", () => {
    const mgr = new CollabManager(makeStubClient(), makeStubChat(), TEST_ADDRESS);
    const cancels: string[] = [];
    const gsoc = (mgr as any).gsoc;
    gsoc.inboundSubs.set("sub1", () => cancels.push("sub1"));
    gsoc.inboundSubs.set("sub2", () => cancels.push("sub2"));
    mgr.shutdown();
    expect(cancels.sort()).toEqual(["sub1", "sub2"]);
    expect(gsoc.inboundSubs.size).toBe(0);
  });
});
