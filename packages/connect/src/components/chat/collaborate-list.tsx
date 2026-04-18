/**
 * CollaborateList — left-pane body for the Collaborate tab.
 *
 * Lists active collaborations (drive- or document-level multi-writer
 * sessions) and exposes the "New collaboration" entry point via a picker
 * modal. Pending invitations are not shown here — they live in chat as
 * CollabInviteCard messages.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useDrives } from "@powerhousedao/reactor-browser";
import type { CollabSummary, ConversationSummary } from "./types.js";
import { CollabDetailPanel } from "./collab-detail-panel.js";

const ACCENT = "#2563eb";

type DriveLike = {
  header: { id: string; name?: string };
  state?: { global?: { name?: string } };
};

export function CollaborateList({
  conversations,
  onOpenCollab,
}: {
  conversations: ConversationSummary[];
  onOpenCollab: (summary: CollabSummary) => void;
}) {
  const [summaries, setSummaries] = useState<CollabSummary[]>(() => readCollabs());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [detailCollabId, setDetailCollabId] = useState<string | null>(null);
  // Briefly-set "pulsing" collab ids — flash when an op-applied event
  // fires, so the row shows real-time collab activity the user can see.
  const [pulsingIds, setPulsingIds] = useState<Set<string>>(new Set());
  const myAddress = (
    (globalThis as any).window?.ph?.swarm?.client?.getOwnerAddress?.()
    ?? (globalThis as any).window?.ph?.swarm?.signerEntry?.swarmAddress
    ?? ""
  ).toLowerCase();
  const detailSummary = detailCollabId
    ? summaries.find((s) => s.collabId === detailCollabId) ?? null
    : null;

  // Refresh from the manager periodically (and on storage events from other
  // tabs). The manager persists to localStorage, so reading from there is
  // always authoritative without needing a React context bridge for MVP.
  useEffect(() => {
    const refresh = () => setSummaries(readCollabs());
    const id = setInterval(refresh, 2000);
    window.addEventListener("storage", refresh);
    // Real-time signal: CollabManager fires this after applying a peer's
    // ops to the local reactor. We both refresh the summary list (so
    // lastActivityAt bumps) and pulse the row for a second so the user
    // gets a visible sign that collaboration is live.
    const onApplied = (e: Event) => {
      const collabId = (e as CustomEvent<{ collabId?: string }>).detail?.collabId;
      refresh();
      if (collabId) {
        setPulsingIds((prev) => {
          const next = new Set(prev);
          next.add(collabId);
          return next;
        });
        setTimeout(() => {
          setPulsingIds((prev) => {
            const next = new Set(prev);
            next.delete(collabId);
            return next;
          });
        }, 1500);
      }
    };
    window.addEventListener("swarm:collab:op-applied", onApplied as EventListener);
    return () => {
      clearInterval(id);
      window.removeEventListener("storage", refresh);
      window.removeEventListener("swarm:collab:op-applied", onApplied as EventListener);
    };
  }, []);

  const handleCreate = useCallback(
    async (input: {
      driveId: string;
      documentId?: string;
      participantAddresses: string[];
      caption?: string;
    }) => {
      const manager = (globalThis as any).window?.ph?.swarm?.collab?.manager;
      if (!manager) throw new Error("Collaboration is not initialized");
      await manager.create({
        target: { driveId: input.driveId, documentId: input.documentId },
        participants: input.participantAddresses,
        caption: input.caption,
      });
      setSummaries(readCollabs());
    },
    [],
  );

  const handleLeave = async (collabId: string) => {
    const manager = (globalThis as any).window?.ph?.swarm?.collab?.manager;
    if (!manager) return;
    try {
      await manager.leave(collabId);
    } catch (err) {
      console.warn("[CollaborateList] leave failed:", err);
    }
    setSummaries(readCollabs());
  };

  // Stable reference — the detail panel's manifest-refresh effect
  // depends on this callback; recreating it every render causes an
  // infinite refresh loop (2s poll timer → re-render → new callback
  // → effect reruns → calls setSummaries → re-render → ...).
  const handleCollabUpdated = useCallback((updated: CollabSummary) => {
    setSummaries((prev) => {
      const idx = prev.findIndex((s) => s.collabId === updated.collabId);
      if (idx < 0) return [updated, ...prev];
      const next = [...prev];
      next[idx] = updated;
      return next;
    });
  }, []);

  const handleDetailClose = useCallback(() => setDetailCollabId(null), []);

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-hidden">
      <div>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          Collaborations
        </h3>
        <div className="rounded-lg border border-gray-100 bg-white p-3">
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="w-full rounded-md py-2 text-xs font-semibold text-white transition-colors"
            style={{ backgroundColor: ACCENT }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#1d4ed8")}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = ACCENT)}
          >
            New collaboration
          </button>
          <p className="mt-2.5 text-[11px] leading-snug text-gray-400">
            Pick a drive and invite peers by <strong className="text-gray-600">Swarm ID</strong>.
            They receive an invitation in chat and can accept with one click.
          </p>
        </div>
      </div>

      {notice && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
          {notice}
        </div>
      )}

      <div className="-mx-1 flex-1 overflow-y-auto px-1">
        {summaries.length === 0 ? (
          <div className="px-2 py-8 text-center text-xs text-gray-400">
            No collaborations yet. Start one above or accept an invitation in chat.
          </div>
        ) : (
          summaries.map((s) => (
            <CollabRow
              key={s.collabId}
              summary={s}
              pulsing={pulsingIds.has(s.collabId)}
              onOpen={() => onOpenCollab(s)}
              onManage={() => setDetailCollabId(s.collabId)}
              onLeave={() => handleLeave(s.collabId)}
            />
          ))
        )}
      </div>

      <CollabDetailPanel
        isOpen={!!detailSummary}
        summary={detailSummary}
        myAddress={myAddress}
        onClose={handleDetailClose}
        onUpdated={handleCollabUpdated}
      />

      <CollabCreatePicker
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onCreate={async (input) => {
          try {
            await handleCreate(input);
            setPickerOpen(false);
            setNotice(null);
          } catch (err) {
            setNotice(err instanceof Error ? err.message : String(err));
          }
        }}
        knownPeers={conversations}
      />
    </div>
  );
}

// ─── Collab row ──────────────────────────────────────────────────

function CollabRow({
  summary,
  pulsing,
  onOpen,
  onManage,
  onLeave,
}: {
  summary: CollabSummary;
  pulsing: boolean;
  onOpen: () => void;
  onManage: () => void;
  onLeave: () => void;
}) {
  const participantCount = summary.participants.length;
  const otherCount = Math.max(0, participantCount - 1);
  const statusLabel =
    summary.status === "pending" ? "setup" :
    summary.status === "revoked" ? "revoked" :
    summary.status === "error" ? "error" :
    "open";
  const statusColor =
    summary.status === "revoked" ? "text-red-500" :
    summary.status === "error" ? "text-amber-600" :
    "text-gray-400";

  const lastActivityRel = summary.lastActivityAt
    ? formatRelativeAgo(summary.lastActivityAt)
    : "";

  return (
    <div
      className={`mb-1 rounded-lg border px-2.5 py-2.5 transition-colors ${
        pulsing
          ? "border-green-200 bg-green-50"
          : "border-transparent hover:bg-gray-50"
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-2.5 text-left"
      >
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[10px] font-bold text-white"
          style={{ backgroundColor: summary.kind === "document" ? "#7c3aed" : "#0ea5e9" }}
        >
          {summary.kind === "document" ? "DOC" : "DRIVE"}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-gray-900">
            {summary.title}
          </div>
          <div className="mt-0.5 truncate text-xs text-gray-400">
            {otherCount === 0
              ? "Just you"
              : `You + ${otherCount} participant${otherCount !== 1 ? "s" : ""}`}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <span className={`flex items-center gap-1 text-[10px] uppercase tracking-wider ${statusColor}`}>
            {pulsing && (
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
            )}
            {statusLabel}
          </span>
          {lastActivityRel && (
            <span className="text-[10px] text-gray-400">{lastActivityRel}</span>
          )}
        </div>
      </button>
      <div className="mt-1 flex justify-end gap-2">
        <button
          type="button"
          onClick={onManage}
          className="text-[10px] font-semibold text-blue-600 hover:underline"
          title="Manage access, add or revoke participants"
        >
          Manage
        </button>
        <button
          type="button"
          onClick={onLeave}
          className="text-[10px] font-semibold text-gray-400 hover:text-red-600"
          title="Leave this collaboration"
        >
          Leave
        </button>
      </div>
    </div>
  );
}

// ─── Create picker ────────────────────────────────────────────────

type CollabScope = "drive" | "document";

type DocNode = { id: string; name: string; documentType?: string };

async function listDriveDocuments(driveId: string): Promise<DocNode[]> {
  const ph = (globalThis as any).window?.ph;
  const reactorClient = ph?.reactorClient;
  if (!reactorClient) return [];
  try {
    const driveDoc = await reactorClient.get(driveId);
    const nodes: any[] = driveDoc?.state?.global?.nodes ?? [];
    return nodes
      .filter((n) => n?.kind === "file" && n?.id)
      .map((n) => ({
        id: n.id,
        name: n.name ?? n.id,
        documentType: n.documentType,
      }));
  } catch {
    return [];
  }
}

function CollabCreatePicker({
  isOpen,
  onClose,
  onCreate,
  knownPeers,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (input: {
    driveId: string;
    documentId?: string;
    participantAddresses: string[];
    caption?: string;
  }) => Promise<void>;
  knownPeers: ConversationSummary[];
}) {
  const drives = useDrives() as DriveLike[] | undefined;
  const [selectedDriveId, setSelectedDriveId] = useState<string | null>(null);
  const [scope, setScope] = useState<CollabScope>("drive");
  const [documents, setDocuments] = useState<DocNode[] | null>(null);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [selectedPeers, setSelectedPeers] = useState<Set<string>>(new Set());
  const [manualAddress, setManualAddress] = useState("");
  const [caption, setCaption] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setSelectedDriveId(null);
      setScope("drive");
      setDocuments(null);
      setSelectedDocId(null);
      setSelectedPeers(new Set());
      setManualAddress("");
      setCaption("");
      setSubmitting(false);
    }
  }, [isOpen]);

  // Load docs when the user switches to document scope (and a drive is picked)
  useEffect(() => {
    if (scope !== "document" || !selectedDriveId) {
      setDocuments(null);
      setSelectedDocId(null);
      return;
    }
    let cancelled = false;
    setLoadingDocs(true);
    listDriveDocuments(selectedDriveId)
      .then((docs) => { if (!cancelled) setDocuments(docs); })
      .finally(() => { if (!cancelled) setLoadingDocs(false); });
    return () => { cancelled = true; };
  }, [scope, selectedDriveId]);

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

  const togglePeer = (addr: string) => {
    setSelectedPeers((prev) => {
      const next = new Set(prev);
      const key = addr.toLowerCase();
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const addManual = () => {
    const addr = manualAddress.trim().toLowerCase();
    if (!addr.startsWith("0x") || addr.length < 10) return;
    setSelectedPeers((prev) => new Set(prev).add(addr));
    setManualAddress("");
  };

  const participantAddresses = useMemo(
    () => Array.from(selectedPeers),
    [selectedPeers],
  );

  const selectedDrive = drives?.find((d) => d.header.id === selectedDriveId);
  const driveName =
    selectedDrive?.state?.global?.name ?? selectedDrive?.header.name ?? "";

  const canSubmit =
    !!selectedDriveId
    && participantAddresses.length > 0
    && (scope === "drive" || !!selectedDocId)
    && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit || !selectedDriveId) return;
    setSubmitting(true);
    try {
      await onCreate({
        driveId: selectedDriveId,
        documentId: scope === "document" ? selectedDocId ?? undefined : undefined,
        participantAddresses,
        caption: caption.trim() || undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div
      role="dialog"
      aria-label="Start a collaboration"
      data-chat-overlay="true"
      onClick={onClose}
      className="fixed inset-0 z-[999] flex items-center justify-center bg-black/60 p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg bg-white shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-gray-200 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Start a collaboration</h3>
            <p className="mt-0.5 text-[11px] text-gray-400">
              Pick a drive and invite peers · live multi-writer via Swarm ACT
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
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              Drive
            </span>
            <select
              value={selectedDriveId ?? ""}
              onChange={(e) => setSelectedDriveId(e.target.value || null)}
              className="w-full rounded-md border border-gray-300 bg-white px-2.5 py-2 text-[13px] text-gray-800 outline-none focus:border-blue-400"
            >
              <option value="">Select a drive…</option>
              {drives?.map((d) => (
                <option key={d.header.id} value={d.header.id}>
                  {d.state?.global?.name ?? d.header.name ?? d.header.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>

          {selectedDriveId && (
            <div>
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                Scope
              </span>
              <div className="flex gap-1 rounded-md border border-gray-200 bg-gray-50 p-1">
                <button
                  type="button"
                  onClick={() => setScope("drive")}
                  className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                    scope === "drive"
                      ? "bg-white text-blue-700 shadow-sm"
                      : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  Entire drive
                </button>
                <button
                  type="button"
                  onClick={() => setScope("document")}
                  className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                    scope === "document"
                      ? "bg-white text-blue-700 shadow-sm"
                      : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  Single document
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-gray-400">
                {scope === "drive"
                  ? <>Every document in <strong>{driveName}</strong> will be live-shared — participants can read and write to all of them.</>
                  : <>Only the chosen document will be live-shared. Other docs in <strong>{driveName}</strong> stay private.</>
                }
              </p>
            </div>
          )}

          {scope === "document" && selectedDriveId && (
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                Document
              </span>
              {loadingDocs ? (
                <div className="flex items-center justify-center rounded-md border border-gray-200 bg-gray-50 py-4">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5" className="animate-spin">
                    <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
                  </svg>
                </div>
              ) : !documents || documents.length === 0 ? (
                <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-3 text-[12px] text-gray-400">
                  No documents in this drive.
                </div>
              ) : (
                <select
                  value={selectedDocId ?? ""}
                  onChange={(e) => setSelectedDocId(e.target.value || null)}
                  className="w-full rounded-md border border-gray-300 bg-white px-2.5 py-2 text-[13px] text-gray-800 outline-none focus:border-blue-400"
                >
                  <option value="">Select a document…</option>
                  {documents.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {d.documentType ? ` — ${d.documentType}` : ""}
                    </option>
                  ))}
                </select>
              )}
            </label>
          )}

          <div>
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              Participants
            </span>
            {knownPeers.length > 0 && (
              <div className="mb-2 max-h-40 overflow-y-auto rounded-md border border-gray-200 bg-gray-50">
                <ul className="divide-y divide-gray-100">
                  {knownPeers.map((peer) => {
                    const addr = peer.peerAddress.toLowerCase();
                    const checked = selectedPeers.has(addr);
                    const label =
                      peer.peerDisplayName
                      || `${peer.peerAddress.slice(0, 10)}…${peer.peerAddress.slice(-4)}`;
                    return (
                      <li key={addr}>
                        <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-white">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => togglePeer(addr)}
                            className="h-4 w-4 shrink-0 rounded border-gray-300 text-blue-600 focus:ring-blue-400"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] text-gray-800">{label}</div>
                            {peer.peerDisplayName && (
                              <div className="truncate font-mono text-[10px] text-gray-400">
                                {peer.peerAddress}
                              </div>
                            )}
                          </div>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <div className="flex gap-2">
              <input
                type="text"
                value={manualAddress}
                onChange={(e) => setManualAddress(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addManual()}
                placeholder="0x... (Swarm ID, not wallet)"
                className="flex-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-blue-400"
              />
              <button
                type="button"
                onClick={addManual}
                disabled={!manualAddress.trim()}
                className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40"
              >
                Add
              </button>
            </div>

            {participantAddresses.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {participantAddresses.map((addr) => (
                  <span
                    key={addr}
                    className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700"
                  >
                    {addr.slice(0, 8)}…{addr.slice(-4)}
                    <button
                      type="button"
                      onClick={() => togglePeer(addr)}
                      className="text-blue-400 hover:text-blue-700"
                      title="Remove"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              Message (optional)
            </span>
            <textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="What's this collaboration about?"
              rows={2}
              className="w-full resize-none rounded-md border border-gray-300 bg-white px-2.5 py-2 text-[13px] leading-relaxed text-gray-800 outline-none placeholder:text-gray-400 focus:border-blue-400"
            />
          </label>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-gray-200 bg-gray-50 px-4 py-3">
          <span className="text-[11px] text-gray-500">
            {participantAddresses.length === 0
              ? "Pick at least one participant"
              : `${participantAddresses.length} invited`}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-[12px] font-semibold text-gray-600 hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              style={{ backgroundColor: canSubmit ? ACCENT : "#93c5fd" }}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold text-white transition-opacity disabled:opacity-60"
            >
              {submitting ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="animate-spin">
                    <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
                  </svg>
                  Creating…
                </>
              ) : (
                "Start collaboration"
              )}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── localStorage readthrough ────────────────────────────────────

const LS_KEY = "swarm:collabs";

function formatRelativeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return "";
  const s = Math.floor(diff / 1000);
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function readCollabs(): CollabSummary[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.sort((a, b) =>
      String(b.lastActivityAt ?? "").localeCompare(String(a.lastActivityAt ?? "")),
    );
  } catch {
    return [];
  }
}
