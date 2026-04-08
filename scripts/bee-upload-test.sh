#!/usr/bin/env bash
# Upload a test JSON blob to Swarm and immediately download + verify it.
# Usage: ./scripts/bee-upload-test.sh [BATCH_ID]
set -euo pipefail

BEE_URL="${BEE_URL:-http://localhost:1633}"

# Get batch ID from arg, env, or auto-detect
if [ "${1:-}" != "" ]; then
  BATCH_ID="$1"
elif [ "${SWARM_STAMP_ID:-}" != "" ]; then
  BATCH_ID="$SWARM_STAMP_ID"
else
  BATCH_ID=$(curl -sf "$BEE_URL/stamps" | jq -r '.stamps[0].batchID // empty')
  if [ -z "$BATCH_ID" ]; then
    echo "No stamps found. Creating one..."
    BATCH_ID=$(curl -sf -X POST "$BEE_URL/stamps/10000000/24" | jq -r .batchID)
    echo "Created stamp: $BATCH_ID"
    echo ""
  fi
fi

echo "=== Swarm Upload/Download Test ==="
echo "Bee URL:  $BEE_URL"
echo "Batch ID: ${BATCH_ID:0:16}..."
echo ""

# Create test payload
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
PAYLOAD=$(cat <<EOF
{
  "test": true,
  "message": "Hello from bee-reactor-adapter",
  "timestamp": "$TIMESTAMP",
  "data": {
    "operations": [
      {"id": "op-0", "index": 0, "action": {"type": "SET_TITLE", "input": {"title": "Test Doc"}}},
      {"id": "op-1", "index": 1, "action": {"type": "SET_BODY", "input": {"body": "Hello Swarm!"}}}
    ]
  }
}
EOF
)

echo "--- Uploading ---"
echo "$PAYLOAD" | jq -c .
echo ""

UPLOAD_RESULT=$(curl -sf -X POST "$BEE_URL/bytes" \
  -H "Swarm-Postage-Batch-Id: $BATCH_ID" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

REFERENCE=$(echo "$UPLOAD_RESULT" | jq -r .reference)
echo "Reference: $REFERENCE"
echo ""

echo "--- Downloading ---"
DOWNLOADED=$(curl -sf "$BEE_URL/bytes/$REFERENCE")

echo "$DOWNLOADED" | jq .
echo ""

echo "--- Verification ---"
UPLOAD_MSG=$(echo "$PAYLOAD" | jq -r .message)
DOWNLOAD_MSG=$(echo "$DOWNLOADED" | jq -r .message)

if [ "$UPLOAD_MSG" = "$DOWNLOAD_MSG" ]; then
  echo "PASS - Upload and download match"
  echo ""
  echo "Operations stored:"
  echo "$DOWNLOADED" | jq -r '.data.operations[] | "  [\(.index)] \(.action.type): \(.action.input | tostring)"'
else
  echo "FAIL - Content mismatch!"
  echo "  Expected: $UPLOAD_MSG"
  echo "  Got:      $DOWNLOAD_MSG"
  exit 1
fi
