/**
 * Integration tests for tag-based upload tracking, deferred uploads,
 * node status, and content availability.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { SwarmClient } from "../../src/swarm-client.js";
import { BEE_URL, TEST_SIGNER_KEY, preflight } from "../helpers.js";

let BATCH_ID = "";

beforeAll(async () => {
  const check = await preflight();
  BATCH_ID = check.batchId;
});

describe("Upload Tracking (Tags)", () => {
  let client: SwarmClient;

  beforeAll(() => {
    client = new SwarmClient({
      beeUrl: BEE_URL,
      batchId: BATCH_ID,
      signerPrivateKey: TEST_SIGNER_KEY,
      useFeedMode: true,
    });
  });

  it("should upload with tag tracking and return tagUid", async () => {
    const { reference, tagUid } = await client.uploadData(
      JSON.stringify({ test: "tracked upload", ts: Date.now() }),
      { tracked: true },
    );

    expect(reference).toBeTruthy();
    expect(reference.length).toBe(64);
    expect(tagUid).toBeDefined();
    expect(typeof tagUid).toBe("number");
    console.log(`  Uploaded: ref=${reference.slice(0, 16)}..., tag=${tagUid}`);
  });

  it("should get tag status showing upload progress", async () => {
    const { tagUid } = await client.uploadData(
      "tag status test data " + Date.now(),
      { tracked: true },
    );

    const status = await client.getTagStatus(tagUid!);
    expect(status.uid).toBe(tagUid);
    expect(status.split).toBeGreaterThan(0);
    // sent/synced may still be 0 if push hasn't started yet
    console.log(`  Tag ${tagUid}: split=${status.split}, sent=${status.sent}, synced=${status.synced}, done=${status.done}`);
  });

  it("should wait for upload confirmation (synced == split)", async () => {
    const data = JSON.stringify({
      test: "confirmation test",
      payload: "x".repeat(1000), // make it a decent size
      ts: Date.now(),
    });

    const { reference, tagUid } = await client.uploadData(data, { tracked: true });
    expect(tagUid).toBeDefined();

    console.log(`  Waiting for confirmation of tag ${tagUid}...`);
    const progressLog: string[] = [];
    const result = await client.waitForConfirmation(
      tagUid!,
      30_000, // 30s timeout
      1_000,  // poll every 1s
      ({ synced, total, percent }) => {
        progressLog.push(`${percent}%`);
      },
    );

    expect(result.synced).toBe(result.total);
    expect(result.durationMs).toBeGreaterThan(0);
    console.log(`  Confirmed: ${result.synced}/${result.total} chunks in ${result.durationMs}ms`);
    console.log(`  Progress: ${progressLog.join(" → ")}`);

    // Verify the data is actually downloadable after confirmation
    const downloaded = await client.downloadData(reference);
    const parsed = JSON.parse(new TextDecoder().decode(downloaded));
    expect(parsed.test).toBe("confirmation test");
  });

  it("should upload with deferred mode (faster upload, async push)", async () => {
    const { reference, tagUid } = await client.uploadData(
      JSON.stringify({ test: "deferred upload", ts: Date.now() }),
      { deferred: true },
    );

    expect(reference).toBeTruthy();
    expect(tagUid).toBeDefined();

    // Deferred: data is stored locally, push happens in background
    // The tag should show split > 0 immediately
    const status = await client.getTagStatus(tagUid!);
    expect(status.split).toBeGreaterThan(0);
    console.log(`  Deferred upload: ref=${reference.slice(0, 16)}..., tag=${tagUid}, split=${status.split}`);

    // Wait for it to actually propagate
    const result = await client.waitForConfirmation(tagUid!, 30_000, 1_000);
    console.log(`  Confirmed after ${result.durationMs}ms`);
  });

  it("should upload without tracking (backward compatible)", async () => {
    const { reference, tagUid } = await client.uploadData(
      "untracked upload " + Date.now(),
    );

    expect(reference).toBeTruthy();
    expect(tagUid).toBeUndefined(); // No tag when not tracked
  });
});

describe("Node Status", () => {
  it("should return detailed node status", async () => {
    const client = new SwarmClient({
      beeUrl: BEE_URL,
      batchId: BATCH_ID,
      signerPrivateKey: TEST_SIGNER_KEY,
      useFeedMode: true,
    });

    const status = await client.getNodeStatus();
    expect(status.overlay).toBeTruthy();
    expect(["full", "light", "dev", "ultra-light"]).toContain(status.beeMode);
    expect(typeof status.isReachable).toBe("boolean");
    expect(status.connectedPeers).toBeGreaterThan(0);
    expect(status.storageRadius).toBeGreaterThanOrEqual(0);

    console.log(`  Node: ${status.beeMode}, peers=${status.connectedPeers}, reachable=${status.isReachable}`);
    console.log(`  Neighborhood: size=${status.neighborhoodSize}, radius=${status.storageRadius}`);
    console.log(`  Reserve: ${status.reserveSize} chunks, pullsync rate=${status.pullsyncRate}`);
  });
});

describe("Content Availability (Stewardship)", () => {
  it("should verify content is available after upload", async () => {
    const client = new SwarmClient({
      beeUrl: BEE_URL,
      batchId: BATCH_ID,
      signerPrivateKey: TEST_SIGNER_KEY,
      useFeedMode: true,
    });

    // Upload and wait for confirmation
    const { reference, tagUid } = await client.uploadData(
      "stewardship test " + Date.now(),
      { tracked: true },
    );
    await client.waitForConfirmation(tagUid!, 30_000);

    // Check availability
    const available = await client.isContentAvailable(reference);
    expect(available).toBe(true);
    console.log(`  Content ${reference.slice(0, 16)}... is available: ${available}`);
  });

  it("should return false for non-existent content", async () => {
    const client = new SwarmClient({
      beeUrl: BEE_URL,
      batchId: BATCH_ID,
      signerPrivateKey: TEST_SIGNER_KEY,
      useFeedMode: true,
    });

    const fakeRef = "0000000000000000000000000000000000000000000000000000000000000000";
    const available = await client.isContentAvailable(fakeRef);
    expect(available).toBe(false);
    console.log(`  Fake reference: available=${available}`);
  });
});
