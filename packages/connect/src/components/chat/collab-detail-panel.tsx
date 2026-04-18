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
  const [addInput, setAddInput] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setAddInput("");
      setError(null);
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
    manager
      .refreshManifest(summary.collabId)
      .then((updated: CollabSummary | null) => {
        if (cancelled || !updated) return;
        onUpdated(updated);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          "Could not refresh membership from Swarm: " +
            (err instanceof Error ? err.message : String(err)),
        );
      })
      .finally(() => { if (!cancelled) setRefreshing(false); });
    return () => { cancelled = true; };
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
    const addr = addInput.trim().toLowerCase();
    if (!addr.startsWith("0x") || addr.length < 10) {
      setError("Paste a Swarm ID starting with 0x");
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
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg bg-white shadow-2xl"
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
                    placeholder="0x... (Swarm ID)"
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
                  They'll receive an invitation in chat and be granted read +
                  write access via a new ACT chain rotation.
                </p>
              </div>
            )}

            <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
              {summary.participants.map((p) => (
                <ParticipantRow
                  key={p.address}
                  participant={p}
                  isMe={p.address === myAddress.toLowerCase()}
                  isInitiator={p.address === summary.initiator}
                  viewerIsInitiator={isInitiator}
                  confirming={confirmRevoke === p.address}
                  busy={busyAddr === p.address}
                  onRequestRevoke={() => setConfirmRevoke(p.address)}
                  onCancelRevoke={() => setConfirmRevoke(null)}
                  onConfirmRevoke={() => handleRevoke(p.address)}
                />
              ))}
            </ul>
          </div>

          {error && (
            <div className="rounded-md border border-red-100 bg-red-50 px-3 py-2 text-[11px] text-red-700">
              {error}
            </div>
          )}

          <div className="rounded-md border border-gray-100 bg-gray-50 px-3 py-2 text-[11px] text-gray-500">
            <strong className="text-gray-700">How revocation works:</strong>{" "}
            removing someone rotates the encryption chain. Future operations
            can't be decrypted by them. Content they already have stays
            readable on their device — Swarm ACT can't rewind history.
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

function ParticipantRow({
  participant,
  isMe,
  isInitiator,
  viewerIsInitiator,
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
  confirming: boolean;
  busy: boolean;
  onRequestRevoke: () => void;
  onCancelRevoke: () => void;
  onConfirmRevoke: () => void;
}) {
  const canRevoke = viewerIsInitiator && !isInitiator && !isMe;
  const short = `${participant.address.slice(0, 10)}…${participant.address.slice(-4)}`;
  const label = participant.displayName ?? short;

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
