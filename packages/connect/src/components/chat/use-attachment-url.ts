/**
 * Downloads an ACT-protected file attachment and exposes it as an
 * object URL suitable for <img>, <audio>, <video>, or <iframe src>.
 *
 * The download happens once per (reference, thumbnail) pair — repeated
 * mounts of the same attachment hit the in-memory cache instead of
 * re-fetching from the Bee node. Each cache entry is reference-counted
 * so we can revoke the object URL when the last consumer unmounts.
 *
 * Swarm chunks occasionally 404 right after upload (propagation window),
 * so reads are retried a few times before surfacing an error.
 */
import { useEffect, useRef, useState } from "react";
import type { FileAttachment } from "./types.js";

type Entry = {
  url?: string;
  promise?: Promise<string>;
  refs: number;
  error?: string;
};

const cache = new Map<string, Entry>();

function keyFor(reference: string, thumbnail: boolean): string {
  return `${thumbnail ? "t" : "f"}:${reference}`;
}

function getManager(): any | null {
  const ph = (globalThis as any).window?.ph;
  return ph?.swarm?.chat?.manager ?? null;
}

async function fetchBlob(
  attachment: FileAttachment,
  thumbnail: boolean,
): Promise<Blob> {
  const manager = getManager();
  if (!manager) throw new Error("ChatManager not initialized");
  return manager.downloadAttachment(attachment, { thumbnail });
}

async function fetchWithRetry(
  attachment: FileAttachment,
  thumbnail: boolean,
): Promise<string> {
  // Swarm can take a few seconds to propagate the chunk to the recipient's
  // neighborhood. Back off 1s, 2s, 4s before giving up.
  const delays = [0, 1000, 2000, 4000];
  let lastErr: unknown;
  for (const delay of delays) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const blob = await fetchBlob(attachment, thumbnail);
      return URL.createObjectURL(blob);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export type AttachmentUrlState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error"; error: string };

/**
 * Load an attachment as an object URL. Pass `thumbnail: true` for grid
 * previews to prefer the smaller thumbnail when one is available.
 */
export function useAttachmentUrl(
  attachment: FileAttachment | undefined,
  opts: { thumbnail?: boolean; enabled?: boolean } = {},
): AttachmentUrlState {
  const thumbnail = opts.thumbnail === true;
  const enabled = opts.enabled !== false;
  const [state, setState] = useState<AttachmentUrlState>({ status: "idle" });
  const keyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!attachment || !enabled) {
      setState({ status: "idle" });
      return;
    }

    const key = keyFor(attachment.reference, thumbnail);
    keyRef.current = key;

    let cancelled = false;
    const entry: Entry = cache.get(key) ?? { refs: 0 };
    entry.refs++;
    cache.set(key, entry);

    const apply = (s: AttachmentUrlState) => {
      if (cancelled) return;
      setState(s);
    };

    if (entry.url) {
      apply({ status: "ready", url: entry.url });
    } else if (entry.error) {
      apply({ status: "error", error: entry.error });
    } else {
      apply({ status: "loading" });
      if (!entry.promise) {
        entry.promise = fetchWithRetry(attachment, thumbnail);
        entry.promise.then(
          (url) => {
            entry.url = url;
            entry.promise = undefined;
          },
          (err) => {
            entry.error = err instanceof Error ? err.message : String(err);
            entry.promise = undefined;
          },
        );
      }
      entry.promise
        .then((url) => apply({ status: "ready", url }))
        .catch((err) =>
          apply({
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    }

    return () => {
      cancelled = true;
      const current = cache.get(key);
      if (!current) return;
      current.refs--;
      if (current.refs <= 0) {
        if (current.url) URL.revokeObjectURL(current.url);
        cache.delete(key);
      }
    };
  }, [attachment?.reference, thumbnail, enabled]);

  return state;
}

/**
 * Trigger a browser download for the given attachment.
 * Uses the already-cached object URL when possible.
 */
export async function downloadAttachmentToDisk(
  attachment: FileAttachment,
): Promise<void> {
  const manager = getManager();
  if (!manager) throw new Error("ChatManager not initialized");
  const blob: Blob = await manager.downloadAttachment(attachment, {
    thumbnail: false,
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = attachment.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a tick to start the download before revoking
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
