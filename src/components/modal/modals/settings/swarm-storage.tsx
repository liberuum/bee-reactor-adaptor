import { Icon } from "@powerhousedao/design-system";
import React, { useEffect, useState } from "react";

/** Snapshot from SwarmConnectPlugin / window.ph.swarm (loose typing for fork UI). */
export type SwarmUiSnapshot = {
  ready?: boolean;
  /** Plugin lifecycle status for loading UI */
  status?: "initializing" | "disconnected" | "no-stamp" | "ready";
  statusMessage?: string;
  plugin?: { clearCache: () => Promise<void> };
  reconnect?: () => Promise<void>;
  clearStorage?: () => Promise<void>;
  stampStatus?: {
    capacityBytes: number;
    usedBytes?: number;
    remainingBytes?: number;
    capacityHuman?: string;
    remainingHuman?: string;
    utilization: number;
    health: string;
    ttlHuman: string;
    expiresAt?: string;
    depth?: number;
    bucketDepth?: number;
    batchId?: string;
    totalCostBzz?: string;
    totalCostUsd?: string | null;
    bzzUsdPrice?: number | null;
  };
  userManifest?: {
    documents: Record<string, { name?: string; documentType?: string; driveId?: string; parentFolder?: string }>;
    /** Drive manifests with folder info */
    driveManifests?: Record<string, { folders?: Record<string, { name: string; parentFolder?: string }> }>;
  };
  signerEntry?: {
    /** ownerAddress from SwarmSignerEntry (wallet-signer.ts) */
    ownerAddress?: string;
    swarmPublicKey?: string;
  };
  client?: {
    topUpStamp: (amount: string) => Promise<void>;
    expandStamp: (depth: number) => Promise<void>;
    createStamp: (amount: string, depth: number) => Promise<string>;
    getStampOptions?: () => Promise<{
      currentDepth: number;
      currentTtlSeconds: number;
      pricePerBlock: number;
      blockTime: number;
      sizeOptions: Array<{ depth: number; label: string; effectiveBytes: number }>;
      durationOptions: Array<{ days: number; label: string; amount: string }>;
    }>;
  };
  /** Whether the Bee node is running in dev mode (no stamp management) */
  isDevMode?: boolean;
  nodeWallet?: string;
  nodeBalances?: { xBZZ: string; xDAI: string };
  /** Per-document sync status */
  syncStatus?: Record<string, { state: "buffered" | "flushing" | "synced" | "error"; pendingOps: number; updatedAt: number }>;
  /** Total bytes uploaded to Swarm this session (tracked by plugin) */
  totalBytesUploaded?: number;
  /** Share documents with another user (clean slate — replaces previous shares to this recipient) */
  shareDocuments?: (docIds: string[], recipientAddress: string) => Promise<{ success: boolean; shared: number; error?: string }>;
  /** Import documents shared by another user */
  importSharedDocuments?: (senderAddress: string) => Promise<{ success: boolean; imported: string[]; error?: string }>;
  /** Look up a user's public profile */
  lookupUser?: (address: string) => Promise<{ address: string; beeNodePublicKey: string } | null>;
  /** Current Bee node URL */
  beeUrl?: string;
  /** Change Bee node URL and reconnect */
  setBeeUrl?: (url: string) => Promise<void>;
};

function StatusDot({ color }: { color: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        backgroundColor: color,
        marginRight: 6,
        flexShrink: 0,
      }}
    />
  );
}

function CopyableValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      title="Click to copy"
      className="cursor-pointer select-all break-all text-left font-mono text-xs text-gray-700 hover:text-gray-900"
    >
      {copied ? "Copied!" : value}
    </button>
  );
}

function Row({
  label,
  value,
  mono,
  copyable,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  /** When set, the raw string is shown in full and is click-to-copy */
  copyable?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <span className="shrink-0 text-gray-500">{label}</span>
      {copyable ? (
        <CopyableValue value={copyable} />
      ) : (
        <span className={mono ? "font-mono text-xs text-gray-700" : "text-gray-900"}>
          {value ?? "—"}
        </span>
      )}
    </div>
  );
}

function UtilBar({ pct }: { pct: number }) {
  return (
    <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
      <div
        style={{ width: `${Math.min(pct, 100)}%` }}
        className={`h-full rounded-full transition-all ${pct > 90 ? "bg-red-500" : pct > 70 ? "bg-yellow-500" : "bg-green-500"}`}
      />
    </div>
  );
}

function healthColor(h: string) {
  if (h === "healthy") return "#22c55e";
  if (h === "warning") return "#eab308";
  if (h === "critical" || h === "expired") return "#ef4444";
  return "#9ca3af";
}

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">{title}</h3>
      <div className="rounded-lg border border-gray-100 bg-white p-3">{children}</div>
    </div>
  );
}

const GNOSIS_CHAIN_ID = "0x64";
const XBZZ_TOKEN = "0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da";
const XBZZ_DECIMALS = 16;

/** Storage size presets matching beeport (depth → human-readable capacity) */
const SIZE_OPTIONS = [
  { depth: 19, label: "110 MB" },
  { depth: 20, label: "680 MB" },
  { depth: 21, label: "2.6 GB" },
  { depth: 22, label: "7.7 GB" },
  { depth: 23, label: "20 GB" },
  { depth: 24, label: "47 GB" },
  { depth: 25, label: "105 GB" },
  { depth: 26, label: "227 GB" },
  { depth: 27, label: "476 GB" },
];

/** Duration presets matching beeport */
const DURATION_OPTIONS = [
  { days: 1, label: "~1 day" },
  { days: 2, label: "~2 days" },
  { days: 7, label: "~7 days" },
  { days: 15, label: "~15 days" },
  { days: 30, label: "~30 days" },
  { days: 90, label: "~90 days" },
  { days: 180, label: "~180 days" },
  { days: 365, label: "~1 year" },
];

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function formatBZZ(plur: string) {
  try {
    const n = BigInt(plur);
    const whole = n / BigInt(10 ** XBZZ_DECIMALS);
    const frac = n % BigInt(10 ** XBZZ_DECIMALS);
    const fracStr = frac.toString().padStart(XBZZ_DECIMALS, "0").slice(0, 4);
    return `${whole}.${fracStr}`;
  } catch {
    return plur;
  }
}

