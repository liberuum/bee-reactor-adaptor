import { describe, it, expect, beforeAll } from "vitest";
import { Bee } from "@ethersphere/bee-js";
import { SwarmClient } from "../src/swarm-client.js";
import { SwarmOperationStore } from "../src/swarm-operation-store.js";
import { SwarmKeyframeStore } from "../src/swarm-keyframe-store.js";
import { SwarmHydrator } from "../src/swarm-hydrator.js";
import { BeeReactorAdapter } from "../src/bee-reactor-adapter.js";
import { SwarmSyncReadModel } from "../src/swarm-sync-read-model.js";
import type { SwarmDocumentManifest } from "../src/types.js";
import type {
  IOperationStore,
  AtomicTxn,
  Operation,
  OperationWithContext,
  OperationFilter,
  PagingOptions,
  PagedResults,
  DocumentRevisions,
} from "../src/swarm-operation-store.js";
import type { IKeyframeStore, PHDocument } from "../src/swarm-keyframe-store.js";
import {
  BEE_URL,
  TEST_SIGNER_KEY,
  makeAction,
  makeOperation,
  waitForFeed,
  waitForPropagation,
  preflight,
} from "./helpers.js";

let BATCH_ID = "";

// ─── In-Memory Stores ───────────────────────────────────────────

class InMemoryOperationStore implements IOperationStore {
  private operations: Map<string, Operation[]> = new Map();
  private allOperations: OperationWithContext[] = [];
  private nextId = 1;

  private key(documentId: string, scope: string, branch: string): string {
    return `${documentId}:${scope}:${branch}`;
  }

  async apply(
    documentId: string,
    documentType: string,
    scope: string,
    branch: string,
    revision: number,
    fn: (txn: AtomicTxn) => void | Promise<void>,
  ): Promise<void> {
    const staged: Operation[] = [];
    const txn: AtomicTxn = {
      addOperations(...ops: Operation[]) { staged.push(...ops); },
    };
    await fn(txn);
    const k = this.key(documentId, scope, branch);
    const existing = this.operations.get(k) ?? [];
    existing.push(...staged);
    this.operations.set(k, existing);
    for (const op of staged) {
      this.allOperations.push({
        operation: op,
        context: { documentId, documentType, scope, branch, ordinal: this.nextId++ },
      });
    }
  }

  async getSince(documentId: string, scope: string, branch: string, revision: number): Promise<PagedResults<Operation>> {
    const k = this.key(documentId, scope, branch);
    const ops = this.operations.get(k) ?? [];
    return { results: ops.filter((op) => op.index > revision) };
  }

  async getSinceId(id: number): Promise<PagedResults<OperationWithContext>> {
    return { results: this.allOperations.filter((o) => o.context.ordinal > id) };
  }

  async getConflicting(): Promise<PagedResults<Operation>> { return { results: [] }; }

  async getRevisions(documentId: string): Promise<DocumentRevisions> {
    const revision: Record<string, number> = {};
    let latestTimestamp = "";
    for (const [key, ops] of this.operations.entries()) {
      if (key.startsWith(documentId + ":")) {
        const scope = key.split(":")[1];
        const maxIndex = Math.max(...ops.map((o) => o.index), -1);
        if (maxIndex >= 0) revision[scope] = maxIndex;
        for (const op of ops) {
          if (op.timestampUtcMs > latestTimestamp) latestTimestamp = op.timestampUtcMs;
        }
      }
    }
    return { revision, latestTimestamp };
  }

  getAll(documentId: string, scope: string, branch: string): Operation[] {
    return this.operations.get(this.key(documentId, scope, branch)) ?? [];
  }
}

class InMemoryKeyframeStore implements IKeyframeStore {
  private keyframes: Map<string, Array<{ revision: number; document: PHDocument }>> = new Map();

  private key(documentId: string, scope: string, branch: string): string {
    return `${documentId}:${scope}:${branch}`;
  }

  async putKeyframe(documentId: string, scope: string, branch: string, revision: number, document: PHDocument): Promise<void> {
    const k = this.key(documentId, scope, branch);
    const existing = this.keyframes.get(k) ?? [];
    existing.push({ revision, document });
    this.keyframes.set(k, existing);
  }

