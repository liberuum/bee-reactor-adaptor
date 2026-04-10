import { decrypt, isEncrypted } from "../src/swarm-crypto.js";
import { Bee } from "@ethersphere/bee-js";

const ref = process.argv[2];
const key = process.argv[3] ?? "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const beeUrl = process.env.BEE_URL ?? "http://localhost:1633";

if (!ref) { console.log("Usage: npx tsx scripts/decrypt-ref.ts <reference> [key]"); process.exit(1); }

async function main() {
  const bee = new Bee(beeUrl);
  const data = await bee.downloadData(ref);
  const bytes = data.toUint8Array();
  console.log(`Size: ${bytes.length} bytes`);
  console.log(`Encrypted: ${isEncrypted(bytes)}`);

  if (!isEncrypted(bytes)) {
    try { console.log("Content:", JSON.parse(new TextDecoder().decode(bytes))); } catch { console.log("Raw:", new TextDecoder().decode(bytes).slice(0, 200)); }
    return;
  }

  const decrypted = await decrypt(bytes, key);
  const text = new TextDecoder().decode(decrypted);
  const parsed = JSON.parse(text);
  console.log("\n=== DECRYPTED ===");
  console.log(`Operations: ${parsed.length}`);
  for (const op of parsed) {
    console.log(`  [${op.index}] ${op.action?.type} (${op._context?.documentType})`);
  }
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
