/**
 * Document sharing and public profile management.
 *
 * - Publish a public profile (Bee node public key) for discoverability
 * - Share documents with other users (encrypted drive bundles)
 * - Import documents shared by others
 */
import type { SwarmClient } from "../swarm-client.js";
import { state } from "./state.js";
import { flushDocumentManifest, flushDriveManifest } from "./flush.js";
import { restoreFolderStructure } from "./hydration.js";

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
    const res = await fetch(`${state.beeUrl}/addresses`);
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

export async function shareDocumentsWithUser(
  client: SwarmClient,
  docIds: string[],
  recipientSignerAddress: string,
): Promise<{ success: boolean; shared: number; error?: string }> {
  try {
    if (state.syncPaused) {
      return { success: false, shared: 0, error: "Please wait for document recovery to finish before sharing." };
    }

    const mySignerAddress = client.getOwnerAddress();
    console.log(`[SwarmPlugin] Sharing ${docIds.length} doc(s) with signer ${recipientSignerAddress.slice(0, 10)}...`);

    // Flush ALL pending docs before sharing — ensure ops are on Swarm
    for (const docId of docIds) {
      if (state.pendingManifests.has(docId) || state.pendingOps.has(docId)) {
        await flushDocumentManifest(docId);
      }
    }
    // Also flush any drive that contains shared docs
    const drivesToFlush = new Set<string>();
    for (const docId of docIds) {
      const driveId = state.docToDrive.get(docId);
      if (driveId && state.pendingDriveUpdates.has(driveId)) {
        drivesToFlush.add(driveId);
      }
    }
    for (const driveId of drivesToFlush) {
      await flushDriveManifest(client, driveId);
    }

    const ph = (globalThis as any).window?.ph;
    const userManifest = ph?.swarm?.userManifest;
    const reactorClient = ph?.reactorClient;

    // Group docs by drive, bundle all ops per drive into ONE upload
    const docsByDrive = new Map<string, Array<{ docId: string; ops: unknown[]; docType: string; docName: string }>>();

    for (const docId of docIds) {
      try {
        const manifest = await client.readManifest(docId);
        if (!manifest || manifest.operationBatches.length === 0) {
          console.warn(`[SwarmPlugin] Doc ${docId.slice(0, 8)} has no ops on Swarm, skipping`);
          continue;
        }

        const allOps: unknown[] = [];
        for (const batch of manifest.operationBatches) {
          try {
            const data = await client.downloadData(batch.reference);
            const ops = JSON.parse(new TextDecoder().decode(data));
            allOps.push(...(Array.isArray(ops) ? ops : [ops]));
          } catch (err) {
            console.warn(`[SwarmPlugin] Failed batch ${batch.reference.slice(0, 8)}:`, err instanceof Error ? err.message : err);
          }
        }
        if (allOps.length === 0) continue;

        const docEntry = userManifest?.documents?.[docId];
        const driveId = docEntry?.driveId ?? state.docToDrive.get(docId) ?? "_default";

        if (!docsByDrive.has(driveId)) docsByDrive.set(driveId, []);
        docsByDrive.get(driveId)!.push({
          docId,
          ops: allOps,
          docType: manifest.documentType,
          docName: docEntry?.name ?? docId,
        });
      } catch (err) {
        console.warn(`[SwarmPlugin] Failed to prepare doc ${docId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
      }
    }

    if (docsByDrive.size === 0) {
      return { success: false, shared: 0, error: "No documents could be shared." };
    }

    // Build share entries — ONE bundle per drive
    const shareEntries: Array<{
      driveId: string; driveName: string; reference: string;
      documents: Array<{ documentId: string; documentType: string; name: string; operationCount: number }>;
      sharedAt: string;
    }> = [];

    let totalDocs = 0;
    for (const [driveId, docs] of docsByDrive) {
      // Resolve drive name
      let driveName = userManifest?.drives?.[driveId]?.name ?? "";
      if (!driveName || driveName === driveId) driveName = state.driveNames.get(driveId) ?? "";
      if (!driveName || driveName === driveId) {
        try {
          if (reactorClient && driveId !== "_default") {
            const driveDoc = await reactorClient.get(driveId);
            driveName = driveDoc?.state?.global?.name ?? "";
          }
        } catch { /* best effort */ }
      }
      if (!driveName || driveName === driveId) driveName = "Shared Drive";

      // Include folder structure from drive manifest (only for docs being shared)
      const sharedDocIds = new Set(docs.map((d) => d.docId));
      let folderInfo: { folders?: Record<string, { name: string; parentFolder?: string }>; docFolders?: Record<string, string> } | undefined;
      const dm = state.driveManifestCache.get(driveId);
      if (dm?.folders && Object.keys(dm.folders).length > 0) {
        const docFolders: Record<string, string> = {};
        const usedFolderIds = new Set<string>();
        for (const [docId, docEntry] of Object.entries(dm.documents)) {
          if (sharedDocIds.has(docId) && docEntry.parentFolder) {
            docFolders[docId] = docEntry.parentFolder;
            usedFolderIds.add(docEntry.parentFolder);
          }
        }
        // Include parent chain for nested folders
        const allFolders: Record<string, { name: string; parentFolder?: string }> = {};
        for (const folderId of usedFolderIds) {
          let current = folderId;
          while (current && dm.folders[current] && !allFolders[current]) {
            allFolders[current] = dm.folders[current];
            current = dm.folders[current].parentFolder!;
          }
        }
        if (Object.keys(allFolders).length > 0) {
          folderInfo = { folders: allFolders, docFolders };
        }
      }

      // Bundle ALL docs' ops for this drive into ONE upload
      const cachedDm = state.driveManifestCache.get(driveId);
      const bundle = {
        documents: docs.map((d) => ({
          documentId: d.docId,
          documentType: d.docType,
          name: d.docName,
          operations: d.ops,
        })),
        ...(folderInfo ? { folders: folderInfo.folders, docFolders: folderInfo.docFolders } : {}),
        ...(cachedDm?.preferredEditor ? { preferredEditor: cachedDm.preferredEditor } : {}),
      };
      const shareResult = await client.uploadSharedData(JSON.stringify(bundle), mySignerAddress, recipientSignerAddress);

      shareEntries.push({
        driveId,
        driveName,
        reference: shareResult.reference,
        documents: docs.map((d) => ({
          documentId: d.docId,
          documentType: d.docType,
          name: d.docName,
          operationCount: d.ops.length,
        })),
        sharedAt: new Date().toISOString(),
      });

      totalDocs += docs.length;
      console.log(`[SwarmPlugin] Bundled ${docs.length} doc(s) for drive "${driveName}" (${docs.reduce((s, d) => s + d.ops.length, 0)} total ops)`);
    }

    // Write ONE clean share manifest
    const shareManifest = {
      from: mySignerAddress,
      to: recipientSignerAddress,
      shares: shareEntries,
      createdAt: new Date().toISOString(),
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
          bundleData = await client.downloadSharedData(share.reference, senderSignerAddress, mySignerAddress);
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
          .filter((op: any) => (op.action?.scope ?? op.scope ?? "global") === "global")
          .map((op: any) => op.action ?? op);

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

          state.recoveringDocs.add(newDocId);
          try {
            await reactorClient.createDocumentInDrive(localDriveId, shellDoc);
            if (userOps.length > 0) {
              await reactorClient.execute(newDocId, "main", userOps);
            }
            imported.push(newDocId);
            origToLocal.set(origDocId, newDocId);
            console.log(`[SwarmPlugin] Imported "${docName}" (${userOps.length} ops) → ${newDocId}`);
          } finally {
            state.recoveringDocs.delete(newDocId);
          }
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
