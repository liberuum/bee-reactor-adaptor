/**
 * Integration tests for SwarmClient feed operations using the optimized
 * uploadReference/downloadReference pattern against a live Bee node.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Bee } from "@ethersphere/bee-js";
import { SwarmClient } from "../../src/swarm-client.js";
import type { SwarmDocumentManifest, SwarmUserManifest, SwarmDriveManifest } from "../../src/types.js";

import { BEE_URL, TEST_SIGNER_KEY, preflight } from "../helpers.js";

let BATCH_ID = "";

beforeAll(async () => {
  const check = await preflight();
  BATCH_ID = check.batchId;
});

describe("SwarmClient with feed mode (uploadReference)", () => {
  let client: SwarmClient;

  beforeAll(() => {
    client = new SwarmClient({
      beeUrl: BEE_URL,
      batchId: BATCH_ID,
      signerPrivateKey: TEST_SIGNER_KEY,
      useFeedMode: true, // Use feeds, not bytes mode
    });
  });

  it("should upload and download data with encryption", async () => {
    const data = JSON.stringify({ hello: "encrypted swarm", ts: Date.now() });
    const result = await client.uploadData(data);
    expect(result.reference).toBeTruthy();
    expect(result.reference.length).toBe(64);

    const downloaded = await client.downloadData(result.reference);
    const parsed = JSON.parse(new TextDecoder().decode(downloaded));
    expect(parsed.hello).toBe("encrypted swarm");
  });

  it("should write and read document manifest via feed", async () => {
    const docId = `feed-doc-${Date.now()}`;
    const manifest: SwarmDocumentManifest = {
      documentId: docId,
      documentType: "test/feed-doc",
      latestRevision: { global: 3 },
      operationBatches: [
        {
          reference: "a".repeat(64),
          scope: "global",
          branch: "main",
          startIndex: 0,
          endIndex: 3,
          timestamp: new Date().toISOString(),
        },
      ],
      keyframes: [],
      updatedAt: new Date().toISOString(),
    };

    await client.updateManifest(docId, manifest);

    const read = await client.readManifest(docId);
    expect(read).not.toBeNull();
    expect(read!.documentId).toBe(docId);
    expect(read!.documentType).toBe("test/feed-doc");
    expect(read!.latestRevision.global).toBe(3);
    expect(read!.operationBatches).toHaveLength(1);
  });

  it("should update document manifest multiple times (feed index increments)", async () => {
    const docId = `feed-multi-${Date.now()}`;

    // Write v1
    const v1: SwarmDocumentManifest = {
      documentId: docId,
      documentType: "test/doc",
      latestRevision: { global: 5 },
      operationBatches: [
        { reference: "b".repeat(64), scope: "global", branch: "main", startIndex: 0, endIndex: 5, timestamp: new Date().toISOString() },
      ],
      keyframes: [],
      updatedAt: new Date().toISOString(),
    };
    await client.updateManifest(docId, v1);

    // Write v2 (appended batch)
    const v2 = { ...v1, latestRevision: { global: 10 } };
    v2.operationBatches = [
      ...v1.operationBatches,
      { reference: "c".repeat(64), scope: "global", branch: "main", startIndex: 6, endIndex: 10, timestamp: new Date().toISOString() },
    ];
    v2.updatedAt = new Date().toISOString();
    await client.updateManifest(docId, v2);

    // Read — should get v2
    const read = await client.readManifest(docId);
    expect(read).not.toBeNull();
    expect(read!.latestRevision.global).toBe(10);
    expect(read!.operationBatches).toHaveLength(2);
  });

  it("should write and read user manifest via feed", async () => {
    const address = client.getOwnerAddress();
    const manifest: SwarmUserManifest = {
      address,
      documents: {},
      drives: {
        "drive-test": {
          name: "Test Drive",
          documentIds: [],
          lastUpdated: new Date().toISOString(),
        },
      },
      stamps: {},
      updatedAt: new Date().toISOString(),
    };

    await client.updateUserManifest(address, manifest);

    const read = await client.readUserManifest(address);
    expect(read).not.toBeNull();
    expect(read!.address).toBe(address);
    expect(read!.drives["drive-test"].name).toBe("Test Drive");
  });

  it("should write and read drive manifest via feed", async () => {
    const driveId = `drive-feed-${Date.now()}`;
    const manifest: SwarmDriveManifest = {
      driveId,
      name: "Feed Test Drive",
      documents: {
        "doc-1": {
          documentType: "test/doc",
          name: "Doc One",
          lastUpdated: new Date().toISOString(),
        },
      },
      folders: {
        "folder-1": { name: "Reports" },
      },
      updatedAt: new Date().toISOString(),
    };

    await client.updateDriveManifest(driveId, manifest);

    const read = await client.readDriveManifest(driveId);
    expect(read).not.toBeNull();
    expect(read!.name).toBe("Feed Test Drive");
    expect(read!.documents["doc-1"].name).toBe("Doc One");
    expect(read!.folders!["folder-1"].name).toBe("Reports");
  });

  it("should return null for non-existent feed", async () => {
    const manifest = await client.readManifest(`nonexistent-${Date.now()}`);
    expect(manifest).toBeNull();
  });

  it("should do full upload → manifest → read roundtrip", async () => {
    const docId = `roundtrip-${Date.now()}`;

    // Upload actual operation data
    const ops = [
      { id: "op-1", index: 0, skip: 0, timestampUtcMs: Date.now().toString(), hash: "h1", action: { type: "SET_TITLE", input: { title: "Test" }, scope: "global" } },
      { id: "op-2", index: 1, skip: 0, timestampUtcMs: Date.now().toString(), hash: "h2", action: { type: "ADD_ROW", input: { row: 1 }, scope: "global" } },
    ];
    const { reference } = await client.uploadData(JSON.stringify(ops));

    // Write manifest pointing to ops
    const manifest: SwarmDocumentManifest = {
      documentId: docId,
      documentType: "test/roundtrip",
      latestRevision: { global: 1 },
      operationBatches: [
        { reference, scope: "global", branch: "main", startIndex: 0, endIndex: 1, timestamp: new Date().toISOString() },
      ],
      keyframes: [],
      updatedAt: new Date().toISOString(),
    };
    await client.updateManifest(docId, manifest);

    // Read manifest back
    const readManifest = await client.readManifest(docId);
    expect(readManifest).not.toBeNull();

    // Download and decrypt ops from the batch reference
    const downloadedOps = await client.downloadData(readManifest!.operationBatches[0].reference);
    const parsedOps = JSON.parse(new TextDecoder().decode(downloadedOps));
    expect(parsedOps).toHaveLength(2);
    expect(parsedOps[0].action.type).toBe("SET_TITLE");
    expect(parsedOps[1].action.type).toBe("ADD_ROW");
  });
});

describe("SwarmClient sharing (feed mode)", () => {
  it("should upload and download shared data with ACT", async () => {
    const client = new SwarmClient({
      beeUrl: BEE_URL,
      batchId: BATCH_ID,
      signerPrivateKey: TEST_SIGNER_KEY,
      useFeedMode: true,
    });

    // Use the Bee node's own public key as grantee (single-node test)
    const beeNodePubKey = await client.getBeeNodePublicKey();
    const secretData = JSON.stringify({ documents: [{ id: "doc-1", ops: [1, 2, 3] }] });

    const { reference, actHistoryAddress } = await client.uploadSharedData(secretData, beeNodePubKey);
    expect(reference).toBeTruthy();
    expect(actHistoryAddress).toBeTruthy();

    const downloaded = await client.downloadSharedData(reference, beeNodePubKey, actHistoryAddress);
    const parsed = JSON.parse(new TextDecoder().decode(downloaded));
    expect(parsed.documents[0].id).toBe("doc-1");
  });

  it("should fail to download ACT data without correct publisher key", async () => {
    const client = new SwarmClient({
      beeUrl: BEE_URL,
      batchId: BATCH_ID,
      signerPrivateKey: TEST_SIGNER_KEY,
      useFeedMode: true,
    });

    const beeNodePubKey = await client.getBeeNodePublicKey();
    const { reference, actHistoryAddress } = await client.uploadSharedData("secret", beeNodePubKey);

    // Wrong publisher key → ECDH fails → download should fail
    const fakePubKey = "02" + "0".repeat(64); // invalid compressed pubkey
    await expect(
      client.downloadSharedData(reference, fakePubKey, actHistoryAddress),
    ).rejects.toThrow();
  });

  it("should write and read share manifest via feed", async () => {
    const client = new SwarmClient({
      beeUrl: BEE_URL,
      batchId: BATCH_ID,
      signerPrivateKey: TEST_SIGNER_KEY,
      useFeedMode: true,
    });

    const sender = client.getOwnerAddress();
    const recipient = "0xffff6666aaaa7777bbbb8888cccc9999dddd0000";

    await client.writeShareManifest(sender, recipient, {
      from: sender,
      to: recipient,
      shares: [
        {
          driveId: "drive-1",
          driveName: "Shared Drive",
          reference: "a".repeat(64),
          documents: [{ documentId: "doc-1", documentType: "test/doc", name: "Doc", operationCount: 5 }],
          sharedAt: new Date().toISOString(),
        },
      ],
      createdAt: new Date().toISOString(),
    });

    const read = await client.readShareManifest(sender, recipient);
    expect(read).not.toBeNull();
    expect(read!.from).toBe(sender);
    expect(read!.shares).toHaveLength(1);
    expect(read!.shares[0].driveName).toBe("Shared Drive");
  });
});