function formatDAI(wei: string) {
  try {
    const n = BigInt(wei);
    const whole = n / BigInt(10 ** 18);
    const frac = n % BigInt(10 ** 18);
    const fracStr = frac.toString().padStart(18, "0").slice(0, 4);
    return `${whole}.${fracStr}`;
  } catch {
    return wei;
  }
}

function AlertBanner({
  type,
  children,
}: {
  type: "critical" | "warning" | "info";
  children: React.ReactNode;
}) {
  const colors =
    type === "critical"
      ? "border-red-200 bg-red-50 text-red-800"
      : type === "warning"
        ? "border-yellow-200 bg-yellow-50 text-yellow-800"
        : "border-blue-200 bg-blue-50 text-blue-800";
  return <div className={`mb-4 rounded-lg border p-3 text-sm ${colors}`}>{children}</div>;
}

function ActionButton({
  onClick,
  disabled,
  loading,
  children,
  variant,
}: {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  children: React.ReactNode;
  variant?: "primary";
}) {
  const base =
    "rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50";
  const styles =
    variant === "primary"
      ? `${base} bg-blue-600 text-white hover:bg-blue-700`
      : `${base} border border-gray-200 text-gray-700 hover:bg-gray-50`;
  return (
    <button type="button" disabled={disabled || loading} onClick={onClick} className={styles}>
      {loading ? "Processing..." : children}
    </button>
  );
}

async function ensureGnosisChain() {
  const eth = window.ethereum;
  if (!eth) throw new Error("No wallet found");
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: GNOSIS_CHAIN_ID }],
    });
  } catch (switchErr: unknown) {
    const code = (switchErr as { code?: number }).code;
    if (code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: GNOSIS_CHAIN_ID,
            chainName: "Gnosis Chain",
            nativeCurrency: { name: "xDAI", symbol: "xDAI", decimals: 18 },
            rpcUrls: ["https://rpc.gnosischain.com"],
            blockExplorerUrls: ["https://gnosisscan.io"],
          },
        ],
      });
    } else {
      throw switchErr;
    }
  }
}

async function sendXDAI(to: string, amountWei: string) {
  await ensureGnosisChain();
  const eth = window.ethereum!;
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const from = accounts[0];
  return eth.request({
    method: "eth_sendTransaction",
    params: [{ from, to, value: "0x" + BigInt(amountWei).toString(16) }],
  }) as Promise<string>;
}

async function sendXBZZ(to: string, amountPlur: string) {
  await ensureGnosisChain();
  const eth = window.ethereum!;
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const from = accounts[0];
  const amt = BigInt(amountPlur).toString(16).padStart(64, "0");
  const toStripped = to.replace("0x", "").padStart(64, "0");
  const data = "0xa9059cbb" + toStripped + amt;
  return eth.request({
    method: "eth_sendTransaction",
    params: [{ from, to: XBZZ_TOKEN, data }],
  }) as Promise<string>;
}

function SyncBadge({ state }: { state?: string }) {
  if (!state || state === "synced") return <span className="text-green-400" title="Synced to Swarm">●</span>;
  if (state === "buffered") return <span className="text-yellow-400 animate-pulse" title="Buffered (waiting to sync)">●</span>;
  if (state === "flushing") return <span className="text-blue-400 animate-pulse" title="Syncing to Swarm...">●</span>;
  if (state === "error") return <span className="text-red-400" title="Sync error">●</span>;
  return null;
}

/** Renders one doc entry row — reused in both inline and expanded views */
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
  doc: { name?: string; documentType?: string };
  indent?: boolean;
  connector?: string;
  syncState?: string;
  pendingOps?: number;
  /** Show full IDs and types instead of truncated */
  full?: boolean;
}) {
  return (
    <div className={`flex items-center gap-2 ${indent ? "pl-4" : ""}`}>
      <SyncBadge state={syncState} />
      {connector && <span className="select-none text-gray-300">{connector}</span>}
      <span className="truncate" title={doc.name || docId}>{doc.name || docId.slice(0, 12)}</span>
      <span className="shrink-0 text-gray-400">({shortType(doc.documentType)})</span>
      <span className="shrink-0 text-gray-300" title={docId}>{full ? docId : docId.slice(0, 8)}</span>
      {syncState === "buffered" && (pendingOps ?? 0) > 0 && (
        <span className="shrink-0 text-yellow-500 text-[10px]">({pendingOps} pending)</span>
      )}
    </div>
  );
}

