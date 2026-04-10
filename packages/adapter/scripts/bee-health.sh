#!/usr/bin/env bash
# Check Bee node health and show key info
set -euo pipefail

BEE_URL="${BEE_URL:-http://localhost:1633}"

echo "=== Bee Node Health ==="
echo "URL: $BEE_URL"
echo ""

HEALTH=$(curl -sf "$BEE_URL/health" 2>/dev/null) || {
  echo "OFFLINE - Cannot reach $BEE_URL"
  echo ""
  echo "Start the node with: bee dev"
  exit 1
}

echo "Status:  $(echo "$HEALTH" | jq -r .status)"
echo "Version: $(echo "$HEALTH" | jq -r .version)"
echo "API:     $(echo "$HEALTH" | jq -r .apiVersion)"
echo ""

echo "=== Postage Stamps ==="
STAMPS=$(curl -sf "$BEE_URL/stamps" 2>/dev/null) || { echo "Could not fetch stamps"; exit 1; }
COUNT=$(echo "$STAMPS" | jq '.stamps | length')

if [ "$COUNT" = "0" ]; then
  echo "No stamps found. Buy one with:"
  echo "  curl -s -X POST $BEE_URL/stamps/10000000/24 | jq"
else
  echo "$STAMPS" | jq -r '.stamps[] | "  Batch: \(.batchID[0:16])...  Usable: \(.usable)  TTL: \(.batchTTL)s"'
fi
echo ""
echo "Total stamps: $COUNT"
