import type { SwarmClient } from "./swarm-client.js";
/**
 * Minimal PHDocument type matching the reactor's definition.
 * The actual type from the reactor should be used when integrating.
 */
export type PHDocument = Record<string, unknown>;
export interface IKeyframeStore {
    putKeyframe(documentId: string, scope: string, branch: string, revision: number, document: PHDocument, signal?: AbortSignal): Promise<void>;
    findNearestKeyframe(documentId: string, scope: string, branch: string, targetRevision: number, signal?: AbortSignal): Promise<{
        revision: number;
        document: PHDocument;
    } | undefined>;
    listKeyframes(documentId: string, scope?: string, branch?: string, signal?: AbortSignal): Promise<Array<{
        scope: string;
        branch: string;
        revision: number;
        document: PHDocument;
    }>>;
    deleteKeyframes(documentId: string, scope?: string, branch?: string, signal?: AbortSignal): Promise<number>;
}
/**
 * Write-through IKeyframeStore that persists keyframes to both a local
 * SQL store (for fast reads) and Swarm /bytes (for decentralized persistence).
 */
export declare class SwarmKeyframeStore implements IKeyframeStore {
    private readonly swarmClient;
    private readonly logger;
    private localStore;
    constructor(swarmClient: SwarmClient, localStore: IKeyframeStore, logger?: {
        warn: (...args: unknown[]) => void;
    });
    /**
     * Replace the local store after construction.
     * Used to inject the Kysely stores created by buildModule() at runtime.
     */
    setLocalStore(store: IKeyframeStore): void;
    /**
     * Forward withTransaction to the local store for Kysely transaction scoping.
     */
    withTransaction(trx: unknown): SwarmKeyframeStore;
    putKeyframe(documentId: string, scope: string, branch: string, revision: number, document: PHDocument, signal?: AbortSignal): Promise<void>;
    findNearestKeyframe(documentId: string, scope: string, branch: string, targetRevision: number, signal?: AbortSignal): Promise<{
        revision: number;
        document: PHDocument;
    } | undefined>;
    listKeyframes(documentId: string, scope?: string, branch?: string, signal?: AbortSignal): Promise<Array<{
        scope: string;
        branch: string;
        revision: number;
        document: PHDocument;
    }>>;
    deleteKeyframes(documentId: string, scope?: string, branch?: string, signal?: AbortSignal): Promise<number>;
    private uploadKeyframeToSwarm;
}
//# sourceMappingURL=swarm-keyframe-store.d.ts.map