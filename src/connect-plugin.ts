import { SwarmClient } from "./swarm-client.js";
import {
  getOrDeriveSwarmKey,
  clearCachedSwarmKey,
  type SwarmSignerEntry,
} from "./wallet-signer.js";
import type { SwarmUserManifest, StampStatus } from "./types.js";

/**
 * Swarm Connect Plugin — hooks into the running Connect app to provide
 * Swarm identity, document discovery, and stamp management.
 *
 * On Renown login:
 * 1. Checks IndexedDB for a cached Swarm signer key
 * 2. If not found, prompts the user's wallet for a one-time signature
 * 3. Derives a secp256k1 key (deterministic: same wallet = same key)
 * 4. Initializes the Bee client with the derived key
 * 5. Reads the user manifest from Swarm (document discovery)
 * 6. Starts stamp health monitoring
 *
 * On logout or browser data clear:
 * - Key cache is cleared, next login re-derives from wallet
 * - Swarm data is NOT lost (same wallet = same key = same access)
 *
 * Usage:
 *   const plugin = new SwarmConnectPlugin({
 *     beeUrl: "http://localhost:1633",
 *     batchId: "your-stamp-id",
 *     useFeedMode: false,
 *   });
 *   await plugin.start(); // Call after window.ph is initialized
 */
