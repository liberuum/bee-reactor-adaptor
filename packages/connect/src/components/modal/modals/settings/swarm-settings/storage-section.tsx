import React, { useCallback, useEffect, useState } from "react";
import type { SwarmUiSnapshot, StampOptions, BucketUtilization } from "./types.js";
import {
  ActionButton,
  AlertBanner,
  Row,
  Section,
  StatusDot,
  UtilBar,
  healthColor,
} from "./primitives.js";
import { SIZE_OPTIONS, DURATION_OPTIONS, formatBytes } from "./constants.js";
import { toast } from "../../../../../services/toast.js";

type StampStatus = NonNullable<SwarmUiSnapshot["stampStatus"]>;

/**
 * Pull the real error out of a bee-js / axios failure.
 * bee-js wraps axios, so the Bee node's response body usually lives at
 * `err.response.data` (often with `{ code, message, reason }`) or in the
 * axios error's `message` as "Request failed with status code 500".
 */
function extractBeeError(err: unknown): { message: string; hint?: string } {
  const anyErr = err as any;
  // bee-js BeeResponseError exposes status/responseBody directly on the
  // error instance. Axios-style errors nest under response.{status,data}.
  const status = anyErr?.status ?? anyErr?.response?.status;
  const body = anyErr?.responseBody ?? anyErr?.response?.data;
  const bodyMessage =
    (typeof body === "string" && body) ||
    body?.message ||
    body?.reason ||
    body?.error ||
    (anyErr instanceof Error ? anyErr.message : undefined) ||
    String(err);

  const lower = String(bodyMessage).toLowerCase();

  let hint: string | undefined;
  if (status === 500 || lower.includes("500")) {
    if (lower.includes("insufficient") && lower.includes("bzz")) {
      hint = "Bee node wallet has insufficient xBZZ — fund it and retry.";
    } else if (lower.includes("insufficient") && lower.includes("dai")) {
      hint = "Bee node wallet has insufficient xDAI for gas — fund it and retry.";
    } else if (lower.includes("nonce") || lower.includes("pending")) {
      hint = "A previous stamp transaction is still confirming on Gnosis Chain. Wait ~1 min and retry.";
    } else if (lower.includes("price") || lower.includes("amount is less")) {
      hint = "The network price changed since you picked a duration. Reselect the duration to get a fresh quote.";
    } else if (lower.includes("chain") || lower.includes("rpc") || lower.includes("dial")) {
      hint = "Bee can't reach its Gnosis Chain RPC right now. Check Bee logs and retry.";
    } else if (lower.includes("cannot topup batch") || lower.includes("cannot create batch") || lower.includes("cannot dilute")) {
      // Outer Bee wrapper; real cause is behind DEBUG verbosity. Most common
      // source in practice is the Gnosis RPC timing out (public endpoints like
      // publicnode.com throttle under load).
      hint = "The Gnosis Chain RPC your Bee node uses is slow or timing out. " +
        "Enable `verbosity: debug` in Bee to see the underlying error, or switch " +
        "`blockchain-rpc-endpoint` to a more reliable provider " +
        "(e.g. https://rpc.gnosischain.com, https://rpc.ankr.com/gnosis) and restart Bee.";
    } else {
      hint = "Bee returned 500. Enable `verbosity: debug` in Bee and check `docker logs bee --tail 200` for the underlying error.";
    }
  }

  return {
    message: bodyMessage,
    hint,
  };
}

