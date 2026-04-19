/**
 * Document sharing and public profile management.
 *
 * - Publish a public profile (Bee node public key) for discoverability
 * - Share documents with other users (encrypted drive bundles)
 * - Import documents shared by others
 */
import type { SwarmClient } from "../swarm-client.js";
import { restoreFolderStructure } from "./hydration.js";

/** Read Bee URL from window.ph.swarm (set by plugin init) */
function getBeeUrl(): string {
  const ph = (globalThis as any).window?.ph;
  // Check ph.swarm.beeUrl first (set by applySwarmExtensions), then localStorage
  // (persisted across page loads), then fallback to localhost.
  try {
    return ph?.swarm?.beeUrl
      ?? localStorage.getItem("swarm:beeUrl")
      ?? "http://localhost:1633";
  } catch {
    return "http://localhost:1633";
  }
}

// ═══════════════════════════════════════════════════════════════
// Public Profile
// ═══════════════════════════════════════════════════════════════

export async function publishPublicProfile(
  client: SwarmClient,
  ethAddress: string,
  swarmPublicKey?: string,
): Promise<void> {
  const signerAddress = client.getOwnerAddress();

  // Check if profile already exists (avoid unnecessary feed writes)
  const existing = await client.readPublicProfile(signerAddress);

  // Get Bee node public key and overlay
  let beeNodePublicKey = "";
  let overlayAddress = "";
  try {
    const res = await fetch(`${getBeeUrl()}/addresses`);
    const data = (await res.json()) as { publicKey?: string; overlay?: string };
    beeNodePublicKey = data.publicKey ?? "";
    overlayAddress = data.overlay ?? "";
  } catch {
    console.warn("[SwarmPlugin] Could not fetch Bee node addresses for profile");
  }

  if (!beeNodePublicKey) {
    console.warn("[SwarmPlugin] No Bee node public key — skipping profile publish");
    return;
  }

  // Skip if profile is up-to-date
  if (
    existing &&
    existing.beeNodePublicKey === beeNodePublicKey &&
    existing.swarmPublicKey === swarmPublicKey
  ) {
    console.log("[SwarmPlugin] Public profile already up-to-date");
    return;
  }

  const profile = {
    address: signerAddress,
    ethAddress,
    beeNodePublicKey,
    swarmPublicKey: swarmPublicKey ?? undefined,
    overlayAddress: overlayAddress || undefined,
    updatedAt: new Date().toISOString(),
  };

  await client.publishPublicProfile(signerAddress, profile);
  console.log(`[SwarmPlugin] Published public profile (signer: ${signerAddress.slice(0, 10)}...)`);
}

// ═══════════════════════════════════════════════════════════════
// Share Documents
// ═══════════════════════════════════════════════════════════════

/**
 * The shape written into the ACT-protected /bzz chunk for BOTH the
 * settings-share flow and the chat-share flow. Keeping one shape means
 * `applyDocumentBundle` imports either bundle identically, so the
 * recipient always gets: correct doc names, full op history, folder
 * structure, and the publisher's preferred editor.
 */
export interface DocumentShareBundle {
  documents: Array<{
    documentId: string;
    documentType: string;
    name: string;
    operations: unknown[];
  }>;
  folders?: Record<string, { name: string; parentFolder?: string }>;
  docFolders?: Record<string, string>;
  preferredEditor?: string;
}

export interface BuiltDriveShareBundle {
  bundle: DocumentShareBundle;
  driveName: string;
  /** Per-doc metadata for the share manifest / chat attachment layer. */
  docs: Array<{
    documentId: string;
    documentType: string;
    name: string;
    operationCount: number;
  }>;
}

/**
 * Collect ops + metadata for a set of docs within a single drive and
 * package them into the canonical share bundle shape. Used by both
 * `shareDocumentsWithUser` (settings → share manifest) and
 * `shareDocumentInChat` (chat → attachment). Returns null when none of
 * the requested docs have any ops to share.
 *
 * Doc name resolution prefers `window.ph.swarm.userManifest.documents`
 * and falls back to the on-chain docId — matching the settings flow so
 * the chat recipient sees "my new doc" instead of a UUID.
 */
