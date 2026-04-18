/**
 * Unit tests for CollabManifestFeed with a stubbed SwarmClient.
 *
 * Covers publish, readLatest (including the stale-latest self-correct),
 * readAtIndex, and the per-topic publish serialization.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Topic, FeedIndex } from "@ethersphere/bee-js";
import { CollabManifestFeed } from "../../src/collab/collab-manifest-feed.js";
import type { CollabManifest } from "../../src/collab/types.js";

// ─── Stub ────────────────────────────────────────────────────────

interface FeedWrite { index: number; payload: string }

function makeStubClient(ownerAddress = "0x1111111111111111111111111111111111111111") {
  const state = {
    feeds: new Map<string, { writes: FeedWrite[]; headIndex: number; staleLatest?: number }>(),
    bzzStore: new Map<string, Uint8Array>(),
    byteStore: new Map<string, Uint8Array>(),
    uploadFileCalls: 0,
    uploadDataCalls: 0,
    writeCalls: 0,
  };
  const client: any = {
    state,
    getOwnerAddress: () => ownerAddress,
    uploadFile: async (data: string | Uint8Array) => {
      state.uploadFileCalls++;
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
      makeFeedReader: (topic: Topic) => ({
        downloadReference: async (opts?: { index?: FeedIndex | number }) => {
          const feed = state.feeds.get(topic.toHex());
          if (!feed || feed.headIndex < 0) throw new Error("feed not found");
          let targetIndex: number;
          if (opts?.index !== undefined) {
            targetIndex = typeof opts.index === "number"
              ? opts.index
              : Number((opts.index as FeedIndex).toBigInt());
          } else if (feed.staleLatest !== undefined) {
            // Simulate Bee's "stale latest" behavior: downloadReference
            // no-arg reports an older entry, but feedIndexNext correctly
            // advances — readLatest should self-correct.
            targetIndex = feed.staleLatest;
          } else {
            targetIndex = feed.headIndex;
          }
          const write = feed.writes.find((w) => w.index === targetIndex);
          if (!write) throw new Error(`no write at index ${targetIndex}`);
          return {
            reference: { toHex: () => write.payload },
            feedIndex: FeedIndex.fromBigInt(BigInt(targetIndex)),
            feedIndexNext: FeedIndex.fromBigInt(BigInt(feed.headIndex + 1)),
          };
        },
      }),
    },
  };
  return client;
}

function mkManifest(overrides: Partial<CollabManifest> = {}): CollabManifest {
  const now = new Date().toISOString();
  return {
    version: 1,
    collabId: "drive:x",
    kind: "drive",
    driveId: "drive-123",
    title: "Test",
    participants: [
      { address: "0xa".padEnd(42, "0"), beeNodePublicKey: "02aa".padEnd(66, "0"), joinedAt: now },
      { address: "0xb".padEnd(42, "0"), beeNodePublicKey: "02bb".padEnd(66, "0"), joinedAt: now },
    ],
    initiator: "0xa".padEnd(42, "0"),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe("CollabManifestFeed.topicFor", () => {
  it("produces a valid 64-char hex topic", () => {
    const topic = CollabManifestFeed.topicFor("drive:any-id");
    expect(topic.toHex()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different collabIds → different topics", () => {
    const a = CollabManifestFeed.topicFor("drive:one");
    const b = CollabManifestFeed.topicFor("drive:two");
    expect(a.toHex()).not.toBe(b.toHex());
  });
});

describe("CollabManifestFeed.publish", () => {
  let client: any;
  let feed: CollabManifestFeed;

  beforeEach(() => {
    client = makeStubClient();
    feed = new CollabManifestFeed(client);
  });

  it("first publish → feedIndex 0, uploads ACT + wrapper + feed write", async () => {
    const result = await feed.publish(mkManifest(), "hist-stub");
    expect(result.feedIndex).toBe(0);
    expect(client.state.uploadFileCalls).toBe(1);
    expect(client.state.uploadDataCalls).toBe(1);
    expect(client.state.writeCalls).toBe(1);
  });

  it("successive publishes advance feedIndex monotonically", async () => {
    const a = await feed.publish(mkManifest({ collabId: "drive:a" }), "hist");
    const b = await feed.publish(mkManifest({ collabId: "drive:a" }), "hist");
    const c = await feed.publish(mkManifest({ collabId: "drive:a" }), "hist");
    expect([a.feedIndex, b.feedIndex, c.feedIndex]).toEqual([0, 1, 2]);
  });

  it("concurrent publishes to the same collab serialize (per-topic lock)", async () => {
    const results = await Promise.all([
      feed.publish(mkManifest({ collabId: "drive:race" }), "hist"),
      feed.publish(mkManifest({ collabId: "drive:race" }), "hist"),
      feed.publish(mkManifest({ collabId: "drive:race" }), "hist"),
    ]);
    const indices = results.map((r) => r.feedIndex).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2]);
  });
});

describe("CollabManifestFeed.readLatest + readAtIndex", () => {
  let client: any;
  let feed: CollabManifestFeed;

  beforeEach(() => {
    client = makeStubClient();
    feed = new CollabManifestFeed(client);
  });

  it("readLatest returns null for a nonexistent feed", async () => {
    const r = await feed.readLatest("drive:none", client.getOwnerAddress(), "02pub");
    expect(r).toBeNull();
  });

  it("readLatest returns the most recent manifest", async () => {
    const collabId = "drive:latest";
    await feed.publish(mkManifest({ collabId, title: "v0" }), "hist");
    await feed.publish(mkManifest({ collabId, title: "v1" }), "hist");
    const result = await feed.readLatest(collabId, client.getOwnerAddress(), "02pub");
    expect(result).not.toBeNull();
    expect(result!.feedIndex).toBe(1);
    expect(result!.manifest.title).toBe("v1");
  });

  it("readLatest self-corrects when Bee returns a stale feedIndex", async () => {
    // Seed two revisions, then mark the feed so that downloadReference
    // no-arg returns index 0 even though the real head is 1. readLatest
    // uses feedIndexNext to detect this and re-reads at the correct index.
    const collabId = "drive:stale";
    await feed.publish(mkManifest({ collabId, title: "v0" }), "hist");
    await feed.publish(mkManifest({ collabId, title: "v1" }), "hist");
    const topicHex = CollabManifestFeed.topicFor(collabId).toHex();
    const feedState = client.state.feeds.get(topicHex)!;
    feedState.staleLatest = 0; // force stale-latest behavior

    const result = await feed.readLatest(collabId, client.getOwnerAddress(), "02pub");
    expect(result).not.toBeNull();
    expect(result!.feedIndex).toBe(1);
    expect(result!.manifest.title).toBe("v1");
  });

  it("readAtIndex returns the manifest at a specific revision", async () => {
    const collabId = "drive:specific";
    await feed.publish(mkManifest({ collabId, title: "v0" }), "hist");
    await feed.publish(mkManifest({ collabId, title: "v1" }), "hist");

    const v0 = await feed.readAtIndex(collabId, client.getOwnerAddress(), "02pub", 0);
    expect(v0?.title).toBe("v0");

    const v1 = await feed.readAtIndex(collabId, client.getOwnerAddress(), "02pub", 1);
    expect(v1?.title).toBe("v1");
  });

  it("readAtIndex returns null for a missing revision", async () => {
    const collabId = "drive:gap";
    await feed.publish(mkManifest({ collabId, title: "v0" }), "hist");
    const result = await feed.readAtIndex(collabId, client.getOwnerAddress(), "02pub", 99);
    expect(result).toBeNull();
  });
});
