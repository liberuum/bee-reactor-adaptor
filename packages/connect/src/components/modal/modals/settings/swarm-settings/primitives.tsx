import React, { useState } from "react";

export function StatusDot({ color }: { color: string }) {
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

export function CopyableValue({ value }: { value: string }) {
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

export function Row({
  label,
  value,
  mono,
  copyable,
}: {
  label: React.ReactNode;
  value?: React.ReactNode;
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
          {value ?? "\u2014"}
        </span>
      )}
    </div>
  );
}

export function UtilBar({ pct }: { pct: number }) {
  return (
    <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
      <div
        style={{ width: `${Math.min(pct, 100)}%` }}
        className={`h-full rounded-full transition-all ${pct > 90 ? "bg-red-500" : pct > 70 ? "bg-yellow-500" : "bg-green-500"}`}
      />
    </div>
  );
}

export function healthColor(h: string) {
  if (h === "healthy") return "#22c55e";
  if (h === "warning") return "#eab308";
  if (h === "critical" || h === "expired") return "#ef4444";
  return "#9ca3af";
}

export function Section({
  title,
  children,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
        {title}
      </h3>
      <div className="rounded-lg border border-gray-100 bg-white p-3">{children}</div>
    </div>
  );
}

export function AlertBanner({
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

export function ActionButton({
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

export function SyncBadge({ state }: { state?: string }) {
  if (!state || state === "synced")
    return (
      <span className="text-green-400" title="Synced to Swarm">
        &#x25CF;
      </span>
    );
  if (state === "buffered")
    return (
      <span className="text-yellow-400 animate-pulse" title="Buffered (waiting to sync)">
        &#x25CF;
      </span>
    );
  if (state === "flushing")
    return (
      <span className="text-blue-400 animate-pulse" title="Syncing to Swarm...">
        &#x25CF;
      </span>
    );
  if (state === "error")
    return (
      <span className="text-red-400" title="Sync error">
        &#x25CF;
      </span>
    );
  return null;
}

export function shortType(t?: string): string {
  if (!t) return "?";
  const parts = t.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : t;
}
