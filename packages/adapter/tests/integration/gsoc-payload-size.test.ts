/**
 * Empirical: how big a JSON payload can a GSOC message carry?
 *
 * The swarm-protocol-reference.md says GSOC is a SOC (chunk) — 4KB max
 * after bee-js framing. The practical send/receive limit depends on
 * bee-js's own encoding overhead and whether the Bee node accepts larger
 * messages.
 *
 * We sweep payload sizes and record (accepted, rejected, received).
 * Finding the ceiling tells us how many ops we can embed directly in a
 * ping before we must fall back to the /bzz-ref path.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Bee } from "@ethersphere/bee-js";
import { GsocNotifier } from "../../src/chat/gsoc-notifier.js";
import type { GsocNotification } from "../../src/chat/types.js";

const BEE_URL_A = process.env.BEE_URL_A || process.env.BEE_URL || "https://dappnode-tailscale.tailcbc470.ts.net:1633";

async function usableBatch(url: string): Promise<string | null> {
  const bee = new Bee(url);
  const stamps = await bee.getAllPostageBatch();
  return stamps.find((s) => s.usable)?.batchID.toHex() ?? null;
}

describe("GSOC payload size sweep", () => {
  let beeA: Bee;
  let batchIdA: string;
  let overlayA: string;
  let senderAddr: string;

  beforeAll(async () => {
    beeA = new Bee(BEE_URL_A);
    const health = await beeA.getHealth().catch(() => null);
    if (health?.status !== "ok") throw new Error(`Node A unreachable at ${BEE_URL_A}`);
    const b = await usableBatch(BEE_URL_A);
    if (!b) throw new Error(`No usable stamp on Node A`);
    batchIdA = b;
    const addrInfo = await fetch(`${BEE_URL_A}/addresses`).then((r) =>
      r.json() as Promise<{ overlay: string; ethereum: string }>,
    );
    overlayA = addrInfo.overlay;
    senderAddr = (addrInfo.ethereum ?? "0x0").toLowerCase();
    console.log(`Node A: ${BEE_URL_A} overlay=${overlayA.slice(0, 12)}…`);
  });

  // The test payloads vary a single `data.filler` string. All other
  // fields (type, from, timestamp) are fixed. We target the sender's
  // own overlay so the round-trip stays on a single Bee.
  const sizes = [
    512,
    1024,
    2048,
    3072,
    3584,
    3840,
    3968,
    4032,
    4064,
    4096,
    8192,
  ];

  for (const size of sizes) {
    it(`payload size ${size}B: send + self-receive`, async () => {
      const gsoc = new GsocNotifier(beeA, batchIdA, senderAddr);
      const collabId = `drive:size-${size}-${Date.now()}`;
      const identifierRaw = `ph:v2:collab-notify:${senderAddr}:${collabId}`;
      const { signerHex, listenAddress, identifierHex } =
        gsoc.mineSignerWithIdentifier(overlayA, identifierRaw, 12);

      const received: GsocNotification[] = [];
      const sub = gsoc.subscribeWithIdentifier(
        `${collabId}:self`,
        listenAddress,
        identifierHex,
        {
          onNotification: (n) => { received.push(n); },
          onError: () => {},
        },
      );
      await new Promise((r) => setTimeout(r, 2_000));

      // Build a payload whose JSON.stringify serializes to about `size`
      // bytes. We tune the filler length based on the rest of the
      // serialized notification.
      const base = {
        collabId,
        writerAddress: senderAddr,
        filler: "",
      };
      const serializedBase = JSON.stringify(base).length
        + JSON.stringify({
            type: "doc-updated",
            from: senderAddr,
            timestamp: new Date().toISOString(),
            data: {},
          }).length;
      const fillerLen = Math.max(0, size - serializedBase);
      base.filler = "x".repeat(fillerLen);

      let sendErr: Error | null = null;
      try {
        await gsoc.sendWithSigner(signerHex, identifierHex, "doc-updated", base);
      } catch (e) {
        sendErr = e instanceof Error ? e : new Error(String(e));
      }

      // Wait up to 10s for self-receive if send succeeded.
      if (!sendErr) {
        const deadline = Date.now() + 10_000;
        while (received.length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      sub.cancel();

      const result = {
        size,
        sendAccepted: !sendErr,
        sendErr: sendErr?.message?.slice(0, 120) ?? null,
        received: received.length > 0,
      };
      console.log(
        `size=${size.toString().padStart(5)}B  send=${result.sendAccepted ? "OK " : "FAIL"}  recv=${result.received ? "OK " : "NO"}${result.sendErr ? "  err=" + result.sendErr : ""}`,
      );
      // No hard assertion — this is a probe. Just don't throw.
      expect(typeof result.sendAccepted).toBe("boolean");
    }, 30_000);
  }
});
