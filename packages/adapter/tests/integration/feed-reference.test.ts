/**
 * Investigation: uploadReference vs uploadPayload for feed writes.
 *
 * Our adapter currently uses uploadPayload (writes the hex reference string
 * as raw UTF-8 bytes into the SOC). The more efficient uploadReference
 * writes a native 32-byte Reference + 8-byte timestamp — but a previous
 * attempt broke because the read side got 40 bytes instead of the expected
 * 64-char hex string.
 *
 * This test suite investigates both approaches side by side to find the
 * correct read/write pairing.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Bee, Topic, Reference } from "@ethersphere/bee-js";

import { BEE_URL, TEST_SIGNER_KEY, preflight } from "../helpers.js";

let BATCH_ID = "";
let bee: Bee;

beforeAll(async () => {
  const check = await preflight();
  BATCH_ID = check.batchId;
  bee = new Bee(BEE_URL, { signer: TEST_SIGNER_KEY });
});

describe("Feed: uploadPayload vs uploadReference", () => {
  it("CURRENT: uploadPayload writes text, downloadPayload reads text", async () => {
    // This is what our adapter does now — write hex string as UTF-8
    const topic = Topic.fromString(`test:payload:${Date.now()}`);
    const writer = bee.makeFeedWriter(topic);
    const reader = bee.makeFeedReader(topic, bee.signer!.publicKey().address());

    // Upload some data to /bytes first to get a reference
    const uploadResult = await bee.uploadData(BATCH_ID, "hello world");
    const refHex = uploadResult.reference.toHex();
    console.log(`  /bytes reference: ${refHex} (${refHex.length} chars)`);

    // Write the hex string as payload
    const payloadBytes = new TextEncoder().encode(refHex);
    console.log(`  uploadPayload: ${payloadBytes.length} bytes (UTF-8 encoded hex string)`);
    await writer.uploadPayload(BATCH_ID, payloadBytes);

    // Read back
    const result = await reader.downloadPayload();
    const readBack = new TextDecoder().decode(result.payload.toUint8Array()).trim();
    console.log(`  downloadPayload: "${readBack}" (${readBack.length} chars)`);

    expect(readBack).toBe(refHex);
    expect(readBack.length).toBe(64);
  });

  it("OPTIMIZED: uploadReference writes native ref, downloadReference reads it", async () => {
    const topic = Topic.fromString(`test:reference:${Date.now()}`);
    const writer = bee.makeFeedWriter(topic);
    const reader = bee.makeFeedReader(topic, bee.signer!.publicKey().address());

    // Upload some data to /bytes
    const uploadResult = await bee.uploadData(BATCH_ID, "hello world optimized");
    const ref = uploadResult.reference;
    console.log(`  /bytes reference: ${ref.toHex()} (${ref.toHex().length} chars)`);

    // Write the native Reference (32 bytes, not 64-char hex)
    await writer.uploadReference(BATCH_ID, ref);

    // Read back with downloadReference (strips 8-byte timestamp, returns Reference)
    const result = await reader.downloadReference();
    const readRef = result.reference;
    console.log(`  downloadReference: ${readRef.toHex()} (${readRef.toHex().length} chars)`);

    expect(readRef.toHex()).toBe(ref.toHex());

    // Verify we can download the actual data using this reference
    const data = await bee.downloadData(readRef);
    expect(new TextDecoder().decode(data.toUint8Array())).toBe("hello world optimized");
  });

  it("INVESTIGATION: what happens if we downloadPayload after uploadReference?", async () => {
    const topic = Topic.fromString(`test:mismatch:${Date.now()}`);
    const writer = bee.makeFeedWriter(topic);
    const reader = bee.makeFeedReader(topic, bee.signer!.publicKey().address());

    const uploadResult = await bee.uploadData(BATCH_ID, "mismatch test");
    const ref = uploadResult.reference;

    // Write with uploadReference (binary: 8-byte timestamp + 32-byte ref)
    await writer.uploadReference(BATCH_ID, ref);

    // Read with downloadPayload (raw bytes, no timestamp stripping)
    const result = await reader.downloadPayload();
    const rawBytes = result.payload.toUint8Array();
    console.log(`  downloadPayload after uploadReference: ${rawBytes.length} bytes`);
    console.log(`  First 8 bytes (timestamp): ${Array.from(rawBytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    console.log(`  Remaining ${rawBytes.length - 8} bytes (reference): ${Array.from(rawBytes.slice(8)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

    // This is what broke before — trying to read binary as hex text
    const asText = new TextDecoder().decode(rawBytes).trim();
    console.log(`  As text: "${asText}" (${asText.length} chars) — THIS IS GARBAGE`);

    // The correct way: use downloadReference which handles the format
    const correctResult = await reader.downloadReference();
    console.log(`  downloadReference: ${correctResult.reference.toHex()} — THIS IS CORRECT`);
    expect(correctResult.reference.toHex()).toBe(ref.toHex());
  });

  it("INVESTIGATION: what happens if we downloadReference after uploadPayload?", async () => {
    const topic = Topic.fromString(`test:reverse-mismatch:${Date.now()}`);
    const writer = bee.makeFeedWriter(topic);
    const reader = bee.makeFeedReader(topic, bee.signer!.publicKey().address());

    const uploadResult = await bee.uploadData(BATCH_ID, "reverse test");
    const refHex = uploadResult.reference.toHex();

    // Write with uploadPayload (UTF-8 text of hex reference)
    await writer.uploadPayload(BATCH_ID, new TextEncoder().encode(refHex));

    // Try to read with downloadReference — this will misinterpret the UTF-8 text as binary
    try {
      const result = await reader.downloadReference();
      console.log(`  downloadReference after uploadPayload: ${result.reference.toHex()}`);
      console.log(`  WARNING: This reference is probably wrong (UTF-8 bytes misinterpreted as Reference)`);

      // Verify: can we download with this reference?
      try {
        await bee.downloadData(result.reference);
        console.log(`  Somehow it worked (coincidence)!`);
      } catch (err) {
        console.log(`  Download failed (expected) — the reference is garbage`);
      }
    } catch (err) {
      console.log(`  downloadReference failed: ${err instanceof Error ? err.message : err}`);
    }
  });

  it("SIZE COMPARISON: payload vs reference SOC size", async () => {
    const topicPayload = Topic.fromString(`test:size-payload:${Date.now()}`);
    const topicRef = Topic.fromString(`test:size-ref:${Date.now()}`);
    const writerPayload = bee.makeFeedWriter(topicPayload);
    const writerRef = bee.makeFeedWriter(topicRef);

    const uploadResult = await bee.uploadData(BATCH_ID, "size comparison test");
    const ref = uploadResult.reference;
    const refHex = ref.toHex();

    // Payload approach: 64 bytes of UTF-8 text
    await writerPayload.uploadPayload(BATCH_ID, new TextEncoder().encode(refHex));

    // Reference approach: 8-byte timestamp + 32-byte reference = 40 bytes
    await writerRef.uploadReference(BATCH_ID, ref);

    const readerPayload = bee.makeFeedReader(topicPayload, bee.signer!.publicKey().address());
    const readerRef = bee.makeFeedReader(topicRef, bee.signer!.publicKey().address());

    const payloadResult = await readerPayload.downloadPayload();
    const refResult = await readerRef.downloadPayload();

    const payloadSize = payloadResult.payload.toUint8Array().length;
    const refSize = refResult.payload.toUint8Array().length;

    console.log(`  uploadPayload SOC data: ${payloadSize} bytes (64-char hex as UTF-8)`);
    console.log(`  uploadReference SOC data: ${refSize} bytes (8-byte timestamp + 32-byte ref)`);
    console.log(`  Savings: ${payloadSize - refSize} bytes per feed write (${Math.round((1 - refSize / payloadSize) * 100)}% smaller)`);

    expect(payloadSize).toBe(64);
    // uploadReference stores 8-byte timestamp + 32-byte ref in the SOC,
    // but downloadPayload may strip or include the timestamp depending
    // on the wrapped-chunk format. Either way, it's smaller than 64.
    expect(refSize).toBeLessThan(payloadSize);
  });
});
