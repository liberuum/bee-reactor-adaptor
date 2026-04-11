import React, { useState } from "react";
import type { SwarmUiSnapshot } from "./types.js";
import { ActionButton, Section } from "./primitives.js";
import { isValidHexAddress, normalizeAddr } from "./constants.js";
import { toast } from "../../../../../services/toast.js";

type FolderEntry = { name: string; parentFolder?: string };
type DocEntry = { name?: string; documentType?: string; driveId?: string; parentFolder?: string };

type ShareTreeFolder = {
  id: string;
  name: string;
  subFolders: ShareTreeFolder[];
  docs: Array<[string, DocEntry]>;
};

function buildShareTree(
  parentId: string | null,
  folders: Record<string, FolderEntry>,
  docs: Array<[string, DocEntry]>,
): { subFolders: ShareTreeFolder[]; docs: Array<[string, DocEntry]> } {
  const matchingFolders = Object.entries(folders)
    .filter(([, f]) => (f.parentFolder || null) === parentId)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name));
  const matchingDocs = docs.filter(([, d]) => (d.parentFolder || null) === parentId);
  const subFolders = matchingFolders.map(([id, f]) => {
    const children = buildShareTree(id, folders, docs);
    return { id, name: f.name, subFolders: children.subFolders, docs: children.docs };
  });
  return { subFolders, docs: matchingDocs };
}

function ShareFolderNode({
  folder,
  depth,
  shareSelected,
  toggleDoc,
}: {
  folder: ShareTreeFolder;
  depth: number;
  shareSelected: Set<string>;
  toggleDoc: (id: string) => void;
}) {
  return (
    <div style={{ marginLeft: `${depth * 16}px` }}>
      <span className="text-gray-500 text-[10px]">{folder.name}/</span>
      {/* Docs first, then sub-folders */}
      {folder.docs.map(([id, d]) => (
        <label
          key={id}
          className="flex items-center gap-1.5 ml-3 cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5"
        >
          <input
            type="checkbox"
            checked={shareSelected.has(id)}
            onChange={() => toggleDoc(id)}
            className="accent-blue-600"
          />
          <span className="text-gray-600">{d.name || id.slice(0, 8)}</span>
        </label>
      ))}
      {folder.subFolders.map((sf) => (
        <ShareFolderNode
          key={sf.id}
          folder={sf}
          depth={depth + 1}
          shareSelected={shareSelected}
          toggleDoc={toggleDoc}
        />
      ))}
    </div>
  );
}

