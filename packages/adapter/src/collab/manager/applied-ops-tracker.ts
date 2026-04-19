/**
 * AppliedOpsTracker — remembers op IDs we applied via peer sync
 * (GSOC ping / feed poll / /bzz fetch) so the push hook doesn't echo
 * them back to the collab feed.
 *
 * The echo problem it solves:
 *   1. Sender S pushes op X to their personal feed + collab mirror.
 *   2. Receiver R ingests X via GSOC → `reactor.load` adds X to their
 *      opstore.
 *   3. R's SwarmChannel sees X in outbox, pushes X to R's personal
 *      feed, and calls `handleLocalPush` on R.
 *   4. Without this tracker, R would mirror X to the collab feed.
 *      S sees X echoed back, UI shows a phantom "peer applied 1 op".
 *
 * The earlier fix compared op.author to myAddress — but op.author is
 * the user's *wallet* address (Renown login), while myAddress is the
 * *Swarm signer* address (derived from the Bee signer key). They are
 * always different, so that filter rejected every op including ones
 * the user actually authored locally. ID-based tracking avoids that
 * address-mismatch entirely.
 *
 * Bounded to {@link DEFAULT_MAX}; the oldest entries fall out as new
 * applies land, so memory stays flat even on long sessions.
 */

const DEFAULT_MAX = 500;

export class AppliedOpsTracker {
  private readonly ids = new Set<string>();

  constructor(private readonly max = DEFAULT_MAX) {}

  /** Call once per op successfully applied via a peer-sync path. */
  markAppliedViaSync(opId: string): void {
    if (this.ids.size >= this.max) {
      // Set iterates insertion order — the first entry is the oldest.
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    this.ids.add(opId);
  }

  /** True when we last saw this op coming from a peer, not locally. */
  wasAppliedViaSync(opId: string): boolean {
    return this.ids.has(opId);
  }
}
