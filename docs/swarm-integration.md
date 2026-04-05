# Swarm Integration Guide

## Current Swarm Node

- **URL**: `https://dappnode-tailscale.tailcbc470.ts.net:1633/`
- **Tailscale HTTP**: `http://100.121.241.25:1633/`
- **Protocol**: Supports both HTTP and HTTPS
- **Endpoint**: Your own bee node on DappNode

## Bee API Endpoints Used

### `/bytes` — Upload/Download Immutable Content

```bash
# Upload a chunk
curl -X POST "https://dappnode-tailscale.tailcbc470.ts.net:1633/bytes" \
  -H "Swarm-Postage-Stamp-Id: $STAMP_ID" \
  -H "Content-Type: application/octet-stream" \
  -d '{"docId":"abc","op":{"type":"SET_TITLE"}}'

# Get chunk
curl "https://dappnode-tailscale.tailcbc470.ts.net:1633/bytes/f1c9a4b3..."
```

### `/feeds/<owner>/<topic>` — Mutable References

```bash
# Upload feed update
curl -X POST "https://dappnode-tailscale.tailcbc470.ts.net:1633/feeds/$OWNER/$TOPIC" \
  -H "Swarm-Postage-Stamp-Id: $STAMP_ID" \
  -H "Content-Type: application/octet-stream" \
  -d '{"operationsHash":"hash1","latestRevision":99}'

# Read feed
curl "https://dappnode-tailscale.tailcbc470.ts.net:1633/feeds/$OWNER/$TOPIC"
```

### `/stamps` — List Postage Stamps (for upload)

```bash
curl "https://dappnode-tailscale.tailcbc470.ts.net:1633/stamps"
```

## Feed Update Pattern

The **CRITICAL** insight about Swarm feeds:

1. **ENS domain points to feed manifest** (immutable reference to the feed)
2. **Feed updates** are mutable — you can change the content hash they point to
3. **You NEVER change ENS content hash** — only update the feed reference
4. **MIME Wrapper** (`---------------------------[hash]`) is **normal** — the ENS Gateway extracts HTML automatically

So the adaptor will:
- Upload operation batches to Swarm → get content hash
- Update the feed with new content hash
- ENS stays the same — feed handles the mutable pointer

## Feed Update Workflow

```
┌──────────┐     ┌────────┐     ┌────────┐     ┌─────────┐
│ New Ops  │──→  │ Upload │──→  │ Update │──→  │ Feed    │
│ written  │     │ /bytes │     │ Feed   │     │ pointer │
│ locally  │     │ /hash  │     │ ref    │     │ updated │
└──────────┘     └────────┘     └────────┘     └─────────┘
```

## What We DON'T Need to Change

- **ENS content hash** — NEVER change this
- **MIME wrapper** — it's expected Swarm behavior
- **ENS Gateway** — handles MIME parsing automatically

## ENS Integration (Future)

```
freeliberty.eth → Feed Manifest Hash
  └── Feed → latest operationsHash for each document
      └── /bytes → actual operation/keyframe data
```
