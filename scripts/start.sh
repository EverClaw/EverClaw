#!/bin/bash
set -euo pipefail

# Everclaw — Start Script
# Securely launches the proxy-router by injecting the wallet key from 1Password at runtime.

MORPHEUS_DIR="$HOME/morpheus"
LOG_DIR="$MORPHEUS_DIR/data/logs"
LOG_FILE="$LOG_DIR/router-stdout.log"

echo "♾️  Starting Everclaw (Morpheus proxy-router)..."

# Check installation
if [[ ! -f "$MORPHEUS_DIR/proxy-router" ]]; then
  echo "❌ proxy-router not found at $MORPHEUS_DIR/proxy-router"
  echo "   Run: bash skills/everclaw/scripts/install.sh"
  exit 1
fi

# Check if already running
if pgrep -f "proxy-router" > /dev/null 2>&1; then
  echo "⚠️  proxy-router is already running (PID: $(pgrep -f proxy-router | head -1))"
  echo "   Stop it first: bash skills/everclaw/scripts/stop.sh"
  exit 1
fi

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Source .env
if [[ -f "$MORPHEUS_DIR/.env" ]]; then
  set -a
  source "$MORPHEUS_DIR/.env"
  set +a
else
  echo "❌ .env not found at $MORPHEUS_DIR/.env"
  exit 1
fi

# Verify ETH_NODE_ADDRESS is set
if [[ -z "${ETH_NODE_ADDRESS:-}" ]]; then
  echo "❌ ETH_NODE_ADDRESS is not set in .env"
  echo "   The router will silently fail without it."
  exit 1
fi

# Retrieve wallet private key from 1Password (never stored on disk)
echo "🔐 Retrieving wallet private key from 1Password..."

OP_TOKEN=$(security find-generic-password -a "${OP_KEYCHAIN_ACCOUNT:-op-agent}" -s "op-service-account-token" -w 2>/dev/null) || {
  echo "❌ Could not retrieve 1Password service account token from keychain."
  echo "   Expected keychain account: ${OP_KEYCHAIN_ACCOUNT:-op-agent}"
  echo "   Expected keychain service: op-service-account-token"
  exit 1
}

WALLET_PRIVATE_KEY=$(OP_SERVICE_ACCOUNT_TOKEN="$OP_TOKEN" op item get "${OP_ITEM_NAME:-YOUR_ITEM_NAME}" --vault "${OP_VAULT_NAME:-YOUR_VAULT_NAME}" --fields "Private Key" --reveal 2>/dev/null) || {
  echo "❌ Could not retrieve wallet private key from 1Password."
  echo "   Set OP_ITEM_NAME and OP_VAULT_NAME environment variables, or edit this script."
  exit 1
}

export WALLET_PRIVATE_KEY
export ETH_NODE_ADDRESS

# Start proxy-router from its directory
cd "$MORPHEUS_DIR"
nohup ./proxy-router > "$LOG_FILE" 2>&1 &
ROUTER_PID=$!

echo "🚀 proxy-router started (PID: $ROUTER_PID)"
echo "📝 Logs: $LOG_FILE"

# Unset the private key from the environment immediately
unset WALLET_PRIVATE_KEY

# Wait for health check
echo "⏳ Waiting for health check..."
MAX_WAIT=30
WAITED=0
while [[ $WAITED -lt $MAX_WAIT ]]; do
  sleep 2
  WAITED=$((WAITED + 2))

  if [[ -f "$MORPHEUS_DIR/.cookie" ]]; then
    COOKIE_PASS=$(cat "$MORPHEUS_DIR/.cookie" | cut -d: -f2)
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -u "admin:$COOKIE_PASS" "http://localhost:8082/healthcheck" 2>/dev/null || echo "000")
    if [[ "$HTTP_CODE" == "200" ]]; then
      echo "✅ proxy-router is healthy (HTTP 200)"
      echo ""
      echo "📋 Status:"
      echo "   PID:      $ROUTER_PID"
      echo "   API:      http://localhost:8082"
      echo "   Swagger:  http://localhost:8082/swagger/index.html"
      echo "   Cookie:   $MORPHEUS_DIR/.cookie"
      echo "   Logs:     $LOG_FILE"
      exit 0
    fi
  fi
done

echo "⚠️  Health check did not respond within ${MAX_WAIT}s"
echo "   The router may still be starting. Check logs:"
echo "   tail -f $LOG_FILE"
