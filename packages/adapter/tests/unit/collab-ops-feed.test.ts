/**
 * Unit tests for CollabOpsFeed with a stubbed SwarmClient.
 *
 * Focus: topic derivation, wrapper-chunk encoding, per-topic write
 * serialization (the TOCTOU race fix), readRange unwrap + cursor
 * semantics, fetchByRefs fast path.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Topic, FeedIndex } from "@ethersphere/bee-js";
import { CollabOpsFeed } from "../../src/collab/collab-ops-feed.js";
import type { CollabOpsBatch } from "../../src/collab/collab-ops-feed.js";
import { buildCollabId } from "../../src/collab/types.js";
import { hexToBytes32 } from "../../src/collab/feed-bytes.js";

// ─── SwarmClient stub ────────────────────────────────────────────

interface FakeFeedState {
  writes: Array<{ index: number; payload: string }>;
  headIndex: number; // latest index (lazy; -1 means no writes yet)
}

interface StubState {
  feeds: Map<string /*topicHex*/, FakeFeedState>;
  byteStore: Map<string /*ref*/, Uint8Array>; // simulates /bytes
  bzzStore: Map<string /*ref*/, Uint8Array>; // simulates /bzz (ACT)
  ownerAddress: string;
  uploadFileCalls: number;
  uploadDataCalls: number;
  writeCalls: number;
  downloadFileCalls: number;
}

function makeStubClient(ownerAddress = "0x1111111111111111111111111111111111111111") {
  const state: StubState = {
    feeds: new Map(),
    byteStore: new Map(),
    bzzStore: new Map(),
    ownerAddress,
    uploadFileCalls: 0,
    uploadDataCalls: 0,
    writeCalls: 0,
    downloadFileCalls: 0,
  };

  const client: any = {
    state,
    getOwnerAddress: () => ownerAddress,
    uploadFile: async (data: string | Uint8Array) => {
      state.uploadFileCalls++;
      // Valid 64-char hex: "aa..." + counter encoded as 6 hex chars,
      // padded to 64 total so the wrapper chunk's hexToBytes32 accepts it.
      const ref = "aa" + state.uploadFileCalls.toString(16).padStart(62, "0");
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      state.bzzStore.set(ref, bytes);
      return {
        reference: ref,
        historyAddress: "cc" + state.uploadFileCalls.toString(16).padStart(62, "0"),
      };
    },
    uploadData: async (data: string | Uint8Array) => {
      state.uploadDataCalls++;
      const ref = "bb" + state.uploadDataCalls.toString(16).padStart(62, "0");
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      state.byteStore.set(ref, bytes);
      return { reference: ref };
    },
    downloadData: async (ref: string) => {
      const data = state.byteStore.get(ref);
      if (!data) throw new Error(`not found: ${ref}`);
      return data;
    },
    downloadFile: async (ref: string) => {
      state.downloadFileCalls++;
      const data = state.bzzStore.get(ref);
      if (!data) throw new Error(`act not found: ${ref}`);
      return data;
    },
    writeFeedPayloadAtIndex: async (topic: Topic, payload: string, index: number) => {
      state.writeCalls++;
      const key = topic.toHex();
      const existing = state.feeds.get(key) ?? { writes: [], headIndex: -1 };
      existing.writes.push({ index, payload });
      existing.headIndex = Math.max(existing.headIndex, index);
      state.feeds.set(key, existing);
    },
    bee: {
      makeFeedReader: (topic: Topic, _owner: string) => ({
        downloadReference: async (opts?: { index?: FeedIndex | number }) => {
          const feed = state.feeds.get(topic.toHex());
          if (!feed || feed.headIndex < 0) {
            throw new Error("feed not found");
          }
          let targetIndex: number;
          if (opts?.index !== undefined) {
            targetIndex = typeof opts.index === "number"
              ? opts.index
              : Number((opts.index as FeedIndex).toBigInt());
          } else {
            targetIndex = feed.headIndex;
          }
          const write = feed.writes.find((w) => w.index === targetIndex);
          if (!write) throw new Error(`no write at index ${targetIndex}`);
          return {
            reference: { toHex: () => write.payload },
            feedIndex: FeedIndex.fromBigInt(BigInt(targetIndex)),
            feedIndexNext: FeedIndex.fromBigInt(BigInt(targetIndex + 1)),
          };
        },
      }),
    },
  };
  return client;
}

