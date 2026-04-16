/**
 * DocumentSharePicker — modal that lets the user pick documents from one
 * of their drives and share them into the active chat conversation.
 *
 * Mounted from ChatPanel. Renders to document.body via createPortal with
 * a data-chat-overlay marker so the sidebar's click-outside handler
 * doesn't close the chat panel when users interact with this modal.
 */
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useDrives } from "@powerhousedao/reactor-browser";

const ACCENT = "#2563eb";

type DriveLike = {
  header: { id: string; name?: string };
  state?: { global?: { name?: string } };
};

type DocNode = {
  id: string;
  name: string;
  documentType?: string;
};

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

export function DocumentSharePicker({
  isOpen,
  peerLabel,
  onClose,
  onShare,
}: {
  isOpen: boolean;
  peerLabel: string;
  onClose: () => void;
  onShare: (driveId: string, driveName: string, docIds: string[], text?: string) => Promise<void> | void;
}) {
  const drives = useDrives() as DriveLike[] | undefined;
  const [selectedDriveId, setSelectedDriveId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DocNode[] | null>(null);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [caption, setCaption] = useState("");
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState("");

  // Reset state on open/close
  useEffect(() => {
    if (!isOpen) {
      setSelectedDriveId(null);
      setDocuments(null);
      setSelectedDocIds(new Set());
      setCaption("");
      setSearch("");
      setSubmitting(false);
    }
  }, [isOpen]);

  // Load documents whenever the user picks a drive
  useEffect(() => {
    if (!selectedDriveId) { setDocuments(null); return; }
    let cancelled = false;
    setLoadingDocs(true);
    setDocuments(null);
    setSelectedDocIds(new Set());
    listDriveDocuments(selectedDriveId)
      .then((docs) => { if (!cancelled) setDocuments(docs); })
      .finally(() => { if (!cancelled) setLoadingDocs(false); });
    return () => { cancelled = true; };
  }, [selectedDriveId]);

  // ESC to close, body scroll-lock
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

  const filteredDocs = useMemo(() => {
    if (!documents) return [] as DocNode[];
    const q = search.trim().toLowerCase();
    if (!q) return documents;
    return documents.filter((d) => d.name.toLowerCase().includes(q));
  }, [documents, search]);

  const selectedDrive = drives?.find((d) => d.header.id === selectedDriveId);
  const driveName = selectedDrive?.state?.global?.name ?? selectedDrive?.header.name ?? "";

  const toggleDoc = (docId: string) => {
    setSelectedDocIds((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  };

  const toggleAll = () => {
    if (!documents) return;
    if (selectedDocIds.size === documents.length) {
      setSelectedDocIds(new Set());
    } else {
      setSelectedDocIds(new Set(documents.map((d) => d.id)));
    }
  };

  const canShare = !!selectedDriveId && selectedDocIds.size > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canShare || !selectedDriveId) return;
    setSubmitting(true);
    try {
      await onShare(selectedDriveId, driveName, [...selectedDocIds], caption);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div
      role="dialog"
      aria-label="Share documents"
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
            <h3 className="text-sm font-semibold text-gray-900">
              Share documents {peerLabel ? `with ${peerLabel}` : ""}
            </h3>
            <p className="mt-0.5 text-[11px] text-gray-400">
              Encrypted end-to-end via Swarm ACT · recipient can import into their drives
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
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                  Documents ({documents?.length ?? 0})
                </span>
                {!loadingDocs && documents && documents.length > 0 && (
                  <button
                    type="button"
                    onClick={toggleAll}
                    className="text-[11px] font-semibold text-blue-600 hover:text-blue-800"
                  >
                    {selectedDocIds.size === documents.length ? "Clear all" : "Select all"}
                  </button>
                )}
              </div>

              {documents && documents.length > 0 && (
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search documents…"
                  className="mb-2 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] outline-none placeholder:text-gray-400 focus:border-blue-400"
                />
              )}

              <div className="max-h-64 overflow-y-auto rounded-md border border-gray-200 bg-gray-50">
                {loadingDocs ? (
                  <div className="flex items-center justify-center py-8">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5" className="animate-spin">
                      <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
                    </svg>
                  </div>
                ) : !documents || documents.length === 0 ? (
                  <div className="px-4 py-8 text-center text-[12px] text-gray-400">
                    No documents in this drive.
                  </div>
                ) : filteredDocs.length === 0 ? (
                  <div className="px-4 py-8 text-center text-[12px] text-gray-400">
                    No documents match "{search}".
                  </div>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {filteredDocs.map((doc) => {
                      const checked = selectedDocIds.has(doc.id);
                      return (
                        <li key={doc.id}>
                          <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-white">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleDoc(doc.id)}
                              className="h-4 w-4 shrink-0 rounded border-gray-300 text-blue-600 focus:ring-blue-400"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[13px] text-gray-800">{doc.name}</div>
                              {doc.documentType && (
                                <div className="truncate text-[10px] text-gray-400">{doc.documentType}</div>
                              )}
                            </div>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          )}

          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              Message (optional)
            </span>
            <textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Add a note about what you're sharing…"
              rows={2}
              className="w-full resize-none rounded-md border border-gray-300 bg-white px-2.5 py-2 text-[13px] leading-relaxed text-gray-800 outline-none placeholder:text-gray-400 focus:border-blue-400"
            />
          </label>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-gray-200 bg-gray-50 px-4 py-3">
          <span className="text-[11px] text-gray-500">
            {selectedDocIds.size === 0
              ? "Pick at least one document"
              : `${selectedDocIds.size} selected`}
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
              disabled={!canShare}
              style={{ backgroundColor: canShare ? ACCENT : "#93c5fd" }}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold text-white transition-opacity disabled:opacity-60"
            >
              {submitting ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="animate-spin">
                    <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
                  </svg>
                  Sharing…
                </>
              ) : (
                "Share"
              )}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
