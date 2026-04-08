import { SwarmClient } from "./swarm-client.js";
import { type SwarmSignerEntry } from "./wallet-signer.js";
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
export declare class SwarmConnectPlugin {
    private config;
    private swarmClient;
    private signerEntry;
    private unsubscribe;
    private userManifest;
    private stampStatus;
    private stampCheckInterval;
    constructor(config: {
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
    });
    /**
     * Start the plugin. Call after `window.ph` is initialized.
     */
    start(): Promise<void>;
    /**
     * Stop the plugin and clean up.
     */
    stop(): void;
    /**
     * Whether the Swarm client is initialized and ready.
     */
    isReady(): boolean;
    getSwarmClient(): SwarmClient | null;
    getSignerEntry(): SwarmSignerEntry | null;
    getUserManifest(): SwarmUserManifest | null;
    getStampStatus(): StampStatus | null;
    /**
     * Manually clear the cached Swarm key (for testing / logout).
     */
    clearCache(): Promise<void>;
    private onUserLogin;
    private onUserLogout;
    private initializeWithKey;
    private startStampMonitoring;
    private updateWindowState;
    /**
     * Fetch and cache the Bee node's Gnosis wallet address and balances.
     * Called after the Swarm client initializes so the settings UI can
     * show funding information.
     */
    private fetchNodeWalletInfo;
}
//# sourceMappingURL=connect-plugin.d.ts.map