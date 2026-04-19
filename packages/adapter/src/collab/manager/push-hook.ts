/**
 * PushHook — entry point for SwarmChannel's "we just pushed ops
 * locally" callback. Filters the batch and hands off to the
 * {@link CollabFeedFlusher}, which owns the debounced ACT feed write
 * + GSOC ping.
 *
 * Why a separate module:
 *   - This file is the one SwarmChannel talks to via
 *     `__swarmCollabManager__.handleLocalPush`. Keeping it tiny
 *     isolates the IPC surface from the transport details.
 *   - Filtering (scope=document drops, self-author filter) is about
 *     *what* to mirror; flushing is about *when*. Two clean
 *     responsibilities, two small modules.
 */

import type { OperationWithContext } from "../../swarm-operation-store.js";
import type { CollabSummary } from "../types.js";
import type { CollabFeedFlusher } from "./feed-flusher.js";
import type { SummaryStore } from "./store.js";

export interface LocalPushInput {
  driveId: string;
  docId: string;
  /** SwarmChannel hands us OperationWithContext[] — each entry wraps a
   *  bare Operation plus its OperationContext. Peers read these back
   *  from the collab feed and unwrap to `.operation` before applying. */
  ops: readonly OperationWithContext[];
  scope: string;
  branch: string;
}

export class PushHook {
  constructor(
    private readonly store: SummaryStore,
    private readonly flusher: CollabFeedFlusher,
    private readonly myAddress: string,
    private readonly isShuttingDown: () => boolean,
  ) {}

  async handleLocalPush(input: LocalPushInput): Promise<void> {
    if (this.isShuttingDown()) return;
    if (!input.ops?.length) return;

    // Skip reactor-machinery ops entirely. scope="document" carries
    // CREATE_DOCUMENT + UPGRADE_DOCUMENT — per-node bootstrap that
    // every participant produces independently when the drive/doc is
    // first materialized (via applyDocumentBundle on joiners, via
    // addDrive on the initiator). Mirroring them would hand a peer an
    // op at index 0 for a document they already have at revision 3+,
    // triggering a RevisionMismatchError in their reactor. We only
    // mirror scope="global" content edits (ADD_FILE, SET_NAME, etc.).
    if (input.scope === "document") return;

    // Mirror only ops we actually authored. SwarmChannel's outbox
    // grows whenever the reactor writes ops — including sync'd ops
    // from peers applied via `reactor.load`. Without this filter we
    // echo every received op back to the collab feed, which shows up
    // as a phantom "peer applied 1 op" row on the original sender's
    // UI and wastes bandwidth.
    const authoredOps = input.ops.filter(
      (o) => opAuthor(o) === this.myAddress.toLowerCase(),
    );
    if (authoredOps.length === 0) return;

    const relevant = this.findCollabsCoveringDoc(input.driveId, input.docId);
    if (relevant.length === 0) return;

    for (const summary of relevant) {
      this.flusher.queue(summary, {
        driveId: input.driveId,
        docId: input.docId,
        ops: authoredOps,
        scope: input.scope,
        branch: input.branch,
      });
    }
  }

  /**
   * Find collabs that should mirror a given (driveId, docId):
   *   - Drive-level collabs: every doc in that drive counts.
   *   - Doc-level collabs: only the specific doc.
   */
  private findCollabsCoveringDoc(
    driveId: string,
    docId: string,
  ): CollabSummary[] {
    const out: CollabSummary[] = [];
    for (const s of this.store.values()) {
      if (s.driveId !== driveId) continue;
      if (s.kind === "document" && s.documentId !== docId) continue;
      out.push(s);
    }
    return out;
  }
}

/**
 * Extract the authoring wallet address from an OperationWithContext.
 * The reactor stores the author under
 * `action.context.signer.user.address`; returns a lowercased string
 * for stable comparison. Returns null if the path isn't present (e.g.
 * legacy ops without signer context).
 */
function opAuthor(op: OperationWithContext): string | null {
  const signer = (op as unknown as {
    operation?: {
      action?: { context?: { signer?: { user?: { address?: unknown } } } };
    };
  }).operation?.action?.context?.signer?.user?.address;
  return typeof signer === "string" ? signer.toLowerCase() : null;
}
