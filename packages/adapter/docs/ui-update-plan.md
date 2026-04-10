# Settings UI Update Plan

Analysis of `packages/connect/src/components/modal/modals/settings/swarm-storage.tsx` (1,550 lines).

## Bugs to Fix

1. **`handleClearCache` (line 863-871)**: Calls `swarm.reconnect()` instead of `swarm.clearStorage()`. Should call clearStorage which auto-reconnects.
2. **`handleCreateStamp` (line 947)**: Calls `client.createStamp(amount, depth)` without `{ immutable: false }`. New stamps default to immutable on the Bee node if we don't specify.
3. **`bee dev` reference (line 844)**: Setup instructions mention `bee dev` — update to reflect production node usage.

## Features to Add

### Stamp Mutability (High Priority)
- Add `immutable` field and `warnings` array to `SwarmUiSnapshot.stampStatus`
- Show mutable/immutable badge next to stamp health indicator
- Display warnings from `stampStatus.warnings` as alert banners
- In "Buy a Postage Stamp" section: add a toggle for mutable vs immutable with descriptions
- Default the toggle to MUTABLE with explanation

### Event-Driven Toast Notifications (High Priority)
- Import `toast` from `@powerhousedao/connect/services`
- Subscribe to `window.ph.swarm.on()` events in a useEffect
- Map events to toasts:
  - `sync:confirmed` → success toast: "Doc synced to Swarm (1.2s)"
  - `sync:error` → error toast: "Sync failed for Doc: error"
  - `sync:all-synced` → success toast: "All documents synced"
  - `plugin:ready` → success toast: "Connected to Swarm"
  - `plugin:retrying` → warning toast: "Bee node offline, retrying..."
  - `storage:cleared` → info toast: "Storage cleared"

### Node Status Section (Medium Priority)
- New section after Connection showing: beeMode, connectedPeers, isReachable, neighborhoodSize, storageRadius
- Uses `getNodeStatus()` from SwarmClient (accessed via window.ph.swarm)

### Upload Progress (Medium Priority)
- Show chunk progress from tag tracking in sync badges
- When a doc is flushing: show "1/3 chunks synced" instead of just the spinner

## Type Updates

`SwarmUiSnapshot.stampStatus` needs:
```typescript
immutable?: boolean;
warnings?: string[];
```

`SwarmUiSnapshot` needs:
```typescript
on?: (event: string, handler: (data: any) => void) => () => void;
getNodeStatus?: () => Promise<NodeStatus>;
```

## Files to Modify
- `packages/connect/src/components/modal/modals/settings/swarm-storage.tsx` — main UI
- `packages/connect/src/components/swarm-landing.tsx` — no changes needed