export class SwarmConnectPlugin {
  private swarmClient: SwarmClient | null = null;
  private signerEntry: SwarmSignerEntry | null = null;
  private unsubscribe: (() => void) | null = null;
  private userManifest: SwarmUserManifest | null = null;
  private stampStatus: StampStatus | null = null;
  private stampCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private config: {
      /** Bee node API URL */
      beeUrl: string;
      /** Postage stamp batch ID */
      batchId: string;
      /** Use feeds for manifests. Set false for bee dev. Default: true */
      useFeedMode?: boolean;
      /** Feed topic prefix. Change to migrate to fresh feeds. Default: "ph" */
      feedTopicPrefix?: string;
      /** Optional static signer key (skips wallet derivation — for Switchboard/testing) */
      signerPrivateKey?: string;
      /** How often to check stamp health (ms). Default: 60000 */
      stampCheckIntervalMs?: number;
      /** Callback when user manifest is loaded from Swarm */
      onUserManifestLoaded?: (manifest: SwarmUserManifest) => void;
      /** Callback when stamp health changes */
      onStampHealthChanged?: (status: StampStatus) => void;
      /** Callback when wallet signature is needed */
      onSignatureRequired?: () => void;
      /** Callback when Swarm client is ready (after key derivation) */
      onReady?: (client: SwarmClient, entry: SwarmSignerEntry) => void;
    },
  ) {}

  /**
   * Start the plugin. Call after `window.ph` is initialized.
   */
  async start(): Promise<void> {
    const ph = (globalThis as any).window?.ph;
    if (!ph) {
      console.warn("[SwarmPlugin] window.ph not available yet");
      return;
    }

    // Expose swarm state on window.ph
    ph.swarm = {
      plugin: this,
      client: null as SwarmClient | null,
      signerEntry: null as SwarmSignerEntry | null,
      userManifest: null as SwarmUserManifest | null,
      stampStatus: null as StampStatus | null,
      nodeWallet: null as string | null,
      nodeBalances: null as { xBZZ: string; xDAI: string } | null,
      ready: false,
    };

    // If static key provided (Switchboard mode), initialize immediately
    if (this.config.signerPrivateKey) {
      this.initializeWithKey(this.config.signerPrivateKey);
    }

    // Check if user is already logged in
    const renown = ph.renown;
    if (renown?.user?.address) {
      await this.onUserLogin(renown.user.address);
    }

    // Subscribe to future login/logout events
    if (renown) {
      const unsub = renown.on(
        "user",
        (user: { address?: string } | undefined) => {
          if (user?.address) {
            this.onUserLogin(user.address).catch((err: unknown) => {
              console.warn("[SwarmPlugin] Error on login:", err);
            });
          } else {
            this.onUserLogout();
          }
        },
      );
      this.unsubscribe = unsub;
    }
  }

  /**
   * Stop the plugin and clean up.
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.stampCheckInterval) {
      clearInterval(this.stampCheckInterval);
      this.stampCheckInterval = null;
    }
  }

  /**
   * Whether the Swarm client is initialized and ready.
   */
  isReady(): boolean {
    return this.swarmClient !== null;
  }

  getSwarmClient(): SwarmClient | null {
    return this.swarmClient;
  }

  getSignerEntry(): SwarmSignerEntry | null {
    return this.signerEntry;
  }

  getUserManifest(): SwarmUserManifest | null {
    return this.userManifest;
  }

  getStampStatus(): StampStatus | null {
    return this.stampStatus;
  }

  /**
   * Manually clear the cached Swarm key (for testing / logout).
   */
  async clearCache(): Promise<void> {
    await clearCachedSwarmKey();
    this.signerEntry = null;
    this.swarmClient = null;
    this.userManifest = null;
    this.updateWindowState();
  }

  // ─── Private ───────────────────────────────────────────────────

  private async onUserLogin(address: string): Promise<void> {
    console.log(`[SwarmPlugin] User login: ${address.slice(0, 10)}...`);

    // If no static key, derive from wallet (checks IndexedDB cache first)
    if (!this.config.signerPrivateKey) {
      try {
        const origin =
          typeof window !== "undefined" ? window.location.origin : undefined;
        const entry = await getOrDeriveSwarmKey(address, origin);

        this.signerEntry = entry;
        this.initializeWithKey(entry.swarmPrivateKey);

        console.log(
          `[SwarmPlugin] Swarm key derived for ${address.slice(0, 10)}...`,
        );
        this.config.onReady?.(this.swarmClient!, entry);
      } catch (err) {
        console.warn(
          "[SwarmPlugin] Failed to derive Swarm key:",
          err instanceof Error ? err.message : err,
        );
        return;
      }
    }

    // Fetch user manifest from Swarm
    if (this.swarmClient) {
      this.userManifest = await this.swarmClient.readUserManifest(address);
      if (this.userManifest) {
        const driveCount = Object.keys(this.userManifest.drives ?? {}).length;
        const docCount = Object.keys(this.userManifest.documents ?? {}).length;
        console.log(
          `[SwarmPlugin] Found ${driveCount} drives, ${docCount} doc entries on Swarm`,
        );
        this.config.onUserManifestLoaded?.(this.userManifest);
      } else {
        console.log("[SwarmPlugin] No documents found on Swarm (new user)");
      }
    }

    this.updateWindowState();
    this.startStampMonitoring();
  }

  private onUserLogout(): void {
    console.log("[SwarmPlugin] User logged out");
    this.userManifest = null;
    this.updateWindowState();
  }

  private initializeWithKey(privateKey: string): void {
    this.swarmClient = new SwarmClient({
      beeUrl: this.config.beeUrl,
      batchId: this.config.batchId,
      signerPrivateKey: privateKey,
      useFeedMode: this.config.useFeedMode,
      feedTopicPrefix: this.config.feedTopicPrefix,
    });
    this.updateWindowState();
    this.fetchNodeWalletInfo().catch(() => {});
  }

  private startStampMonitoring(): void {
    if (!this.swarmClient) return;
    if (this.stampCheckInterval) {
      clearInterval(this.stampCheckInterval);
    }

    const intervalMs = this.config.stampCheckIntervalMs ?? 60_000;
    const check = async () => {
      if (!this.swarmClient) return;
      try {
        const prev = this.stampStatus?.health;
        this.stampStatus = await this.swarmClient.getStampStatus();
        this.updateWindowState();

        if (prev !== this.stampStatus.health) {
          this.config.onStampHealthChanged?.(this.stampStatus);
          if (
            this.stampStatus.health === "warning" ||
            this.stampStatus.health === "critical"
          ) {
            console.warn(
              `[SwarmPlugin] Stamp health: ${this.stampStatus.health} (${this.stampStatus.ttlHuman} remaining)`,
            );
          }
        }
      } catch {
        // Bee node might be unreachable
      }
    };

    check();
    this.stampCheckInterval = setInterval(check, intervalMs);
  }

  private updateWindowState(): void {
    const ph = (globalThis as any).window?.ph;
    if (ph?.swarm) {
      ph.swarm.client = this.swarmClient;
      ph.swarm.signerEntry = this.signerEntry;
      ph.swarm.userManifest = this.userManifest;
      ph.swarm.stampStatus = this.stampStatus;
      ph.swarm.ready = this.swarmClient !== null;
    }
  }

  /**
   * Fetch and cache the Bee node's Gnosis wallet address and balances.
   * Called after the Swarm client initializes so the settings UI can
   * show funding information.
   */
  private async fetchNodeWalletInfo(): Promise<void> {
    if (!this.swarmClient) return;
    const ph = (globalThis as any).window?.ph;
    if (!ph?.swarm) return;
    try {
      const wallet = await this.swarmClient.getNodeWallet();
      ph.swarm.nodeWallet = wallet.address;
      ph.swarm.nodeBalances = { xBZZ: wallet.xBZZ, xDAI: wallet.xDAI };
    } catch {
      // Bee node may not expose wallet endpoint (e.g. bee dev mode)
    }
  }
}