function DocsTreeSection({
  docs,
  syncStatus,
  driveManifests,
}: {
  docs: Array<[string, { name?: string; documentType?: string; driveId?: string; parentFolder?: string }]>;
  syncStatus?: Record<string, { state: string; pendingOps: number }>;
  driveManifests?: Record<string, { folders?: Record<string, { name: string; parentFolder?: string }> }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [fullView, setFullView] = useState(false);

  if (docs.length === 0) {
    return (
      <Section title="Documents (0)">
        <p className="text-xs text-gray-400">No documents on Swarm yet</p>
      </Section>
    );
  }

  // Group: drives first, then child docs grouped under their drive
  const drives = docs.filter(([, d]) => d.documentType === "powerhouse/document-drive");
  const childDocs = docs.filter(([, d]) => d.documentType !== "powerhouse/document-drive");
  const driveIds = new Set(drives.map(([id]) => id));

  // Build drive → children map
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

  /** Render docs for a folder (recursive) */
  const renderFolder = (
    folderId: string,
    folderName: string,
    allChildren: typeof childDocs,
    folders: Record<string, { name: string; parentFolder?: string }>,
    depth: number,
    full: boolean,
  ): React.ReactNode => {
    const docsInFolder = allChildren.filter(([, d]) => d.parentFolder === folderId);
    const subFolders = Object.entries(folders).filter(([, f]) => f.parentFolder === folderId);
    if (docsInFolder.length === 0 && subFolders.length === 0) return null;
    return (
      <div key={folderId} className="mb-0.5" style={{ paddingLeft: `${depth * 16}px` }}>
        <div className="flex items-center gap-1 text-gray-500">
          <span className="select-none text-gray-300">├─</span>
          <span className="font-medium">{folderName}/</span>
        </div>
        {subFolders.map(([sfId, sf]) => renderFolder(sfId, sf.name, allChildren, folders, depth + 1, full))}
        {docsInFolder.map(([docId, doc], i) => (
          <DocRow
            key={docId}
            docId={docId}
            doc={doc}
            indent
            connector={i === docsInFolder.length - 1 ? "└─" : "├─"}
            syncState={syncStatus?.[docId]?.state}
            pendingOps={syncStatus?.[docId]?.pendingOps}
            full={full}
          />
        ))}
      </div>
    );
  };

  const treeContent = (full: boolean) => (
    <div className={`font-mono text-xs leading-6 text-gray-600`}>
      {drives.map(([driveId, drive]) => {
        const children = driveChildren.get(driveId) ?? [];
        const folders = driveManifests?.[driveId]?.folders ?? {};
        const rootDocs = children.filter(([, d]) => !d.parentFolder || !folders[d.parentFolder]);
        const folderDocIds = new Set(
          children.filter(([, d]) => d.parentFolder && folders[d.parentFolder]).map(([id]) => id),
        );
        const rootFolders = Object.entries(folders).filter(([, f]) => !f.parentFolder);

        return (
          <div key={driveId} className="mb-1">
            <div className="flex items-center gap-2 text-gray-900">
              <SyncBadge state={syncStatus?.[driveId]?.state} />
              <span className="font-medium">{drive.name || "drive"}/</span>
              <span className="text-gray-300" title={driveId}>{full ? driveId : driveId.slice(0, 8)}</span>
            </div>
            {/* Root-level folders */}
            {rootFolders.map(([fId, f]) => renderFolder(fId, f.name, children, folders, 1, full))}
            {/* Root-level docs (not in any folder) */}
            {rootDocs.map(([docId, doc], i) => (
              <DocRow
                key={docId}
                docId={docId}
                doc={doc}
                indent
                connector={i === rootDocs.length - 1 && folderDocIds.size === 0 ? "└─" : "├─"}
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
      <Section title={
        <div className="flex w-full items-center justify-between">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1"
          >
            <span className="text-[10px]">{expanded ? "▼" : "▶"}</span>
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
      }>
        {expanded ? (
          <div className="max-h-48 overflow-y-auto">
            {treeContent(false)}
          </div>
        ) : (
          <p className="text-xs text-gray-400">
            {drives.length} drive{drives.length !== 1 ? "s" : ""}, {childDocs.length} document{childDocs.length !== 1 ? "s" : ""}
          </p>
        )}
      </Section>

      {/* Full-screen overlay for browsing large document trees */}
      {fullView && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => { if (e.target === e.currentTarget) setFullView(false); }}
        >
          <div className="relative mx-4 flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="text-sm font-semibold text-gray-900">
                Swarm Documents ({docs.length})
              </h2>
              <button
                type="button"
                onClick={() => setFullView(false)}
                className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {treeContent(true)}
            </div>
            <div className="border-t px-4 py-2 text-right">
              <span className="text-[10px] text-gray-400">
                {drives.length} drive{drives.length !== 1 ? "s" : ""} · {childDocs.length} doc{childDocs.length !== 1 ? "s" : ""} · {orphans.length} unlinked
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Global share tree — collapses when total items > maxCollapsed, with folder hierarchy */
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
  childDocs: Array<[string, { name?: string; documentType?: string; driveId?: string; parentFolder?: string }]>;
  orphans: Array<[string, { name?: string; documentType?: string }]>;
  driveManifests: Record<string, { folders?: Record<string, { name: string; parentFolder?: string }> }>;
  shareSelected: Set<string>;
  toggleDrive: (id: string) => void;
  toggleDoc: (id: string) => void;
  maxCollapsed: number;
  needsGlobalExpand: boolean;
}) {
  const [expanded, setExpanded] = useState(!needsGlobalExpand);

  // Build flat list of all items for collapsed view
  let itemCount = 0;

  return (
    <div className="mb-3 space-y-1 font-mono text-xs max-h-64 overflow-y-auto">
      {drives.map(([driveId, drive]) => {
        const children = childDocs.filter(([, d]) => d.driveId === driveId);
        const allChecked = children.length > 0 && children.every(([id]) => shareSelected.has(id));
        const folders = driveManifests[driveId]?.folders ?? {};
        const rootChildren = children.filter(([, d]) => !d.parentFolder || !folders[d.parentFolder!]);
        const rootFolders = Object.entries(folders).filter(([, f]) => !f.parentFolder);

        // Track items for global collapse
        const driveStart = itemCount;
        itemCount += 1 + children.length; // drive + children
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
              <span className="font-medium text-gray-700">{drive.name || driveId.slice(0, 8)}</span>
              <span className="text-gray-400 text-[10px]">({children.length} doc{children.length !== 1 ? "s" : ""})</span>
            </label>
            {/* Folders */}
            {rootFolders.map(([fId, f]) => {
              const docsInFolder = children.filter(([, d]) => d.parentFolder === fId);
              if (docsInFolder.length === 0) return null;
              return (
                <div key={fId} className="ml-5">
                  <span className="text-gray-500 text-[10px]">{f.name}/</span>
                  {docsInFolder.map(([id, d]) => (
                    <label key={id} className="flex items-center gap-1.5 ml-3 cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5">
                      <input type="checkbox" checked={shareSelected.has(id)} onChange={() => toggleDoc(id)} className="accent-blue-600" />
                      <span className="text-gray-600">{d.name || id.slice(0, 8)}</span>
                    </label>
                  ))}
                </div>
              );
            })}
            {/* Root docs (not in folder) */}
            {rootChildren.map(([id, d]) => (
              <label key={id} className="flex items-center gap-1.5 ml-5 cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5">
                <input type="checkbox" checked={shareSelected.has(id)} onChange={() => toggleDoc(id)} className="accent-blue-600" />
                <span className="text-gray-600">{d.name || id.slice(0, 8)}</span>
              </label>
            ))}
          </div>
        );
      })}
      {orphans.map(([id, d]) => {
        itemCount++;
        if (!expanded && itemCount > maxCollapsed) return null;
        return (
          <label key={id} className="flex items-center gap-1.5 cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5">
            <input type="checkbox" checked={shareSelected.has(id)} onChange={() => toggleDoc(id)} className="accent-blue-600" />
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

/** @deprecated Use ShareTreeGlobal instead */
function ShareDriveTree({
  driveId,
  driveName,
  children,
  allChecked,
  toggleDrive,
  toggleDoc,
  shareSelected,
  maxVisible,
  needsCollapse,
}: {
  driveId: string;
  driveName: string;
  children: Array<[string, { name?: string; documentType?: string; driveId?: string }]>;
  allChecked: boolean;
  toggleDrive: (id: string) => void;
  toggleDoc: (id: string) => void;
  shareSelected: Set<string>;
  maxVisible: number;
  needsCollapse: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = needsCollapse && !expanded ? children.slice(0, maxVisible) : children;
  const hiddenCount = children.length - maxVisible;

  return (
    <div>
      <label className="flex items-center gap-1.5 cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5">
        <input
          type="checkbox"
          checked={allChecked}
          onChange={() => toggleDrive(driveId)}
          className="accent-blue-600"
          disabled={children.length === 0}
        />
        <span className="font-medium text-gray-700">{driveName}</span>
        <span className="text-gray-400 text-[10px]">({children.length} doc{children.length !== 1 ? "s" : ""})</span>
      </label>
      {visible.map(([id, d]) => (
        <label key={id} className="flex items-center gap-1.5 ml-5 cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5">
          <input
            type="checkbox"
            checked={shareSelected.has(id)}
            onChange={() => toggleDoc(id)}
            className="accent-blue-600"
          />
          <span className="text-gray-600">{d.name || id.slice(0, 8)}</span>
        </label>
      ))}
      {needsCollapse && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="ml-5 mt-0.5 text-[10px] text-blue-500 hover:text-blue-700"
        >
          {expanded ? "show less" : `+${hiddenCount} more doc${hiddenCount !== 1 ? "s" : ""}...`}
        </button>
      )}
    </div>
  );
}

function shortType(t?: string): string {
  if (!t) return "?";
  // "powerhouse/document-model" → "document-model"
  const parts = t.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : t;
}

export const SwarmStorageSettings: React.FC = () => {
  const [swarm, setSwarm] = useState<SwarmUiSnapshot | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearingStorage, setClearingStorage] = useState(false);
  const [beeUrlInput, setBeeUrlInput] = useState("http://localhost:1633");
  const [savingBeeUrl, setSavingBeeUrl] = useState(false);

  // Sharing state
  const [shareSelected, setShareSelected] = useState<Set<string>>(new Set());
  const [shareRecipient, setShareRecipient] = useState("");
  const [sharing, setSharing] = useState(false);
  const [shareResult, setShareResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [importSender, setImportSender] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ ok: boolean; msg: string } | null>(null);

  /** Validate a hex address — accepts with or without 0x prefix, 40 hex chars */
  const isValidHexAddress = (addr: string) => {
    const trimmed = addr.trim().replace(/^0x/i, "");
    return /^[a-fA-F0-9]{40}$/.test(trimmed);
  };
  /** Normalize: ensure 0x prefix */
  const normalizeAddr = (addr: string) => {
    const trimmed = addr.trim();
    return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  };
  const [topUpBusy, setTopUpBusy] = useState(false);
  const [expandBusy, setExpandBusy] = useState(false);
  const [fundBusy, setFundBusy] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ ok: boolean; msg: string } | null>(null);
  const [stampOptions, setStampOptions] = useState<{
    sizeOptions: Array<{ depth: number; label: string }>;
    durationOptions: Array<{ days: number; label: string; amount: string }>;
    currentDepth: number;
  } | null>(null);
  const [selectedSize, setSelectedSize] = useState<number | null>(null);
  const [selectedDuration, setSelectedDuration] = useState<{ days: number; amount: string } | null>(null);

  useEffect(() => {
    const read = () => {
      const ph = window.ph as { swarm?: SwarmUiSnapshot } | undefined;
      const s = ph?.swarm;
      if (!s) { setSwarm(null); return; }
      // Deep-copy userManifest so React detects changes to documents/driveManifests
      const um = s.userManifest;
      setSwarm({
        ...s,
        userManifest: um ? {
          documents: { ...um.documents },
          driveManifests: um.driveManifests ? { ...um.driveManifests } : undefined,
        } : undefined,
      });
    };
    read();
    const id = setInterval(read, 2000);
    return () => clearInterval(id);
  }, []);

  // Sync Bee URL input when swarm state becomes available
  useEffect(() => {
    if (swarm?.beeUrl && swarm.beeUrl !== beeUrlInput) {
      setBeeUrlInput(swarm.beeUrl);
    }
  }, [swarm?.beeUrl]);

  // Load stamp options when client is ready
  useEffect(() => {
    const client = swarm?.client;
    if (!client?.getStampOptions) return;
    client.getStampOptions().then(setStampOptions).catch(() => {});
  }, [swarm?.client, swarm?.ready]);

  const showStatus = (ok: boolean, msg: string) => {
    setStatusMsg({ ok, msg });
    setTimeout(() => setStatusMsg(null), 6000);
  };

  const currentBeeUrl = swarm?.beeUrl || "http://localhost:1633";
  const beeUrlChanged = beeUrlInput.trim().replace(/\/+$/, "") !== currentBeeUrl;

  if (!swarm) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-gray-400">
        <Icon name="Globe" size={32} />
        <p className="text-sm">Swarm plugin not active</p>
        <p className="text-xs">SwarmConnectPlugin must be started before using Swarm storage.</p>
      </div>
    );
  }

  if (swarm.status && swarm.status !== "ready") {
    const isError = swarm.status === "disconnected" || swarm.status === "no-stamp";
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
        <Icon name="Globe" size={32} className={isError ? "text-red-400" : "text-blue-400"} />
        {swarm.status === "initializing" && (
          <div className="flex items-center gap-2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
            <p className="text-sm text-gray-600">Initializing Swarm connection...</p>
          </div>
        )}
        {isError && (
          <p className="text-sm font-medium text-red-500">
            {swarm.status === "disconnected" ? "Bee node not connected" : "No postage stamp"}
          </p>
        )}
        {swarm.statusMessage && (
          <p className="max-w-sm text-center text-xs text-gray-500">{swarm.statusMessage}</p>
        )}
        {swarm.status === "disconnected" && (
          <div className="mt-2 rounded-md bg-gray-50 p-3 text-xs text-gray-600">
            <p className="font-medium mb-1">Setup instructions:</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>Download Bee from github.com/ethersphere/bee/releases</li>
              <li>Run <code className="bg-gray-200 px-1 rounded">bee dev</code> for testing or configure a full node</li>
              <li>Reload this page once the node is running</li>
            </ol>
          </div>
        )}
      </div>
    );
  }

  const stamp = swarm.stampStatus;
  const manifest = swarm.userManifest;
  const signer = swarm.signerEntry;
  const client = swarm.client;
  const nodeWallet = swarm.nodeWallet;
  const balances = swarm.nodeBalances;
  const docs = manifest ? Object.entries(manifest.documents) : [];
  const ready = swarm.ready;
  const isDevMode = swarm.isDevMode;

  const handleClearCache = async () => {
    if (!swarm.reconnect) return;
    setClearing(true);
    try {
      await swarm.reconnect();
    } finally {
      setClearing(false);
    }
  };

  const handleFundBZZ = async () => {
    if (!nodeWallet) return;
    setFundBusy(true);
    try {
      const txHash = await sendXBZZ(nodeWallet, "10000000000000000");
      showStatus(true, `Sent 1 xBZZ to Bee node. Tx: ${txHash.slice(0, 14)}...`);
    } catch (err) {
      showStatus(false, err instanceof Error ? err.message : "xBZZ transfer failed");
    } finally {
      setFundBusy(false);
    }
  };

  const handleFundDAI = async () => {
    if (!nodeWallet) return;
    setFundBusy(true);
    try {
      const txHash = await sendXDAI(nodeWallet, "100000000000000000");
      showStatus(true, `Sent 0.1 xDAI to Bee node. Tx: ${txHash.slice(0, 14)}...`);
    } catch (err) {
      showStatus(false, err instanceof Error ? err.message : "xDAI transfer failed");
    } finally {
      setFundBusy(false);
    }
  };

  // ─── Stamp management with human-readable options ───────────────

  const handleTopUp = async () => {
    if (!client || !selectedDuration) return;
    setTopUpBusy(true);
    try {
      await client.topUpStamp(selectedDuration.amount);
      showStatus(true, `Stamp topped up — ~${selectedDuration.days} days added.`);
      setSelectedDuration(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Top up failed";
      if (msg.includes("insufficient") || msg.includes("500")) {
        showStatus(false, "Bee node wallet has insufficient xBZZ. Fund it first via the wallet section above.");
      } else {
        showStatus(false, `Top up failed: ${msg}`);
      }
    } finally {
      setTopUpBusy(false);
    }
  };

  const handleExpand = async () => {
    if (!client || !selectedSize) return;
    setExpandBusy(true);
    try {
      await client.expandStamp(selectedSize);
      showStatus(true, `Capacity expanded to depth ${selectedSize}. Duration may have decreased — consider topping up.`);
      setSelectedSize(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Expand failed";
      if (msg.includes("500") || msg.includes("insufficient")) {
        showStatus(false, "Expand failed — check Bee node wallet balance and logs.");
      } else {
        showStatus(false, `Expand failed: ${msg}`);
      }
    } finally {
      setExpandBusy(false);
    }
  };

  const handleCreateStamp = async () => {
    if (!client) return;
    const depth = selectedSize ?? 22;
    const amount = selectedDuration?.amount ?? "414720000";
    setCreateBusy(true);
    try {
      const sizeLabel = stampOptions?.sizeOptions.find((s) => s.depth === depth)?.label ?? `depth ${depth}`;
      const durLabel = selectedDuration ? `~${selectedDuration.days} days` : "~7 days";
      const batchId = await client.createStamp(amount, depth);
      showStatus(true, `Stamp created: ${batchId.slice(0, 12)}... (${sizeLabel}, ${durLabel}). Allow a few minutes for propagation.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Stamp creation failed";
      if (msg.includes("insufficient") || msg.includes("500")) {
        showStatus(false, "Stamp creation failed — Bee node wallet needs xBZZ. Fund it first.");
      } else {
        showStatus(false, `Stamp creation failed: ${msg}`);
      }
    } finally {
      setCreateBusy(false);
    }
  };

  const usedBytes = stamp?.usedBytes ?? (stamp ? Math.round(stamp.capacityBytes * (stamp.utilization / 100)) : 0);
  const needsAttention =
    stamp &&
    (stamp.health === "warning" || stamp.health === "critical" || stamp.health === "expired");
  const capacityHigh = stamp && stamp.utilization > 80;
  const hasWallet = !!window.ethereum;

  return (
    <div className="overflow-y-auto p-4" style={{ maxHeight: "calc(70vh - 100px)" }}>
      <div className="flex flex-col gap-1">
        {statusMsg ? (
          <AlertBanner type={statusMsg.ok ? "info" : "critical"}>
            <p>{statusMsg.msg}</p>
          </AlertBanner>
        ) : null}
        {needsAttention && stamp ? (
          <AlertBanner
            type={stamp.health === "critical" || stamp.health === "expired" ? "critical" : "warning"}
          >
            <p className="font-medium">
              {stamp.health === "expired"
                ? "Stamp expired — uploads are disabled! Top up using the controls below."
                : stamp.health === "critical"
                  ? `Stamp expires in ${stamp.ttlHuman}! Top up below to keep your data available.`
                  : `Stamp expires in ${stamp.ttlHuman}. Consider topping up below.`}
            </p>
          </AlertBanner>
        ) : null}
        {capacityHigh && stamp ? (
          <AlertBanner type={stamp.utilization >= 100 ? "critical" : "warning"}>
            <p className="font-medium">
              {stamp.utilization >= 100
                ? "Storage full — new uploads will fail! Expand capacity below."
                : `Storage ${stamp.utilization}% full. Expand capacity below or uploads may fail.`}
            </p>
          </AlertBanner>
        ) : null}
        <Section title="Connection">
          <div className="mb-2">
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500 shrink-0">Bee Node</label>
              <input
                type="text"
                value={beeUrlInput}
                placeholder="https://your-bee-node.com:1633"
                onChange={(e) => setBeeUrlInput(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === "Enter" && beeUrlChanged && swarm.setBeeUrl) {
                    setSavingBeeUrl(true);
                    await swarm.setBeeUrl(beeUrlInput.trim().replace(/\/+$/, ""));
                    setSavingBeeUrl(false);
                  }
                }}
                className={`flex-1 rounded-md border px-2 py-1 text-xs font-mono ${beeUrlChanged ? "border-blue-400" : "border-gray-200"}`}
              />
              {beeUrlChanged && (
                <ActionButton
                  onClick={async () => {
                    if (!swarm.setBeeUrl) return;
                    setSavingBeeUrl(true);
                    await swarm.setBeeUrl(beeUrlInput.trim().replace(/\/+$/, ""));
                    setSavingBeeUrl(false);
                  }}
                  loading={savingBeeUrl}
                  variant="primary"
                >
                  {savingBeeUrl ? "Connecting..." : "Save & Connect"}
                </ActionButton>
              )}
            </div>
            <p className="text-[10px] text-gray-400 mt-1">
              Currently connected to: <span className="font-mono">{currentBeeUrl}</span>
            </p>
          </div>
          <Row
            label="Status"
            value={
              <span className="flex items-center">
                <StatusDot color={ready ? "#22c55e" : "#ef4444"} />
                {ready ? "Connected" : "Disconnected"}
              </span>
            }
          />
          {signer?.ownerAddress ? (
            <Row
              label="Your Wallet"
              copyable={signer.ownerAddress}
            />
          ) : null}
          {signer?.swarmPublicKey ? (
            <Row
              label="Swarm Key"
              copyable={signer.swarmPublicKey}
            />
          ) : null}
        </Section>
        {nodeWallet ? (
          <Section title="Bee Node Wallet">
            <p className="mb-2 text-xs text-gray-400">
              Your Bee node needs xBZZ (for stamps) and xDAI (for gas) on Gnosis Chain.
            </p>
            <Row
              label="Node Address"
              copyable={nodeWallet}
            />
            {balances ? <Row label="xBZZ Balance" value={`${formatBZZ(balances.xBZZ)} xBZZ`} /> : null}
            {balances ? <Row label="xDAI Balance" value={`${formatDAI(balances.xDAI)} xDAI`} /> : null}
            {hasWallet ? (
              <div className="mt-2 flex gap-2">
                <ActionButton
                  onClick={handleFundBZZ}
                  loading={fundBusy}
                  disabled={!ready}
                  variant="primary"
                >
                  Send 1 xBZZ
                </ActionButton>
                <ActionButton onClick={handleFundDAI} loading={fundBusy} disabled={!ready}>
                  Send 0.1 xDAI
                </ActionButton>
              </div>
            ) : (
              <p className="mt-2 text-xs text-yellow-600">
                Connect a wallet (MetaMask) to fund the Bee node.
              </p>
            )}
          </Section>
        ) : null}
        {stamp ? (
          <Section title="Storage">
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
                {swarm.totalBytesUploaded != null && swarm.totalBytesUploaded > 0 && (
                  <div className="mt-2 flex justify-between text-xs text-gray-500">
                    <span>Your data uploaded</span>
                    <span className="font-medium">{formatBytes(swarm.totalBytesUploaded)}</span>
                  </div>
                )}
                <details className="mt-2">
                  <summary className="cursor-pointer text-[10px] text-blue-400 hover:text-blue-600">
                    Why is utilization high with little data?
                  </summary>
                  <div className="mt-1 rounded bg-gray-50 p-2 text-[10px] leading-relaxed text-gray-500">
                    <p className="mb-1">
                      Swarm splits data into 4KB chunks distributed across <strong>65,536 buckets</strong> by content hash.
                      Utilization tracks the <strong>fullest bucket</strong>, not total data.
                    </p>
                    <p className="mb-1">
                      With a small stamp (depth {stamp.depth ?? "?"}), each bucket has only <strong>{stamp.depth != null && stamp.bucketDepth != null ? Math.pow(2, stamp.depth - stamp.bucketDepth) : "?"} slots</strong>.
                      A few uploads can fill one bucket while others stay empty — like a hash table with uneven distribution.
                    </p>
                    <p>
                      <strong>Tip:</strong> Larger stamps (depth 22+) have more slots per bucket, so utilization stays low longer and you get closer to the advertised capacity.
                    </p>
                  </div>
                </details>
              </div>
            </div>
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
              label="Expires"
              value={stamp.expiresAt ? new Date(stamp.expiresAt).toLocaleDateString() : "—"}
            />
            <Row
              label={
                <span className="group relative cursor-help">
                  Batch ID
                  <span className="pointer-events-none absolute bottom-full left-0 z-10 mb-1 hidden w-56 rounded bg-gray-800 p-2 text-[10px] font-normal leading-relaxed text-white shadow-lg group-hover:block">
                    Unique identifier for your postage stamp on Gnosis Chain. Like a receipt for your prepaid storage.
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
                      Depth {stamp.depth} = {stamp.depth - (stamp.bucketDepth ?? 16)} bits per bucket = {Math.pow(2, stamp.depth - (stamp.bucketDepth ?? 16))} slots per bucket.
                      Higher depth (22+) gives better utilization efficiency.
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
            {isDevMode ? (
              <p className="mt-2 text-xs text-gray-400">
                Stamp management unavailable in Bee dev mode.
              </p>
            ) : (
              <div className="mt-3 space-y-3">
                {/* ── Extend Duration ── */}
                <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                  <p className="mb-2 text-xs font-medium text-gray-600">Extend Duration</p>
                  <div className="flex items-end gap-2">
                    <select
                      className="flex-1 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-blue-400 focus:outline-none"
                      value={selectedDuration?.days ?? ""}
                      onChange={(e) => {
                        const days = Number(e.target.value);
                        if (!days) { setSelectedDuration(null); return; }
                        const opts = stampOptions?.durationOptions ?? [];
                        const opt = opts.find((o) => o.days === days);
                        if (opt) setSelectedDuration({ days: opt.days, amount: opt.amount });
                      }}
                    >
                      <option value="">Select duration...</option>
                      {(stampOptions?.durationOptions ?? DURATION_OPTIONS).map((opt) => (
                        <option key={opt.days} value={opt.days}>{opt.label}</option>
                      ))}
                    </select>
                    <ActionButton
                      onClick={handleTopUp}
                      loading={topUpBusy}
                      disabled={!ready || !selectedDuration}
                      variant="primary"
                    >
                      Top Up
                    </ActionButton>
                  </div>
                  <p className="mt-1 text-[10px] text-gray-400">Adds time to your stamp. Costs xBZZ from node wallet.</p>
                </div>

                {/* ── Expand Storage ── */}
                <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                  <p className="mb-2 text-xs font-medium text-gray-600">Expand Storage</p>
                  <div className="flex items-end gap-2">
                    <select
                      className="flex-1 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-blue-400 focus:outline-none"
                      value={selectedSize ?? ""}
                      onChange={(e) => setSelectedSize(e.target.value ? Number(e.target.value) : null)}
                    >
                      <option value="">Select size...</option>
                      {SIZE_OPTIONS.filter((s) => s.depth > (stamp.depth ?? 0)).map((opt) => (
                        <option key={opt.depth} value={opt.depth}>{opt.label} (depth {opt.depth})</option>
                      ))}
                    </select>
                    <ActionButton
                      onClick={handleExpand}
                      loading={expandBusy}
                      disabled={!ready || !selectedSize}
                    >
                      Expand
                    </ActionButton>
                  </div>
                  <p className="mt-1 text-[10px] text-gray-400">
                    Increases capacity and slots per bucket (better distribution). Halves remaining duration — top up after.
                    {stamp.utilization >= 100 && " Required — storage is full."}
                    {stamp.depth != null && stamp.depth < 22 && stamp.utilization > 30 &&
                      " Recommended: expand to depth 22+ for more efficient storage."}
                  </p>
                </div>
              </div>
            )}
          </Section>
        ) : (
          <Section title="Buy a Postage Stamp">
            <p className="mb-3 text-xs text-gray-400">
              A postage stamp is prepaid storage on Swarm. Choose capacity and duration, then create.
              Your Bee node wallet must be funded with xBZZ first.
            </p>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Storage capacity</label>
                <select
                  className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-blue-400 focus:outline-none"
                  value={selectedSize ?? ""}
                  onChange={(e) => setSelectedSize(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">Select size...</option>
                  {SIZE_OPTIONS.map((opt) => (
                    <option key={opt.depth} value={opt.depth}>{opt.label} (depth {opt.depth})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Storage duration (approx.)</label>
                <select
                  className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-blue-400 focus:outline-none"
                  value={selectedDuration?.days ?? ""}
                  onChange={(e) => {
                    const days = Number(e.target.value);
                    if (!days) { setSelectedDuration(null); return; }
                    const opts = stampOptions?.durationOptions ?? [];
                    const opt = opts.find((o) => o.days === days);
                    if (opt) setSelectedDuration({ days: opt.days, amount: opt.amount });
                    else setSelectedDuration({ days, amount: String(BigInt(days) * 17280n * 24000n) });
                  }}
                >
                  <option value="">Select duration...</option>
                  {DURATION_OPTIONS.map((opt) => (
                    <option key={opt.days} value={opt.days}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <ActionButton
                onClick={handleCreateStamp}
                loading={createBusy}
                disabled={!ready || !selectedSize || !selectedDuration}
                variant="primary"
              >
                {selectedSize && selectedDuration
                  ? `Create Stamp (${SIZE_OPTIONS.find((s) => s.depth === selectedSize)?.label ?? ""}, ~${selectedDuration.days}d)`
                  : "Create Stamp"}
              </ActionButton>
              <p className="text-[10px] text-gray-400">
                Requires xBZZ in the Bee node wallet. Larger capacity + longer duration costs more xBZZ.
              </p>
            </div>
          </Section>
        )}
        <DocsTreeSection docs={docs} syncStatus={swarm.syncStatus} driveManifests={swarm.userManifest?.driveManifests} />

        {/* ─── Your Swarm ID ─────────────────────────────── */}
        {swarm.signerEntry?.ownerAddress && (
          <Section title="Your Swarm ID">
            <p className="mb-1 text-xs text-gray-400">
              Share this ID with others so they can send you documents via Swarm.
            </p>
            <CopyableValue value={normalizeAddr(swarm.client ? (swarm.client as any).getOwnerAddress?.() ?? swarm.signerEntry.ownerAddress : swarm.signerEntry.ownerAddress)} />
          </Section>
        )}

        {/* ─── Share ─────────────────────────────────────── */}
        <Section title="Share">
          {(() => {
            const drives = docs.filter(([, d]) => d.documentType === "powerhouse/document-drive");
            const driveIds = new Set(drives.map(([id]) => id));
            const childDocs = docs.filter(([, d]) => d.documentType !== "powerhouse/document-drive");
            const orphans = childDocs.filter(([, d]) => !d.driveId || !driveIds.has(d.driveId));

            const toggleDoc = (id: string) => {
              setShareSelected((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id); else next.add(id);
                return next;
              });
              setShareResult(null);
            };

            const toggleDrive = (driveId: string) => {
              const children = childDocs.filter(([, d]) => d.driveId === driveId).map(([id]) => id);
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
              return <p className="text-xs text-gray-400 italic">No documents to share yet.</p>;
            }

            const totalItems = childDocs.length + drives.length;
            const MAX_COLLAPSED = 5;
            const needsGlobalExpand = totalItems > MAX_COLLAPSED;
            const dm = swarm.userManifest?.driveManifests ?? {};

            return (
              <div>
                <p className="mb-2 text-xs text-gray-400">
                  Select a drive or individual documents, then enter the recipient's Swarm ID.
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

                {/* Recipient + Share button */}
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
                          setShareResult({ ok: true, msg: `Shared ${r.shared} document${r.shared !== 1 ? "s" : ""} successfully!` });
                          setShareSelected(new Set());
                          setShareRecipient("");
                        } else {
                          setShareResult({ ok: false, msg: r.error ?? "Share failed" });
                        }
                      } catch (err) {
                        setShareResult({ ok: false, msg: err instanceof Error ? err.message : "Share failed" });
                      } finally {
                        setSharing(false);
                      }
                    }}
                    loading={sharing}
                    disabled={!ready || shareSelected.size === 0 || !isValidHexAddress(shareRecipient)}
                    variant="primary"
                  >
                    {sharing ? `Sharing ${shareSelected.size}...` : `Share ${shareSelected.size > 0 ? `(${shareSelected.size})` : ""}`}
                  </ActionButton>
                </div>
                {shareResult && (
                  <p className={`text-xs ${shareResult.ok ? "text-green-600" : "text-red-500"}`}>
                    {shareResult.msg}
                  </p>
                )}
              </div>
            );
          })()}
        </Section>

        {/* ─── Import Shared Documents ─────────────────────── */}
        <Section title="Import from Swarm User">
          <p className="mb-2 text-xs text-gray-400">
            Enter the Swarm ID of a user who shared documents with you.
            Your Bee node will decrypt the shared data automatically.
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
                    setImportResult({ ok: true, msg: `Imported ${result.imported.length} document(s). Refresh to see them.` });
                    setImportSender("");
                  } else {
                    setImportResult({ ok: false, msg: result.error ?? "Import failed" });
                  }
                } catch (err) {
                  setImportResult({ ok: false, msg: err instanceof Error ? err.message : "Import failed" });
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

        <Section title="Swarm Data">
          <p className="mb-2 text-xs text-gray-400">
            Clear all documents and manifests from Swarm feeds. This writes empty
            manifests — old data expires when the stamp runs out. Use this to start
            fresh if feeds have stale data.
          </p>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">Clear all Swarm data</span>
            <ActionButton
              onClick={async () => {
                setClearingStorage(true);
                try {
                  // Try the plugin's clearStorage first
                  if (swarm?.clearStorage) {
                    await swarm.clearStorage();
                    showStatus(true, "Swarm storage cleared. Refresh to start fresh.");
                    return;
                  }
                  // Fallback: call client API directly
                  const ph = window.ph as { swarm?: SwarmUiSnapshot; renown?: { user?: { address?: string } } } | undefined;
                  const client = ph?.swarm?.client as { updateUserManifest?: (address: string, manifest: unknown) => Promise<void> } | undefined;
                  const address = ph?.renown?.user?.address;
                  if (client?.updateUserManifest && address) {
                    await client.updateUserManifest(address, {
                      address,
                      documents: {},
                      drives: {},
                      stamps: {},
                      updatedAt: new Date().toISOString(),
                    });
                    showStatus(true, "Swarm storage cleared. Refresh to start fresh.");
                  } else {
                    showStatus(false, "Cannot clear — Swarm client not available.");
                  }
                } catch (err) {
                  showStatus(false, err instanceof Error ? err.message : "Clear failed");
                } finally {
                  setClearingStorage(false);
                }
              }}
              loading={clearingStorage}
              disabled={!ready}
            >
              {clearingStorage ? "Clearing..." : "Clear Swarm Storage"}
            </ActionButton>
          </div>
        </Section>
        <Section title="Swarm Key Cache">
          <p className="mb-2 text-xs text-gray-400">
            Your Swarm key is derived from a one-time wallet signature and cached
            locally in IndexedDB. Clearing it will prompt a new signature from
            your wallet and automatically reconnect — your Swarm data is not lost
            since the same wallet always produces the same key.
          </p>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">Clear and reconnect</span>
            <ActionButton onClick={handleClearCache} loading={clearing} disabled={!ready}>
              {clearing ? "Reconnecting..." : "Clear & Reconnect"}
            </ActionButton>
          </div>
        </Section>
      </div>
    </div>
  );
};