export function StorageSection({
  stamp,
  client,
  isDevMode,
  ready,
  stampOptions,
  totalBytesUploaded,
  showStatus,
  getBucketUtilization,
  nodeBalanceBzz,
  reconnect,
  refreshStamp,
}: {
  stamp: StampStatus;
  client: SwarmUiSnapshot["client"];
  isDevMode?: boolean;
  ready: boolean;
  stampOptions: StampOptions | null;
  totalBytesUploaded?: number;
  showStatus: (ok: boolean, msg: string) => void;
  getBucketUtilization?: SwarmUiSnapshot["getBucketUtilization"];
  nodeBalanceBzz?: string;
  reconnect?: () => Promise<void>;
  refreshStamp?: () => Promise<void>;
}) {
  const [bucketData, setBucketData] = useState<BucketUtilization | null>(null);
  const [topUpBusy, setTopUpBusy] = useState(false);
  const [topUpStep, setTopUpStep] = useState<string | null>(null);
  const [expandBusy, setExpandBusy] = useState(false);
  const [expandStep, setExpandStep] = useState<string | null>(null);
  const [selectedDuration, setSelectedDuration] = useState<{
    days: number;
    amount: string;
  } | null>(null);
  const [selectedSize, setSelectedSize] = useState<number | null>(null);

  const usedBytes =
    stamp.usedBytes ?? Math.round(stamp.capacityBytes * (stamp.utilization / 100));

  // Cost estimation for top-up: amount * 2^depth / 10^16
  const topUpCostBzz =
    selectedDuration && stamp.depth != null
      ? Number(BigInt(selectedDuration.amount) * BigInt(2 ** stamp.depth)) / 1e16
      : null;
  const walletBzz = nodeBalanceBzz ? Number(BigInt(nodeBalanceBzz)) / 1e16 : null;
  const canAffordTopUp =
    topUpCostBzz != null && walletBzz != null ? walletBzz >= topUpCostBzz : null;

  // For expand: new depth doubles capacity, halves TTL. No xBZZ cost, just a dilute tx (gas only).
  const expandNewCapacity = selectedSize
    ? SIZE_OPTIONS.find((s) => s.depth === selectedSize)?.label ?? `depth ${selectedSize}`
    : null;

  const handleTopUp = async () => {
    if (!client || !selectedDuration) return;
    setTopUpBusy(true);
    try {
      // Re-fetch the live chain price right before submitting so we never send
      // a stale amount. Chain price changes slowly, but in a long-open Settings
      // panel the cached `stampOptions.pricePerBlock` can drift.
      let amount = selectedDuration.amount;
      try {
        setTopUpStep("Checking current network price...");
        const beeUrl = (window as any).ph?.swarm?.beeUrl;
        if (beeUrl) {
          const res = await fetch(`${beeUrl}/chainstate`);
          if (res.ok) {
            const chain = (await res.json()) as { currentPrice: number };
            const livePrice = BigInt(chain.currentPrice);
            const days = BigInt(selectedDuration.days);
            // 17280 blocks/day × 2x safety multiplier (matches adapter init.ts)
            const liveAmount = days * 17280n * livePrice * 2n;
            if (liveAmount > BigInt(amount)) {
              console.log(
                `[SwarmPlugin] Using live price ${livePrice} PLUR/block (was ${stampOptions?.pricePerBlock ?? "unknown"}): amount ${amount} → ${liveAmount}`,
              );
              amount = liveAmount.toString();
            }
          }
        }
      } catch (priceErr) {
        console.warn("[SwarmPlugin] Live price fetch failed, using cached amount:", priceErr);
      }

      setTopUpStep("Submitting transaction to Gnosis Chain...");
      toast("Submitting top-up transaction...", { type: "connect-success" });
      await client.topUpStamp(amount);

      setTopUpStep("Transaction submitted. Waiting for confirmation...");
      toast(`Top-up submitted \u2014 waiting for blockchain confirmation...`, { type: "connect-success" });

      // Poll stamp status until TTL reflects the top-up (or timeout after 2 min)
      const startTtl = stamp.ttlSeconds ?? 0;
      const deadline = Date.now() + 120_000;
      setTopUpStep("Waiting for stamp to update (this may take 1\u20132 minutes)...");
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10_000));
        try {
          const res = await fetch(`${(window as any).ph?.swarm?.beeUrl}/stamps/${stamp.batchId}`);
          if (res.ok) {
            const data = (await res.json()) as { duration?: { toSeconds?: () => number }; batchTTL?: number };
            const newTtl = data.batchTTL ?? 0;
            if (newTtl > startTtl + 3600) {
              setTopUpStep("Confirmed!");
              break;
            }
          }
        } catch { /* keep polling */ }
      }

      toast(`Stamp topped up \u2014 ~${selectedDuration.days} days added!`, { type: "connect-success" });
      showStatus(true, `Stamp topped up \u2014 ~${selectedDuration.days} days added.`);
      setSelectedDuration(null);

      // Refresh stamp status (no wallet signature needed)
      setTopUpStep("Refreshing stamp status...");
      if (refreshStamp) await refreshStamp();
    } catch (err) {
      const { message, hint } = extractBeeError(err);
      console.error("[SwarmPlugin] Top up failed:", err);
      showStatus(false, hint ? `Top up failed: ${hint} (Bee: ${message})` : `Top up failed: ${message}`);
    } finally {
      setTopUpBusy(false);
      setTopUpStep(null);
    }
  };

  const handleExpand = async () => {
    if (!client || !selectedSize) return;
    setExpandBusy(true);
    try {
      setExpandStep("Submitting dilute transaction...");
      toast("Submitting expand transaction...", { type: "connect-success" });
      await client.expandStamp(selectedSize);

      setExpandStep("Transaction submitted. Waiting for confirmation...");
      toast("Expand submitted \u2014 waiting for blockchain confirmation...", { type: "connect-success" });

      // Poll stamp until depth reflects the expansion (or timeout after 2 min)
      const deadline = Date.now() + 120_000;
      setExpandStep("Waiting for stamp to update (this may take 1\u20132 minutes)...");
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10_000));
        try {
          const res = await fetch(`${(window as any).ph?.swarm?.beeUrl}/stamps/${stamp.batchId}`);
          if (res.ok) {
            const data = (await res.json()) as { depth?: number };
            if (data.depth != null && data.depth >= selectedSize) {
              setExpandStep("Confirmed!");
              break;
            }
          }
        } catch { /* keep polling */ }
      }

      toast(`Capacity expanded to ${expandNewCapacity}!`, { type: "connect-success" });
      showStatus(true, `Capacity expanded to ${expandNewCapacity}. Duration halved \u2014 consider topping up.`);
      setSelectedSize(null);

      setExpandStep("Refreshing stamp status...");
      if (refreshStamp) await refreshStamp();
    } catch (err) {
      const { message, hint } = extractBeeError(err);
      console.error("[SwarmPlugin] Expand failed:", err);
      showStatus(false, hint ? `Expand failed: ${hint} (Bee: ${message})` : `Expand failed: ${message}`);
    } finally {
      setExpandBusy(false);
      setExpandStep(null);
    }
  };

  return (
    <Section title="Storage">
      {/* ── Capacity gauge ── */}
      <div className="mb-3 rounded-lg bg-gray-50 p-3">
        <div className="mb-2 flex items-end justify-between">
          <div>
            <p className="text-2xl font-semibold text-gray-900">
              {stamp.remainingHuman || formatBytes(stamp.capacityBytes - usedBytes)}
            </p>
            <p className="text-xs text-gray-400">
              available of {stamp.capacityHuman || formatBytes(stamp.capacityBytes)} effective
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold text-gray-900">{stamp.ttlHuman}</p>
            <p className="text-xs text-gray-400">until expiry</p>
          </div>
        </div>
        <div>
          <div className="mb-1 flex justify-between text-xs text-gray-400">
            <span>Bucket utilization</span>
            <span>{stamp.utilization}%</span>
          </div>
          <UtilBar pct={stamp.utilization} />
          {totalBytesUploaded != null && totalBytesUploaded > 0 && (
            <div className="mt-2 flex justify-between text-xs text-gray-500">
              <span>Your data uploaded</span>
              <span className="font-medium">{formatBytes(totalBytesUploaded)}</span>
            </div>
          )}
          <details
            className="mt-2"
            onToggle={(e) => {
              if ((e.target as HTMLDetailsElement).open && !bucketData && getBucketUtilization) {
                getBucketUtilization().then((data) => { if (data) setBucketData(data); });
              }
            }}
          >
            <summary className="cursor-pointer text-[10px] text-blue-400 hover:text-blue-600">
              Why is utilization high with little data?
            </summary>
            <div className="mt-1 rounded bg-gray-50 p-2 text-[10px] leading-relaxed text-gray-500">
              <p className="mb-1">
                Swarm splits data into 4KB chunks distributed across{" "}
                <strong>65,536 buckets</strong> by content hash. Utilization tracks the{" "}
                <strong>fullest bucket</strong>, not total data.
              </p>
              <p className="mb-1">
                With a small stamp (depth {stamp.depth ?? "?"}), each bucket has only{" "}
                <strong>
                  {stamp.depth != null && stamp.bucketDepth != null
                    ? Math.pow(2, stamp.depth - stamp.bucketDepth)
                    : "?"}{" "}
                  slots
                </strong>
                . A few uploads can fill one bucket while others stay empty &mdash; like a hash
                table with uneven distribution.
              </p>
              <p>
                <strong>Tip:</strong> Larger stamps (depth 22+) have more slots per bucket, so
                utilization stays low longer and you get closer to the advertised capacity.
              </p>
              {bucketData && bucketData.hotBuckets.length > 0 && (
                <div className="mt-2 border-t border-gray-200 pt-2">
                  <p className="font-medium text-yellow-700 mb-1">
                    {bucketData.hotBuckets.length} hot bucket{bucketData.hotBuckets.length !== 1 ? "s" : ""} (&ge;80% full):
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {bucketData.hotBuckets.slice(0, 20).map((b) => (
                      <span
                        key={b.index}
                        className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-mono ${
                          b.percentFull >= 100
                            ? "bg-red-100 text-red-700"
                            : "bg-yellow-100 text-yellow-700"
                        }`}
                        title={`Bucket #${b.index}: ${b.collisions}/${bucketData.bucketUpperBound} slots (${b.percentFull}%)`}
                      >
                        #{b.index} {b.percentFull}%
                      </span>
                    ))}
                    {bucketData.hotBuckets.length > 20 && (
                      <span className="text-[9px] text-gray-400">
                        +{bucketData.hotBuckets.length - 20} more
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-gray-400">
                    Max slots per bucket: {bucketData.bucketUpperBound}.
                    {bucketData.hotBuckets.some((b) => b.percentFull >= 100) &&
                      " Some buckets are full — new uploads targeting these buckets will fail. Expand your stamp."}
                  </p>
                </div>
              )}
              {bucketData && bucketData.hotBuckets.length === 0 && (
                <p className="mt-2 border-t border-gray-200 pt-2 text-green-600">
                  No hot buckets — all buckets are below 80% utilization.
                </p>
              )}
            </div>
          </details>
        </div>
      </div>

      {/* ── Details rows ── */}
      <Row
        label="Health"
        value={
          <span className="flex items-center">
            <StatusDot color={healthColor(stamp.health)} />
            {stamp.health.charAt(0).toUpperCase() + stamp.health.slice(1)}
          </span>
        }
      />
      <Row
        label="Type"
        value={
          <span className="flex items-center gap-1.5">
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                stamp.immutable
                  ? "bg-yellow-50 text-yellow-700 ring-1 ring-yellow-200"
                  : "bg-green-50 text-green-700 ring-1 ring-green-200"
              }`}
            >
              {stamp.immutable ? "Immutable" : "Mutable"}
            </span>
            {stamp.immutable && (
              <span className="text-[10px] text-yellow-600">
                Old data never garbage collected
              </span>
            )}
          </span>
        }
      />
      {stamp.warnings && stamp.warnings.length > 0 && (
        <div className="mt-2">
          {stamp.warnings.map((w, i) => (
            <AlertBanner key={i} type="warning">
              <p className="text-[10px]">{w}</p>
            </AlertBanner>
          ))}
        </div>
      )}
      <Row
        label="Expires"
        value={stamp.expiresAt ? new Date(stamp.expiresAt).toLocaleDateString() : "\u2014"}
      />
      <Row
        label={
          <span className="group relative cursor-help">
            Batch ID
            <span className="pointer-events-none absolute bottom-full left-0 z-10 mb-1 hidden w-56 rounded bg-gray-800 p-2 text-[10px] font-normal leading-relaxed text-white shadow-lg group-hover:block">
              Unique identifier for your postage stamp on Gnosis Chain. Like a receipt for your
              prepaid storage.
            </span>
          </span>
        }
        copyable={stamp.batchId ?? undefined}
      />
      {stamp.depth != null && (
        <Row
          label={
            <span className="group relative cursor-help">
              Depth
              <span className="pointer-events-none absolute bottom-full left-0 z-10 mb-1 hidden w-64 rounded bg-gray-800 p-2 text-[10px] font-normal leading-relaxed text-white shadow-lg group-hover:block">
                Controls storage capacity. Each +1 depth doubles capacity but halves duration.
                Depth {stamp.depth} = {stamp.depth - (stamp.bucketDepth ?? 16)} bits per bucket ={" "}
                {Math.pow(2, stamp.depth - (stamp.bucketDepth ?? 16))} slots per bucket. Higher
                depth (22+) gives better utilization efficiency.
              </span>
            </span>
          }
          value={String(stamp.depth)}
        />
      )}
      {stamp.totalCostBzz && (
        <Row
          label="Total stamp cost"
          value={
            <span>
              {stamp.totalCostBzz} xBZZ
              {stamp.totalCostUsd && (
                <span className="ml-1 text-gray-400">({stamp.totalCostUsd})</span>
              )}
            </span>
          }
        />
      )}
      {stamp.bzzUsdPrice != null && (
        <Row label="xBZZ market price" value={`$${stamp.bzzUsdPrice.toFixed(4)} USD`} />
      )}

      {/* ── Stamp management controls ── */}
      {isDevMode ? (
        <p className="mt-2 text-xs text-gray-400">
          Stamp management unavailable in Bee dev mode.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {/* Extend Duration */}
          <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
            <p className="mb-2 text-xs font-medium text-gray-600">Extend Duration</p>
            <div className="flex items-end gap-2">
              <select
                className="flex-1 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-blue-400 focus:outline-none"
                value={selectedDuration?.days ?? ""}
                onChange={(e) => {
                  const days = Number(e.target.value);
                  if (!days) {
                    setSelectedDuration(null);
                    return;
                  }
                  const opts = stampOptions?.durationOptions ?? [];
                  const opt = opts.find((o) => o.days === days);
                  if (opt) setSelectedDuration({ days: opt.days, amount: opt.amount });
                }}
              >
                <option value="">Select duration...</option>
                {(stampOptions?.durationOptions ?? DURATION_OPTIONS).map((opt) => (
                  <option key={opt.days} value={opt.days}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <ActionButton
                onClick={handleTopUp}
                loading={topUpBusy}
                disabled={!ready || !selectedDuration || canAffordTopUp === false}
                variant="primary"
              >
                {topUpBusy ? "Processing..." : "Top Up"}
              </ActionButton>
            </div>
            {topUpCostBzz != null && (
              <div className={`mt-2 rounded-lg border p-2 text-[10px] ${canAffordTopUp === false ? "border-red-200 bg-red-50" : "border-blue-100 bg-blue-50"}`}>
                <div className="flex justify-between mb-0.5">
                  <span className="text-gray-500">Cost for ~{selectedDuration?.days}d extension</span>
                  <span className="font-medium text-gray-700">{topUpCostBzz.toFixed(4)} xBZZ</span>
                </div>
                {walletBzz != null && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Wallet balance</span>
                    <span className={`font-medium ${canAffordTopUp ? "text-green-600" : "text-red-600"}`}>
                      {walletBzz.toFixed(4)} xBZZ
                    </span>
                  </div>
                )}
                {canAffordTopUp === false && (
                  <p className="mt-1 text-red-600 font-medium">
                    Insufficient balance. Need {(topUpCostBzz - (walletBzz ?? 0)).toFixed(4)} more xBZZ.
                  </p>
                )}
              </div>
            )}
            {!selectedDuration && !topUpStep && (
              <p className="mt-1 text-[10px] text-gray-400">
                Select a duration to see cost estimate. Costs xBZZ from node wallet.
              </p>
            )}
            {topUpStep && (
              <div className="mt-2 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-2.5">
                <div className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
                <span className="text-[10px] font-medium text-blue-700">{topUpStep}</span>
              </div>
            )}
          </div>

          {/* Expand Storage */}
          <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
            <p className="mb-2 text-xs font-medium text-gray-600">Expand Storage</p>
            <div className="flex items-end gap-2">
              <select
                className="flex-1 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-blue-400 focus:outline-none"
                value={selectedSize ?? ""}
                onChange={(e) =>
                  setSelectedSize(e.target.value ? Number(e.target.value) : null)
                }
              >
                <option value="">Select size...</option>
                {SIZE_OPTIONS.filter((s) => s.depth > (stamp.depth ?? 0)).map((opt) => (
                  <option key={opt.depth} value={opt.depth}>
                    {opt.label} (depth {opt.depth})
                  </option>
                ))}
              </select>
              <ActionButton
                onClick={handleExpand}
                loading={expandBusy}
                disabled={!ready || !selectedSize}
              >
                {expandBusy ? "Processing..." : "Expand"}
              </ActionButton>
            </div>
            {selectedSize && stamp.depth != null && (
              <div className="mt-2 rounded-lg border border-yellow-100 bg-yellow-50 p-2 text-[10px]">
                <div className="flex justify-between mb-0.5">
                  <span className="text-gray-500">Current capacity</span>
                  <span className="text-gray-700">{SIZE_OPTIONS.find((s) => s.depth === stamp.depth)?.label ?? `depth ${stamp.depth}`} (depth {stamp.depth})</span>
                </div>
                <div className="flex justify-between mb-0.5">
                  <span className="text-gray-500">New capacity</span>
                  <span className="font-medium text-green-600">{expandNewCapacity} (depth {selectedSize})</span>
                </div>
                <div className="flex justify-between mb-0.5">
                  <span className="text-gray-500">Duration impact</span>
                  <span className="font-medium text-yellow-600">
                    Halved {selectedSize - stamp.depth > 1 ? `(${2 ** (selectedSize - stamp.depth)}\u00D7 reduction)` : ""} &mdash; top up after
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">xBZZ cost</span>
                  <span className="text-gray-700">None (gas only &mdash; xDAI)</span>
                </div>
              </div>
            )}
            {!selectedSize && !expandStep && (
              <p className="mt-1 text-[10px] text-gray-400">
                Select a size to see impact. Increases capacity but halves remaining duration.
                {stamp.utilization >= 100 && " Required \u2014 storage is full."}
                {stamp.depth != null &&
                  stamp.depth < 22 &&
                  stamp.utilization > 30 &&
                  " Recommended: expand to depth 22+ for more efficient storage."}
              </p>
            )}
            {expandStep && (
              <div className="mt-2 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-2.5">
                <div className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
                <span className="text-[10px] font-medium text-blue-700">{expandStep}</span>
              </div>
            )}
          </div>

          {/* Create New Stamp — useful when current stamp is immutable */}
          <NewStampInline
            client={client}
            ready={ready}
            stampOptions={stampOptions}
            showStatus={showStatus}
            currentStampImmutable={stamp.immutable}
            nodeBalanceBzz={nodeBalanceBzz}
            reconnect={reconnect}
          />
        </div>
      )}
    </Section>
  );
}

// ─── New Stamp (inline, shown when user already has a stamp) ───

function NewStampInline({
  client,
  ready,
  stampOptions,
  showStatus,
  currentStampImmutable,
  nodeBalanceBzz,
  reconnect,
}: {
  client: SwarmUiSnapshot["client"];
  ready: boolean;
  stampOptions: StampOptions | null;
  showStatus: (ok: boolean, msg: string) => void;
  currentStampImmutable?: boolean;
  nodeBalanceBzz?: string;
  reconnect?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(currentStampImmutable === true);
  const [createBusy, setCreateBusy] = useState(false);
  const [newSize, setNewSize] = useState<number | null>(22);
  const [newDuration, setNewDuration] = useState<{ days: number; amount: string } | null>(null);
  const [newImmutable, setNewImmutable] = useState(false);

  // Cost estimation: amount * 2^depth / 10^16 = xBZZ
  const estimatedCostBzz =
    newSize && newDuration
      ? Number(BigInt(newDuration.amount) * BigInt(2 ** newSize)) / 1e16
      : null;
  const walletBzz = nodeBalanceBzz ? Number(BigInt(nodeBalanceBzz)) / 1e16 : null;
  const canAfford =
    estimatedCostBzz != null && walletBzz != null ? walletBzz >= estimatedCostBzz : null;

  const [createStep, setCreateStep] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!client) return;
    const depth = newSize ?? 22;
    const days = newDuration?.days ?? 7;
    setCreateBusy(true);
    try {
      const sizeLabel =
        stampOptions?.sizeOptions.find((s) => s.depth === depth)?.label ?? `depth ${depth}`;
      const durLabel = `~${days} days`;
      const mutLabel = newImmutable ? "immutable" : "mutable";

      // Always recompute the amount from live chain price right before creation
      // so the first-time setup flow can't send a stale figure.
      let amount = newDuration?.amount ?? "";
      try {
        setCreateStep("Checking current network price...");
        const beeUrl = (window as any).ph?.swarm?.beeUrl;
        if (beeUrl) {
          const res = await fetch(`${beeUrl}/chainstate`);
          if (res.ok) {
            const chain = (await res.json()) as { currentPrice: number };
            const livePrice = BigInt(chain.currentPrice);
            // 17280 blocks/day × 2x safety multiplier (matches adapter init.ts)
            const liveAmount = BigInt(days) * 17280n * livePrice * 2n;
            if (!amount || liveAmount > BigInt(amount)) {
              console.log(
                `[SwarmPlugin] Create: live price ${livePrice}, amount ${amount || "(none)"} → ${liveAmount}`,
              );
              amount = liveAmount.toString();
            }
          }
        }
      } catch (priceErr) {
        console.warn("[SwarmPlugin] Live price fetch failed on create:", priceErr);
      }
      if (!amount) {
        showStatus(false, "Could not determine stamp cost — network price unavailable.");
        return;
      }

      setCreateStep("Submitting stamp creation to Gnosis Chain...");
      toast("Creating stamp...", { type: "connect-success" });
      const batchId = await client.createStamp(amount, depth, { immutable: newImmutable });

      setCreateStep("Stamp submitted! Waiting for blockchain confirmation (1\u20132 min)...");
      toast(`Stamp ${batchId.slice(0, 8)}... submitted. Waiting for confirmation...`, { type: "connect-success" });
      showStatus(true, `New stamp: ${batchId.slice(0, 12)}... (${sizeLabel}, ${durLabel}, ${mutLabel}).`);

      // Auto-reconnect so the UI picks up the new stamp
      if (reconnect) {
        await new Promise((r) => setTimeout(r, 3000));
        setCreateStep("Reconnecting...");
        await reconnect();
      }
      setOpen(false);
      toast(`New stamp ready (${sizeLabel}, ${durLabel}, ${mutLabel})!`, { type: "connect-success" });
    } catch (err) {
      const { message, hint } = extractBeeError(err);
      console.error("[SwarmPlugin] Stamp creation failed:", err);
      toast(message, { type: "connect-warning" });
      showStatus(false, hint ? `Stamp creation failed: ${hint} (Bee: ${message})` : `Stamp creation failed: ${message}`);
    } finally {
      setCreateBusy(false);
      setCreateStep(null);
    }
  };

  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between text-xs font-medium text-gray-600"
      >
        <span>Create New Stamp</span>
        <span className="text-[10px] text-gray-400">{open ? "\u25BC" : "\u25B6"}</span>
      </button>
      {currentStampImmutable && !open && (
        <p className="mt-1 text-[10px] text-yellow-600">
          Your current stamp is immutable. Create a mutable one for better storage efficiency.
        </p>
      )}
      {open && (
        <div className="mt-3 space-y-3">
          <div>
            <label className="mb-1 block text-[10px] font-medium text-gray-500">
              Storage capacity
            </label>
            <select
              className="w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 focus:border-blue-400 focus:outline-none"
              value={newSize ?? ""}
              onChange={(e) => setNewSize(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Select size...</option>
              {SIZE_OPTIONS.map((opt) => (
                <option key={opt.depth} value={opt.depth}>
                  {opt.label} (depth {opt.depth})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-medium text-gray-500">
              Duration
            </label>
            <select
              className="w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 focus:border-blue-400 focus:outline-none"
              value={newDuration?.days ?? ""}
              onChange={(e) => {
                const days = Number(e.target.value);
                if (!days) { setNewDuration(null); return; }
                const opts = stampOptions?.durationOptions ?? [];
                const opt = opts.find((o) => o.days === days);
                if (opt) setNewDuration({ days: opt.days, amount: opt.amount });
                else {
                  // Fallback: compute from live chain price if the adapter hasn't
                  // prepopulated an option. 17280 blocks/day (5s Gnosis blocks),
                  // 2x safety multiplier to clear Bee's 24h-minimum check.
                  const price = BigInt(stampOptions?.pricePerBlock ?? 0);
                  if (price > 0n) {
                    setNewDuration({ days, amount: String(BigInt(days) * 17280n * price * 2n) });
                  }
                }
              }}
            >
              <option value="">Select duration...</option>
              {DURATION_OPTIONS.map((opt) => (
                <option key={opt.days} value={opt.days}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-medium text-gray-500">
              Stamp type
            </label>
            <div className="flex gap-2">
              <label
                className={`flex flex-1 cursor-pointer items-start gap-2 rounded-lg border p-2 transition-colors ${
                  !newImmutable
                    ? "border-green-300 bg-green-50"
                    : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <input
                  type="radio"
                  name="new-stamp-type"
                  checked={!newImmutable}
                  onChange={() => setNewImmutable(false)}
                  className="mt-0.5 accent-green-600"
                />
                <div>
                  <p className="text-[10px] font-medium text-gray-700">
                    Mutable <span className="text-green-600">(recommended)</span>
                  </p>
                  <p className="text-[9px] text-gray-400 leading-relaxed">
                    Old feed data gets garbage collected. Best for Connect.
                  </p>
                </div>
              </label>
              <label
                className={`flex flex-1 cursor-pointer items-start gap-2 rounded-lg border p-2 transition-colors ${
                  newImmutable
                    ? "border-yellow-300 bg-yellow-50"
                    : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <input
                  type="radio"
                  name="new-stamp-type"
                  checked={newImmutable}
                  onChange={() => setNewImmutable(true)}
                  className="mt-0.5 accent-yellow-600"
                />
                <div>
                  <p className="text-[10px] font-medium text-gray-700">Immutable</p>
                  <p className="text-[9px] text-gray-400 leading-relaxed">
                    All data permanent until expiry. Higher cost.
                  </p>
                </div>
              </label>
            </div>
          </div>
          {/* Cost estimation */}
          {estimatedCostBzz != null && (
            <div className={`rounded-lg border p-2.5 text-[10px] ${canAfford === false ? "border-red-200 bg-red-50" : "border-blue-100 bg-blue-50"}`}>
              <div className="flex justify-between mb-1">
                <span className="text-gray-500">Estimated cost</span>
                <span className="font-medium text-gray-700">{estimatedCostBzz.toFixed(4)} xBZZ</span>
              </div>
              {walletBzz != null && (
                <>
                  <div className="flex justify-between mb-1">
                    <span className="text-gray-500">Node wallet balance</span>
                    <span className={`font-medium ${canAfford ? "text-green-600" : "text-red-600"}`}>
                      {walletBzz.toFixed(4)} xBZZ
                    </span>
                  </div>
                  {canAfford === false && (
                    <p className="mt-1.5 text-red-600 font-medium">
                      Insufficient balance. Top up your node wallet with {(estimatedCostBzz - walletBzz).toFixed(4)} xBZZ before creating.
                    </p>
                  )}
                  {canAfford === true && (
                    <div className="flex justify-between border-t border-blue-100 pt-1 mt-1">
                      <span className="text-gray-500">Remaining after purchase</span>
                      <span className="font-medium text-gray-600">{(walletBzz - estimatedCostBzz).toFixed(4)} xBZZ</span>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          <ActionButton
            onClick={handleCreate}
            loading={createBusy}
            disabled={!ready || !newSize || !newDuration || canAfford === false}
            variant="primary"
          >
            {newSize && newDuration
              ? `Create ${newImmutable ? "Immutable" : "Mutable"} Stamp (${SIZE_OPTIONS.find((s) => s.depth === newSize)?.label ?? ""}, ~${newDuration.days}d)`
              : "Create Stamp"}
          </ActionButton>
          {!createStep && (
            <p className="text-[9px] text-gray-400">
              Requires xBZZ in the Bee node wallet.
            </p>
          )}
          {createStep && (
            <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-2">
              <div className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
              <span className="text-[9px] font-medium text-blue-700">{createStep}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Create Stamp ──────────────────────────────────────────────

export function CreateStampSection({
  client,
  ready,
  stampOptions,
  showStatus,
  nodeBalanceBzz,
  reconnect,
}: {
  client: SwarmUiSnapshot["client"];
  ready: boolean;
  stampOptions: StampOptions | null;
  showStatus: (ok: boolean, msg: string) => void;
  nodeBalanceBzz?: string;
  reconnect?: () => Promise<void>;
}) {
  const [createBusy, setCreateBusy] = useState(false);
  const [selectedSize, setSelectedSize] = useState<number | null>(null);
  const [selectedDuration, setSelectedDuration] = useState<{
    days: number;
    amount: string;
  } | null>(null);
  const [stampImmutable, setStampImmutable] = useState(false);
  const [createStep, setCreateStep] = useState<string | null>(null);

  // Cost estimation
  const estimatedCostBzz =
    selectedSize && selectedDuration
      ? Number(BigInt(selectedDuration.amount) * BigInt(2 ** selectedSize)) / 1e16
      : null;
  const walletBzz = nodeBalanceBzz ? Number(BigInt(nodeBalanceBzz)) / 1e16 : null;
  const canAfford =
    estimatedCostBzz != null && walletBzz != null ? walletBzz >= estimatedCostBzz : null;

  const handleCreateStamp = async () => {
    if (!client) return;
    const depth = selectedSize ?? 22;
    const days = selectedDuration?.days ?? 7;
    setCreateBusy(true);
    try {
      const sizeLabel =
        stampOptions?.sizeOptions.find((s) => s.depth === depth)?.label ?? `depth ${depth}`;
      const durLabel = `~${days} days`;
      const mutLabel = stampImmutable ? "immutable" : "mutable";

      let amount = selectedDuration?.amount ?? "";
      try {
        setCreateStep("Checking current network price...");
        const beeUrl = (window as any).ph?.swarm?.beeUrl;
        if (beeUrl) {
          const res = await fetch(`${beeUrl}/chainstate`);
          if (res.ok) {
            const chain = (await res.json()) as { currentPrice: number };
            const livePrice = BigInt(chain.currentPrice);
            const liveAmount = BigInt(days) * 17280n * livePrice * 2n;
            if (!amount || liveAmount > BigInt(amount)) {
              console.log(
                `[SwarmPlugin] Create: live price ${livePrice}, amount ${amount || "(none)"} → ${liveAmount}`,
              );
              amount = liveAmount.toString();
            }
          }
        }
      } catch (priceErr) {
        console.warn("[SwarmPlugin] Live price fetch failed on create:", priceErr);
      }
      if (!amount) {
        showStatus(false, "Could not determine stamp cost — network price unavailable.");
        return;
      }

      setCreateStep("Submitting stamp creation to Gnosis Chain...");
      toast("Creating stamp...", { type: "connect-success" });
      const batchId = await client.createStamp(amount, depth, { immutable: stampImmutable });

      setCreateStep("Stamp submitted! Waiting for blockchain confirmation (1\u20132 min)...");
      toast(`Stamp ${batchId.slice(0, 8)}... submitted. Waiting for confirmation...`, { type: "connect-success" });
      showStatus(true, `Stamp created: ${batchId.slice(0, 12)}... (${sizeLabel}, ${durLabel}, ${mutLabel}).`);

      // Auto-reconnect to pick up the new stamp
      if (reconnect) {
        await new Promise((r) => setTimeout(r, 3000));
        setCreateStep("Reconnecting...");
        await reconnect();
      }
      toast(`Stamp ready (${sizeLabel}, ${durLabel}, ${mutLabel})!`, { type: "connect-success" });
    } catch (err) {
      const { message, hint } = extractBeeError(err);
      console.error("[SwarmPlugin] Stamp creation failed:", err);
      toast(message, { type: "connect-warning" });
      showStatus(false, hint ? `Stamp creation failed: ${hint} (Bee: ${message})` : `Stamp creation failed: ${message}`);
    } finally {
      setCreateBusy(false);
      setCreateStep(null);
    }
  };

  return (
    <Section title="Buy a Postage Stamp">
      <p className="mb-3 text-xs text-gray-400">
        A postage stamp is prepaid storage on Swarm. Choose capacity and duration, then create.
        Your Bee node wallet must be funded with xBZZ first.
      </p>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">
            Storage capacity
          </label>
          <select
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-blue-400 focus:outline-none"
            value={selectedSize ?? ""}
            onChange={(e) => setSelectedSize(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Select size...</option>
            {SIZE_OPTIONS.map((opt) => (
              <option key={opt.depth} value={opt.depth}>
                {opt.label} (depth {opt.depth})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">
            Storage duration (approx.)
          </label>
          <select
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-blue-400 focus:outline-none"
            value={selectedDuration?.days ?? ""}
            onChange={(e) => {
              const days = Number(e.target.value);
              if (!days) {
                setSelectedDuration(null);
                return;
              }
              const opts = stampOptions?.durationOptions ?? [];
              const opt = opts.find((o) => o.days === days);
              if (opt) setSelectedDuration({ days: opt.days, amount: opt.amount });
              else {
                // Fallback: compute from live chain price if the adapter hasn't
                // prepopulated an option. 17280 blocks/day (5s Gnosis blocks),
                // 2x safety multiplier to clear Bee's 24h-minimum check.
                const price = BigInt(stampOptions?.pricePerBlock ?? 0);
                if (price > 0n) {
                  setSelectedDuration({ days, amount: String(BigInt(days) * 17280n * price * 2n) });
                }
              }
            }}
          >
            <option value="">Select duration...</option>
            {DURATION_OPTIONS.map((opt) => (
              <option key={opt.days} value={opt.days}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">Stamp type</label>
          <div className="flex gap-3">
            <label
              className={`flex flex-1 cursor-pointer items-start gap-2 rounded-lg border p-3 transition-colors ${
                !stampImmutable
                  ? "border-green-300 bg-green-50"
                  : "border-gray-200 hover:border-gray-300"
              }`}
            >
              <input
                type="radio"
                name="stamp-type"
                checked={!stampImmutable}
                onChange={() => setStampImmutable(false)}
                className="mt-0.5 accent-green-600"
              />
              <div>
                <p className="text-xs font-medium text-gray-700">
                  Mutable <span className="text-green-600">(recommended)</span>
                </p>
                <p className="text-[10px] text-gray-400 leading-relaxed">
                  Old feed data is garbage collected when updated. Ideal for Swarm Connect
                  &mdash; feed writes reuse stamp slots.
                </p>
              </div>
            </label>
            <label
              className={`flex flex-1 cursor-pointer items-start gap-2 rounded-lg border p-3 transition-colors ${
                stampImmutable
                  ? "border-yellow-300 bg-yellow-50"
                  : "border-gray-200 hover:border-gray-300"
              }`}
            >
              <input
                type="radio"
                name="stamp-type"
                checked={stampImmutable}
                onChange={() => setStampImmutable(true)}
                className="mt-0.5 accent-yellow-600"
              />
              <div>
                <p className="text-xs font-medium text-gray-700">Immutable</p>
                <p className="text-[10px] text-gray-400 leading-relaxed">
                  All data is permanently stored until stamp expires. Every feed update uses a
                  new slot. Higher storage cost for frequent writes.
                </p>
              </div>
            </label>
          </div>
        </div>
        {/* Cost estimation */}
        {estimatedCostBzz != null && (
          <div className={`rounded-lg border p-3 text-xs ${canAfford === false ? "border-red-200 bg-red-50" : "border-blue-100 bg-blue-50"}`}>
            <div className="flex justify-between mb-1">
              <span className="text-gray-500">Estimated cost</span>
              <span className="font-medium text-gray-700">{estimatedCostBzz.toFixed(4)} xBZZ</span>
            </div>
            {walletBzz != null && (
              <>
                <div className="flex justify-between mb-1">
                  <span className="text-gray-500">Node wallet balance</span>
                  <span className={`font-medium ${canAfford ? "text-green-600" : "text-red-600"}`}>
                    {walletBzz.toFixed(4)} xBZZ
                  </span>
                </div>
                {canAfford === false && (
                  <p className="mt-1.5 text-red-600 font-medium">
                    Insufficient balance. Top up your node wallet with {(estimatedCostBzz - walletBzz).toFixed(4)} xBZZ before creating.
                  </p>
                )}
                {canAfford === true && (
                  <div className="flex justify-between border-t border-blue-100 pt-1 mt-1">
                    <span className="text-gray-500">Remaining after purchase</span>
                    <span className="font-medium text-gray-600">{(walletBzz - estimatedCostBzz).toFixed(4)} xBZZ</span>
                  </div>
                )}
              </>
            )}
          </div>
        )}
        <ActionButton
          onClick={handleCreateStamp}
          loading={createBusy}
          disabled={!ready || !selectedSize || !selectedDuration || canAfford === false}
          variant="primary"
        >
          {selectedSize && selectedDuration
            ? `Create ${stampImmutable ? "Immutable" : "Mutable"} Stamp (${SIZE_OPTIONS.find((s) => s.depth === selectedSize)?.label ?? ""}, ~${selectedDuration.days}d)`
            : "Create Stamp"}
        </ActionButton>
        {!createStep && (
          <p className="text-[10px] text-gray-400">
            Requires xBZZ in the Bee node wallet. Larger capacity + longer duration costs more
            xBZZ.
          </p>
        )}
        {createStep && (
          <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-2.5">
            <div className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
            <span className="text-[10px] font-medium text-blue-700">{createStep}</span>
          </div>
        )}
      </div>
    </Section>
  );
}
