import { phGlobalConfigFromEnv } from "@powerhousedao/connect/config";
import { toast } from "@powerhousedao/connect/services";
import {
  addDefaultDrivesForNewReactor,
  createBrowserReactor,
  getDefaultDrivesFromEnv,
} from "@powerhousedao/connect/utils";
import {
  addPHEventHandlers,
  addRemoteDrive,
  DocumentCache,
  DocumentChangeType,
  extractDriveSlugFromPath,
  extractNodeSlugFromPath,
  getDrives,
  login,
  RegistryClient,
  refreshReactorDataClient,
  setDefaultPHGlobalConfig,
  setDocumentCache,
  setDrives,
  setFeatures,
  setPackageDiscoveryService,
  setPHToast,
  setReactorClient,
  setReactorClientModule,
  setRenown,
  setSelectedDrive,
  setSelectedNode,
  setVetraPackageManager,
  type PHToastFn,
} from "@powerhousedao/reactor-browser";
import {
  BrowserKeyStorage,
  RenownBuilder,
  RenownCryptoBuilder,
} from "@renown/sdk";
import {
  logger,
  type DocumentModelLib,
  type UpgradeManifest,
} from "document-model";
import { initFeatureFlags } from "../feature-flags.js";
// Monorepo relative import — for npm deployment use:
// import { initSwarmPlugin } from "@liberuum-org/bee-reactor-adapter";
import { initSwarmPlugin } from "../../../adapter/src/plugin/init.js";
import type {} from "../../../adapter/src/channel/add-swarm-remote.js"; // type-only — actual import is dynamic below
import { PackageDiscoveryService } from "../package-discovery.js";
import { BrowserPackageManager } from "../package-manager.js";
import { loadPackagesConfig } from "../packages.config.js";
import { createProcessorHostModule } from "./processor-host-module.js";

export async function clearReactorStorage() {
  await window.ph?.reactorClientModule?.pg?.close();

  // Dropping tables inside an existing PGlite instance is unreliable with
  // `relaxedDurability: true` followed by an immediate page reload — pending
  // IDB writes can be lost. Deleting the underlying database outright sidesteps
  // flush-timing; the next startup re-creates and re-migrates from scratch.
  const dbs = await indexedDB.databases();
  const targets = dbs
    .map((d) => d.name)
    .filter((n): n is string => !!n && /pglite|reactor/i.test(n));

  await Promise.all(
    targets.map(
      (name) =>
        new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        }),
    ),
  );
}

