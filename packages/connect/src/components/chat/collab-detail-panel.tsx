/**
 * CollabDetailPanel — modal dialog that shows participants of a collab
 * and lets the initiator add / revoke access.
 *
 * Non-initiators see a read-only view.
 *
 * All writes go through the adapter's CollabManager, which rotates the
 * ACT grantee chain and publishes a new manifest feed revision.
 */
import React, { useEffect, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import type { CollabSummary, CollabParticipant } from "./types.js";
import { parseBulkAddresses } from "../../../../adapter/src/collab/address-utils.js";

const ACCENT = "#2563eb";
const DANGER = "#dc2626";

export function CollabDetailPanel({
  isOpen,
  summary,
  myAddress,
  onClose,
  onUpdated,
}: {
  isOpen: boolean;
  summary: CollabSummary | null;
  myAddress: string;
  onClose: () => void;
  onUpdated: (updated: CollabSummary) => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [busyAddr, setBusyAddr] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshError, setLastRefreshError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [addInput, setAddInput] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedForBulk, setSelectedForBulk] = useState<Set<string>>(new Set());
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmBulkRevoke, setConfirmBulkRevoke] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setAddInput("");
      setError(null);
      setLastRefreshError(null);
      setBusyAddr(null);
      setAddBusy(false);
      setConfirmRevoke(null);
      setShowAdd(false);
      setSearch("");
      setSelectedForBulk(new Set());
      setBulkMode(false);
      setBulkBusy(false);
      setConfirmBulkRevoke(false);
    }
  }, [isOpen]);

  // Refresh manifest on open so we show the authoritative list.
  useEffect(() => {
    if (!isOpen || !summary) return;
    const manager = (globalThis as any).window?.ph?.swarm?.collab?.manager;
    if (!manager?.refreshManifest) return;
    let cancelled = false;
    setRefreshing(true);
    setLastRefreshError(null);
    manager
      .refreshManifest(summary.collabId)
      .then((updated: CollabSummary | null) => {
        if (cancelled || !updated) return;
        onUpdated(updated);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Could not refresh the member list: ${msg}`);
        setLastRefreshError(msg);
      })
      .finally(() => { if (!cancelled) setRefreshing(false); });
    return () => { cancelled = true; };
  }, [isOpen, summary?.collabId, onUpdated, refreshToken]);

  // Live updates: subscribe to the manager's event bus while the
  // panel is open so peerActivity / recentActivity / participant
  // changes show up without a manual close + reopen. We always fetch
  // the latest summary from manager.get() inside the handler because
  // CollabManager emits events BEFORE the summary prop has
  // propagated down from the parent.
  useEffect(() => {
    if (!isOpen || !summary) return;
    const manager = (globalThis as any).window?.ph?.swarm?.collab?.manager;
    if (!manager?.on) return;
    const handle = (e: { collabId?: string }) => {
      if (e.collabId && e.collabId !== summary.collabId) return;
      const fresh = manager.get?.(summary.collabId);
      if (fresh) onUpdated(fresh);
    };
    const unsubA = manager.on("op-applied", handle);
    const unsubB = manager.on("collab-updated", handle);
    return () => { unsubA?.(); unsubB?.(); };
  }, [isOpen, summary?.collabId, onUpdated]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [isOpen, onClose]);

  const handleRevoke = useCallback(async (addr: string) => {
    const manager = (globalThis as any).window?.ph?.swarm?.collab?.manager;
    if (!manager || !summary) return;
    setBusyAddr(addr);
    setError(null);
    try {
      const updated = await manager.revokeParticipant(summary.collabId, addr);
      if (updated) onUpdated(updated);
      setConfirmRevoke(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAddr(null);
    }
  }, [summary?.collabId, onUpdated]);

  const handleAdd = useCallback(async () => {
    const manager = (globalThis as any).window?.ph?.swarm?.collab?.manager;
    if (!manager || !summary) return;

    const parsed = parseBulkAddresses(addInput);
    if (parsed.valid.length === 0) {
      if (parsed.invalid.length > 0) {
        setError(`Couldn't parse ${parsed.invalid.length} address${parsed.invalid.length === 1 ? "" : "es"} — check they start with 0x and have 40 hex chars.`);
      } else {
        setError("Paste a peer address starting with 0x.");
      }
      return;
    }

    // Filter addresses already on the participant list — avoids the
    // round-trip to the manager + a confusing "already in the collab"
    // error.
    const existing = new Set(summary.participants.map((p) => p.address.toLowerCase()));
    const toAdd = parsed.valid.filter((a) => !existing.has(a));
    if (toAdd.length === 0) {
      setError("Those addresses are already in the collaboration.");
      return;
    }

    setAddBusy(true);
    setError(null);
    let failures: string[] = [];
    let last: CollabSummary | undefined;
    try {
      for (const addr of toAdd) {
        try {
          last = await manager.addParticipant(summary.collabId, addr);
        } catch (err) {
          failures.push(addr);
          console.warn("[CollabDetailPanel] addParticipant failed:", err);
        }
      }
      if (last) onUpdated(last);
      if (failures.length > 0) {
        setError(
          `Added ${toAdd.length - failures.length}/${toAdd.length}. Failed: ${failures.map((f) => f.slice(0, 10) + "…").join(", ")}`,
        );
      } else {
        setAddInput("");
        setShowAdd(false);
      }
    } finally {
      setAddBusy(false);
    }
  }, [summary?.collabId, summary?.participants, addInput, onUpdated]);

  const handleBulkRevoke = useCallback(async () => {
    const manager = (globalThis as any).window?.ph?.swarm?.collab?.manager;
    if (!manager || !summary) return;
    if (selectedForBulk.size === 0) return;
    setBulkBusy(true);
    setError(null);
    let last: CollabSummary | undefined;
    let failures: string[] = [];
    try {
      for (const addr of selectedForBulk) {
        try {
          last = await manager.revokeParticipant(summary.collabId, addr);
        } catch (err) {
          failures.push(addr);
          console.warn("[CollabDetailPanel] revokeParticipant failed:", err);
        }
      }
      if (last) onUpdated(last);
      if (failures.length > 0) {
        setError(
          `Revoked ${selectedForBulk.size - failures.length}/${selectedForBulk.size}. Failed: ${failures.map((f) => f.slice(0, 10) + "…").join(", ")}`,
        );
      }
      setSelectedForBulk(new Set());
      setConfirmBulkRevoke(false);
      if (failures.length === 0) setBulkMode(false);
    } finally {
      setBulkBusy(false);
    }
  }, [summary?.collabId, selectedForBulk, onUpdated]);

  // Filter participants by search query (name/address substring).
  const filteredParticipants = useMemo(() => {
    if (!summary) return [];
    const q = search.trim().toLowerCase();
    if (!q) return summary.participants;
    return summary.participants.filter((p) =>
      p.address.toLowerCase().includes(q)
      || (p.displayName ?? "").toLowerCase().includes(q),
    );
  }, [summary, search]);

  if (!isOpen || !summary) return null;

  const isInitiator = summary.initiator === myAddress.toLowerCase();
  // Show the search box once the list is long enough to want filtering.
  const showSearch = summary.participants.length > 5;
  // Bulk-revoke mode only matters to the initiator (only they can
  // actually revoke); non-initiators never see the checkboxes.
  const canBulkRevoke = isInitiator
    && summary.participants.some((p) =>
      p.address !== summary.initiator && p.address !== myAddress.toLowerCase()
    );

  return createPortal(
    <div
      role="dialog"
      aria-label="Collaboration details"
      data-chat-overlay="true"
      onClick={onClose}
      className="fixed inset-0 z-[999] flex items-center justify-center bg-black/60 p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-[min(100%,32rem)] flex-col overflow-hidden rounded-lg bg-white shadow-2xl"
      >
        <div className="flex shrink-0 items-start justify-between border-b border-gray-200 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className="inline-flex h-5 items-center rounded px-1.5 text-[9px] font-bold uppercase tracking-wider text-white"
                style={{ backgroundColor: summary.kind === "document" ? "#7c3aed" : "#0ea5e9" }}
              >
                {summary.kind === "document" ? "Doc" : "Drive"}
              </span>
              <h3 className="truncate text-sm font-semibold text-gray-900">{summary.title}</h3>
            </div>
            <p className="mt-0.5 text-[11px] text-gray-400">
              {isInitiator ? "You are the initiator" : "You're a participant"} ·
              {" "}{summary.participants.length} member{summary.participants.length !== 1 ? "s" : ""}
              {refreshing && <span className="ml-1 text-blue-500">· refreshing…</span>}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            title="Close (Esc)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                Participants
                {search && filteredParticipants.length !== summary.participants.length && (
                  <span className="ml-1 font-normal normal-case text-gray-400">
                    ({filteredParticipants.length} of {summary.participants.length})
                  </span>
                )}
              </span>
              <div className="flex items-center gap-2">
                {canBulkRevoke && !bulkMode && (
                  <button
                    type="button"
                    onClick={() => setBulkMode(true)}
                    className="text-[11px] font-semibold text-gray-500 hover:underline"
                  >
                    Select
                  </button>
                )}
                {canBulkRevoke && bulkMode && (
                  <button
                    type="button"
                    onClick={() => {
                      setBulkMode(false);
                      setSelectedForBulk(new Set());
                      setConfirmBulkRevoke(false);
                    }}
                    className="text-[11px] font-semibold text-gray-500 hover:underline"
                  >
                    Done
                  </button>
                )}
                {isInitiator && !showAdd && !bulkMode && (
                  <button
                    type="button"
                    onClick={() => setShowAdd(true)}
                    className="text-[11px] font-semibold hover:underline"
                    style={{ color: ACCENT }}
                  >
                    + Add participant
                  </button>
                )}
              </div>
            </div>

            {showSearch && (
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search participants…"
                className="mb-2 w-full rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-blue-400"
              />
            )}

            {isInitiator && showAdd && (
              <div className="mb-2 rounded-md border border-gray-200 bg-gray-50 p-2.5">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={addInput}
                    onChange={(e) => { setAddInput(e.target.value); if (error) setError(null); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !addBusy && addInput.trim()) {
                        e.preventDefault();
                        handleAdd();
                      }
                    }}
                    placeholder="0x… peer address(es)"
                    disabled={addBusy}
                    className="flex-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-blue-400 disabled:opacity-60"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={handleAdd}
                    disabled={addBusy || !addInput.trim()}
                    style={{ backgroundColor: !addBusy && addInput.trim() ? ACCENT : "#93c5fd" }}
                    className="rounded-md px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-60"
                  >
                    {addBusy ? "Adding…" : "Add"}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowAdd(false); setAddInput(""); setError(null); }}
                    disabled={addBusy}
                    className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-60"
                  >
                    Cancel
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-gray-500">
                  Paste one or several addresses (comma or newline separated).
                  They'll each get a one-click invite in chat.
                </p>
              </div>
            )}

            {bulkMode && (
              <div className="mb-2 flex items-center justify-between rounded-md border border-blue-100 bg-blue-50 px-2.5 py-1.5 text-[11px]">
                <span className="text-blue-800">
                  {selectedForBulk.size === 0
                    ? "Select one or more participants below."
                    : `${selectedForBulk.size} selected`}
                </span>
                <div className="flex items-center gap-2">
                  {confirmBulkRevoke ? (
                    <>
                      <button
                        type="button"
                        onClick={handleBulkRevoke}
                        disabled={bulkBusy}
                        style={{ backgroundColor: DANGER }}
                        className="rounded-md px-2 py-0.5 text-[11px] font-semibold text-white disabled:opacity-60"
                      >
                        {bulkBusy ? "Revoking…" : `Revoke ${selectedForBulk.size}`}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmBulkRevoke(false)}
                        disabled={bulkBusy}
                        className="text-gray-500 hover:text-gray-700"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmBulkRevoke(true)}
                      disabled={selectedForBulk.size === 0}
                      className="font-semibold text-red-600 hover:underline disabled:cursor-not-allowed disabled:text-gray-400 disabled:no-underline"
                    >
                      Revoke selected
                    </button>
                  )}
                </div>
              </div>
            )}

            {refreshing && summary.participants.length === 0 ? (
              <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
                <ParticipantRowSkeleton />
                <ParticipantRowSkeleton />
                <ParticipantRowSkeleton />
              </ul>
            ) : filteredParticipants.length === 0 ? (
              <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-4 text-center text-[11px] text-gray-400">
                No participants match "{search}".
              </div>
            ) : (
              <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
                {filteredParticipants.map((p) => {
                  const activity = summary.peerActivity?.[p.address.toLowerCase()];
                  const isMeRow = p.address === myAddress.toLowerCase();
                  const isInitiatorRow = p.address === summary.initiator;
                  const selectable = bulkMode && !isMeRow && !isInitiatorRow;
                  const selected = selectedForBulk.has(p.address);
                  return (
                    <ParticipantRow
                      key={p.address}
                      participant={p}
                      isMe={isMeRow}
                      isInitiator={isInitiatorRow}
                      viewerIsInitiator={isInitiator}
                      lastAppliedAt={activity?.lastAppliedAt}
                      opsApplied={activity?.opsApplied ?? 0}
                      // "Awaiting response" when there's no record of
                      // ops arriving from this peer yet.
                      hasActivity={!!activity || peerHasSeenActivity(summary.collabId, p.address)}
                      confirming={confirmRevoke === p.address}
                      busy={busyAddr === p.address}
                      bulkSelectable={selectable}
                      bulkSelected={selected}
                      onToggleBulk={() => {
                        setSelectedForBulk((prev) => {
                          const next = new Set(prev);
                          if (next.has(p.address)) next.delete(p.address);
                          else next.add(p.address);
                          return next;
                        });
                      }}
                      onRequestRevoke={() => setConfirmRevoke(p.address)}
                      onCancelRevoke={() => setConfirmRevoke(null)}
                      onConfirmRevoke={() => handleRevoke(p.address)}
                    />
                  );
                })}
              </ul>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-100 bg-red-50 px-3 py-2 text-[11px] text-red-700">
              <span className="flex-1">{error}</span>
              {lastRefreshError && (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setLastRefreshError(null);
                    setRefreshToken((t) => t + 1);
                  }}
                  className="shrink-0 rounded-md border border-red-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-red-700 hover:bg-red-100"
                >
                  Retry
                </button>
              )}
            </div>
          )}

          <RecentActivitySection
            summary={summary}
            myAddress={myAddress}
          />

          <div className="rounded-md border border-gray-100 bg-gray-50 px-3 py-2 text-[11px] text-gray-500">
            <strong className="text-gray-700">How revoking works:</strong>{" "}
            removing someone rotates the encryption key so they can't see
            future edits. Content they already have on their device stays
            readable — encryption can't reach back in time.
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-gray-200 bg-gray-50 px-4 py-3">
          <span className="truncate font-mono text-[10px] text-gray-400">
            {summary.collabId}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[12px] font-semibold text-gray-600 hover:bg-gray-200"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Best-effort signal that a participant has been active in a collab.
 * We look for any pollSummary cursor in localStorage — CollabManager
 * writes one the first time it applies an op batch from that peer.
 * No cursor yet = we've never seen ops from them; either they haven't
 * accepted the invite or they've accepted but haven't edited anything.
 */