async function seedBatch(
  client: any,
  feed: CollabOpsFeed,
  collabId: string,
  driveId: string,
  docId: string,
  content: Partial<CollabOpsBatch> & { opsJson: string },
): Promise<{ actRef: string; actHistoryAddress: string; feedIndex: number }> {
  const batch: CollabOpsBatch = {
    startIndex: 0,
    endIndex: 0,
    scope: "global",
    branch: "main",
    timestamp: new Date().toISOString(),
    ...content,
  };
  return feed.appendBatch(collabId, driveId, docId, batch, "hist-stub");
}

// ─── Tests ───────────────────────────────────────────────────────

describe("CollabOpsFeed.topicFor", () => {
  it("doc-scoped topic differs from drive-scoped topic for the same collab", () => {
    const driveId = "drive-123";
    const docId = "doc-abc";
    const collabId = buildCollabId("document", driveId, docId);
    const driveTopic = CollabOpsFeed.topicFor(collabId, driveId);
    const docTopic = CollabOpsFeed.topicFor(collabId, driveId, docId);
    expect(driveTopic.toHex()).not.toBe(docTopic.toHex());
  });

  it("same inputs → same topic (deterministic)", () => {
    const t1 = CollabOpsFeed.topicFor("drive:x", "drive-123", "doc-abc");
    const t2 = CollabOpsFeed.topicFor("drive:x", "drive-123", "doc-abc");
    expect(t1.toHex()).toBe(t2.toHex());
  });
});

describe("CollabOpsFeed.appendBatch", () => {
  let client: any;
  let feed: CollabOpsFeed;

  beforeEach(() => {
    client = makeStubClient();
    feed = new CollabOpsFeed(client);
  });

  it("uploads ACT payload, wrapper chunk, then feed entry", async () => {
    const result = await seedBatch(client, feed, "drive:x", "drive-123", "doc-abc", {
      opsJson: JSON.stringify([{ id: "op-1" }]),
    });
    expect(client.state.uploadFileCalls).toBe(1);
    expect(client.state.uploadDataCalls).toBe(1);
    expect(client.state.writeCalls).toBe(1);
    expect(result.feedIndex).toBe(0);
    expect(result.actRef).toMatch(/^[0-9a-f]+$/);
    expect(result.actHistoryAddress).toMatch(/^[0-9a-f]+$/);
  });

  it("wrapper chunk contains exactly actRef || actHist as 64 bytes", async () => {
    const { actRef, actHistoryAddress } = await seedBatch(
      client, feed, "drive:x", "drive-123", "doc-abc", { opsJson: "[]" },
    );
    const uploadedWrappers = Array.from(client.state.byteStore.values()) as Uint8Array[];
    const wrapper = uploadedWrappers.find((b) => b.length === 64);
    expect(wrapper).toBeDefined();
    const actRefFromWrapper = Array.from(wrapper!.slice(0, 32))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const actHistFromWrapper = Array.from(wrapper!.slice(32))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(actRefFromWrapper).toBe(actRef);
    expect(actHistFromWrapper).toBe(actHistoryAddress);
  });

  it("successive appends to the same topic land at successive indices", async () => {
    const first = await seedBatch(client, feed, "drive:x", "drive-123", "doc-abc", { opsJson: "[]" });
    const second = await seedBatch(client, feed, "drive:x", "drive-123", "doc-abc", { opsJson: "[]" });
    const third = await seedBatch(client, feed, "drive:x", "drive-123", "doc-abc", { opsJson: "[]" });
    expect([first.feedIndex, second.feedIndex, third.feedIndex]).toEqual([0, 1, 2]);
  });

  it("concurrent appends serialize per topic (TOCTOU race fix)", async () => {
    // Kick off three appends concurrently. Without the per-topic lock,
    // all three would see lastWrittenIndex=undefined, derive nextIndex=0,
    // and collide on the same feed slot.
    const launches = Promise.all([
      seedBatch(client, feed, "drive:race", "drive-123", "doc-abc", { opsJson: "[1]" }),
      seedBatch(client, feed, "drive:race", "drive-123", "doc-abc", { opsJson: "[2]" }),
      seedBatch(client, feed, "drive:race", "drive-123", "doc-abc", { opsJson: "[3]" }),
    ]);
    const results = await launches;
    const indices = results.map((r) => r.feedIndex).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2]);
  });

  it("concurrent appends to DIFFERENT topics don't serialize against each other", async () => {
    // Independent topics run in parallel — each one lands at index 0.
    const [a, b] = await Promise.all([
      seedBatch(client, feed, "drive:a", "drive-a", "doc-a", { opsJson: "[]" }),
      seedBatch(client, feed, "drive:b", "drive-b", "doc-b", { opsJson: "[]" }),
    ]);
    expect(a.feedIndex).toBe(0);
    expect(b.feedIndex).toBe(0);
  });
});

