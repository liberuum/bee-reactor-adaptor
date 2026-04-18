/**
 * CollabDetailPanel — modal dialog that shows participants of a collab
 * and lets the initiator add / revoke access.
 *
 * Non-initiators see a read-only view.
 *
 * All writes go through the adapter's CollabManager, which rotates the
 * ACT grantee chain and publishes a new manifest feed revision.
 */
import React, { useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import type { CollabSummary, CollabParticipant } from "./types.js";

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

  useEffect(() => {
    if (!isOpen) {
      setAddInput("");
      setError(null);
      setLastRefreshError(null);
      setBusyAddr(null);
      setAddBusy(false);
      setConfirmRevoke(null);
      setShowAdd(false);
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
    const addr = addInput.trim().toLowerCase();
    if (!addr.startsWith("0x") || addr.length < 10) {
      setError("Paste a peer address starting with 0x");
      return;
    }
    setAddBusy(true);
    setError(null);
    try {
      const updated = await manager.addParticipant(summary.collabId, addr);
      if (updated) onUpdated(updated);
      setAddInput("");
      setShowAdd(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddBusy(false);
    }
  }, [summary?.collabId, addInput, onUpdated]);

  if (!isOpen || !summary) return null;

  const isInitiator = summary.initiator === myAddress.toLowerCase();

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
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                Participants
              </span>
              {isInitiator && !showAdd && (
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

            {isInitiator && showAdd && (
              <div className="mb-2 rounded-md border border-gray-200 bg-gray-50 p-2.5">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={addInput}
                    onChange={(e) => setAddInput(e.target.value)}
                    placeholder="0x… peer address"
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
                  They'll get a one-click invite in chat. Once they join, you
                  can both edit together in real time.
                </p>
              </div>
            )}

            {refreshing && summary.participants.length === 0 ? (
              <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
                <ParticipantRowSkeleton />
                <ParticipantRowSkeleton />
                <ParticipantRowSkeleton />
              </ul>
            ) : (
              <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
                {summary.participants.map((p) => (
                  <ParticipantRow
                    key={p.address}
                    participant={p}
                    isMe={p.address === myAddress.toLowerCase()}
                    isInitiator={p.address === summary.initiator}
                    viewerIsInitiator={isInitiator}
                    // "Awaiting response" when there's no record of
                    // ops arriving from this peer yet. Imperfect (they
                    // might have joined silently), but useful signal
                    // for the common case right after inviting.
                    hasActivity={peerHasSeenActivity(summary.collabId, p.address)}
                    confirming={confirmRevoke === p.address}
                    busy={busyAddr === p.address}
                    onRequestRevoke={() => setConfirmRevoke(p.address)}
                    onCancelRevoke={() => setConfirmRevoke(null)}
                    onConfirmRevoke={() => handleRevoke(p.address)}
                  />
                ))}
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
  confirming,
  busy,
  onRequestRevoke,
  onCancelRevoke,
  onConfirmRevoke,
}: {
  participant: CollabParticipant;
  isMe: boolean;
  isInitiator: boolean;
  viewerIsInitiator: boolean;
  hasActivity: boolean;
  confirming: boolean;
  busy: boolean;
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

  return (
    <li className="flex items-center gap-2.5 px-3 py-2 text-[13px]">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[11px] font-semibold text-gray-600">
        {getInitials(label)}
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
        <div className="truncate font-mono text-[10px] text-gray-400">
          {participant.address}
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
            className="shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold text-gray-500 transition-colors hover:bg-red-50 hover:text-red-600"
            title="Remove this participant"
          >
            Revoke
          </button>
        )
      )}
    </li>
  );
}

function getInitials(name: string): string {
  if (name.startsWith("0x")) return name.slice(2, 4).toUpperCase();
  const parts = name.split(/[.\s]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
