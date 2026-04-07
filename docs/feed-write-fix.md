# Feed Write Fix — Root Cause & Solution

**Date:** 2026-04-07  
**Adapter version:** 0.14.0  
**Status:** Fixed

## The Problem

Persistent 400 (Bad Request) errors when writing to Swarm feeds, causing user manifest data loss and failed sync operations.

## Root Cause

Three issues combined:

### 1. Feed Index Gaps (adapter 0.11.0-0.12.0)
Early versions manually tracked feed indices and passed explicit `options.index` to `writer.uploadPayload()`. When retries wrote at non-consecutive indices (e.g., index 5 when only 0-2 existed), it created **gaps** in the feed sequence.

Per Swarm docs: *"Only the highest **consecutively** filled index is considered the latest."* Gaps break `findNextIndex` — the exponential binary search can't find entries after a gap.

### 2. Concurrent Writers (no serialization)
Two sync operations (drive + doc) would call `updateUserManifest` concurrently. Both called `findNextIndex` at the same time, got the same next index, and one write succeeded while the other got 400 (SOC already exists at that index).

Per Swarm docs: *"Each feed index is write-once. Updates are permanent."*

### 3. Corrupted Feed Accumulation
Each testing session added entries to the same user manifest feed topic (`ph:user:<address>`). After 100+ entries with gaps, the feed was unrecoverable — `findNextIndex` couldn't find a valid next index.

## The Fix

### Per-Topic Write Lock (serialization)
```typescript
private feedWriteLocks: Map<string, Promise<void>> = new Map();

private async writeFeedPayload(topic: Topic, payload: string): Promise<void> {
  const topicHex = topic.toHex();
  // Serialize: wait for any in-flight write to the same topic
  const pending = this.feedWriteLocks.get(topicHex);
  if (pending) await pending.catch(() => {});
  // ... write with lock
}
```
Only one write per topic at a time. Prevents concurrent writers from getting the same `findNextIndex` result.

### No Manual Index Management
```typescript
// Let bee-js handle index discovery automatically (Swarm best practice)
await writer.uploadPayload(this.batchId, data);
// No options.index — bee-js probes findNextIndex internally
```
Per Swarm docs: *"It is recommended to use the default behavior when performing feed updates (no index specified)."*

### Configurable Feed Topic Prefix
```typescript
feedTopicPrefix?: string  // Default: "ph"
// Usage: documentTopic = `${prefix}:doc:${documentId}`
//        userTopic = `${prefix}:user:${address}`
```
When feeds are corrupted (gaps from old versions), change the prefix to get fresh feeds. The old feeds expire with the postage stamp.

### Retry on 400 with Backoff
```typescript
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    await writer.uploadPayload(this.batchId, data);
    return;
  } catch (err) {
    if (msg.includes("400")) {
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    throw err;
  }
}
```
Handles transient propagation delays — if a previous write hasn't propagated yet, `findNextIndex` might return a stale index.

## Key Lessons

1. **Never pass explicit feed indices** — let bee-js handle `findNextIndex`
2. **Serialize writes per topic** — feeds assume single writer per topic
3. **Feeds are append-only, write-once per index** — no overwrites, no gaps
4. **Use topic versioning for migration** — don't try to fix corrupted feeds, create new ones
5. **Read Swarm docs before implementing** — the feed protocol has specific constraints that aren't obvious
