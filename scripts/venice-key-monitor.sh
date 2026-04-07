#!/bin/bash

# Venice Key Health Monitor
# Checks DIEM balances across all API keys and disables depleted keys

set -e

WORKSPACE="/Users/bernardo/.openclaw/workspace"
SCRIPT_DIR="$WORKSPACE/skills/everclaw/scripts"
KEYS_FILE="$SCRIPT_DIR/venice-keys.json"
LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"

KEYS_JSON=$(cat "$KEYS_FILE" 2>/dev/null || jq -n '[]')
KEYS=($(echo "$KEYS_JSON" | jq -r 'to_entries[].value.api_key'))

DISABLED_KEYS=()
HEALTHY_KEYS=()

echo "🔍 Venice Key Health Monitor"
echo "============================"
echo ""

for i in "${!KEYS[@]}"; do
  API_KEY="${KEYS[$i]}"
  KEY_ID=$(echo "$KEYS_JSON" | jq -r ".[$i] | .id // \"key_$i\"")
  TARGET=$(echo "$KEYS_JSON" | jq -r ".[$i] | .target // \"default\"")

  echo "Checking Key: $KEY_ID (Target: $TARGET)"

  # Query Venice API for DIEM balance
  BALANCE_RESPONSE=$(curl -s -H "Authorization: Bearer $API_KEY" \
    "https://api.vene.co/api/climate/deiem" \
    --connect-timeout 5 \
    --max-time 10 \
    --retry 2 \
    --retry-delay 5)

  if echo "$BALANCE_RESPONSE" | jq -e '.data?.balances? | length > 0' > /dev/null 2>&1; then
    # Extract DIEM balance (first balance with "diem" type)
    DIEM_BALANCE=$(echo "$BALANCE_RESPONSE" | jq -r '.data.balances[] | select(.currency?.toLowerCase() == "diem") | .balance // 0' | head -n 1)

    # Check if balance is valid
    if [ "$DIEM_BALANCE" != "null" ] && [ "$DIEM_BALANCE" != "0" ]; then
      echo "  ✅ Healthy - Balance: $DIEM_BALANCE"
      HEALTHY_KEYS+=("$KEY_ID:$TARGET:$DIEM_BALANCE")
    else
      echo "  ⚠️  Depleted - Balance: $DIEM_BALANCE"
      DISABLED_KEYS+=("$KEY_ID:$TARGET")
    fi
  else
    echo "  ❌ Error - Could not fetch balance"
    DISABLED_KEYS+=("$KEY_ID:$TARGET (API error)")
  fi
  echo ""
done

echo "============================"
echo "Summary"
echo "============================"
echo "Healthy Keys: ${#HEALTHY_KEYS[@]}"
echo "Disabled Keys: ${#DISABLED_KEYS[@]}"
echo ""

# Write log
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
{
  echo "{\"timestamp\": \"$TIMESTAMP\"},"
  echo "\"diemBalances\": {"
  for key in "${HEALTHY_KEYS[@]}"; do
    IFS=':' read -r KEY_ID TARGET BALANCE <<< "$key"
    echo "  \"$KEY_ID\": {\"target\": \"$TARGET\", \"balance\": $BALANCE},"
  done
  echo "  \"disabledKeys\": ["
  for key in "${DISABLED_KEYS[@]}"; do
    echo "    \"$key\","
  done
  echo "  ]"
  echo "}"
} > "$LOG_DIR/key-health-$(date +%Y-%m-%d).log"

# Report via stdout
echo "JSON Output:"

# Build healthy keys array
HEALTHY_JSON="["
first_healthy=true
for key in "${HEALTHY_KEYS[@]}"; do
  IFS=':' read -r KEY_ID TARGET BALANCE <<< "$key"
  if [ "$first_healthy" = true ]; then
    HEALTHY_JSON="${HEALTHY_JSON}{\"id\": \"$KEY_ID\", \"target\": \"$TARGET\", \"balance\": $BALANCE}"
    first_healthy=false
  else
    HEALTHY_JSON="${HEALTHY_JSON},{\"id\": \"$KEY_ID\", \"target\": \"$TARGET\", \"balance\": $BALANCE}"
  fi
done
if [ ${#HEALTHY_KEYS[@]} -gt 0 ]; then
  HEALTHY_JSON="${HEALTHY_JSON}]"
else
  HEALTHY_JSON={}
fi

# Build disabled keys array
DISABLED_JSON="["
first_disabled=true
for key in "${DISABLED_KEYS[@]}"; do
  if [ "$first_disabled" = true ]; then
    DISABLED_JSON="${DISABLED_JSON}\"$key\""
    first_disabled=false
  else
    DISABLED_JSON="${DISABLED_JSON},\"$key\""
  fi
done
DISABLED_JSON="${DISABLED_JSON}]"

# Final output
echo "{"
echo "  \"healthy\": $HEALTHY_JSON,"
echo "  \"disabled_keys\": $DISABLED_JSON"
echo "}"

# Write keys.json backup if any keys were disabled
if [ ${#DISABLED_KEYS[@]} -gt 0 ]; then
  echo ""
  echo "Backing up depleted keys..."
  backup_file="$LOG_DIR/keys-backup-$(date +%Y-%m-%d-%H%M%S).json"
  cp "$KEYS_FILE" "$backup_file"
  echo "Backup: $backup_file"

  # Remove depleted keys from keys.json
  temp_json=$(mktemp)
  disable_keys_array=$(printf '%s,' "${DISABLED_KEYS[@]}")
  jq --argjson disable_keys "[$disable_keys_array]" \
    'del(.[] | .api_key | select(. == ($disable_keys[]?)))' \
    "$KEYS_FILE" > "$temp_json" && mv "$temp_json" "$KEYS_FILE"

  echo "Updated $KEYS_FILE with depleted keys removed"
fi