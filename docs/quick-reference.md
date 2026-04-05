# Quick Reference

## Important URLs

| Service | URL |
|---|---|
| Swarm Bee | `https://dappnode-tailscale.tailcbc470.ts.net:1633/` |
| Tailscale Bee | `http://100.121.241.25:1633/` |
| Powerhouse Switchboard | `https://switchboard-dev.powerhouse.xyz/graphql` |
| Powerhouse Knowledge Vault | UUID: `cbbc2a6c-65ba-4732-b3cd-c4796ddcb734` |
| ENS: freeliberty.eth | Points to feed manifest |
| Powerhouse source | `/workspace/powerhouse/packages/reactor/src/` |

## 10 Core Concepts

1. **Operations** = append-only hash chain of mutations — the source of truth
2. **Keyframes** = periodic snapshots for fast state rebuild
3. **Feeds** = mutable pointers on Swarm (never change ENS, update feeds)
4. **`/bytes`** = immutable content storage on Swarm
5. **DocSync** = protocol for syncing operations between reactors
6. **Write Cache** = ring buffer with LRU eviction
7. **Read Models** = projections built from operations (DocumentView, DocumentIndexer)
8. **Processors** = user-defined side effects fired after read models
9. **Job Lifecycle** = PENDING → RUNNING → WRITE_READY → READ_READY (or FAILED)
10. **MIME Wrapper** = expected Swarm behavior (ENS gateway parses automatically)

## DappNode Endpoints

| Service | Primary | Backup |
|---|---|---|
| Swarm Bee | `https://dappnode-tailscale.tailcbc470.ts.net:1633/` | `http://100.121.241.25:1633/` |
| Reth (Web3 RPC) | `https://dappnode-tailscale.tailcbc470.ts.net:8545/` | `http://100.121.241.25:8545/` |
| MCP Server | `https://dappnode-tailscale.tailcbc470.ts.net:4010/mcp` | `http://100.121.241.25:4010/mcp` |
