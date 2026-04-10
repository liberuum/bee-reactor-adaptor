#!/usr/bin/env bash
# Download and pretty-print a Swarm reference (any JSON blob stored via /bytes).
# Usage: ./scripts/bee-inspect.sh <reference>
set -euo pipefail

BEE_URL="${BEE_URL:-http://localhost:1633}"

if [ "${1:-}" = "" ]; then
  echo "Usage: $0 <swarm-reference>"
  echo ""
  echo "Download and display a JSON blob from Swarm /bytes."
  echo "The reference is the hex hash returned by uploadData()."
  echo ""
  echo "Examples:"
  echo "  $0 a1b2c3d4e5f6..."
  echo "  $0 a1b2c3d4e5f6... | jq .operationBatches"
  exit 1
fi

REFERENCE="$1"

echo "=== Swarm Inspect ==="
echo "Reference: $REFERENCE"
echo "URL: $BEE_URL/bytes/$REFERENCE"
echo ""

DATA=$(curl -sf "$BEE_URL/bytes/$REFERENCE" 2>/dev/null) || {
  echo "ERROR: Could not download reference $REFERENCE"
  echo "The reference may not exist or the Bee node may be unreachable."
  exit 1
}

# Try to parse as JSON, fall back to raw
if echo "$DATA" | jq . >/dev/null 2>&1; then
  echo "$DATA" | jq .
else
  echo "(raw data, not JSON)"
  echo "$DATA" | head -c 2000
fi