export async function buildDriveShareBundle(
  client: SwarmClient,
  driveId: string,
  docIds: string[],
): Promise<BuiltDriveShareBundle | null> {
  const ph = (globalThis as any).window?.ph;
  const userManifest = ph?.swarm?.userManifest;
  const reactorClient = ph?.reactorClient;

  const preparedDocs: Array<{
    docId: string;
    ops: unknown[];
    docType: string;
    docName: string;
  }> = [];

  for (const docId of docIds) {
    try {
      let allOps: unknown[] = [];
      let documentType: string | undefined;
      let docName: string | undefined;

      // Prefer the reactor's local operation store as the source of ops:
      // it has EVERY op the user has performed, including ones the
      // SwarmChannel outbox hasn't flushed to Swarm yet. Reading from
      // client.readManifest alone produced partial bundles — if the
      // user hit Share while 6 recent ops were in-flight in the outbox,
      // the recipient would only see the ops already persisted, missing
      // the middle/tail of the history.
      if (reactorClient) {
        try {
          const doc = await reactorClient.get(docId);
          documentType = doc?.header?.documentType;
          docName = doc?.header?.name;

          // Paginate through all global-scope ops. Page size is generous
          // enough that most docs fit in one round; we iterate defensively
          // in case a doc has thousands of ops.
          const view = { branch: "main", scopes: ["global"] };
          let page: any = await reactorClient.getOperations(
            docId,
            view,
            undefined,
            { cursor: "", limit: 1000 },
          );
          while (page) {
            const results = Array.isArray(page.results) ? page.results : [];
            allOps.push(...results);
            if (!page.nextCursor || typeof page.next !== "function") break;
            page = await page.next();
          }
        } catch (err) {
          console.warn(
            `[SwarmPlugin] Local reactor read for ${docId.slice(0, 8)} failed, falling back to Swarm:`,
            err instanceof Error ? err.message : err,
          );
          allOps = [];
        }
      }

      // Fallback: if reactorClient isn't available or the local read
      // produced nothing (rare — e.g. reactor still booting), read from
      // Swarm. This keeps older integrations working even if the local
      // store isn't ready.
      if (allOps.length === 0) {
        const manifest = await client.readManifest(docId);
        if (!manifest || manifest.operationBatches.length === 0) {
          console.warn(`[SwarmPlugin] Doc ${docId.slice(0, 8)} has no ops on Swarm, skipping`);
          continue;
        }
        documentType = documentType ?? manifest.documentType;
        for (const batch of manifest.operationBatches) {
          try {
            const data = await client.downloadData(batch.reference);
            const ops = JSON.parse(new TextDecoder().decode(data));
            allOps.push(...(Array.isArray(ops) ? ops : [ops]));
          } catch (err) {
            console.warn(`[SwarmPlugin] Failed batch ${batch.reference.slice(0, 8)}:`, err instanceof Error ? err.message : err);
          }
        }
      }

      if (allOps.length === 0) continue;

      const docEntry = userManifest?.documents?.[docId] as { name?: string } | undefined;
      preparedDocs.push({
        docId,
        ops: allOps,
        docType: documentType ?? "unknown",
        docName: docName ?? docEntry?.name ?? docId,
      });
    } catch (err) {
      console.warn(`[SwarmPlugin] Failed to prepare doc ${docId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
    }
  }

  if (preparedDocs.length === 0) return null;

  // Resolve drive name (userManifest → reactor → "Shared Drive")
  let driveName = userManifest?.drives?.[driveId]?.name ?? "";
  if (!driveName || driveName === driveId) {
    try {
      if (reactorClient && driveId !== "_default") {
        const driveDoc = await reactorClient.get(driveId);
        driveName = driveDoc?.state?.global?.name ?? "";
      }
    } catch { /* best effort */ }
  }
  if (!driveName || driveName === driveId) driveName = "Shared Drive";

  // Folder structure: only carry folders that contain shared docs, plus
  // their parent chain (so nested hierarchies stay intact on import).
  const sharedDocIds = new Set(preparedDocs.map((d) => d.docId));
  let folders: DocumentShareBundle["folders"];
  let docFolders: DocumentShareBundle["docFolders"];
  let preferredEditor: string | undefined;
  try {
    const dm = await client.readDriveManifest(driveId);
    preferredEditor = dm?.preferredEditor;
    if (dm?.folders && Object.keys(dm.folders).length > 0) {
      const dfMap: Record<string, string> = {};
      const usedFolderIds = new Set<string>();
      for (const [docId, docEntry] of Object.entries(dm.documents)) {
        if (sharedDocIds.has(docId) && docEntry.parentFolder) {
          dfMap[docId] = docEntry.parentFolder;
          usedFolderIds.add(docEntry.parentFolder);
        }
      }
      const allFolders: Record<string, { name: string; parentFolder?: string }> = {};
      for (const folderId of usedFolderIds) {
        let current: string | undefined = folderId;
        while (current && dm.folders[current] && !allFolders[current]) {
          allFolders[current] = dm.folders[current];
          current = dm.folders[current].parentFolder;
        }
      }
      if (Object.keys(allFolders).length > 0) {
        folders = allFolders;
        docFolders = dfMap;
      }
    }
  } catch { /* drive manifest missing is fine — just ship without folders */ }

  const bundle: DocumentShareBundle = {
    documents: preparedDocs.map((d) => ({
      documentId: d.docId,
      documentType: d.docType,
      name: d.docName,
      operations: d.ops,
    })),
    ...(folders ? { folders } : {}),
    ...(docFolders ? { docFolders } : {}),
    ...(preferredEditor ? { preferredEditor } : {}),
  };

  return {
    bundle,
    driveName,
    docs: preparedDocs.map((d) => ({
      documentId: d.docId,
      documentType: d.docType,
      name: d.docName,
      operationCount: d.ops.length,
    })),
  };
}

export async function shareDocumentsWithUser(
  client: SwarmClient,
  docIds: string[],
  recipientSignerAddress: string,
): Promise<{ success: boolean; shared: number; error?: string }> {
  try {
    const mySignerAddress = client.getOwnerAddress();
    console.log(`[SwarmPlugin] Sharing ${docIds.length} doc(s) with signer ${recipientSignerAddress.slice(0, 10)}...`);

    // SwarmChannel handles flushing via SyncManager outbox — no manual flush needed.

    const ph = (globalThis as any).window?.ph;
    const userManifest = ph?.swarm?.userManifest;

    // Group docIds by their owning drive (resolved from the user manifest)
    // so we can build one bundle per drive. Matches the legacy shape that
    // the import side has been happy with.
    const docIdsByDrive = new Map<string, string[]>();
    for (const docId of docIds) {
      const docEntry = userManifest?.documents?.[docId] as { driveId?: string } | undefined;
      const driveId = docEntry?.driveId ?? "_default";
      const bucket = docIdsByDrive.get(driveId) ?? [];
      bucket.push(docId);
      docIdsByDrive.set(driveId, bucket);
    }

    // Resolve recipient's Bee node public key for ACT grant
    const recipientProfile = await client.readPublicProfile(recipientSignerAddress);
    if (!recipientProfile?.beeNodePublicKey) {
      return { success: false, shared: 0, error: "Recipient has no public profile or missing Bee node public key. They need to connect to Swarm first." };
    }
    const recipientBeeNodePubKey = recipientProfile.beeNodePublicKey;

    // Get our own Bee node public key (stored in share manifest for recipient to download)
    const myBeeNodePubKey = await client.getBeeNodePublicKey();

    const shareEntries: Array<{
      driveId: string; driveName: string; reference: string;
      actHistoryAddress?: string; actGranteeRef?: string; publisherBeeNodePubKey?: string;
      documents: Array<{ documentId: string; documentType: string; name: string; operationCount: number }>;
      sharedAt: string;
    }> = [];

    let totalDocs = 0;
    for (const [driveId, driveDocIds] of docIdsByDrive) {
      const built = await buildDriveShareBundle(client, driveId, driveDocIds);
      if (!built) continue;

      const shareResult = await client.uploadSharedData(
        JSON.stringify(built.bundle),
        recipientBeeNodePubKey,
      );

      shareEntries.push({
        driveId,
        driveName: built.driveName,
        reference: shareResult.reference,
        actHistoryAddress: shareResult.actHistoryAddress,
        actGranteeRef: shareResult.actGranteeRef,
        publisherBeeNodePubKey: myBeeNodePubKey,
        documents: built.docs,
        sharedAt: new Date().toISOString(),
      });

      totalDocs += built.docs.length;
      const totalOps = built.docs.reduce((s, d) => s + d.operationCount, 0);
      console.log(`[SwarmPlugin] Bundled ${built.docs.length} doc(s) for drive "${built.driveName}" (${totalOps} total ops)`);
    }

    if (shareEntries.length === 0) {
      return { success: false, shared: 0, error: "No documents could be shared." };
    }

    // Write ONE clean share manifest (v2 = ACT-protected)
    const shareManifest = {
      from: mySignerAddress,
      to: recipientSignerAddress,
      shares: shareEntries,
      createdAt: new Date().toISOString(),
      version: 2 as const,
    };
    await client.writeShareManifest(mySignerAddress, recipientSignerAddress, shareManifest);

    console.log(`[SwarmPlugin] Shared ${totalDocs} doc(s) across ${shareEntries.length} drive(s)`);
    return { success: true, shared: totalDocs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[SwarmPlugin] Share failed:", msg);
    return { success: false, shared: 0, error: msg };
  }
}

// ═══════════════════════════════════════════════════════════════
// Import Shared Documents
// ═══════════════════════════════════════════════════════════════

/**
 * Apply a share bundle (already downloaded & decrypted) as a new local
 * drive. The bundle format is identical for share-manifest imports and
 * chat attachment imports, so both flows call this helper.
 *
 * @param bundleData - Raw bundle bytes (JSON, optionally gzipped by ACT)
 * @param opts.cacheKey - sessionStorage key so repeated imports of the
 *                       same share reuse the already-created drive
 * @param opts.displayName - Name shown to the user in the drive list
 * @param opts.preserveIds - Collab-accept path: reuse the sender's drive
 *   and doc IDs instead of minting fresh ones. Required for live collab
 *   so both sides agree on the feed-topic IDs and reactor doc IDs.
 */
export async function applyDocumentBundle(
  bundleData: Uint8Array,
  opts: {
    cacheKey: string;
    displayName: string;
    preserveIds?: { driveId: string };
  },
): Promise<{ success: boolean; driveId?: string; imported: string[]; error?: string }> {
  const ph = (globalThis as any).window?.ph;
  const reactorClient = ph?.reactorClient;
  if (!reactorClient) {
    return { success: false, imported: [], error: "Reactor not available." };
  }

  const { addDrive } = await import("@powerhousedao/reactor-browser");
  const { driveCreateDocument } = await import("@powerhousedao/shared/document-drive");

  let bundleRaw: any;
  try {
    bundleRaw = JSON.parse(new TextDecoder().decode(bundleData));
  } catch (err) {
    return {
      success: false,
      imported: [],
      error: `Bundle not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!bundleRaw.documents) {
    return { success: false, imported: [], error: "Bundle missing documents array (stale format)." };
  }

  const docs: any[] = bundleRaw.documents;
  const bundleFolders: Record<string, { name: string; parentFolder?: string }> = bundleRaw.folders ?? {};
  const bundlePreferredEditor: string | undefined = bundleRaw.preferredEditor;
  const bundleDocFolders: Record<string, string> = bundleRaw.docFolders ?? {};

  // Reuse an existing import drive if we've processed this share before,
  // or if preserveIds is set and the drive with that canonical ID already
  // exists locally (receiver rejoining a collab they previously accepted).
  let localDriveId: string | undefined;
  if (opts.preserveIds?.driveId) {
    // Canonical-ID path: if the drive already exists under that ID we're
    // rejoining a collab; otherwise fall through to the create branch
    // below which will mint it with this exact ID. Never consult the
    // sessionStorage cache in this mode — a stale entry could point to a
    // locally-minted drive ID that mismatches the canonical one.
    try {
      await reactorClient.get(opts.preserveIds.driveId);
      localDriveId = opts.preserveIds.driveId;
    } catch { /* doesn't exist yet — fall through to create */ }
  } else {
    try {
      const cached = sessionStorage.getItem(opts.cacheKey);
      if (cached) {
        await reactorClient.get(cached);
        localDriveId = cached;
      }
    } catch { /* fall through to create */ }
  }

  if (!localDriveId) {
    try {
      if (opts.preserveIds?.driveId) {
        // Collab-accept: create a drive with the sender's canonical ID so
        // both sides read/write the same collab feed topics.
        const driveDoc = driveCreateDocument({
          global: { name: opts.displayName || "", icon: null, nodes: [] },
        });
        driveDoc.header.id = opts.preserveIds.driveId;
        driveDoc.header.slug = opts.preserveIds.driveId;
        if (bundlePreferredEditor) {
          driveDoc.header.meta = { preferredEditor: bundlePreferredEditor };
        }
        const d = await reactorClient.create(driveDoc);
        localDriveId = d?.header?.id ?? opts.preserveIds.driveId;
      } else {
        const d = await addDrive({ global: { name: opts.displayName } }, bundlePreferredEditor);
        localDriveId = d?.header?.id;
      }
      if (!localDriveId) {
        return { success: false, imported: [], error: "Failed to create drive." };
      }
      sessionStorage.setItem(opts.cacheKey, localDriveId);
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      return {
        success: false,
        imported: [],
        error: `Failed to create drive: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const imported: string[] = [];
  const origToLocal = new Map<string, string>();

  for (const docBundle of docs) {
    const { documentId: origDocId, documentType, name: docName, operations: rawOps } = docBundle;
    const opsArray = Array.isArray(rawOps) ? rawOps : [rawOps];

    const userOps = opsArray
      .filter((op: any) => {
        const scope = op.operation?.action?.scope ?? op.context?.scope ?? op.action?.scope ?? op.scope ?? "global";
        return scope === "global";
      })
      .map((op: any) => {
        const action = op.operation?.action ?? op.action ?? op;
        if (action.timestampUtcMs && typeof action.timestampUtcMs === "number") {
          action.timestampUtcMs = new Date(action.timestampUtcMs).toISOString();
        }
        // Preserve the original signer info on the action. Reactor-
        // client's signAction early-returns if action.context.signer.
        // signatures exists ("If the action already has valid
        // signatures, it is returned unchanged"). Deleting context
        // here was erasing the sender's signature, so execute went
        // on to re-sign with the importing user's wallet — which is
        // why imported docs showed the recipient as the author of
        // every operation instead of the original creator.
        //
        // For actions lacking a signer entirely (e.g. legacy bundles
        // from before signing was universal), leave action.context
        // as-is: signActions will supply a fresh signature only for
        // those, without touching already-signed actions in the batch.
        return action;
      });

    try {
      const docModelModule = await reactorClient.getDocumentModelModule(documentType);
      if (!docModelModule) {
        console.warn(`[SwarmPlugin] Unknown doc type: ${documentType}`);
        continue;
      }
      const initialState = docModelModule.utils.createState();
      // preserveIds (collab-accept path) keeps the sender's doc ID so
      // reactor.load on incoming ops targets the same doc ID that the
      // sender used when emitting them. For regular sharing we mint a
      // fresh ID so multi-share recipients don't collide on each other.
      const newDocId = opts.preserveIds ? origDocId : crypto.randomUUID();
      // If preserveIds and the doc already exists locally (receiver
      // rejoining), skip re-creation — execute() is idempotent by opId
      // so we could technically re-apply ops, but we avoid a duplicate
      // createDocumentInDrive call that would throw.
      let alreadyExists = false;
      if (opts.preserveIds) {
        try {
          await reactorClient.get(newDocId);
          alreadyExists = true;
        } catch { /* expected if new */ }
      }
      if (!alreadyExists) {
        const shellDoc = {
          header: {
            id: newDocId,
            documentType,
            name: docName || origDocId,
            slug: newDocId,
            branch: "main",
            createdAtUtcIso: new Date().toISOString(),
            lastModifiedAtUtcIso: new Date().toISOString(),
            revision: { global: 0 },
            sig: { publicKey: "", nonce: "" },
          },
          state: initialState,
          initialState,
          operations: { global: [], local: [] },
        };
        await reactorClient.createDocumentInDrive(localDriveId, shellDoc);
      }
      if (userOps.length > 0) {
        await reactorClient.execute(newDocId, "main", userOps);
      }
      imported.push(newDocId);
      origToLocal.set(origDocId, newDocId);
    } catch (err) {
      console.warn(`[SwarmPlugin] Failed to import "${docName}":`, err instanceof Error ? err.message : err);
    }
  }

  // Restore folder structure when bundle carries one
  if (Object.keys(bundleFolders).length > 0 && localDriveId) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await reactorClient.get(localDriveId);
      const docMoves = Object.entries(bundleDocFolders)
        .map(([origId, folderId]) => ({ docId: origToLocal.get(origId)!, targetFolder: folderId }))
        .filter((m) => m.docId);
      await restoreFolderStructure(reactorClient, localDriveId, bundleFolders, docMoves);
    } catch (err) {
      console.warn(`[SwarmPlugin] Could not restore import folders:`, err instanceof Error ? err.message : err);
    }
  }

  return { success: true, driveId: localDriveId, imported };
}

export async function importFromUser(
  client: SwarmClient,
  senderSignerAddress: string,
): Promise<{ success: boolean; imported: string[]; error?: string }> {
  try {
    const mySignerAddress = client.getOwnerAddress();
    console.log(`[SwarmPlugin] Importing shared docs from signer ${senderSignerAddress.slice(0, 10)}...`);

    // 1. Read the share manifest from the sender's feed
    const shareManifest = await client.readShareManifest(senderSignerAddress, mySignerAddress);
    if (!shareManifest || shareManifest.shares.length === 0) {
      return {
        success: false,
        imported: [],
        error: "No documents shared with you from this Swarm ID.",
      };
    }

    const imported: string[] = [];
    const ph = (globalThis as any).window?.ph;
    const reactorClient = ph?.reactorClient;
    if (!reactorClient) {
      return { success: false, imported: [], error: "Reactor not available." };
    }

    const { addDrive } = await import("@powerhousedao/reactor-browser");

    for (const share of shareManifest.shares) {
      const driveName = share.driveName || "Imported Docs";
      const displayName = `${driveName} (shared)`;

      // Download the drive bundle FIRST (need preferredEditor before creating drive)
      console.log(`[SwarmPlugin] Downloading drive bundle "${driveName}" ref=${share.reference.slice(0, 16)}...`);
      let bundleData: Uint8Array | null = null;
      const retryDelays = [0, 3000, 8000];
      for (let attempt = 0; attempt < retryDelays.length; attempt++) {
        if (attempt > 0) {
          console.log(`[SwarmPlugin] Retry ${attempt}/2 for drive bundle (waiting for propagation)...`);
          await new Promise((r) => setTimeout(r, retryDelays[attempt]));
        }
        try {
          if (shareManifest.version === 2 && share.publisherBeeNodePubKey && share.actHistoryAddress) {
            // v2: ACT-protected download — Bee node handles ECDH decryption
            bundleData = await client.downloadSharedData(share.reference, share.publisherBeeNodePubKey, share.actHistoryAddress);
          } else {
            // v1 legacy: insecure deriveShareKey — warn user
            console.warn("[SwarmPlugin] Share uses insecure v1 encryption. Ask sender to re-share for better security.");
            bundleData = await client.legacyDownloadSharedData(share.reference, senderSignerAddress, mySignerAddress);
          }
          break;
        } catch (dlErr) {
          if (attempt === retryDelays.length - 1) {
            console.warn(`[SwarmPlugin] Failed to download drive bundle "${driveName}":`, dlErr instanceof Error ? dlErr.message : dlErr);
          }
        }
      }
      if (!bundleData) continue;

      // Parse the bundle
      const bundleRaw = JSON.parse(new TextDecoder().decode(bundleData));
      if (!bundleRaw.documents) {
        console.warn(`[SwarmPlugin] Stale bundle format for "${driveName}" — ask sender to re-share`);
        continue;
      }
      const docs: any[] = bundleRaw.documents;
      const bundleFolders: Record<string, { name: string; parentFolder?: string }> = bundleRaw.folders ?? {};
      const bundlePreferredEditor: string | undefined = bundleRaw.preferredEditor;
      const bundleDocFolders: Record<string, string> = bundleRaw.docFolders ?? {};
      console.log(`[SwarmPlugin] Downloaded bundle: ${docs.length} doc(s) in "${driveName}"${Object.keys(bundleFolders).length > 0 ? `, ${Object.keys(bundleFolders).length} folder(s)` : ""}${bundlePreferredEditor ? ` (editor: ${bundlePreferredEditor})` : ""}`);

      // Create or reuse local drive for this bundle
      const driveKey = `swarm:importDrive:${senderSignerAddress}:${displayName}`;
      let localDriveId: string | undefined;
      try {
        const cached = sessionStorage.getItem(driveKey);
        if (cached) {
          await reactorClient.get(cached);
          localDriveId = cached;
          console.log(`[SwarmPlugin] Reusing import drive "${displayName}" (${localDriveId.slice(0, 8)})`);
        }
      } catch { /* drive doesn't exist, create new */ }

      if (!localDriveId) {
        try {
          const d = await addDrive({ global: { name: displayName } }, bundlePreferredEditor);
          localDriveId = d?.header?.id;
          if (!localDriveId) continue;
          sessionStorage.setItem(driveKey, localDriveId);
          console.log(`[SwarmPlugin] Created import drive: ${displayName} (${localDriveId.slice(0, 8)})`);
          await new Promise((r) => setTimeout(r, 500));
        } catch (err) {
          console.warn(`[SwarmPlugin] Failed to create drive "${displayName}":`, err);
          continue;
        }
      }

      // Map original docId → new local docId (for folder assignment)
      const origToLocal = new Map<string, string>();

      // Import each doc from the bundle
      for (const docBundle of docs) {
        const { documentId: origDocId, documentType, name: docName, operations: rawOps } = docBundle;
        const opsArray = Array.isArray(rawOps) ? rawOps : [rawOps];

        const userOps = opsArray
          .filter((op: any) => {
            // Support both formats:
            // - OperationWithContext: { operation: { action: { scope } }, context: { scope } }
            // - Plain action: { scope, type, input }
            const scope = op.operation?.action?.scope ?? op.context?.scope ?? op.action?.scope ?? op.scope ?? "global";
            return scope === "global";
          })
          .map((op: any) => {
            // Extract the plain action from whichever format we have:
            // - OperationWithContext: op.operation.action
            // - Wrapped: op.action
            // - Plain: op itself
            const action = op.operation?.action ?? op.action ?? op;

            // Normalize timestampUtcMs: the reactor expects an ISO string,
            // but shared operations may have numeric epoch ms from the push.
            if (action.timestampUtcMs && typeof action.timestampUtcMs === "number") {
              action.timestampUtcMs = new Date(action.timestampUtcMs).toISOString();
            }
            // Also normalize nested context.timestampUtcMs if present
            if (action.context?.signer) {
              // Strip the outer context wrapper — execute() doesn't need it
              delete action.context;
            }
            return action;
          });

        console.log(`[SwarmPlugin] Importing "${docName}" (${userOps.length} actions)`);

        try {
          const docModelModule = await reactorClient.getDocumentModelModule(documentType);
          if (!docModelModule) {
            console.warn(`[SwarmPlugin] Unknown doc type: ${documentType}`);
            continue;
          }

          const initialState = docModelModule.utils.createState();
          const newDocId = crypto.randomUUID();
          const shellDoc = {
            header: {
              id: newDocId,
              documentType,
              name: docName || origDocId,
              slug: newDocId,
              branch: "main",
              createdAtUtcIso: new Date().toISOString(),
              lastModifiedAtUtcIso: new Date().toISOString(),
              revision: { global: 0 },
              sig: { publicKey: "", nonce: "" },
            },
            state: initialState,
            initialState,
            operations: { global: [], local: [] },
          };

          await reactorClient.createDocumentInDrive(localDriveId, shellDoc);
          if (userOps.length > 0) {
            await reactorClient.execute(newDocId, "main", userOps);
          }
          imported.push(newDocId);
          origToLocal.set(origDocId, newDocId);
          console.log(`[SwarmPlugin] Imported "${docName}" (${userOps.length} ops) → ${newDocId}`);
        } catch (err) {
          console.warn(`[SwarmPlugin] Failed to import "${docName}":`, err instanceof Error ? err.message : err);
        }
      }

      // Restore folder structure if bundle includes folder info
      if (Object.keys(bundleFolders).length > 0 && localDriveId) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          await reactorClient.get(localDriveId);
          const docMoves = Object.entries(bundleDocFolders)
            .map(([origId, folderId]) => ({ docId: origToLocal.get(origId)!, targetFolder: folderId }))
            .filter((m) => m.docId);
          await restoreFolderStructure(reactorClient, localDriveId, bundleFolders, docMoves);
        } catch (err) {
          console.warn(`[SwarmPlugin] Could not restore import folders:`, err instanceof Error ? err.message : err);
        }
      }
    }

    console.log(`[SwarmPlugin] Import complete: ${imported.length} documents`);
    return { success: true, imported };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[SwarmPlugin] Import failed:", msg);
    return { success: false, imported: [], error: msg };
  }
}
