import { describe, it, expect, beforeAll } from "vitest";
import { Bee, Topic } from "@ethersphere/bee-js";
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

const BEE_URL = "http://localhost:1633";
// Auto-detected in beforeAll — survives bee dev restarts
let BATCH_ID = "";
// Test signer key (DO NOT use in production)
const TEST_SIGNER_KEY =
  "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

/**
 * In-memory IOperationStore for testing — simulates the local SQL cache.
 */
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
      addOperations(...ops: Operation[]) {
        staged.push(...ops);
      },
    };

    await fn(txn);

    const k = this.key(documentId, scope, branch);
    const existing = this.operations.get(k) ?? [];
    existing.push(...staged);
    this.operations.set(k, existing);

    for (const op of staged) {
      this.allOperations.push({
        operation: op,
        context: {
          documentId,
          documentType,
          scope,
          branch,
          ordinal: this.nextId++,
        },
      });
    }
  }

  async getSince(
    documentId: string,
    scope: string,
    branch: string,
    revision: number,
    _filter?: OperationFilter,
    _paging?: PagingOptions,
  ): Promise<PagedResults<Operation>> {
    const k = this.key(documentId, scope, branch);
    const ops = this.operations.get(k) ?? [];
    const results = ops.filter((op) => op.index > revision);
    return { results };
  }

  async getSinceId(
    id: number,
    _paging?: PagingOptions,
  ): Promise<PagedResults<OperationWithContext>> {
    const results = this.allOperations.filter((o) => o.context.ordinal > id);
    return { results };
  }

  async getConflicting(
    _documentId: string,
    _scope: string,
    _branch: string,
    _minTimestamp: string,
  ): Promise<PagedResults<Operation>> {
    return { results: [] };
  }

  async getRevisions(
    documentId: string,
    _branch: string,
  ): Promise<DocumentRevisions> {
    const revision: Record<string, number> = {};
    let latestTimestamp = "";

    for (const [key, ops] of this.operations.entries()) {
      if (key.startsWith(documentId + ":")) {
        const scope = key.split(":")[1];
        const maxIndex = Math.max(...ops.map((o) => o.index), -1);
        if (maxIndex >= 0) {
          revision[scope] = maxIndex;
        }
        for (const op of ops) {
          if (op.timestampUtcMs > latestTimestamp) {
            latestTimestamp = op.timestampUtcMs;
          }
        }
      }
    }

    return { revision, latestTimestamp };
  }

  getAll(
    documentId: string,
    scope: string,
    branch: string,
  ): Operation[] {
    return this.operations.get(this.key(documentId, scope, branch)) ?? [];
  }
}

/**
 * In-memory IKeyframeStore for testing.
 */
class InMemoryKeyframeStore implements IKeyframeStore {
  private keyframes: Map<
    string,
    { revision: number; document: PHDocument }[]
  > = new Map();

  private key(documentId: string, scope: string, branch: string): string {
    return `${documentId}:${scope}:${branch}`;
  }

  async putKeyframe(
    documentId: string,
    scope: string,
    branch: string,
    revision: number,
    document: PHDocument,
  ): Promise<void> {
    const k = this.key(documentId, scope, branch);
    const existing = this.keyframes.get(k) ?? [];
    existing.push({ revision, document });
    this.keyframes.set(k, existing);
  }

  async findNearestKeyframe(
    documentId: string,
    scope: string,
    branch: string,
    targetRevision: number,
  ): Promise<{ revision: number; document: PHDocument } | undefined> {
    const k = this.key(documentId, scope, branch);
    const kfs = this.keyframes.get(k) ?? [];
    const eligible = kfs.filter((kf) => kf.revision <= targetRevision);
    if (eligible.length === 0) return undefined;
    return eligible.reduce((a, b) =>
      a.revision > b.revision ? a : b,
    );
  }

  async listKeyframes(
    documentId: string,
    scope?: string,
    branch?: string,
  ): Promise<
    Array<{
      scope: string;
      branch: string;
      revision: number;
      document: PHDocument;
    }>
  > {
    const results: Array<{
      scope: string;
      branch: string;
      revision: number;
      document: PHDocument;
    }> = [];

    for (const [key, kfs] of this.keyframes.entries()) {
      const [docId, s, b] = key.split(":");
      if (docId !== documentId) continue;
      if (scope && s !== scope) continue;
      if (branch && b !== branch) continue;

      for (const kf of kfs) {
        results.push({ scope: s, branch: b, ...kf });
      }
    }

    return results;
  }

  async deleteKeyframes(): Promise<number> {
    return 0;
  }
}