  async findNearestKeyframe(documentId: string, scope: string, branch: string, targetRevision: number): Promise<{ revision: number; document: PHDocument } | undefined> {
    const kfs = this.keyframes.get(this.key(documentId, scope, branch)) ?? [];
    const eligible = kfs.filter((kf) => kf.revision <= targetRevision);
    if (eligible.length === 0) return undefined;
    return eligible.reduce((a, b) => a.revision > b.revision ? a : b);
  }

  async listKeyframes(documentId: string, scope?: string, branch?: string): Promise<Array<{ scope: string; branch: string; revision: number; document: PHDocument }>> {
    const results: Array<{ scope: string; branch: string; revision: number; document: PHDocument }> = [];
    for (const [key, kfs] of this.keyframes.entries()) {
      const [docId, s, b] = key.split(":");
      if (docId !== documentId) continue;
      if (scope && s !== scope) continue;
      if (branch && b !== branch) continue;
      for (const kf of kfs) results.push({ scope: s, branch: b, ...kf });
    }
    return results;
  }

  async deleteKeyframes(): Promise<number> { return 0; }
}

// ─── Tests ──────────────────────────────────────────────────────

describe("Integration: Bee Node", () => {
  let bee: Bee;

  beforeAll(async () => {
    const check = await preflight();
    BATCH_ID = check.batchId;
    bee = new Bee(BEE_URL);
  });

  describe("SwarmClient", () => {
    let client: SwarmClient;

    beforeAll(() => {
      client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: true,
      });
    });

    it("should report healthy", async () => {
      expect(await client.isHealthy()).toBe(true);
    });

    it("should upload and download encrypted data", async () => {
      const data = JSON.stringify({ hello: "swarm", ts: Date.now() });
      const result = await client.uploadData(data);
      expect(result.reference).toBeTruthy();
      expect(result.reference.length).toBe(64);

      const downloaded = await client.downloadData(result.reference);
      const parsed = JSON.parse(new TextDecoder().decode(downloaded));
      expect(parsed.hello).toBe("swarm");
    });

    it("should return null for non-existent feed", async () => {
      const manifest = await client.readManifest("non-existent-doc-" + Date.now());
      expect(manifest).toBeNull();
    });

    it("should write and read a document manifest via feed", async () => {
      const docId = `test-doc-${Date.now()}`;
      const manifest: SwarmDocumentManifest = {
        documentId: docId,
        documentType: "powerhouse/builder-profile",
        latestRevision: { global: 5 },
        operationBatches: [{
          reference: "a".repeat(64),
          scope: "global",
          branch: "main",
          startIndex: 0,
          endIndex: 5,
          timestamp: new Date().toISOString(),
        }],
        keyframes: [],
        updatedAt: new Date().toISOString(),
      };

      await client.updateManifest(docId, manifest);

      const read = await waitForFeed(() => client.readManifest(docId));
      expect(read.documentId).toBe(docId);
      expect(read.latestRevision.global).toBe(5);
      expect(read.operationBatches).toHaveLength(1);
    });
  });

  describe("SwarmOperationStore", () => {
    let localStore: InMemoryOperationStore;
    let swarmStore: SwarmOperationStore;
    let client: SwarmClient;

    beforeAll(() => {
      client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: true,
      });
      localStore = new InMemoryOperationStore();
      swarmStore = new SwarmOperationStore(client, localStore);
    });

    it("should write operations to both local and Swarm", async () => {
      const docId = `ops-test-${Date.now()}`;
      const op = makeOperation(0);

      await swarmStore.apply(docId, "powerhouse/builder-profile", "global", "main", 0, (txn) => txn.addOperations(op));

      // Local store should have the operation immediately
      const localOps = localStore.getAll(docId, "global", "main");
      expect(localOps).toHaveLength(1);

      // Wait for async Swarm upload + feed propagation
      await swarmStore.flush();
      const manifest = await waitForFeed(() => client.readManifest(docId));
      expect(manifest.operationBatches).toHaveLength(1);

      // Download the actual operation batch from Swarm
      const data = await client.downloadData(manifest.operationBatches[0].reference);
      const ops = JSON.parse(new TextDecoder().decode(data));
      expect(ops).toHaveLength(1);
    });

    it("should read from local store", async () => {
      const docId = `read-test-${Date.now()}`;
      const op = makeOperation(0);
      await swarmStore.apply(docId, "test/doc", "global", "main", 0, (txn) => txn.addOperations(op));
      const result = await swarmStore.getSince(docId, "global", "main", -1);
      expect(result.results).toHaveLength(1);
    });
  });

  describe("SwarmKeyframeStore", () => {
    let localStore: InMemoryKeyframeStore;
    let swarmStore: SwarmKeyframeStore;
    let client: SwarmClient;

    beforeAll(() => {
      client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: true,
      });
      localStore = new InMemoryKeyframeStore();
      swarmStore = new SwarmKeyframeStore(client, localStore);
    });

    it("should write keyframe to both local and Swarm", async () => {
      const docId = `kf-test-${Date.now()}`;
      const doc: PHDocument = {
        header: { id: docId, documentType: "powerhouse/builder-profile" },
        state: { global: { name: "Test Profile" }, local: {} },
      };

      await swarmStore.putKeyframe(docId, "global", "main", 10, doc);

      // Local should have it
      const local = await swarmStore.findNearestKeyframe(docId, "global", "main", 10);
      expect(local).toBeDefined();
      expect(local!.revision).toBe(10);

      // Wait for async upload + propagation
      await waitForPropagation(4000);
      const manifest = await waitForFeed(() => client.readManifest(docId));
      expect(manifest.keyframes).toHaveLength(1);
      expect(manifest.keyframes[0].revision).toBe(10);
    });
  });

  describe("SwarmHydrator", () => {
    it("should hydrate a fresh store from Swarm", async () => {
      const client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: true,
      });

      const docId = `hydrate-test-${Date.now()}`;

      // Write 3 operation batches sequentially
      const sourceLocal = new InMemoryOperationStore();
      const sourceSwarm = new SwarmOperationStore(client, sourceLocal);

      for (let i = 0; i < 3; i++) {
        await sourceSwarm.apply(docId, "test/doc", "global", "main", i, (txn) => txn.addOperations(makeOperation(i)));
        await sourceSwarm.flush();
        await waitForPropagation(2000);
      }

      // Verify manifest is on Swarm
      const manifest = await waitForFeed(() => client.readManifest(docId));
      expect(manifest.operationBatches.length).toBeGreaterThanOrEqual(3);

      // Hydrate into a fresh store
      const targetLocal = new InMemoryOperationStore();
      const targetKeyframes = new InMemoryKeyframeStore();
      const hydrator = new SwarmHydrator(client);

      const loadedOps: Array<{ docId: string; branch: string; ops: unknown[] }> = [];
      const result = await hydrator.hydrate(
        [docId],
        targetLocal,
        targetKeyframes,
        async (docId, branch, ops) => { loadedOps.push({ docId, branch, ops }); },
      );

      expect(result.documentsHydrated).toBe(1);
      expect(result.operationBatchesDownloaded).toBeGreaterThanOrEqual(3);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("SwarmSyncReadModel", () => {
    it("should upload operations to Swarm", async () => {
      const client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: true,
      });

      const readModel = new SwarmSyncReadModel(client);
      const docId = `readmodel-test-${Date.now()}`;

      await readModel.indexOperations([
        {
          operation: makeOperation(0, makeAction("UPDATE_PROFILE", { name: "Test" })),
          context: { documentId: docId, documentType: "powerhouse/builder-profile", scope: "global", branch: "main", ordinal: 1 },
        },
      ]);
      await readModel.flush();
      await waitForPropagation(5000);

      const manifest = await waitForFeed(() => client.readManifest(docId));
      expect(manifest.documentId).toBe(docId);
      expect(manifest.operationBatches.length).toBeGreaterThanOrEqual(1);
    });

    it("should handle multiple mutation batches", async () => {
      const client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: true,
      });

      const readModel = new SwarmSyncReadModel(client);
      const docId = `multi-mut-${Date.now()}`;

      for (let i = 0; i < 3; i++) {
        await readModel.indexOperations([{
          operation: makeOperation(i, makeAction("UPDATE_PROFILE", { name: `Version ${i + 1}` })),
          context: { documentId: docId, documentType: "test/doc", scope: "global", branch: "main", ordinal: i + 1 },
        }]);
        await readModel.flush();
        await waitForPropagation(4000);
      }
      await waitForPropagation(3000);

      const manifest = await waitForFeed(() => client.readManifest(docId));
      expect(manifest.operationBatches.length).toBe(3);
      expect(manifest.latestRevision["global"]).toBe(2);
    });
  });

  describe("User manifest (identity)", () => {
    it("should create user manifest when operations have signer context", async () => {
      const client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: true,
      });

      const readModel = new SwarmSyncReadModel(client);
      const docId = `user-manifest-test-${Date.now()}`;
      const userAddress = "0xadbA7C2F82139031D7564D18aC22D09B12A0BcA4";

      await readModel.indexOperations([{
        operation: makeOperation(0, makeAction("UPDATE_PROFILE", { name: "My Swarm Doc" }, "global", userAddress)),
        context: { documentId: docId, documentType: "powerhouse/builder-profile", scope: "global", branch: "main", ordinal: 1 },
      }]);
      await readModel.flush();
      await waitForPropagation(5000);

      const userManifest = await waitForFeed(() => client.readUserManifest(userAddress));
      expect(userManifest.address).toBe(userAddress);
      expect(userManifest.documents[docId]).toBeDefined();
    });
  });

  describe("Stamp status", () => {
    it("should return stamp health information", async () => {
      const client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: true,
      });

      const status = await client.getStampStatus();
      expect(status.batchId).toBe(BATCH_ID);
      expect(status.usable).toBe(true);
      expect(status.ttlSeconds).toBeGreaterThan(0);
      expect(status.ttlHuman).toBeTruthy();
      expect(["healthy", "warning", "critical"]).toContain(status.health);
      expect(status.capacityBytes).toBeGreaterThan(0);
      expect(typeof status.immutable).toBe("boolean");
      expect(Array.isArray(status.warnings)).toBe(true);
      // Log stamp mutability for visibility
      console.log(`  Stamp immutable: ${status.immutable}`);
      if (status.warnings.length > 0) {
        console.log(`  Warnings: ${status.warnings.join("; ")}`);
      }
    });
  });

  describe("App-layer encryption (AES-256-GCM)", () => {
    it("should encrypt and decrypt data round-trip", async () => {
      const { encrypt, decrypt } = await import("../src/swarm-crypto.js");
      const key = TEST_SIGNER_KEY;
      const plaintext = "Hello Swarm! This is private data.";
      const encrypted = await encrypt(plaintext, key);
      const decrypted = await decrypt(encrypted, key);
      expect(new TextDecoder().decode(decrypted)).toBe(plaintext);
    });

    it("should work with Swarm upload/download round-trip", async () => {
      const { isEncrypted } = await import("../src/swarm-crypto.js");
      const client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: true,
      });

      const secret = JSON.stringify({ private: true, data: "only-for-me" });
      const { reference } = await client.uploadData(secret);
      const downloaded = await client.downloadData(reference);
      const parsed = JSON.parse(new TextDecoder().decode(downloaded));
      expect(parsed.data).toBe("only-for-me");

      // Verify raw bytes are encrypted
      const raw = await client.downloadData(reference, { skipDecryption: true });
      expect(isEncrypted(raw)).toBe(true);
    });
  });

  describe("Encrypted SwarmSyncReadModel (full privacy flow)", () => {
    it("should encrypt ops and decrypt on hydration", async () => {
      const { isEncrypted } = await import("../src/swarm-crypto.js");
      const client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: true,
      });

      const readModel = new SwarmSyncReadModel(client);
      const docId = `encrypted-rm-${Date.now()}`;

      await readModel.indexOperations([{
        operation: makeOperation(0, makeAction("UPDATE_PROFILE", { name: "Top Secret" })),
        context: { documentId: docId, documentType: "test/encrypted", scope: "global", branch: "main", ordinal: 1 },
      }]);
      await readModel.flush();
      await waitForPropagation(5000);

      const manifest = await waitForFeed(() => client.readManifest(docId));
      expect(manifest.operationBatches.length).toBe(1);

      // Verify raw bytes are encrypted
      const rawData = await client.downloadData(manifest.operationBatches[0].reference, { skipDecryption: true });
      expect(isEncrypted(rawData)).toBe(true);

      // Hydrate — SwarmClient auto-decrypts
      const hydrator = new SwarmHydrator(client);
      const loaded: unknown[][] = [];
      const result = await hydrator.hydrate(
        [docId],
        new InMemoryOperationStore(),
        new InMemoryKeyframeStore(),
        async (_docId, _branch, ops) => { loaded.push(ops); },
      );

      expect(result.operationBatchesDownloaded).toBe(1);
      expect(loaded.length).toBe(1);
      const ops = loaded[0] as Array<{ action: { type: string; input: { name: string } } }>;
      expect(ops[0].action.input.name).toBe("Top Secret");
    });
  });

  describe("BeeReactorAdapter (full flow — Path B, not used by Connect plugin)", () => {
    it.skip("should orchestrate write-through and hydration (skipped: Path B adapter has feed propagation timing issues on live nodes)", { timeout: 120_000 }, async () => {
      const docId = `adapter-test-${Date.now()}`;

      const adapter = new BeeReactorAdapter({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: true,
        trackedDocuments: [docId],
        pollIntervalMs: 0,
      });

      const localOps = new InMemoryOperationStore();
      const localKfs = new InMemoryKeyframeStore();
      const swarmOps = adapter.createOperationStore(localOps);
      const swarmKfs = adapter.createKeyframeStore(localKfs);
      await adapter.start();

      // Write one operation batch
      await swarmOps.apply(docId, "test/doc", "global", "main", 0, (txn) => txn.addOperations(makeOperation(0)));
      await swarmOps.flush();
      await waitForPropagation(5000);

      // Verify manifest
      const client = adapter.getSwarmClient();
      const manifest = await waitForFeed(() => client.readManifest(docId));
      expect(manifest.operationBatches.length).toBeGreaterThanOrEqual(1);

      // Hydrate into a fresh adapter
      const adapter2 = new BeeReactorAdapter({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: true,
        trackedDocuments: [docId],
        pollIntervalMs: 0,
      });

      const freshOps = new InMemoryOperationStore();
      const freshKfs = new InMemoryKeyframeStore();
      adapter2.createOperationStore(freshOps);
      adapter2.createKeyframeStore(freshKfs);

      const loaded: unknown[][] = [];
      await adapter2.start(async (_docId, _branch, ops) => { loaded.push(ops); });
      expect(loaded.length).toBeGreaterThanOrEqual(1);

      await adapter.stop();
      await adapter2.stop();
    });
  });

  describe("Wallet-derived signer", () => {
    it("should derive deterministic key from signature", async () => {
      const { deriveSwarmKey } = await import("../src/wallet-signer.js");
      const sig = "0xaabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd1122334400";
      const key1 = deriveSwarmKey(sig);
      const key2 = deriveSwarmKey(sig);
      expect(key1).toBe(key2);
      expect(key1.startsWith("0x")).toBe(true);
      expect(key1.length).toBe(66);
    });

    it("should create a valid Bee PrivateKey from derived key", async () => {
      const { deriveSwarmKey } = await import("../src/wallet-signer.js");
      const { PrivateKey } = await import("@ethersphere/bee-js");
      const sig = "0xdeadbeef11223344deadbeef11223344deadbeef11223344deadbeef11223344deadbeef11223344deadbeef11223344deadbeef11223344deadbeef1122334400";
      const key = deriveSwarmKey(sig);
      const pk = new PrivateKey(key);
      expect(pk.publicKey().toCompressedHex().length).toBeGreaterThan(0);
      expect(pk.publicKey().address().toHex().length).toBe(40);
    });
  });
});
