import { SwarmClient } from "./swarm-client.js";
import { getOrDeriveSwarmKey, clearCachedSwarmKey, } from "./wallet-signer.js";
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
 */
export class SwarmConnectPlugin {
    config;
    swarmClient = null;
    signerEntry = null;
    unsubscribe = null;
    userManifest = null;
    stampStatus = null;
    stampCheckInterval = null;
    constructor(config) {
        this.config = config;
    }
    // ─── Access to window.ph ──────────────────────────────────────
    /** Single accessor for the Connect app's global context */
    get ph() {
        return globalThis.window?.ph;
    }
    /**
     * Start the plugin. Call after `window.ph` is initialized.
     */
    async start() {
        if (!this.ph) {
            console.warn("[SwarmPlugin] window.ph not available yet");
            return;
        }
        // Expose swarm state on window.ph
        this.ph.swarm = {
            plugin: this,
            client: null,
            signerEntry: null,
            userManifest: null,
            stampStatus: null,
            nodeWallet: null,
            nodeBalances: null,
            ready: false,
        };
        // If static key provided (Switchboard mode), initialize immediately
        if (this.config.signerPrivateKey) {
            this.initializeWithKey(this.config.signerPrivateKey);
        }
        // Check if user is already logged in
        const renown = this.ph.renown;
        if (renown?.user?.address) {
            await this.onUserLogin(renown.user.address);
        }
        // Subscribe to future login/logout events
        if (renown) {
            const unsub = renown.on("user", (user) => {
                if (user?.address) {
                    this.onUserLogin(user.address).catch((err) => {
                        console.warn("[SwarmPlugin] Error on login:", err);
                    });
                }
                else {
                    this.onUserLogout();
                }
            });
            this.unsubscribe = unsub;
        }
    }
    /**
     * Stop the plugin and clean up all state.
     */
    stop() {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
        if (this.stampCheckInterval) {
            clearInterval(this.stampCheckInterval);
            this.stampCheckInterval = null;
        }
        this.swarmClient = null;
        this.signerEntry = null;
        this.userManifest = null;
        this.stampStatus = null;
        this.updateWindowState();
    }
    isReady() {
        return this.swarmClient !== null;
    }
    getSwarmClient() {
        return this.swarmClient;
    }
    getSignerEntry() {
        return this.signerEntry;
    }
    getUserManifest() {
        return this.userManifest;
    }
    getStampStatus() {
        return this.stampStatus;
    }
    /**
     * Manually clear the cached Swarm key (for testing / logout).
     */
    async clearCache() {
        await clearCachedSwarmKey();
        this.signerEntry = null;
        this.swarmClient = null;
        this.userManifest = null;
        this.updateWindowState();
    }
    // ─── Private ──────────────────────────────────────────────────
    async onUserLogin(address) {
        console.log(`[SwarmPlugin] User login: ${address.slice(0, 10)}...`);
        if (!this.config.signerPrivateKey) {
            try {
                const origin = typeof window !== "undefined" ? window.location.origin : undefined;
                const entry = await getOrDeriveSwarmKey(address, origin);
                this.signerEntry = entry;
                this.initializeWithKey(entry.swarmPrivateKey);
                console.log(`[SwarmPlugin] Swarm key derived for ${address.slice(0, 10)}...`);
                this.config.onReady?.(this.swarmClient, entry);
            }
            catch (err) {
                console.warn("[SwarmPlugin] Failed to derive Swarm key:", err instanceof Error ? err.message : err);
                return;
            }
        }
        if (this.swarmClient) {
            this.userManifest = await this.swarmClient.readUserManifest(address);
            if (this.userManifest) {
                const driveCount = Object.keys(this.userManifest.drives ?? {}).length;
                console.log(`[SwarmPlugin] Found ${driveCount} drive(s) on Swarm`);
            }
            else {
                console.log("[SwarmPlugin] No documents found on Swarm (new user)");
                this.userManifest = {
                    address,
                    documents: {},
                    drives: {},
                    stamps: {},
                    updatedAt: new Date().toISOString(),
                };
            }
            this.config.onUserManifestLoaded?.(this.userManifest);
        }
        this.updateWindowState();
        this.startStampMonitoring();
    }
    onUserLogout() {
        console.log("[SwarmPlugin] User logged out");
        this.userManifest = null;
        this.updateWindowState();
    }
    initializeWithKey(privateKey) {
        this.swarmClient = new SwarmClient({
            beeUrl: this.config.beeUrl,
            batchId: this.config.batchId,
            signerPrivateKey: privateKey,
            useFeedMode: this.config.useFeedMode,
            feedTopicPrefix: this.config.feedTopicPrefix,
        });
        this.updateWindowState();
        this.fetchNodeWalletInfo().catch(() => { });
    }
    startStampMonitoring() {
        if (!this.swarmClient)
            return;
        if (this.stampCheckInterval) {
            clearInterval(this.stampCheckInterval);
        }
        const intervalMs = this.config.stampCheckIntervalMs ?? 60_000;
        const check = async () => {
            if (!this.swarmClient)
                return;
            try {
                const prev = this.stampStatus?.health;
                this.stampStatus = await this.swarmClient.getStampStatus();
                this.updateWindowState();
                if (prev !== this.stampStatus.health) {
                    this.config.onStampHealthChanged?.(this.stampStatus);
                    if (this.stampStatus.health === "warning" ||
                        this.stampStatus.health === "critical") {
                        console.warn(`[SwarmPlugin] Stamp health: ${this.stampStatus.health} (${this.stampStatus.ttlHuman} remaining)`);
                    }
                }
            }
            catch {
                // Bee node might be unreachable
            }
        };
        check();
        this.stampCheckInterval = setInterval(check, intervalMs);
    }
    updateWindowState() {
        const swarm = this.ph?.swarm;
        if (!swarm)
            return;
        swarm.client = this.swarmClient;
        swarm.signerEntry = this.signerEntry;
        swarm.userManifest = this.userManifest;
        swarm.stampStatus = this.stampStatus;
        swarm.ready = this.swarmClient !== null;
    }
    async fetchNodeWalletInfo() {
        if (!this.swarmClient)
            return;
        const swarm = this.ph?.swarm;
        if (!swarm)
            return;
        try {
            const wallet = await this.swarmClient.getNodeWallet();
            swarm.nodeWallet = wallet.address;
            swarm.nodeBalances = { xBZZ: wallet.xBZZ, xDAI: wallet.xDAI };
        }
        catch {
            // Bee node may not expose wallet endpoint (e.g. bee dev mode)
        }
    }
}
//# sourceMappingURL=connect-plugin.js.map