export async function createReactor(localPackage?: DocumentModelLib) {
  if (!window.ph) {
    window.ph = {};
  }
  if (window.ph.loading) return;

  window.ph.loading = true;

  // add window event handlers for updates
  addPHEventHandlers();

  // register toast function for use in editor components
  setPHToast(toast as PHToastFn);

  // initialize feature flags
  const features = await initFeatureFlags();

  logger.info(
    "Features: @features",
    JSON.stringify(Object.fromEntries(features), null, 2),
  );

  // initialize renown crypto
  const keyPairStorage = await BrowserKeyStorage.create();
  const renownCrypto = await new RenownCryptoBuilder()
    .withKeyPairStorage(keyPairStorage)
    .build();

  // initialize Renown
  const renown = await new RenownBuilder("connect", {
    basename: phGlobalConfigFromEnv.routerBasename,
    baseUrl: phGlobalConfigFromEnv.renownUrl,
  })
    .withCrypto(renownCrypto)
    .build();

  // load packages list from ph-packages.json (replaceable post-build)
  const packagesConfig = await loadPackagesConfig();

  // initialize package manager
  const packageManager = new BrowserPackageManager(
    phGlobalConfigFromEnv.routerBasename ?? "",
    PH_PACKAGE_REGISTRY_URL,
  );
  setVetraPackageManager(packageManager);
  await packageManager.init(localPackage);
  const packagesResult = await packageManager.addPackages(
    packagesConfig.packages,
  );
  packagesResult.map((r) => {
    if (r.type === "error") console.error(r.error);
  });

  // get document models to set in the reactor (all versions)
  const documentModelModules = packageManager.packages
    .flatMap((pkg) => pkg.documentModels)
    .filter(
      (module, index, modules) =>
        // deduplicate by documentType and version
        modules.findIndex(
          (m) =>
            m.documentModel.global.id === module.documentModel.global.id &&
            m.version === module.version,
        ) === index,
    );

  // get upgrade manifests from packages
  const upgradeManifests = packageManager.packages
    .flatMap((pkg) => pkg.upgradeManifests)
    .filter(
      (manifest, index, manifests) =>
        // deduplicate by documentType and version
        manifest !== undefined &&
        manifests.findIndex(
          (m) => m && m.documentType === manifest.documentType,
        ) === index,
    ) as UpgradeManifest<readonly number[]>[];

  // initialize package discovery service for auto-installing unknown document types
  const discoveryService =
    packageManager.cdnUrl !== null
      ? new PackageDiscoveryService(
          packageManager,
          new RegistryClient(packageManager.cdnUrl),
          {
            mode: "immediate",
            storageKey: phGlobalConfigFromEnv.routerBasename ?? "",
          },
        )
      : undefined;

  if (discoveryService) {
    setPackageDiscoveryService(discoveryService);
  }

  // create reactor v2 with all versions and upgrade manifests
  const reactorClientModule = await createBrowserReactor(
    documentModelModules,
    upgradeManifests,
    renown,
    discoveryService,
  );

  // get the drives from the reactor
  const drives = await getDrives(reactorClientModule.client);

  // set the selected drive and node from the path
  const path = window.location.pathname;
  const driveSlug = extractDriveSlugFromPath(path);
  const nodeSlug = extractNodeSlugFromPath(path);

  // initialize user from URL parameter
  const didFromUrl = getDidFromUrl();
  await login(didFromUrl, renown);

  const documentCache = new DocumentCache(reactorClientModule.client);

  // dispatch the events to set the values in the window object
  setDefaultPHGlobalConfig(phGlobalConfigFromEnv);
  setReactorClientModule(reactorClientModule);
  setReactorClient(reactorClientModule.client);
  setDocumentCache(documentCache);
  setRenown(renown);
  setDrives(drives);
  setSelectedDrive(driveSlug);
  setSelectedNode(nodeSlug);
  setFeatures(features);

  // Add default drives for new reactor (after window.ph is set up)
  const defaultDrivesConfig = getDefaultDrivesFromEnv();
  if (defaultDrivesConfig.length > 0) {
    await addDefaultDrivesForNewReactor(defaultDrivesConfig);
  }

  // if remoteUrl is set and drive not already existing add remote drive and open it
  const remoteUrl = getDriveUrl();
  if (remoteUrl) {
    try {
      await addRemoteDrive(remoteUrl);
    } catch (error) {
      console.error(`Failed to add remote drive from ${remoteUrl}:`, error);
    }
  }

  // Subscribe via ReactorClient interface
  const reactorClient = reactorClientModule.client;
  reactorClient.subscribe({ type: "powerhouse/document-drive" }, (event) => {
    const docs = (event as any).documents ?? [];
    const docNames = docs.map((d: any) => d?.header?.name || d?.header?.id?.slice(0, 8) || "?").join(", ");
    console.log(`[Reactor] drive-change event type="${(event as any).type}" docs=[${docNames}]`);
    logger.verbose("ReactorClient subscription event: @event", event);
    refreshReactorDataClient(reactorClientModule.client).catch((e) =>
      logger.error("@error", e),
    );

    // Auto-register Swarm remotes for newly created drives.
    // This ensures drives created AFTER the initial registration window
    // still get synced to Swarm via SwarmChannel.
    // Awaited to prevent race: ops must not arrive before remote is registered.
    if ((event as any).type === "created") {
      const sm = reactorClientModule.reactorModule?.syncModule?.syncManager;
      const swarmState = (window.ph as any)?.swarm;
      if (sm && swarmState?.client && swarmState?.beeUrl) {
        (async () => {
          const { addSwarmRemoteForDrive } = await import("../../../adapter/src/channel/add-swarm-remote.js");
          for (const doc of docs) {
            const driveId = doc?.header?.id;
            if (!driveId) continue;
            try {
              await addSwarmRemoteForDrive(sm, driveId, {
                beeUrl: swarmState.beeUrl,
                batchId: swarmState.client?.stamps?.batchId ?? "",
                ownerAddress: (window.ph as any)?.renown?.user?.address ?? "",
              });
            } catch (err: any) {
              console.warn(`[SwarmChannel] Auto-register drive ${driveId.slice(0, 8)} failed:`, err);
            }
          }
        })();
      }
    }
  });

  // Redirect when a currently-viewed document or drive is deleted remotely
  reactorClient.subscribe({}, (event) => {
    console.log(`[Reactor] global event type="${event.type}" context=${JSON.stringify(event.context ?? {}).slice(0, 120)}`);
    if (event.type !== DocumentChangeType.Deleted) return;
    const deletedId = event.context?.childId;
    if (!deletedId) return;

    const selectedDriveId = window.ph?.selectedDriveId;
    const selectedNodeId = window.ph?.selectedNodeId;

    if (selectedDriveId && deletedId === selectedDriveId) {
      setSelectedDrive(undefined);
      toast("The drive you were viewing has been deleted");
      return;
    }

    if (selectedNodeId && deletedId === selectedNodeId) {
      setSelectedNode(undefined);
      toast("The document you were editing has been deleted");
    }
  });

  // Refresh from ReactorClient to pick up any synced drives
  await refreshReactorDataClient(reactorClientModule.client);

  // Setup processor factories for packages that have them
  const packagesWithProcessorFactories = packageManager.packages.filter(
    (pkg) => pkg.processorFactory !== undefined,
  );

  if (packagesWithProcessorFactories.length > 0) {
    const readModels =
      reactorClientModule.reactorModule?.readModelCoordinator?.readModels ?? [];
    const processorHostModule = await createProcessorHostModule(
      reactorClientModule.client,
      readModels,
    );
    if (processorHostModule !== undefined) {
      await Promise.all(
        packagesWithProcessorFactories.map(async (pkg) => {
          const { manifest, processorFactory } = pkg;
          const name = manifest.name;
          const id = manifest.name;
          logger.info("Loading processor factory: @name", name);
          try {
            const factory = await processorFactory?.(processorHostModule);
            if (!factory) return;
            await reactorClientModule.reactorModule?.processorManager.registerFactory(
              id,
              factory,
            );
          } catch (error) {
            logger.error(`Error registering processor: @name`, name);
            logger.error("@error", error);
          }
        }),
      );
    }
  }

  // Initialize Swarm plugin in the background (non-blocking)
  // Connects to Bee node, derives wallet key, starts sync
  initSwarmPlugin().catch((err) =>
    logger.warn("[SwarmPlugin] Init failed:", err),
  );

  // Subscribe to Swarm events for toast notifications at the app level.
  // These must live here (not in the settings modal) so toasts fire even
  // when the settings panel is closed — e.g. during normal document editing.
  let pollCount = 0;
  const pollSwarmEvents = setInterval(() => {
    pollCount++;
    const on = (window.ph as any)?.swarm?.on;
    if (!on) {
      // Give up after 30s (30 attempts) to avoid infinite polling
      if (pollCount > 30) clearInterval(pollSwarmEvents);
      return;
    }
    clearInterval(pollSwarmEvents);

    // Define registerSwarmRemotes before event handlers that reference it.
    // Register Swarm remotes for drives — includes Swarm discovery + recovery.
    const registerSwarmRemotes = async () => {
      const swarmState = (window.ph as any)?.swarm;
      const sm = reactorClientModule.reactorModule?.syncModule?.syncManager;
      if (!sm) {
        console.log("[SwarmChannel] No syncManager — skipping drive registration");
        return;
      }
      if (!swarmState?.client || !swarmState?.beeUrl) {
        console.log("[SwarmChannel] Swarm not ready — will retry");
        return;
      }

      // Check local drives first
      const drivesList = await getDrives(reactorClientModule.client);
      const localDriveIds = drivesList.map((d: any) => {
        if (typeof d === "string") return d;
        if (d?.id) return d.id;
        if (d?.slug) return d.slug;
        if (d?.header?.id) return d.header.id;
        return "";
      }).filter(Boolean);

      // If no local drives, check Swarm user manifest for recovery.
      let driveIds = localDriveIds;
      if (driveIds.length === 0 && swarmState.client) {
        try {
          const userManifest = await swarmState.client.readUserManifest(
            (window.ph as any)?.renown?.user?.address ?? "",
          );
          if (userManifest?.drives) {
            driveIds = Object.keys(userManifest.drives);
            if (driveIds.length > 0) {
              console.log(`[SwarmChannel] No local drives, found ${driveIds.length} on Swarm:`, driveIds.map((id: string) => id.slice(0, 8)));
            }
          }
        } catch {
          // No user manifest on Swarm — truly fresh start
        }
      }

      if (driveIds.length === 0) return false;
      console.log(`[SwarmChannel] Registering ${driveIds.length} drive(s):`, driveIds.map((id: string) => id.slice(0, 8)));

      const ownerAddr = (window.ph as any)?.renown?.user?.address ?? swarmState.ownerAddress ?? "";
      let registered = 0;
      for (const driveId of driveIds) {
        if (!driveId) continue;
        try {
          const { addSwarmRemoteForDrive } = await import("../../../adapter/src/channel/add-swarm-remote.js");
          const added = await addSwarmRemoteForDrive(sm, String(driveId), {
            beeUrl: swarmState.beeUrl,
            batchId: swarmState.client?.stamps?.batchId ?? "",
            ownerAddress: ownerAddr,
          });
          if (added) registered++;
        } catch (err) {
          console.warn(`[SwarmChannel] Failed to register drive ${String(driveId).slice(0, 8)}:`, err);
        }
      }
      if (registered > 0) {
        console.log(`[SwarmChannel] Registered ${registered} Swarm remote(s)`);

        // If this was a recovery (drives from Swarm, not local), trigger one pull.
        const phAny = window.ph as any;
        if (localDriveIds.length === 0 && !phAny?._skipSwarmRecovery) {
          console.log("[SwarmChannel] Recovery mode — triggering inbox pull");
          const remotes = sm.list();
          for (const remote of remotes) {
            if ((remote.channel as any)?.pullFromSwarm) {
              (remote.channel as any).pullFromSwarm().catch(() => {});
            }
          }
        } else if (phAny?._skipSwarmRecovery) {
          console.log("[SwarmChannel] Skipping recovery — storage was just cleared");
          phAny._skipSwarmRecovery = false;
        }
      }
      return registered > 0;
    };

    on("sync:confirmed", (e: Record<string, unknown>) => {
      const chunks = e.chunksTotal ? ` (${e.chunksSynced}/${e.chunksTotal} chunks)` : "";
      toast(`"${e.docName}" synced to Swarm${chunks} in ${e.durationMs}ms`, { type: "connect-success" });
    });
    on("sync:error", (e: Record<string, unknown>) => {
      toast(`Sync failed: ${e.error}`, { type: "connect-warning" });
    });
    on("sync:all-synced", () => {
      toast("All documents synced to Swarm", { type: "connect-success" });
    });
    on("plugin:ready", () => {
      toast("Connected to Swarm", { type: "connect-success" });

      // Run the full registration flow (including Swarm discovery + recovery).
      // This is critical when the plugin takes longer to initialize than the
      // 30s retry window (e.g., wallet signature prompt delays).
      registerSwarmRemotes().catch((err) =>
        logger.warn("[SwarmChannel] Plugin-ready registration failed:", err),
      );
    });
    // Show a one-time notification on first retry — auto-closes after 30s
    let retryToastShown = false;
    on("plugin:retrying", () => {
      if (retryToastShown) return;
      retryToastShown = true;
      toast(
        "Bee node not reachable. Go to Settings \u2192 Swarm Storage to configure your node URL.",
        { type: "connect-warning", autoClose: 30000 } as any,
      );
    });
    on("storage:cleared", () => {
      toast("Swarm storage cleared", { type: "connect-success" });
    });

    logger.info("[SwarmPlugin] Toast notifications active");

    // Try immediately, then retry every 3s up to 30s (drives may be hydrating)
    let attempts = 0;
    const retryInterval = setInterval(async () => {
      attempts++;
      try {
        const done = await registerSwarmRemotes();
        if (done || attempts >= 10) {
          clearInterval(retryInterval);
          if (!done && attempts >= 10) {
            console.log("[SwarmChannel] Gave up waiting for drives after 30s");
          }
        }
      } catch (err) {
        console.warn("[SwarmChannel] Registration attempt failed:", err);
        if (attempts >= 10) clearInterval(retryInterval);
      }
    }, 3000);
  }, 1000);

  window.ph.loading = false;
}

function getDidFromUrl() {
  const searchParams = new URLSearchParams(window.location.search);
  const didComponent = searchParams.get("user");
  const did = didComponent ? decodeURIComponent(didComponent) : undefined;
  return did;
}

function getDriveUrl() {
  const searchParams = new URLSearchParams(window.location.search);
  const driveUrl = searchParams.get("driveUrl");
  const url = driveUrl ? decodeURIComponent(driveUrl) : undefined;
  return url;
}
