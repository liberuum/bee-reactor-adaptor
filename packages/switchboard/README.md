# @liberuum-org/switchboard

Fork of `@powerhousedao/switchboard@6.0.0-dev.156` with Swarm Bee storage adapter support.

## What Changed

When environment variables `SWARM_BEE_URL`, `SWARM_STAMP_ID`, and `SWARM_SIGNER_KEY` are set, the switchboard registers a `SwarmSyncReadModel` that uploads every reactor operation to a Swarm Bee node. When the env vars are not set, behavior is identical to the original package.

**Total changes: 1 import added, 16 lines of logic added.**

## Usage

```bash
# Install as a drop-in replacement
npm install @liberuum-org/switchboard@6.0.0-dev.156-swarm.5

# Or override in an existing project
# package.json:
{
  "overrides": {
    "@powerhousedao/switchboard": "npm:@liberuum-org/switchboard@6.0.0-dev.156-swarm.5"
  }
}
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SWARM_BEE_URL` | Yes | Bee node API URL (e.g. `http://localhost:1633`) |
| `SWARM_STAMP_ID` | Yes | Postage stamp batch ID for uploads |
| `SWARM_SIGNER_KEY` | Yes | Private key (hex) for Swarm feed signing |
| `SWARM_FEED_MODE` | No | Set to `false` for `bee dev` mode (default: `true`) |
| `SWARM_ENCRYPTION_KEY` | No | 32-byte hex key for AES-256-GCM encryption of all uploads. When set, all operation batches are encrypted before Swarm upload. |

```bash
# Start Vetra with Swarm storage
SWARM_BEE_URL=http://localhost:1633 \
SWARM_STAMP_ID=your-stamp-id \
SWARM_SIGNER_KEY=0x... \
SWARM_FEED_MODE=false \
ph-cli vetra --watch
```

You'll see in the logs:
```
ℹ [switchboard] Swarm Bee adapter enabled (http://localhost:1633)
ℹ [switchboard] Swarm Bee adapter started — operations will persist to Swarm
```

## Diff

```diff
--- @powerhousedao/switchboard@6.0.0-dev.156 (server-DaWxxH2k.mjs)
+++ @liberuum-org/switchboard@6.0.0-dev.156-swarm.5

 import { ChannelScheme, EventBus, ReactorBuilder, ... } from "@powerhousedao/reactor";
+import { SwarmSyncReadModel, SwarmClient } from "@liberuum-org/bee-reactor-adapter";

 // Inside initializeClient(), after withDocumentModelLoader:
+    const swarmBeeUrl = process.env.SWARM_BEE_URL;
+    const swarmStampId = process.env.SWARM_STAMP_ID;
+    const swarmSignerKey = process.env.SWARM_SIGNER_KEY;
+    if (swarmBeeUrl && swarmStampId && swarmSignerKey) {
+      const swarmClient = new SwarmClient({
+        beeUrl: swarmBeeUrl,
+        batchId: swarmStampId,
+        signerPrivateKey: swarmSignerKey,
+        useFeedMode: process.env.SWARM_FEED_MODE !== "false",
+      });
+      builder.withReadModel(new SwarmSyncReadModel(swarmClient, logger));
+      logger.info(`Swarm Bee adapter enabled (${swarmBeeUrl})`);
+    }

 // After buildModule() and ReactorInstrumentation:
+    if (swarmBeeUrl && swarmStampId && swarmSignerKey) {
+      logger.info("Swarm Bee adapter started — operations will persist to Swarm");
+    }
```

## How It Works

The `SwarmSyncReadModel` implements the reactor's `IReadModel` interface and is registered via the existing `ReactorBuilder.withReadModel()` extension point. The reactor's `ReadModelCoordinator` calls `indexOperations()` on every registered read model whenever operations are written. Our read model uploads the operations to Swarm `/bytes` and updates the document's manifest.

This approach requires **zero changes to the reactor's internal write path**. The Swarm upload is asynchronous and non-blocking — if it fails, errors are logged but the reactor continues normally.

## Dependencies

This package depends on `@liberuum-org/bee-reactor-adapter@0.2.0` which provides `SwarmSyncReadModel` and `SwarmClient`.

## Base Version

- Based on: `@powerhousedao/switchboard@6.0.0-dev.156`
- Only `server-DaWxxH2k.mjs` is modified (the server initialization file)
- All other files are identical to the original
