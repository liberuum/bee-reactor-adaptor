#!/usr/bin/env npx tsx
/**
 * End-to-end adapter flow test with full Swarm inspection.
 *
 * Runs the complete write-through + hydration cycle and prints
 * every Swarm reference so you can verify the data directly:
 *
 *   npx tsx scripts/test-adapter-flow.ts
 *
 * Then inspect any reference with:
 *   ./scripts/bee-inspect.sh <reference>
 *
 * Requires: bee dev running on localhost:1633
 */

import { SwarmClient } from "../src/swarm-client.js";
import { SwarmOperationStore } from "../src/swarm-operation-store.js";
import { SwarmKeyframeStore } from "../src/swarm-keyframe-store.js";
import { SwarmHydrator } from "../src/swarm-hydrator.js";
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

const BEE_URL = process.env.BEE_URL ?? "http://localhost:1633";

// ─── Helpers ─────────────────────────────────────────────────────

class InMemoryOperationStore implements IOperationStore {
  private operations: Map<string, Operation[]> = new Map();
  private allOps: OperationWithContext[] = [];
  private nextId = 1;
  private key(d: string, s: string, b: string) { return `${d}:${s}:${b}`; }

  async apply(documentId: string, documentType: string, scope: string, branch: string, revision: number, fn: (txn: AtomicTxn) => void | Promise<void>): Promise<void> {
    const staged: Operation[] = [];
    await fn({ addOperations: (...ops) => staged.push(...ops) });
    const k = this.key(documentId, scope, branch);
    const existing = this.operations.get(k) ?? [];
    existing.push(...staged);
    this.operations.set(k, existing);
    for (const op of staged) {
      this.allOps.push({ operation: op, context: { documentId, documentType, scope, branch, ordinal: this.nextId++ } });
    }
  }

  async getSince(documentId: string, scope: string, branch: string, revision: number, _f?: OperationFilter, _p?: PagingOptions): Promise<PagedResults<Operation>> {
    const ops = this.operations.get(this.key(documentId, scope, branch)) ?? [];
    return { results: ops.filter(o => o.index > revision) };
  }

  async getSinceId(id: number, _p?: PagingOptions): Promise<PagedResults<OperationWithContext>> {
    return { results: this.allOps.filter(o => o.context.ordinal > id) };
  }

  async getConflicting(): Promise<PagedResults<Operation>> { return { results: [] }; }

  async getRevisions(documentId: string): Promise<DocumentRevisions> {
    const revision: Record<string, number> = {};
    let latestTimestamp = "";
    for (const [key, ops] of this.operations.entries()) {
      if (!key.startsWith(documentId + ":")) continue;
      const scope = key.split(":")[1];
      const maxIdx = Math.max(...ops.map(o => o.index), -1);
      if (maxIdx >= 0) revision[scope] = maxIdx;
      for (const op of ops) {
        if (op.timestampUtcMs > latestTimestamp) latestTimestamp = op.timestampUtcMs;
      }
    }
    return { revision, latestTimestamp };
  }

  getAll(d: string, s: string, b: string): Operation[] {
    return this.operations.get(this.key(d, s, b)) ?? [];
  }
}

class InMemoryKeyframeStore implements IKeyframeStore {
  private kfs: Map<string, { revision: number; document: PHDocument }[]> = new Map();
  private key(d: string, s: string, b: string) { return `${d}:${s}:${b}`; }

  async putKeyframe(d: string, s: string, b: string, r: number, doc: PHDocument): Promise<void> {
    const k = this.key(d, s, b);
    const existing = this.kfs.get(k) ?? [];
    existing.push({ revision: r, document: doc });
    this.kfs.set(k, existing);
  }

  async findNearestKeyframe(d: string, s: string, b: string, target: number) {
    const kfs = this.kfs.get(this.key(d, s, b)) ?? [];
    const eligible = kfs.filter(kf => kf.revision <= target);
    return eligible.length ? eligible.reduce((a, c) => a.revision > c.revision ? a : c) : undefined;
  }

  async listKeyframes(d: string, s?: string, b?: string) {
    const results: Array<{ scope: string; branch: string; revision: number; document: PHDocument }> = [];
    for (const [key, kfs] of this.kfs.entries()) {
      const [docId, sc, br] = key.split(":");
      if (docId !== d) continue;
      if (s && sc !== s) continue;
      if (b && br !== b) continue;
      for (const kf of kfs) results.push({ scope: sc, branch: br, ...kf });
    }
    return results;
  }

  async deleteKeyframes() { return 0; }
}

