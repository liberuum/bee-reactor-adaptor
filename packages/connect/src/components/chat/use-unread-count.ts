/**
 * Lightweight hook to read total unread message count from localStorage.
 * Used by the sidebar chat button to show an unread badge.
 *
 * Polls every 2 seconds (same cadence as the main chat hook refreshing
 * conversations) so badges stay fresh without requiring the chat panel
 * to be open.
 */
import { useState, useEffect } from "react";

const CHAT_STORAGE_KEY = "swarm:chatMessages";
const CHAT_LAST_READ_KEY = "swarm:chatLastRead";

interface StoredMessage {
  id: string;
  from: string;
  to: string;
  timestamp: string;
}

function computeTotalUnread(): number {
  try {
    const rawMsgs = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!rawMsgs) return 0;
    const rawRead = localStorage.getItem(CHAT_LAST_READ_KEY);

    const entries = JSON.parse(rawMsgs) as Array<[string, StoredMessage[]]>;
    const lastRead = new Map<string, number>(
      rawRead ? (JSON.parse(rawRead) as Array<[string, number]>) : [],
    );

    // Normalize lastRead keys to lowercase so we don't miss a match when
    // the two maps were written with different case (addresses flow through
    // several sources — user input, ENS resolution, ChatMessage.from).
    const lastReadByLower = new Map<string, number>();
    for (const [k, v] of lastRead) {
      const lk = k.toLowerCase();
      const existing = lastReadByLower.get(lk) ?? 0;
      if (v > existing) lastReadByLower.set(lk, v);
    }

    let total = 0;
    for (const [peer, msgs] of entries) {
      const peerLower = peer.toLowerCase();
      const readAt = lastReadByLower.get(peerLower) ?? 0;
      for (const m of msgs) {
        // "From peer" means the peer sent it TO us — i.e., msg.to is US (not the peer).
        // Our own sent messages have msg.to === peer; we skip those.
        const fromPeer = m.to && m.to.toLowerCase() !== peerLower;
        if (!fromPeer) continue;
        const ts = new Date(m.timestamp).getTime();
        if (ts > readAt) total++;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

export function useUnreadCount(intervalMs = 2000): number {
  const [count, setCount] = useState(() => computeTotalUnread());

  useEffect(() => {
    const tick = () => setCount(computeTotalUnread());
    tick();
    const id = setInterval(tick, intervalMs);

    // Also update on storage events (other tabs)
    const onStorage = (e: StorageEvent) => {
      if (e.key === CHAT_STORAGE_KEY || e.key === CHAT_LAST_READ_KEY) tick();
    };
    window.addEventListener("storage", onStorage);

    // Same-tab update: the plugin dispatches this when it persists a message.
    // `storage` events don't fire in the writing tab, so we need our own signal.
    window.addEventListener("swarm:chatMessages:updated", tick);
    window.addEventListener("swarm:chatLastRead:updated", tick);

    return () => {
      clearInterval(id);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("swarm:chatMessages:updated", tick);
      window.removeEventListener("swarm:chatLastRead:updated", tick);
    };
  }, [intervalMs]);

  return count;
}