function peerHasSeenActivity(collabId: string, peerAddress: string): boolean {
  try {
    const ls = (globalThis as any).window?.localStorage;
    if (!ls) return false;
    const prefix = `swarm:collabPeerCursor:${collabId}:${peerAddress.toLowerCase()}:`;
    for (let i = 0; i < ls.length; i++) {
      const key = ls.key(i);
      if (key && key.startsWith(prefix)) return true;
    }
  } catch { /* no localStorage */ }
  return false;
}

function ParticipantRowSkeleton() {
  return (
    <li className="flex items-center gap-2.5 px-3 py-2">
      <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-gray-200" />
      <div className="flex-1 space-y-1">
        <div className="h-3 w-32 animate-pulse rounded bg-gray-200" />
        <div className="h-2.5 w-48 animate-pulse rounded bg-gray-100" />
      </div>
    </li>
  );
}

function ParticipantRow({
  participant,
  isMe,
  isInitiator,
  viewerIsInitiator,
  hasActivity,
  lastAppliedAt,
  opsApplied,
  confirming,
  busy,
  bulkSelectable,
  bulkSelected,
  onToggleBulk,
  onRequestRevoke,
  onCancelRevoke,
  onConfirmRevoke,
}: {
  participant: CollabParticipant;
  isMe: boolean;
  isInitiator: boolean;
  viewerIsInitiator: boolean;
  hasActivity: boolean;
  lastAppliedAt?: string;
  opsApplied: number;
  confirming: boolean;
  busy: boolean;
  bulkSelectable: boolean;
  bulkSelected: boolean;
  onToggleBulk: () => void;
  onRequestRevoke: () => void;
  onCancelRevoke: () => void;
  onConfirmRevoke: () => void;
}) {
  const canRevoke = viewerIsInitiator && !isInitiator && !isMe;
  const short = `${participant.address.slice(0, 10)}…${participant.address.slice(-4)}`;
  const label = participant.displayName ?? short;
  // Show the "awaiting" hint only for other participants (not the
  // viewer, not the owner) who haven't produced any activity yet.
  const awaiting = !isMe && !isInitiator && !hasActivity;
  const activeNow =
    lastAppliedAt !== undefined
    && Date.now() - new Date(lastAppliedAt).getTime() < 60_000;

  return (
    <li className={`flex items-center gap-2.5 px-3 py-2 text-[13px] ${bulkSelected ? "bg-blue-50" : ""}`}>
      {bulkSelectable && (
        <input
          type="checkbox"
          checked={bulkSelected}
          onChange={onToggleBulk}
          className="h-4 w-4 shrink-0 rounded border-gray-300 text-blue-600 focus:ring-blue-400"
          aria-label={`Select ${label}`}
        />
      )}
      <div className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[11px] font-semibold text-gray-600">
        {getInitials(label)}
        {activeNow && (
          <span
            className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-green-500"
            title="Active in the last minute"
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-semibold text-gray-900">{label}</span>
          {isInitiator && (
            <span className="rounded bg-blue-50 px-1 text-[9px] font-semibold uppercase tracking-wider text-blue-700">
              Owner
            </span>
          )}
          {isMe && (
            <span className="rounded bg-gray-100 px-1 text-[9px] font-semibold uppercase tracking-wider text-gray-500">
              You
            </span>
          )}
          {awaiting && (
            <span
              className="rounded bg-amber-50 px-1 text-[9px] font-semibold uppercase tracking-wider text-amber-700"
              title="No activity yet — they may not have accepted the invitation"
            >
              Awaiting
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-gray-400">
          <span className="truncate font-mono">{participant.address}</span>
          {lastAppliedAt && (
            <span
              className="shrink-0 whitespace-nowrap font-sans text-gray-500"
              title={`Last op applied ${new Date(lastAppliedAt).toLocaleString()} · ${opsApplied} ops this session`}
            >
              · {formatRelativeAgoShort(lastAppliedAt)}
              {opsApplied > 0 ? ` · ${opsApplied} ops` : ""}
            </span>
          )}
        </div>
      </div>

      {canRevoke && (
        confirming ? (
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              onClick={onConfirmRevoke}
              disabled={busy}
              style={{ backgroundColor: DANGER }}
              className="rounded-md px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-60"
            >
              {busy ? "Revoking…" : "Revoke access"}
            </button>
            <button
              type="button"
              onClick={onCancelRevoke}
              disabled={busy}
              className="rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onRequestRevoke}
            className="shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold text-gray-500 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
            title="Remove this participant"
          >
            Revoke
          </button>
        )
      )}
    </li>
  );
}

/**
 * Recent activity feed — shows the last ~20 events that CollabManager
 * has recorded for this collab (joins, revokes, op-applied batches).
 * Backed by `summary.recentActivity`, so a fresh browser sees the same
 * recent events after rehydrating from user-manifest.
 */
function RecentActivitySection({
  summary,
  myAddress,
}: {
  summary: CollabSummary;
  myAddress: string;
}) {
  const entries = summary.recentActivity ?? [];
  if (entries.length === 0) {
    return (
      <div>
        <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          Recent activity
        </h4>
        <div className="rounded-md border border-gray-100 bg-gray-50 px-3 py-2 text-[11px] text-gray-400">
          No activity yet.
        </div>
      </div>
    );
  }
  const me = myAddress.toLowerCase();
  // Newest first in the UI (storage keeps oldest-first for the ring
  // buffer).
  const reversed = [...entries].reverse();
  return (
    <div>
      <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
        Recent activity
      </h4>
      <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-gray-100 bg-gray-50 p-1.5">
        {reversed.map((entry, i) => (
          <li
            key={`${entry.at}-${i}`}
            className="flex items-start gap-2 rounded px-1.5 py-1 text-[11px]"
          >
            <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: activityColor(entry.kind) }} />
            <span className="flex-1 text-gray-700">{describeActivity(entry, me, summary.initiator)}</span>
            <span
              className="shrink-0 whitespace-nowrap text-[10px] text-gray-400"
              title={new Date(entry.at).toLocaleString()}
            >
              {formatRelativeAgoShort(entry.at)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function describeActivity(
  entry: NonNullable<CollabSummary["recentActivity"]>[number],
  me: string,
  initiator: string,
): string {
  const actor = (entry.actor ?? "").toLowerCase();
  const actorLabel = !actor
    ? "Someone"
    : actor === me
      ? "You"
      : actor === initiator
        ? "Owner"
        : `${actor.slice(0, 8)}…${actor.slice(-4)}`;
  switch (entry.kind) {
    case "created":
      return `${actorLabel} created the collaboration`;
    case "accepted":
      return `${actorLabel} joined`;
    case "left":
      return `${actorLabel} left`;
    case "participant-added":
      return `${actorLabel} added`;
    case "participant-revoked":
      return `${actorLabel} removed`;
    case "ops-applied": {
      const n = entry.opsCount ?? 0;
      const docBit = entry.docId ? ` on doc ${entry.docId.slice(0, 8)}…` : "";
      return `${actorLabel} applied ${n} op${n === 1 ? "" : "s"}${docBit}`;
    }
    default:
      return `${actorLabel} did something`;
  }
}

function activityColor(kind: NonNullable<CollabSummary["recentActivity"]>[number]["kind"]): string {
  switch (kind) {
    case "created":
    case "accepted":
      return "#10b981"; // green
    case "participant-added":
      return "#2563eb"; // blue
    case "participant-revoked":
    case "left":
      return "#dc2626"; // red
    case "ops-applied":
      return "#a16207"; // amber
    default:
      return "#9ca3af"; // gray
  }
}

function getInitials(name: string): string {
  if (name.startsWith("0x")) return name.slice(2, 4).toUpperCase();
  const parts = name.split(/[.\s]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** Compact relative time for inline labels ("now", "3m", "5h", "2d"). */
function formatRelativeAgoShort(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return "";
  const s = Math.floor(diff / 1000);
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
