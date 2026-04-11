import React, { useState } from "react";
import type { SwarmUiSnapshot } from "./types.js";
import { Section, SyncBadge, shortType } from "./primitives.js";

// ─── Tree Data Types ────────────────────────────────────────────

type DocEntry = { name?: string; documentType?: string; driveId?: string; parentFolder?: string };
type FolderEntry = { name: string; parentFolder?: string };

type TreeFolder = {
  id: string;
  name: string;
  subFolders: TreeFolder[];
  docs: Array<[string, DocEntry]>;
};

/**
 * Build a recursive tree from a flat folder map + document list.
 * Same algorithm as the Switchboard CLI's build_children():
 * 1. Find all nodes where parentFolder matches current parent
 * 2. Folders first (recurse), then files
 */
function buildFolderTree(
  folderId: string | null,
  folders: Record<string, FolderEntry>,
  docs: Array<[string, DocEntry]>,
): { subFolders: TreeFolder[]; docs: Array<[string, DocEntry]> } {
  const matchingFolders = Object.entries(folders)
    .filter(([, f]) => {
      const parent = f.parentFolder || null;
      return parent === folderId;
    })
    .sort(([, a], [, b]) => (a.name ?? "").localeCompare(b.name ?? ""));

  const matchingDocs = docs.filter(([, d]) => {
    const parent = d.parentFolder || null;
    return parent === folderId;
  });

  const subFolders: TreeFolder[] = matchingFolders.map(([id, f]) => {
    const children = buildFolderTree(id, folders, docs);
    return { id, name: f.name, subFolders: children.subFolders, docs: children.docs };
  });

  return { subFolders, docs: matchingDocs };
}

// ─── Components ─────────────────────────────────────────────────

function DocRow({
  docId,
  doc,
  indent,
  connector,
  syncState,
  pendingOps,
  full,
}: {
  docId: string;
  doc: DocEntry;
  indent?: boolean;
  connector?: string;
  syncState?: string;
  pendingOps?: number;
  full?: boolean;
}) {
  return (
    <div className={`flex items-center gap-2 ${indent ? "pl-4" : ""}`}>
      <SyncBadge state={syncState} />
      {connector && <span className="select-none text-gray-300">{connector}</span>}
      <span className="truncate" title={doc.name || docId}>
        {doc.name || docId.slice(0, 12)}
      </span>
      <span className="shrink-0 text-gray-400">({shortType(doc.documentType)})</span>
      <span className="shrink-0 text-gray-300" title={docId}>
        {full ? docId : docId.slice(0, 8)}
      </span>
      {syncState === "buffered" && (pendingOps ?? 0) > 0 && (
        <span className="shrink-0 text-yellow-500 text-[10px]">({pendingOps} pending)</span>
      )}
    </div>
  );
}