describe("CollabOpsFeed.getLatestIndex + readRange", () => {
  let client: any;
  let feed: CollabOpsFeed;

  beforeEach(() => {
    client = makeStubClient();
    feed = new CollabOpsFeed(client);
  });

  it("getLatestIndex returns null for a nonexistent feed", async () => {
    const latest = await feed.getLatestIndex(
      "drive:none", "drive-none", "doc-none", "0xpeer",
    );
    expect(latest).toBeNull();
  });

  it("getLatestIndex returns the latest written index", async () => {
    await seedBatch(client, feed, "drive:x", "drive-1", "doc-1", { opsJson: "[]" });
    await seedBatch(client, feed, "drive:x", "drive-1", "doc-1", { opsJson: "[]" });
    const latest = await feed.getLatestIndex(
      "drive:x", "drive-1", "doc-1", client.getOwnerAddress(),
    );
    expect(latest).toBe(1);
  });

  it("readRange returns only batches in [fromIndex, toIndex]", async () => {
    const a = await seedBatch(client, feed, "drive:x", "drive-1", "doc-1", {
      opsJson: JSON.stringify([{ id: "op-0" }]),
    });
    const b = await seedBatch(client, feed, "drive:x", "drive-1", "doc-1", {
      opsJson: JSON.stringify([{ id: "op-1" }]),
    });
    const c = await seedBatch(client, feed, "drive:x", "drive-1", "doc-1", {
      opsJson: JSON.stringify([{ id: "op-2" }]),
    });
    expect([a.feedIndex, b.feedIndex, c.feedIndex]).toEqual([0, 1, 2]);

    const partial = await feed.readRange(
      "drive:x", "drive-1", "doc-1", client.getOwnerAddress(), 1, 2, "02pub",
    );
    expect(partial.map((e) => e.feedIndex)).toEqual([1, 2]);
    expect(JSON.parse(partial[0].batch.opsJson)).toEqual([{ id: "op-1" }]);
    expect(JSON.parse(partial[1].batch.opsJson)).toEqual([{ id: "op-2" }]);
  });

  it("readRange returns empty array when fromIndex > toIndex", async () => {
    await seedBatch(client, feed, "drive:x", "drive-1", "doc-1", { opsJson: "[]" });
    const result = await feed.readRange(
      "drive:x", "drive-1", "doc-1", client.getOwnerAddress(), 5, 3, "02pub",
    );
    expect(result).toEqual([]);
  });

  it("readRange skips malformed wrapper chunks (wrong size)", async () => {
    // Seed one valid batch, then inject a malformed 32-byte entry at
    // the next index so readRange has to skip it.
    await seedBatch(client, feed, "drive:x", "drive-1", "doc-1", { opsJson: "[]" });
    const topic = CollabOpsFeed.topicFor("drive:x", "drive-1", "doc-1");
    const feedKey = topic.toHex();
    const malformedRef = "de".repeat(32);
    client.state.byteStore.set(malformedRef, new Uint8Array(32)); // 32, not 64
    const feedState = client.state.feeds.get(feedKey)!;
    feedState.writes.push({ index: 1, payload: malformedRef });
    feedState.headIndex = 1;

    const result = await feed.readRange(
      "drive:x", "drive-1", "doc-1", client.getOwnerAddress(), 0, 1, "02pub",
    );
    expect(result.map((e) => e.feedIndex)).toEqual([0]); // only the valid one
  });
});

describe("CollabOpsFeed.fetchByRefs", () => {
  let client: any;
  let feed: CollabOpsFeed;

  beforeEach(() => {
    client = makeStubClient();
    feed = new CollabOpsFeed(client);
  });

  it("returns null when the /bzz fetch fails (chunk not propagated)", async () => {
    const batch = await feed.fetchByRefs("missing-ref", "missing-hist", "02pub");
    expect(batch).toBeNull();
  });

  it("returns the parsed batch when /bzz contains it", async () => {
    const ref = "ca".repeat(32); // valid 64-char hex
    const raw = JSON.stringify({
      opsJson: JSON.stringify([{ id: "inline-op" }]),
      startIndex: 0,
      endIndex: 0,
      scope: "global",
      branch: "main",
      timestamp: "2026-04-19T12:00:00.000Z",
    });
    client.state.bzzStore.set(ref, new TextEncoder().encode(raw));

    const batch = await feed.fetchByRefs(ref, "any-hist", "02pub");
    expect(batch).not.toBeNull();
    expect(batch!.scope).toBe("global");
    expect(JSON.parse(batch!.opsJson)).toEqual([{ id: "inline-op" }]);
  });
});
