# @liberuum-org/connect

Fork of `@powerhousedao/connect` with **Swarm Storage** integration. Adds decentralized document storage, encrypted sharing, and recovery via Swarm Bee nodes.

## What's Added

### Swarm Storage Settings Tab
- **Connection**: configurable Bee node URL with Save & Connect
- **Your Swarm ID**: copyable signer address for sharing with other users
- **Storage stats**: capacity, TTL, utilization, USD pricing
- **Document tree**: drives + docs with sync status badges
- **Share**: checkbox tree to share individual docs or full drives with another Swarm user
- **Import**: enter a sender's Swarm ID to import documents shared with you
- **Stamp management**: extend duration, expand storage, buy new stamps
- **Clear storage**: surgical clear (keeps identity, clears drives/shares)

### Source Changes vs Upstream (`@powerhousedao/connect@6.0.0-dev.174`)

| File | Change |
|------|--------|
| `src/utils/reactor.ts` | Uses `createSwarmSyncBuilder()` + `ReactorBuilder.withSync()` for dual GQL + Swarm channels |
| `src/store/reactor.ts` | Swarm plugin init, event handlers, drive registration + recovery from Swarm |
| `src/components/modal/modals/SettingsModal.tsx` | Added SwarmIcon + "Swarm Storage" tab |
| `src/components/modal/modals/settings/swarm-settings/` | Full Swarm settings UI (12 new files) |
| `src/components/swarm-landing.tsx` | Landing gate — forces wallet login before app access |
| `src/components/app-loader.tsx` | Wraps `<App>` in `<SwarmLandingGate>` |

All other source files are synced from upstream `@powerhousedao/connect@6.0.0-dev.174`.

## Publishing

```bash
npm run build
npm publish --tag swarm
```

Published as `@liberuum-org/connect` on npm with the `swarm` tag.

## Usage

In `package.json` overrides:
```json
{
  "overrides": {
    "@powerhousedao/connect": "npm:@liberuum-org/connect@6.0.0-dev.174-swarm.1"
  }
}
```