function FolderNode({
  folder,
  depth,
  syncStatus,
  full,
}: {
  folder: TreeFolder;
  depth: number;
  syncStatus?: Record<string, { state: string; pendingOps: number }>;
  full?: boolean;
}) {
  return (
    <div className="mb-0.5" style={{ paddingLeft: `${depth * 16}px` }}>
      <div className="flex items-center gap-1 text-gray-500">
        <span className="select-none text-gray-300">{"\u251C\u2500"}</span>
        <span className="font-medium">{folder.name}/</span>
      </div>
      {/* Sub-folders first (recursive) */}
      {folder.subFolders.map((sf) => (
        <FolderNode
          key={sf.id}
          folder={sf}
          depth={depth + 1}
          syncStatus={syncStatus}
          full={full}
        />
      ))}
      {/* Then docs */}
      {folder.docs.map(([docId, doc], i) => (
        <DocRow
          key={docId}
          docId={docId}
          doc={doc}
          indent
          connector={i === folder.docs.length - 1 ? "\u2514\u2500" : "\u251C\u2500"}
          syncState={syncStatus?.[docId]?.state}
          pendingOps={syncStatus?.[docId]?.pendingOps}
          full={full}
        />
      ))}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────

export function DocsTreeSection({
  docs,
  syncStatus,
  driveManifests,
  isContentAvailable,
  reuploadContent,
}: {
  docs: Array<[string, DocEntry]>;
  syncStatus?: Record<string, { state: string; pendingOps: number }>;
  driveManifests?: Record<string, { folders?: Record<string, FolderEntry> }>;
  isContentAvailable?: SwarmUiSnapshot["isContentAvailable"];
  reuploadContent?: SwarmUiSnapshot["reuploadContent"];
}) {
  const [expanded, setExpanded] = useState(false);
  const [fullView, setFullView] = useState(false);
  const [healthChecks, setHealthChecks] = useState<Record<string, boolean | "checking" | "reuploading">>({});

  const checkAvailability = async (docId: string) => {
    if (!isContentAvailable) return;
    setHealthChecks((prev) => ({ ...prev, [docId]: "checking" }));
    try {
      const available = await isContentAvailable(docId);
      setHealthChecks((prev) => ({ ...prev, [docId]: available }));
    } catch {
      setHealthChecks((prev) => ({ ...prev, [docId]: false }));
    }
  };

  const handleReupload = async (docId: string) => {
    if (!reuploadContent) return;
    setHealthChecks((prev) => ({ ...prev, [docId]: "reuploading" }));
    try {
      await reuploadContent(docId);
      setHealthChecks((prev) => ({ ...prev, [docId]: true }));
    } catch {
      setHealthChecks((prev) => ({ ...prev, [docId]: false }));
    }
  };

  if (docs.length === 0) {
    return (
      <Section title="Documents (0)">
        <p className="text-xs text-gray-400">No documents on Swarm yet</p>
      </Section>
    );
  }

  // Separate drives from child docs
  const drives = docs.filter(([, d]) => d.documentType === "powerhouse/document-drive");
  const childDocs = docs.filter(([, d]) => d.documentType !== "powerhouse/document-drive");
  const driveIds = new Set(drives.map(([id]) => id));

  // Group children by drive
  const driveChildren = new Map<string, typeof childDocs>();
  const orphans: typeof childDocs = [];
  for (const entry of childDocs) {
    const driveId = entry[1].driveId;
    if (driveId && driveIds.has(driveId)) {
      const existing = driveChildren.get(driveId) ?? [];
      existing.push(entry);
      driveChildren.set(driveId, existing);
    } else {
      orphans.push(entry);
    }
  }

  const treeContent = (full: boolean) => (
    <div className="font-mono text-xs leading-6 text-gray-600">
      {drives.map(([driveId, drive]) => {
        const children = driveChildren.get(driveId) ?? [];
        const folders = driveManifests?.[driveId]?.folders ?? {};

        // Build recursive tree from flat folder map + doc list
        const tree = buildFolderTree(null, folders, children);

        return (
          <div key={driveId} className="mb-1">
            <div className="flex items-center gap-2 text-gray-900">
              <SyncBadge state={syncStatus?.[driveId]?.state} />
              <span className="font-medium">{drive.name || "drive"}/</span>
              <span className="text-gray-300" title={driveId}>
                {full ? driveId : driveId.slice(0, 8)}
              </span>
            </div>
            {/* Folders first (recursive tree) */}
            {tree.subFolders.map((sf) => (
              <FolderNode
                key={sf.id}
                folder={sf}
                depth={1}
                syncStatus={syncStatus}
                full={full}
              />
            ))}
            {/* Root-level docs */}
            {tree.docs.map(([docId, doc], i) => (
              <DocRow
                key={docId}
                docId={docId}
                doc={doc}
                indent
                connector={
                  i === tree.docs.length - 1
                    ? "\u2514\u2500"
                    : "\u251C\u2500"
                }
                syncState={syncStatus?.[docId]?.state}
                pendingOps={syncStatus?.[docId]?.pendingOps}
                full={full}
              />
            ))}
          </div>
        );
      })}
      {orphans.length > 0 && drives.length > 0 ? (
        <div className="mt-1 border-t border-gray-100 pt-1 text-gray-400">unlinked:</div>
      ) : null}
      {orphans.map(([docId, doc]) => (
        <DocRow
          key={docId}
          docId={docId}
          doc={doc}
          syncState={syncStatus?.[docId]?.state}
          pendingOps={syncStatus?.[docId]?.pendingOps}
          full={full}
        />
      ))}
    </div>
  );

  return (
    <>
      <Section
        title={
          <div className="flex w-full items-center justify-between">
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1"
            >
              <span className="text-[10px]">{expanded ? "\u25BC" : "\u25B6"}</span>
              <span>Documents ({docs.length})</span>
            </button>
            {expanded && docs.length > 0 && (
              <button
                type="button"
                onClick={() => setFullView(true)}
                className="text-[10px] text-blue-500 hover:text-blue-700"
                title="Expand to full view"
              >
                expand
              </button>
            )}
          </div>
        }
      >
        {expanded ? (
          <div className="max-h-48 overflow-y-auto">{treeContent(false)}</div>
        ) : (
          <p className="text-xs text-gray-400">
            {drives.length} drive{drives.length !== 1 ? "s" : ""}, {childDocs.length} document
            {childDocs.length !== 1 ? "s" : ""}
          </p>
        )}
      </Section>

      {/* Full-screen overlay for browsing large document trees */}
      {fullView && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => {
            if (e.target === e.currentTarget) setFullView(false);
          }}
        >
          <div className="relative mx-4 flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="text-sm font-semibold text-gray-900">
                Swarm Documents ({docs.length})
              </h2>
              <div className="flex items-center gap-2">
                {isContentAvailable && (
                  <button
                    type="button"
                    onClick={() => docs.forEach(([id]) => checkAvailability(id))}
                    className="rounded-md px-2 py-1 text-[10px] text-blue-500 hover:bg-blue-50"
                  >
                    Check all availability
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setFullView(false)}
                  className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M4 4l8 8M12 4l-8 8"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {treeContent(true)}
              {/* Per-doc health checks in full view */}
              {Object.keys(healthChecks).length > 0 && (
                <div className="mt-3 border-t border-gray-100 pt-3">
                  <p className="text-[10px] font-medium text-gray-500 mb-1">Content Availability</p>
                  <div className="space-y-0.5">
                    {docs.map(([docId, doc]) => {
                      const status = healthChecks[docId];
                      if (status === undefined) return null;
                      return (
                        <div key={docId} className="flex items-center gap-2 text-[10px]">
                          {status === "checking" ? (
                            <span className="h-2 w-2 animate-spin rounded-full border border-blue-400 border-t-transparent" />
                          ) : status === "reuploading" ? (
                            <span className="h-2 w-2 animate-spin rounded-full border border-yellow-400 border-t-transparent" />
                          ) : status === true ? (
                            <span className="text-green-500" title="Available">{"\u2713"}</span>
                          ) : (
                            <span className="text-red-500" title="Not available">{"\u2717"}</span>
                          )}
                          <span className="text-gray-600">{doc.name || docId.slice(0, 12)}</span>
                          {status === false && reuploadContent && (
                            <button
                              type="button"
                              onClick={() => handleReupload(docId)}
                              className="text-blue-500 hover:text-blue-700 underline"
                            >
                              re-upload
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            <div className="border-t px-4 py-2 text-right">
              <span className="text-[10px] text-gray-400">
                {drives.length} drive{drives.length !== 1 ? "s" : ""} &middot; {childDocs.length}{" "}
                doc{childDocs.length !== 1 ? "s" : ""} &middot; {orphans.length} unlinked
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