function ShareTreeGlobal({
  drives,
  childDocs,
  orphans,
  driveManifests,
  shareSelected,
  toggleDrive,
  toggleDoc,
  maxCollapsed,
  needsGlobalExpand,
}: {
  drives: Array<[string, { name?: string; documentType?: string }]>;
  childDocs: Array<[string, DocEntry]>;
  orphans: Array<[string, { name?: string; documentType?: string }]>;
  driveManifests: Record<string, { folders?: Record<string, FolderEntry> }>;
  shareSelected: Set<string>;
  toggleDrive: (id: string) => void;
  toggleDoc: (id: string) => void;
  maxCollapsed: number;
  needsGlobalExpand: boolean;
}) {
  const [expanded, setExpanded] = useState(!needsGlobalExpand);
  let itemCount = 0;

  return (
    <div className="mb-3 space-y-1 font-mono text-xs max-h-64 overflow-y-auto">
      {drives.map(([driveId, drive]) => {
        const children = childDocs.filter(([, d]) => d.driveId === driveId);
        const allChecked =
          children.length > 0 && children.every(([id]) => shareSelected.has(id));
        const folders = driveManifests[driveId]?.folders ?? {};

        // Build recursive tree — same algorithm as documents view
        const tree = buildShareTree(null, folders, children);

        const driveStart = itemCount;
        itemCount += 1 + children.length;
        const showThisDrive = expanded || driveStart < maxCollapsed;
        if (!showThisDrive) return null;

        return (
          <div key={driveId}>
            <label className="flex items-center gap-1.5 cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5">
              <input
                type="checkbox"
                checked={allChecked}
                onChange={() => toggleDrive(driveId)}
                className="accent-blue-600"
                disabled={children.length === 0}
              />
              <span className="font-medium text-gray-700">
                {drive.name || driveId.slice(0, 8)}
              </span>
              <span className="text-gray-400 text-[10px]">
                ({children.length} doc{children.length !== 1 ? "s" : ""})
              </span>
            </label>
            {/* Root docs first, then folders (top-down) */}
            {tree.docs.map(([id, d]) => (
              <label
                key={id}
                className="flex items-center gap-1.5 ml-5 cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5"
              >
                <input
                  type="checkbox"
                  checked={shareSelected.has(id)}
                  onChange={() => toggleDoc(id)}
                  className="accent-blue-600"
                />
                <span className="text-gray-600">{d.name || id.slice(0, 8)}</span>
              </label>
            ))}
            {tree.subFolders.map((sf) => (
              <ShareFolderNode
                key={sf.id}
                folder={sf}
                depth={1}
                shareSelected={shareSelected}
                toggleDoc={toggleDoc}
              />
            ))}
          </div>
        );
      })}
      {orphans.map(([id, d]) => {
        itemCount++;
        if (!expanded && itemCount > maxCollapsed) return null;
        return (
          <label
            key={id}
            className="flex items-center gap-1.5 cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5"
          >
            <input
              type="checkbox"
              checked={shareSelected.has(id)}
              onChange={() => toggleDoc(id)}
              className="accent-blue-600"
            />
            <span className="text-gray-600">{d.name || id.slice(0, 8)}</span>
          </label>
        );
      })}
      {needsGlobalExpand && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[10px] text-blue-500 hover:text-blue-700"
        >
          {expanded ? "show less" : `show all ${childDocs.length + orphans.length} docs...`}
        </button>
      )}
    </div>
  );
}

// ─── Section Components ────────────────────────────────────────

