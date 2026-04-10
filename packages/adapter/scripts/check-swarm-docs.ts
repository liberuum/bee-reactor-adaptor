import { SwarmClient } from "../src/swarm-client.js";

const BEE_URL = process.env.BEE_URL ?? "http://localhost:1633";
const BATCH_ID = "0d72c15d3218864d011038ba8ae53a7fc1ef545577359d6ac7d9179e106c553a";
const SIGNER = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

const client = new SwarmClient({
  beeUrl: BEE_URL,
  batchId: BATCH_ID,
  signerPrivateKey: SIGNER,
  useFeedMode: false,
});

const docIds = process.argv.slice(2);
if (docIds.length === 0) {
  console.log("Usage: npx tsx scripts/check-swarm-docs.ts <docId1> [docId2] ...");
  console.log("");
  console.log("Note: In bytes mode (bee dev), the manifest index is per-process.");
  console.log("The switchboard process has its own index. This script can only");
  console.log("check documents whose Swarm references you already know.");
  console.log("");
  console.log("To check all docs, use the Switchboard GraphQL API to list documents,");
  console.log("then look up their Swarm refs.");
  process.exit(0);
}

for (const docId of docIds) {
  console.log(`\n=== Document: ${docId} ===`);
  const manifest = await client.readManifest(docId);
  if (!manifest) {
    console.log("  Not found in local manifest index.");
    console.log("  (In bytes mode, each process has its own index.)");
    continue;
  }
  console.log(JSON.stringify(manifest, null, 2));

  for (const batch of manifest.operationBatches) {
    console.log(`\n  --- Op batch: ${batch.reference.slice(0, 20)}... ---`);
    const data = await client.downloadData(batch.reference);
    const ops = JSON.parse(new TextDecoder().decode(data));
    for (const op of ops) {
      console.log(`    [${op.index}] ${(op.action as any)?.type ?? "unknown"}`);
    }
  }

  for (const kf of manifest.keyframes) {
    console.log(`\n  --- Keyframe: ${kf.reference.slice(0, 20)}... @rev${kf.revision} ---`);
    const data = await client.downloadData(kf.reference);
    const parsed = JSON.parse(new TextDecoder().decode(data));
    console.log(`    Document type: ${parsed.documentType ?? parsed.document?.header?.documentType ?? "?"}`);
    console.log(`    State keys: ${Object.keys(parsed.document?.state ?? parsed.state ?? {}).join(", ")}`);
  }
}
