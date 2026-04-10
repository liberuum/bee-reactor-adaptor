import { Bee, PrivateKey } from "@ethersphere/bee-js";

async function main() {
  const signer = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
  const bee = new Bee("http://localhost:1633", { signer });
  const stamps = await bee.getAllPostageBatch();
  const batchId = stamps[0].batchID;

  console.log("=== Upload with ACT ===");
  const result = await bee.uploadData(batchId, '{"test":"act-direct"}', { act: true });
  console.log("ref:", result.reference.toHex());

  const historyAddr = (result.historyAddress as any)?.value;
  console.log("history raw:", result.historyAddress);
  console.log("history .value:", historyAddr);
  console.log("history .value?.toHex():", historyAddr?.toHex?.());

  const pk = new PrivateKey(signer);
  const pubKey = pk.publicKey().toCompressedHex();
  console.log("pubkey:", pubKey);

  console.log("\n=== Download with ACT ===");
  try {
    const data = await bee.downloadData(result.reference, {
      actPublisher: pubKey,
      actHistoryAddress: historyAddr,
    });
    console.log("SUCCESS:", new TextDecoder().decode(data.toUint8Array()));
  } catch (e: any) {
    console.log("ERROR:", e.message);
    console.log("status:", e.status);
    console.log("body:", e.responseBody);
  }
}

main().catch(console.error);