function makeOp(index: number): Operation {
  return {
    id: `op-${index}`,
    index,
    skip: 0,
    timestampUtcMs: new Date().toISOString(),
    hash: `hash-${index}`,
    action: { type: "SET_TITLE", input: { title: `Document v${index + 1}` } },
  };
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   Bee Reactor Adapter — Full Flow Test          ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log();

  // 1. Check bee health
  console.log("--- Step 1: Check Bee node ---");
  let batchId: string;
  try {
    const health = await fetch(`${BEE_URL}/health`).then(r => r.json());
    console.log(`  Bee ${health.version} — ${health.status}`);
  } catch {
    console.error(`  FAIL: Cannot reach Bee at ${BEE_URL}`);
    console.error(`  Start with: bee dev`);
    process.exit(1);
  }

  // Get or create stamp
  const stamps = await fetch(`${BEE_URL}/stamps`).then(r => r.json()) as { stamps: Array<{ batchID: string }> };
  if (stamps.stamps.length > 0) {
    batchId = stamps.stamps[0].batchID;
    console.log(`  Using stamp: ${batchId.slice(0, 16)}...`);
  } else {
    console.log("  No stamps found, creating one...");
    const res = await fetch(`${BEE_URL}/stamps/10000000/24`, { method: "POST" }).then(r => r.json()) as { batchID: string };
    batchId = res.batchID;
    console.log(`  Created stamp: ${batchId.slice(0, 16)}...`);
  }
  console.log();

  // 2. Create adapter components
  const signerKey = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
  const client = new SwarmClient({ beeUrl: BEE_URL, batchId, signerPrivateKey: signerKey, useFeedMode: false });
  const localOps = new InMemoryOperationStore();
  const localKfs = new InMemoryKeyframeStore();
  const swarmOps = new SwarmOperationStore(client, localOps);
  const swarmKfs = new SwarmKeyframeStore(client, localKfs);

  const docId = `test-doc-${Date.now()}`;
  const docType = "powerhouse/test-document";

  // 3. Write operations
  console.log("--- Step 2: Write 5 operations ---");
  const swarmRefs: string[] = [];

  for (let i = 0; i < 5; i++) {
    const op = makeOp(i);
    await swarmOps.apply(docId, docType, "global", "main", i, (txn) => txn.addOperations(op));
    await swarmOps.flush(); // Wait for Swarm upload to complete

    const manifest = await client.readManifest(docId);
    if (manifest && manifest.operationBatches.length > swarmRefs.length) {
      const latest = manifest.operationBatches[manifest.operationBatches.length - 1];
      swarmRefs.push(latest.reference);
      console.log(`  Op ${i}: index=${op.index} action=${(op.action as { type: string }).type}`);
      console.log(`         Swarm ref: ${latest.reference}`);
    }
  }
  console.log();

  // 4. Write a keyframe
  console.log("--- Step 3: Write keyframe at revision 4 ---");
  const kfDoc: PHDocument = {
    header: { id: docId, documentType: docType, slug: "test-doc" },
    state: {
      global: { title: "Document v5", body: "Full state snapshot" },
      local: {},
    },
  };
  await swarmKfs.putKeyframe(docId, "global", "main", 4, kfDoc);
  await new Promise(r => setTimeout(r, 1500)); // wait for async upload

  const manifestAfterKf = await client.readManifest(docId);
  if (manifestAfterKf && manifestAfterKf.keyframes.length > 0) {
    const kfRef = manifestAfterKf.keyframes[0].reference;
    console.log(`  Keyframe ref: ${kfRef}`);
    console.log(`  Manifest compacted: ${manifestAfterKf.operationBatches.length} op batches remaining`);
  }
  console.log();

  // 5. Show final manifest
  console.log("--- Step 4: Final manifest on Swarm ---");
  const finalManifest = await client.readManifest(docId);
  console.log(JSON.stringify(finalManifest, null, 2));
  console.log();

  // 6. Verify each reference directly
  console.log("--- Step 5: Verify Swarm references ---");
  for (const ref of swarmRefs) {
    try {
      const data = await client.downloadData(ref);
      const ops = JSON.parse(new TextDecoder().decode(data));
      const summary = ops.map((o: Operation) => `op-${o.index}:${(o.action as { type: string }).type}`).join(", ");
      console.log(`  ${ref.slice(0, 16)}... => [${summary}]`);
    } catch (err) {
      console.log(`  ${ref.slice(0, 16)}... => DOWNLOAD FAILED (may have been compacted)`);
    }
  }

  if (finalManifest?.keyframes[0]) {
    const kfData = await client.downloadData(finalManifest.keyframes[0].reference);
    const kf = JSON.parse(new TextDecoder().decode(kfData));
    console.log(`  ${finalManifest.keyframes[0].reference.slice(0, 16)}... => keyframe@${kf.revision} (${JSON.stringify(kf.document.state?.global?.title ?? "?")})`);
  }
  console.log();

  // 7. Hydrate a fresh store
  console.log("--- Step 6: Hydrate fresh store from Swarm ---");
  const freshOps = new InMemoryOperationStore();
  const freshKfs = new InMemoryKeyframeStore();
  const hydrator = new SwarmHydrator(client);

  const loaded: Array<{ branch: string; count: number }> = [];
  const result = await hydrator.hydrate(
    [docId],
    freshOps,
    freshKfs,
    async (_docId, branch, ops) => {
      loaded.push({ branch, count: (ops as unknown[]).length });
    },
  );

  console.log(`  Documents hydrated: ${result.documentsHydrated}`);
  console.log(`  Op batches downloaded: ${result.operationBatchesDownloaded}`);
  console.log(`  Keyframes downloaded: ${result.keyframesDownloaded}`);
  console.log(`  Errors: ${result.errors.length}`);
  if (loaded.length > 0) {
    for (const l of loaded) {
      console.log(`  Loaded ${l.count} ops on branch "${l.branch}"`);
    }
  }

  const hydratedKf = await freshKfs.findNearestKeyframe(docId, "global", "main", 100);
  if (hydratedKf) {
    console.log(`  Hydrated keyframe: revision ${hydratedKf.revision}`);
    console.log(`  State: ${JSON.stringify((hydratedKf.document as Record<string, unknown>).state)}`);
  }
  console.log();

  // 8. Print inspection commands
  console.log("--- Inspect commands ---");
  console.log("Run these to verify data directly on Swarm:");
  console.log();
  for (const ref of swarmRefs) {
    console.log(`  ./scripts/bee-inspect.sh ${ref}`);
  }
  if (finalManifest?.keyframes[0]) {
    console.log(`  ./scripts/bee-inspect.sh ${finalManifest.keyframes[0].reference}`);
  }
  console.log();

  console.log("DONE");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