export function ShareSection({
  swarm,
  docs,
  ready,
}: {
  swarm: SwarmUiSnapshot;
  docs: Array<
    [string, { name?: string; documentType?: string; driveId?: string; parentFolder?: string }]
  >;
  ready: boolean;
}) {
  const [shareSelected, setShareSelected] = useState<Set<string>>(new Set());
  const [shareRecipient, setShareRecipient] = useState("");
  const [sharing, setSharing] = useState(false);
  const [shareResult, setShareResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const drives = docs.filter(([, d]) => d.documentType === "powerhouse/document-drive");
  const driveIds = new Set(drives.map(([id]) => id));
  const childDocs = docs.filter(([, d]) => d.documentType !== "powerhouse/document-drive");
  const orphans = childDocs.filter(([, d]) => !d.driveId || !driveIds.has(d.driveId));

  const toggleDoc = (id: string) => {
    setShareSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setShareResult(null);
  };

  const toggleDrive = (driveId: string) => {
    const children = childDocs
      .filter(([, d]) => d.driveId === driveId)
      .map(([id]) => id);
    setShareSelected((prev) => {
      const next = new Set(prev);
      const allSelected = children.every((id) => next.has(id));
      if (allSelected) {
        children.forEach((id) => next.delete(id));
      } else {
        children.forEach((id) => next.add(id));
      }
      return next;
    });
    setShareResult(null);
  };

  if (drives.length === 0 && childDocs.length === 0) {
    return (
      <Section title="Share">
        <p className="text-xs text-gray-400 italic">No documents to share yet.</p>
      </Section>
    );
  }

  const totalItems = childDocs.length + drives.length;
  const MAX_COLLAPSED = 5;
  const needsGlobalExpand = totalItems > MAX_COLLAPSED;
  const dm = swarm.userManifest?.driveManifests ?? {};

  return (
    <Section title="Share">
      <p className="mb-2 text-xs text-gray-400">
        Select a drive or individual documents, then enter the recipient&apos;s Swarm ID.
      </p>

      <ShareTreeGlobal
        drives={drives}
        childDocs={childDocs}
        orphans={orphans}
        driveManifests={dm}
        shareSelected={shareSelected}
        toggleDrive={toggleDrive}
        toggleDoc={toggleDoc}
        maxCollapsed={MAX_COLLAPSED}
        needsGlobalExpand={needsGlobalExpand}
      />

      <div className="flex gap-2 mb-2">
        <input
          type="text"
          placeholder="Recipient's Swarm ID (0x...)"
          value={shareRecipient}
          onChange={(e) => setShareRecipient(e.target.value)}
          className="flex-1 rounded-md border border-gray-200 px-2 py-1.5 text-xs font-mono"
        />
        <ActionButton
          onClick={async () => {
            if (shareSelected.size === 0 || !shareRecipient || !swarm.shareDocuments) return;
            const toShare = [...shareSelected];
            setSharing(true);
            setShareResult(null);
            try {
              const r = await swarm.shareDocuments(toShare, normalizeAddr(shareRecipient));
              if (r.success) {
                toast(
                  `Shared ${r.shared} document${r.shared !== 1 ? "s" : ""} via Swarm`,
                  { type: "connect-success" },
                );
                setShareResult({
                  ok: true,
                  msg: `Shared ${r.shared} document${r.shared !== 1 ? "s" : ""} successfully!`,
                });
                setShareSelected(new Set());
                setShareRecipient("");
              } else {
                const errMsg = r.error ?? "Share failed";
                toast(errMsg, { type: "connect-warning" });
                setShareResult({ ok: false, msg: errMsg });
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : "Share failed";
              toast(errMsg, { type: "connect-warning" });
              setShareResult({ ok: false, msg: errMsg });
            } finally {
              setSharing(false);
            }
          }}
          loading={sharing}
          disabled={!ready || shareSelected.size === 0 || !isValidHexAddress(shareRecipient)}
          variant="primary"
        >
          {sharing
            ? `Sharing ${shareSelected.size}...`
            : `Share ${shareSelected.size > 0 ? `(${shareSelected.size})` : ""}`}
        </ActionButton>
      </div>
      {shareResult && (
        <p className={`text-xs ${shareResult.ok ? "text-green-600" : "text-red-500"}`}>
          {shareResult.msg}
        </p>
      )}
    </Section>
  );
}

export function ImportSection({
  swarm,
  ready,
}: {
  swarm: SwarmUiSnapshot;
  ready: boolean;
}) {
  const [importSender, setImportSender] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ ok: boolean; msg: string } | null>(null);

  return (
    <Section title="Import from Swarm User">
      <p className="mb-2 text-xs text-gray-400">
        Enter the Swarm ID of a user who shared documents with you. Your Bee node will
        decrypt the shared data automatically.
      </p>
      <div className="flex gap-2 mb-2">
        <input
          type="text"
          placeholder="Sender's Swarm ID (0x...)"
          value={importSender}
          onChange={(e) => setImportSender(e.target.value)}
          className="flex-1 rounded-md border border-gray-200 px-2 py-1.5 text-xs font-mono"
        />
        <ActionButton
          onClick={async () => {
            if (!importSender || !swarm.importSharedDocuments) return;
            const sender = importSender.trim();
            if (!isValidHexAddress(sender)) return;
            setImporting(true);
            setImportResult(null);
            try {
              const result = await swarm.importSharedDocuments(normalizeAddr(sender));
              if (result.success) {
                toast(
                  `Imported ${result.imported.length} document(s) from Swarm`,
                  { type: "connect-success" },
                );
                setImportResult({
                  ok: true,
                  msg: `Imported ${result.imported.length} document(s). Refresh to see them.`,
                });
                setImportSender("");
              } else {
                const errMsg = result.error ?? "Import failed";
                toast(errMsg, { type: "connect-warning" });
                setImportResult({ ok: false, msg: errMsg });
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : "Import failed";
              toast(errMsg, { type: "connect-warning" });
              setImportResult({ ok: false, msg: errMsg });
            } finally {
              setImporting(false);
            }
          }}
          loading={importing}
          disabled={!ready || !isValidHexAddress(importSender)}
          variant="primary"
        >
          {importing ? "Importing..." : "Import"}
        </ActionButton>
      </div>
      {importResult && (
        <p className={`text-xs ${importResult.ok ? "text-green-600" : "text-red-500"}`}>
          {importResult.msg}
        </p>
      )}
    </Section>
  );
}