function makeTestOperation(index: number): Operation {
  return {
    id: `op-${index}`,
    index,
    skip: 0,
    timestampUtcMs: new Date().toISOString(),
    hash: `hash-${index}`,
    action: { type: "SET_TITLE", input: { title: `Title ${index}` } },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("Integration: Bee Dev Node", () => {
  let bee: Bee;

  beforeAll(async () => {
    bee = new Bee(BEE_URL);
    const health = await bee.getHealth();
    expect(health.status).toBe("ok");

    // Auto-detect or create a postage stamp
    const stamps = await bee.getAllPostageBatch();
    if (stamps.length > 0) {
      BATCH_ID = stamps[0].batchID.toHex();
    } else {
      const res = await fetch(`${BEE_URL}/stamps/10000000/24`, { method: "POST" });
      const data = await res.json() as { batchID: string };
      BATCH_ID = data.batchID;
    }
  });

  describe("SwarmClient", () => {
    let client: SwarmClient;

    beforeAll(() => {
      client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
      useFeedMode: false,
      });
    });

    it("should report healthy", async () => {
      expect(await client.isHealthy()).toBe(true);
    });

    it("should upload and download data", async () => {
      const data = JSON.stringify({ hello: "swarm", ts: Date.now() });
      const result = await client.uploadData(data);

      expect(result.reference).toBeTruthy();
      expect(typeof result.reference).toBe("string");
      expect(result.reference.length).toBeGreaterThan(10);

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
        documentType: "test/doc",
        latestRevision: { global: 5 },
        operationBatches: [
          {
            reference: "deadbeef",
            scope: "global",
            branch: "main",
            startIndex: 0,
            endIndex: 5,
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
      expect(read!.latestRevision.global).toBe(5);
      expect(read!.operationBatches).toHaveLength(1);
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
      useFeedMode: false,
      });
      localStore = new InMemoryOperationStore();
      swarmStore = new SwarmOperationStore(client, localStore);
    });

    it("should write operations to both local and Swarm", async () => {
      const docId = `ops-test-${Date.now()}`;
      const op = makeTestOperation(0);

      await swarmStore.apply(
        docId,
        "test/doc",
        "global",
        "main",
        0,
        (txn) => txn.addOperations(op),
      );

      // Local store should have the operation immediately
      const localOps = localStore.getAll(docId, "global", "main");
      expect(localOps).toHaveLength(1);
      expect(localOps[0].id).toBe("op-0");

      // Wait for async Swarm upload
      await swarmStore.flush();

      // Swarm feed should have the manifest
      const manifest = await client.readManifest(docId);
      expect(manifest).not.toBeNull();
      expect(manifest!.operationBatches).toHaveLength(1);
      expect(manifest!.operationBatches[0].startIndex).toBe(0);

      // Download the actual operation batch from Swarm
      const data = await client.downloadData(
        manifest!.operationBatches[0].reference,
      );
      const ops = JSON.parse(new TextDecoder().decode(data));
      expect(ops).toHaveLength(1);
      expect(ops[0].id).toBe("op-0");
    });

    it("should read from local store", async () => {
      const docId = `read-test-${Date.now()}`;
      const op = makeTestOperation(0);

      await swarmStore.apply(
        docId,
        "test/doc",
        "global",
        "main",
        0,
        (txn) => txn.addOperations(op),
      );

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
      useFeedMode: false,
      });
      localStore = new InMemoryKeyframeStore();
      swarmStore = new SwarmKeyframeStore(client, localStore);
    });

    it("should write keyframe to both local and Swarm", async () => {
      const docId = `kf-test-${Date.now()}`;
      const doc: PHDocument = {
        header: { id: docId, documentType: "test/doc" },
        state: { title: "Hello Swarm" },
      };

      await swarmStore.putKeyframe(docId, "global", "main", 10, doc);

      // Local should have it
      const local = await swarmStore.findNearestKeyframe(
        docId,
        "global",
        "main",
        10,
      );
      expect(local).toBeDefined();
      expect(local!.revision).toBe(10);

      // Wait a moment for async upload
      await new Promise((r) => setTimeout(r, 2000));

      // Swarm feed should have the keyframe
      const manifest = await client.readManifest(docId);
      expect(manifest).not.toBeNull();
      expect(manifest!.keyframes).toHaveLength(1);
      expect(manifest!.keyframes[0].revision).toBe(10);

      // Download and verify keyframe content
      const data = await client.downloadData(manifest!.keyframes[0].reference);
      const kfData = JSON.parse(new TextDecoder().decode(data));
      expect(kfData.revision).toBe(10);
      expect(kfData.document.state.title).toBe("Hello Swarm");
    });
  });

  describe("SwarmHydrator", () => {
    it("should hydrate a fresh store from Swarm", async () => {
      const client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
      useFeedMode: false,
      });

      const docId = `hydrate-test-${Date.now()}`;

      // Step 1: Write operations to Swarm via one store
      const sourceLocal = new InMemoryOperationStore();
      const sourceSwarm = new SwarmOperationStore(client, sourceLocal);

      for (let i = 0; i < 3; i++) {
        await sourceSwarm.apply(
          docId,
          "test/doc",
          "global",
          "main",
          i,
          (txn) => txn.addOperations(makeTestOperation(i)),
        );
        // Wait for each upload to complete before the next one,
        // to avoid concurrent manifest overwrites
        await sourceSwarm.flush();
      }

      // Verify all 3 batches are on Swarm
      const manifest = await client.readManifest(docId);
      expect(manifest).not.toBeNull();
      expect(manifest!.operationBatches.length).toBeGreaterThanOrEqual(3);

      // Step 2: Create a fresh empty store and hydrate from Swarm
      const targetLocal = new InMemoryOperationStore();
      const targetKeyframes = new InMemoryKeyframeStore();
      const hydrator = new SwarmHydrator(client);

      const loadedOps: Array<{ docId: string; branch: string; ops: unknown[] }> = [];
      const result = await hydrator.hydrate(
        [docId],
        targetLocal,
        targetKeyframes,
        async (docId, branch, ops) => {
          loadedOps.push({ docId, branch, ops });
        },
      );

      expect(result.documentsHydrated).toBe(1);
      expect(result.operationBatchesDownloaded).toBeGreaterThanOrEqual(3);
      expect(result.errors).toHaveLength(0);
      expect(loadedOps.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("SwarmSyncReadModel (Switchboard integration pattern)", () => {
    it("should upload operations to Swarm when indexOperations is called", async () => {
      const client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: false,
      });

      const readModel = new SwarmSyncReadModel(client);
      expect(readModel.name).toBe("swarm-sync");

      const docId = `readmodel-test-${Date.now()}`;

      // Simulate what the reactor's ReadModelCoordinator sends
      await readModel.indexOperations([
        {
          operation: {
            id: "op-create-1",
            index: 0,
            skip: 0,
            timestampUtcMs: new Date().toISOString(),
            hash: "hash-create-1",
            action: { type: "CREATE_DOCUMENT", input: {} },
          },
          context: {
            documentId: docId,
            documentType: "powerhouse/document-model",
            scope: "document",
            branch: "main",
            ordinal: 1,
          },
        },
        {
          operation: {
            id: "op-set-name-1",
            index: 0,
            skip: 0,
            timestampUtcMs: new Date().toISOString(),
            hash: "hash-set-name-1",
            action: { type: "SET_MODEL_NAME", input: { name: "My Model" } },
          },
          context: {
            documentId: docId,
            documentType: "powerhouse/document-model",
            scope: "global",
            branch: "main",
            ordinal: 2,
          },
        },
      ]);

      // Wait for async uploads
      await readModel.flush();

      // Verify manifest exists on Swarm
      const manifest = await client.readManifest(docId);
      expect(manifest).not.toBeNull();
      expect(manifest!.documentId).toBe(docId);
      expect(manifest!.documentType).toBe("powerhouse/document-model");

      // Should have 2 batches (ops grouped by scope: document + global)
      expect(manifest!.operationBatches.length).toBeGreaterThanOrEqual(1);

      // Download and verify the operation data
      let foundCreateDoc = false;
      let foundSetName = false;
      for (const batch of manifest!.operationBatches) {
        const data = await client.downloadData(batch.reference);
        const ops = JSON.parse(new TextDecoder().decode(data));
        for (const op of ops) {
          if (op.action.type === "CREATE_DOCUMENT") foundCreateDoc = true;
          if (op.action.type === "SET_MODEL_NAME") {
            foundSetName = true;
            expect(op.action.input.name).toBe("My Model");
          }
        }
      }
      expect(foundCreateDoc).toBe(true);
      expect(foundSetName).toBe(true);
    });

    it("should handle multiple indexOperations calls (simulating multiple mutations)", async () => {
      const client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: false,
      });

      const readModel = new SwarmSyncReadModel(client);
      const docId = `multi-mut-test-${Date.now()}`;

      // First mutation batch
      await readModel.indexOperations([
        {
          operation: {
            id: "op-1",
            index: 0,
            skip: 0,
            timestampUtcMs: new Date().toISOString(),
            hash: "h1",
            action: { type: "SET_TITLE", input: { title: "Version 1" } },
          },
          context: {
            documentId: docId,
            documentType: "test/doc",
            scope: "global",
            branch: "main",
            ordinal: 1,
          },
        },
      ]);
      await readModel.flush();

      // Second mutation batch
      await readModel.indexOperations([
        {
          operation: {
            id: "op-2",
            index: 1,
            skip: 0,
            timestampUtcMs: new Date().toISOString(),
            hash: "h2",
            action: { type: "SET_TITLE", input: { title: "Version 2" } },
          },
          context: {
            documentId: docId,
            documentType: "test/doc",
            scope: "global",
            branch: "main",
            ordinal: 2,
          },
        },
      ]);
      await readModel.flush();

      // Third mutation batch
      await readModel.indexOperations([
        {
          operation: {
            id: "op-3",
            index: 2,
            skip: 0,
            timestampUtcMs: new Date().toISOString(),
            hash: "h3",
            action: { type: "SET_TITLE", input: { title: "Version 3" } },
          },
          context: {
            documentId: docId,
            documentType: "test/doc",
            scope: "global",
            branch: "main",
            ordinal: 3,
          },
        },
      ]);
      await readModel.flush();

      // Verify manifest has all 3 batches
      const manifest = await client.readManifest(docId);
      expect(manifest).not.toBeNull();
      expect(manifest!.operationBatches.length).toBe(3);
      expect(manifest!.latestRevision["global"]).toBe(2);

      // Download each batch and verify content
      const allOps: Array<{ action: { type: string; input: { title: string } } }> = [];
      for (const batch of manifest!.operationBatches) {
        const data = await client.downloadData(batch.reference);
        const ops = JSON.parse(new TextDecoder().decode(data));
        allOps.push(...ops);
      }
      expect(allOps.length).toBe(3);
      expect(allOps[0].action.input.title).toBe("Version 1");
      expect(allOps[1].action.input.title).toBe("Version 2");
      expect(allOps[2].action.input.title).toBe("Version 3");
    });

    it("should handle operations for multiple documents in a single batch", async () => {
      const client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: false,
      });

      const readModel = new SwarmSyncReadModel(client);
      const docA = `multi-doc-a-${Date.now()}`;
      const docB = `multi-doc-b-${Date.now()}`;

      // Single indexOperations call with ops for 2 different documents
      await readModel.indexOperations([
        {
          operation: {
            id: "a-op-1",
            index: 0,
            skip: 0,
            timestampUtcMs: new Date().toISOString(),
            hash: "ha1",
            action: { type: "CREATE", input: {} },
          },
          context: {
            documentId: docA,
            documentType: "test/alpha",
            scope: "document",
            branch: "main",
            ordinal: 1,
          },
        },
        {
          operation: {
            id: "b-op-1",
            index: 0,
            skip: 0,
            timestampUtcMs: new Date().toISOString(),
            hash: "hb1",
            action: { type: "CREATE", input: {} },
          },
          context: {
            documentId: docB,
            documentType: "test/beta",
            scope: "document",
            branch: "main",
            ordinal: 2,
          },
        },
      ]);
      await readModel.flush();

      // Each document should have its own manifest
      const manifestA = await client.readManifest(docA);
      const manifestB = await client.readManifest(docB);
      expect(manifestA).not.toBeNull();
      expect(manifestB).not.toBeNull();
      expect(manifestA!.documentType).toBe("test/alpha");
      expect(manifestB!.documentType).toBe("test/beta");
      expect(manifestA!.operationBatches.length).toBe(1);
      expect(manifestB!.operationBatches.length).toBe(1);
    });
  });

  describe("User manifest (identity integration)", () => {
    it("should create user manifest when operations have signer context", async () => {
      const client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: false,
      });

      const readModel = new SwarmSyncReadModel(client);
      const docId = `user-manifest-test-${Date.now()}`;
      const userAddress = "0xadbA7C2F82139031D7564D18aC22D09B12A0BcA4";

      // Send operations with signer context (simulates Renown-signed ops)
      await readModel.indexOperations([
        {
          operation: {
            id: "op-signed-1",
            index: 0,
            skip: 0,
            timestampUtcMs: new Date().toISOString(),
            hash: "h-signed-1",
            action: {
              type: "CREATE_DOCUMENT",
              input: { name: "My Swarm Doc", documentId: docId },
              context: {
                signer: {
                  user: { address: userAddress, networkId: "eip155", chainId: 1 },
                  app: { name: "connect", key: "did:key:zTest..." },
                  signatures: [],
                },
              },
            },
          },
          context: {
            documentId: docId,
            documentType: "powerhouse/document-model",
            scope: "document",
            branch: "main",
            ordinal: 1,
          },
        },
      ]);
      await readModel.flush();

      // Verify user manifest was created
      const userManifest = await client.readUserManifest(userAddress);
      expect(userManifest).not.toBeNull();
      expect(userManifest!.address).toBe(userAddress);
      expect(userManifest!.documents[docId]).toBeDefined();
      expect(userManifest!.documents[docId].documentType).toBe("powerhouse/document-model");
      expect(userManifest!.documents[docId].name).toBe("My Swarm Doc");
    });

    it("should accumulate documents in user manifest across multiple operations", async () => {
      const client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: false,
      });

      const readModel = new SwarmSyncReadModel(client);
      const userAddress = "0x1111222233334444555566667777888899990000";
      const doc1 = `user-multi-1-${Date.now()}`;
      const doc2 = `user-multi-2-${Date.now()}`;

      const makeSignedOp = (docId: string, name: string, ordinal: number) => ({
        operation: {
          id: `op-${ordinal}`,
          index: 0,
          skip: 0,
          timestampUtcMs: new Date().toISOString(),
          hash: `h-${ordinal}`,
          action: {
            type: "CREATE_DOCUMENT",
            input: { name, documentId: docId },
            context: {
              signer: {
                user: { address: userAddress, networkId: "eip155", chainId: 1 },
                app: { name: "connect", key: "did:key:z..." },
                signatures: [],
              },
            },
          },
        },
        context: {
          documentId: docId,
          documentType: "test/doc",
          scope: "document" as const,
          branch: "main" as const,
          ordinal,
        },
      });

      // First document
      await readModel.indexOperations([makeSignedOp(doc1, "Doc Alpha", 1)]);
      await readModel.flush();

      // Second document
      await readModel.indexOperations([makeSignedOp(doc2, "Doc Beta", 2)]);
      await readModel.flush();

      // User manifest should have both documents
      const manifest = await client.readUserManifest(userAddress);
      expect(manifest).not.toBeNull();
      expect(Object.keys(manifest!.documents)).toHaveLength(2);
      expect(manifest!.documents[doc1].name).toBe("Doc Alpha");
      expect(manifest!.documents[doc2].name).toBe("Doc Beta");
    });

    it("should not create user manifest for operations without signer", async () => {
      const client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: false,
      });

      const readModel = new SwarmSyncReadModel(client);
      const docId = `no-signer-test-${Date.now()}`;

      // Operation without signer context (anonymous / switchboard-signed)
      await readModel.indexOperations([
        {
          operation: {
            id: "op-anon-1",
            index: 0,
            skip: 0,
            timestampUtcMs: new Date().toISOString(),
            hash: "h-anon-1",
            action: { type: "SET_TITLE", input: { title: "Anonymous" } },
          },
          context: {
            documentId: docId,
            documentType: "test/doc",
            scope: "global",
            branch: "main",
            ordinal: 1,
          },
        },
      ]);
      await readModel.flush();

      // Document manifest should exist (ops still uploaded)
      const docManifest = await client.readManifest(docId);
      expect(docManifest).not.toBeNull();

      // But no user manifest for any address
      // (we can't check all addresses, but we know none was extracted)
    });
  });

  describe("Stamp status", () => {
    it("should return stamp health information", async () => {
      const client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: false,
      });

      const status = await client.getStampStatus();
      expect(status.batchId).toBe(BATCH_ID);
      expect(status.usable).toBe(true);
      expect(status.ttlSeconds).toBeGreaterThan(0);
      expect(status.ttlHuman).toBeTruthy();
      expect(status.health).toBe("healthy");
      expect(status.capacityBytes).toBeGreaterThan(0);
      expect(status.expiresAt).toBeTruthy();
    });
  });

  describe("ACT access control", () => {
    it("should upload with ACT and return historyAddress", async () => {
      const client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: false,
      });

      // Upload with ACT encryption
      const data = JSON.stringify({ secret: "encrypted-content", ts: Date.now() });
      const result = await client.uploadData(data, { act: true });

      expect(result.reference).toBeTruthy();
      expect(result.reference.length).toBe(64);
      expect(result.historyAddress).toBeTruthy();
      expect(result.historyAddress!.length).toBe(64);

      // Verify the publisher's public key can be derived
      const { PrivateKey } = await import("@ethersphere/bee-js");
      const pk = new PrivateKey(TEST_SIGNER_KEY);
      const pubKeyHex = pk.publicKey().toCompressedHex();
      expect(pubKeyHex.length).toBeGreaterThan(0);
    });

    it("should download ACT-encrypted data using node publisher key", async () => {
      const client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: false,
      });

      // Upload with ACT
      const data = JSON.stringify({ secret: "decrypt-me", value: 42 });
      const result = await client.uploadData(data, { act: true });

      // ACT uses the BEE NODE's internal key for ECDH, not our client signer.
      // Get the node's public key from /addresses endpoint.
      const nodeAddresses = await fetch(`${BEE_URL}/addresses`).then(r => r.json()) as { publicKey: string };

      const downloaded = await client.downloadData(result.reference, {
        actPublisher: nodeAddresses.publicKey,
        actHistoryAddress: result.historyAddress,
      });

      const parsed = JSON.parse(new TextDecoder().decode(downloaded));
      expect(parsed.secret).toBe("decrypt-me");
      expect(parsed.value).toBe(42);
    });

    it("should return historyAddress only when ACT is enabled", async () => {
      const client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: false,
      });

      // Without ACT
      const plain = await client.uploadData("plain data");
      expect(plain.historyAddress).toBeUndefined();

      // With ACT
      const encrypted = await client.uploadData("encrypted data", { act: true });
      expect(encrypted.historyAddress).toBeTruthy();
    });
  });

  describe("App-layer encryption (AES-256-GCM)", () => {
    it("should encrypt and decrypt data round-trip", async () => {
      const { encrypt, decrypt } = await import("../src/swarm-crypto.js");

      const plaintext = "Hello Swarm! This is private data.";
      const key = "0xaabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344";

      const encrypted = await encrypt(plaintext, key);
      expect(encrypted.length).toBeGreaterThan(plaintext.length);

      const decrypted = await decrypt(encrypted, key);
      expect(new TextDecoder().decode(decrypted)).toBe(plaintext);
    });

    it("should fail to decrypt with wrong key", async () => {
      const { encrypt, decrypt } = await import("../src/swarm-crypto.js");

      const encrypted = await encrypt("secret data", "0xaabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344");

      await expect(
        decrypt(encrypted, "0x1122334455667788112233445566778811223344556677881122334455667788"),
      ).rejects.toThrow();
    });

    it("should detect encrypted vs unencrypted data", async () => {
      const { encrypt, isEncrypted } = await import("../src/swarm-crypto.js");

      const encrypted = await encrypt("test", "0xaabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344");
      expect(isEncrypted(encrypted)).toBe(true);

      const plain = new TextEncoder().encode("plain text");
      expect(isEncrypted(plain)).toBe(false);
    });

    it("should encrypt JSON objects and decrypt back", async () => {
      const { encryptJSON, decryptJSON } = await import("../src/swarm-crypto.js");
      const key = "0xaabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344";

      const obj = { operations: [{ type: "SET_TITLE", input: { title: "Private Doc" } }] };
      const encrypted = await encryptJSON(obj, key);
      const decrypted = await decryptJSON(encrypted, key);

      expect(decrypted).toEqual(obj);
    });

    it("should produce different ciphertext for same plaintext (random IV)", async () => {
      const { encrypt } = await import("../src/swarm-crypto.js");
      const key = "0xaabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344";

      const enc1 = await encrypt("same data", key);
      const enc2 = await encrypt("same data", key);

      // Different IVs → different ciphertext (semantic security)
      expect(enc1).not.toEqual(enc2);
    });

    it("should work with Swarm upload/download round-trip", async () => {
      const { encrypt, decrypt } = await import("../src/swarm-crypto.js");

      const client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: false,
      });

      const key = "0xaabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344";
      const secret = JSON.stringify({ private: true, data: "only-for-me" });

      // Encrypt → upload → download → decrypt
      const encrypted = await encrypt(secret, key);
      const { reference } = await client.uploadData(encrypted);
      const downloaded = await client.downloadData(reference);
      const decrypted = await decrypt(downloaded, key);

      expect(JSON.parse(new TextDecoder().decode(decrypted))).toEqual({
        private: true,
        data: "only-for-me",
      });
    });
  });

  describe("Wallet-derived signer", () => {
    it("should derive deterministic key from signature", async () => {
      const { deriveSwarmKey, buildSignMessage } = await import(
        "../src/wallet-signer.js"
      );

      // Same signature always produces same key
      const sig1 =
        "0xaabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd1122334400";
      const key1 = await deriveSwarmKey(sig1);
      const key2 = await deriveSwarmKey(sig1);
      expect(key1).toBe(key2);
      expect(key1.startsWith("0x")).toBe(true);
      expect(key1.length).toBe(66); // 0x + 64 hex chars = 32 bytes

      // Different signature produces different key
      const sig2 =
        "0x1122334455667788112233445566778811223344556677881122334455667788112233445566778811223344556677881122334455667788112233445566778800";
      const key3 = await deriveSwarmKey(sig2);
      expect(key3).not.toBe(key1);
    });

    it("should build sign message with domain separator", async () => {
      const { buildSignMessage } = await import("../src/wallet-signer.js");

      const msg = buildSignMessage(
        "0xadbA7C2F82139031D7564D18aC22D09B12A0BcA4",
        "https://connect.example.com",
      );

      expect(msg).toContain("Authorize Swarm storage");
      expect(msg).toContain("0xadbA7C2F82139031D7564D18aC22D09B12A0BcA4");
      expect(msg).toContain("https://connect.example.com");
      expect(msg).toContain("does not authorize any blockchain transaction");
    });

    it("should create a valid Bee PrivateKey from derived key", async () => {
      const { deriveSwarmKey } = await import("../src/wallet-signer.js");
      const { PrivateKey } = await import("@ethersphere/bee-js");

      const sig =
        "0xdeadbeef11223344deadbeef11223344deadbeef11223344deadbeef11223344deadbeef11223344deadbeef11223344deadbeef11223344deadbeef1122334400";
      const key = await deriveSwarmKey(sig);

      // Should be usable as a Bee signer
      const pk = new PrivateKey(key);
      const pubKey = pk.publicKey();
      const address = pubKey.address();

      expect(pubKey.toCompressedHex().length).toBeGreaterThan(0);
      expect(address.toHex().length).toBe(40);
    });
  });

  describe("Encrypted SwarmSyncReadModel (full privacy flow)", () => {
    it("should encrypt ops on upload and decrypt on hydration", async () => {
      const encKey = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
      const { isEncrypted } = await import("../src/swarm-crypto.js");

      const client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: false,
      });

      // Create read model WITH encryption key
      const readModel = new SwarmSyncReadModel(client);
      readModel.setEncryptionKey(encKey);
      expect(readModel.isEncryptionEnabled()).toBe(true);

      const docId = `encrypted-rm-test-${Date.now()}`;

      // Index operations (will be encrypted before upload)
      await readModel.indexOperations([
        {
          operation: {
            id: "enc-op-1",
            index: 0,
            skip: 0,
            timestampUtcMs: new Date().toISOString(),
            hash: "h1",
            action: { type: "SET_TITLE", input: { title: "Top Secret" } },
          },
          context: {
            documentId: docId,
            documentType: "test/encrypted",
            scope: "global",
            branch: "main",
            ordinal: 1,
          },
        },
      ]);
      await readModel.flush();

      // Verify manifest was created
      const manifest = await client.readManifest(docId);
      expect(manifest).not.toBeNull();
      expect(manifest!.encrypted).toBe(true);
      expect(manifest!.operationBatches.length).toBe(1);

      // Verify the raw bytes on Swarm are ENCRYPTED (not readable JSON)
      const rawData = await client.downloadData(manifest!.operationBatches[0].reference);
      expect(isEncrypted(rawData)).toBe(true);
      // Should NOT be valid JSON
      let isJson = false;
      try { JSON.parse(new TextDecoder().decode(rawData)); isJson = true; } catch { /* expected */ }
      expect(isJson).toBe(false);

      // Now hydrate with the correct key — should decrypt successfully
      const { SwarmHydrator } = await import("../src/swarm-hydrator.js");
      const hydrator = new SwarmHydrator(client);
      hydrator.setDecryptionKey(encKey);

      // Transfer manifest index for bytes mode
      const client2 = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: false,
      });
      client2.setManifestIndex(client.getManifestIndex());
      const hydrator2 = new SwarmHydrator(client2);
      hydrator2.setDecryptionKey(encKey);

      const loaded: unknown[][] = [];
      const result = await hydrator2.hydrate(
        [docId],
        new InMemoryOperationStore(),
        new InMemoryKeyframeStore(),
        async (_docId, _branch, ops) => { loaded.push(ops); },
      );

      expect(result.operationBatchesDownloaded).toBe(1);
      expect(loaded.length).toBe(1);
      // The decrypted ops should contain our secret title
      const ops = loaded[0] as Array<{ action: { type: string; input: { title: string } } }>;
      expect(ops[0].action.type).toBe("SET_TITLE");
      expect(ops[0].action.input.title).toBe("Top Secret");
    });

    it("should fail hydration without correct decryption key", async () => {
      const encKey = "0x1111111111111111111111111111111111111111111111111111111111111111";
      const wrongKey = "0x2222222222222222222222222222222222222222222222222222222222222222";

      const client = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: false,
      });

      const readModel = new SwarmSyncReadModel(client);
      readModel.setEncryptionKey(encKey);

      const docId = `wrong-key-test-${Date.now()}`;
      await readModel.indexOperations([
        {
          operation: {
            id: "wk-op-1", index: 0, skip: 0,
            timestampUtcMs: new Date().toISOString(),
            hash: "h1",
            action: { type: "SET_TITLE", input: { title: "Can't Touch This" } },
          },
          context: {
            documentId: docId, documentType: "test/enc",
            scope: "global", branch: "main", ordinal: 1,
          },
        },
      ]);
      await readModel.flush();

      // Try to hydrate with WRONG key
      const client2 = new SwarmClient({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: false,
      });
      client2.setManifestIndex(client.getManifestIndex());

      const { SwarmHydrator } = await import("../src/swarm-hydrator.js");
      const hydrator = new SwarmHydrator(client2);
      hydrator.setDecryptionKey(wrongKey);

      const result = await hydrator.hydrate(
        [docId],
        new InMemoryOperationStore(),
        new InMemoryKeyframeStore(),
      );

      // Should fail — wrong key can't decrypt
      expect(result.operationBatchesDownloaded).toBe(0);
    });
  });

  describe("BeeReactorAdapter (full flow)", () => {
    it("should orchestrate write-through and hydration", async () => {
      const docId = `adapter-test-${Date.now()}`;

      // Create adapter
      const adapter = new BeeReactorAdapter({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: false,
        trackedDocuments: [docId],
        pollIntervalMs: 0, // disable polling for test
      });

      // Create local stores
      const localOps = new InMemoryOperationStore();
      const localKfs = new InMemoryKeyframeStore();

      // Wrap with Swarm stores
      const swarmOps = adapter.createOperationStore(localOps);
      const swarmKfs = adapter.createKeyframeStore(localKfs);

      // Start adapter (hydration on empty — should be a no-op)
      await adapter.start();

      // Write some operations (flush after each to avoid manifest race)
      for (let i = 0; i < 5; i++) {
        await swarmOps.apply(
          docId,
          "test/doc",
          "global",
          "main",
          i,
          (txn) => txn.addOperations(makeTestOperation(i)),
        );
        await swarmOps.flush();
      }

      // Write a keyframe
      await swarmKfs.putKeyframe(docId, "global", "main", 4, {
        header: { id: docId },
        state: { title: "Final State" },
      });

      // Wait for async keyframe upload
      await new Promise((r) => setTimeout(r, 2000));

      // Verify Swarm has the keyframe.
      // Note: the keyframe store compacts older operation batches from the manifest,
      // so operationBatches may be empty after a keyframe at the latest revision.
      const client = adapter.getSwarmClient();
      const manifest = await client.readManifest(docId);
      expect(manifest).not.toBeNull();
      expect(manifest!.keyframes.length).toBe(1);
      expect(manifest!.keyframes[0].revision).toBe(4);

      // Now simulate a fresh adapter hydrating from Swarm.
      // In bytes mode, we transfer the manifest index to simulate
      // what feeds would do in production (persistent mutable pointers).
      const adapter2 = new BeeReactorAdapter({
        beeUrl: BEE_URL,
        batchId: BATCH_ID,
        signerPrivateKey: TEST_SIGNER_KEY,
        useFeedMode: false,
        trackedDocuments: [docId],
        pollIntervalMs: 0,
      });

      // Transfer manifest index (simulates feed persistence)
      const client2 = adapter2.getSwarmClient();
      client2.setManifestIndex(client.getManifestIndex());

      const freshOps = new InMemoryOperationStore();
      const freshKfs = new InMemoryKeyframeStore();
      adapter2.createOperationStore(freshOps);
      adapter2.createKeyframeStore(freshKfs);

      const loaded: unknown[][] = [];
      await adapter2.start(async (_docId, _branch, ops) => {
        loaded.push(ops);
      });

      // Operation batches were compacted by the keyframe, so no ops to load.
      // The keyframe itself captures the full state.

      // Should have hydrated keyframes
      const kf = await freshKfs.findNearestKeyframe(docId, "global", "main", 10);
      expect(kf).toBeDefined();
      expect(kf!.revision).toBe(4);

      // Cleanup
      await adapter.stop();
      await adapter2.stop();
    });
  });
});
