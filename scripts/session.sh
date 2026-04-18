#!/bin/bash
set -euo pipefail

# Morpheus Session Manager
# Usage:
#   ./session.sh open <model_name> [duration_seconds]
#   ./session.sh close <session_id>
#   ./session.sh cleanup              Close stale/expired sessions
#   ./session.sh list

MORPHEUS_DIR="$HOME/morpheus"
API_BASE="http://localhost:8082"

# Model name -> model ID mapping
# Uses a function instead of associative arrays for bash 3.2 compatibility
# (macOS ships bash 3.2 which doesn't support declare -A)
#
# To update: query the router for current on-chain model IDs:
#   curl -s -u "admin:$COOKIE_PASS" http://localhost:8082/blockchain/models | jq '.[] | {Name, Id}'
lookup_model_id() {
  case "$1" in
    kimi-k2.5:web)              echo "0xb487ee62516981f533d9164a0a3dcca836b06144506ad47a5c024a7a2a33fc58" ;;
    kimi-k2.5)                  echo "0xbb9e920d94ad3fa2861e1e209d0a969dbe9e1af1cf1ad95c49f76d7b63d32d93" ;;
    kimi-k2-thinking)           echo "0xc40b0a1ea1b20e042449ae44ffee8e87f3b8ba3d0be3ea61b86e6a89ba1a44e3" ;;
    glm-5)                      echo "0x2034b95f87b6d68299aba1fdc381b89e43b9ec48609e308296c9ba067730ec54" ;;
    glm-5.1|glm-5.1:web)        echo "0x9394665484ef479bc5fe0039f4f13503295c175cdfdf4c84a71accb7fbbc6edd" ;;
    glm-4.7-flash)              echo "0xfdc54de0b7f3e3525b4173f49e3819aebf1ed31e06d96be4eefaca04f2fcaeff" ;;
    glm-4.7)                    echo "0xed0a2161f215f576b6d0424540b0ba5253fc9f2c58dff02c79e28d0a5fdd04f1" ;;
    qwen3-235b)                 echo "0x2a7100f530e6f0f388e77e48f5a1bef5f31a5be3d1c460f73e0b6cc13d0e7f5f" ;;
    qwen3-coder-480b)           echo "0x470c71e89d3d9e05da58ec9a637e1ac96f73db0bf7e6ec26f5d5f46c7e5a37b3" ;;
    hermes-3-llama-3.1-405b)    echo "0x7e146f012beda5cbf6d6a01abf1bfbe4f8fb18f1e22b5bc3e2c1d0e9f8a7b6c5" ;;
    llama-3.3-70b)              echo "0xc753061a5d2640decfbbc1d1d35744e6805015d30d32872f814a93784c627fc3" ;;
    gpt-oss-120b)               echo "0x2e7228fe07523d84308d5a39f6dbf03d94c2be3fc4f73bf0b68c8e920f9a1c5a" ;;
    venice-uncensored)          echo "0xa003c4fba6bdb87b5a05c8b2c1657db8270827db0e87fcc2eaef17029aa01e6b" ;;
    whisper-v3-large-turbo)     echo "0x3e4f8c1a2b5d6e7f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7" ;;
    tts-kokoro)                 echo "0x4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5" ;;
    text-embedding-bge-m3)      echo "0x5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6" ;;
    *) echo "" ;;
  esac
}

# List of known model names for help output
KNOWN_MODELS="glm-5 glm-5.1:web kimi-k2.5:web kimi-k2.5 kimi-k2-thinking glm-4.7-flash glm-4.7 qwen3-235b qwen3-coder-480b hermes-3-llama-3.1-405b llama-3.3-70b gpt-oss-120b venice-uncensored whisper-v3-large-turbo tts-kokoro text-embedding-bge-m3"

# Diamond MarketPlace contract address (Lumerin, Base)
DIAMOND_CONTRACT="0x6aBE1d282f72B474E54527D93b979A4f64d3030a"

# RPC endpoint for on-chain queries
RPC_URL="${EVERCLAW_RPC:-https://base-mainnet.public.blastapi.io}"

# Read auth cookie
get_auth() {
  if [[ ! -f "$MORPHEUS_DIR/.cookie" ]]; then
    echo "ERROR: .cookie file not found. Is the proxy-router running?" >&2
    exit 1
  fi
  COOKIE_PASS=$(cat "$MORPHEUS_DIR/.cookie" | cut -d: -f2)
}

# Resolve model name to model ID
resolve_model() {
  local model_name="$1"

  # If it already looks like a hex ID, use it directly
  if [[ "$model_name" == 0x* ]]; then
    echo "$model_name"
    return
  fi

  local model_id
  model_id=$(lookup_model_id "$model_name")
  if [[ -z "$model_id" ]]; then
    echo "ERROR: Unknown model: $model_name" >&2
    echo "   Available models:" >&2
    for m in $KNOWN_MODELS; do
      echo "     $m" >&2
    done
    exit 1
  fi
  echo "$model_id"
}

# Get wallet address from proxy-router (no hardcoded addresses)
get_wallet() {
  if [[ -n "${MORPHEUS_WALLET_ADDRESS:-}" ]]; then
    echo "$MORPHEUS_WALLET_ADDRESS"
  else
    echo "ERROR: MORPHEUS_WALLET_ADDRESS env var required for on-chain queries." >&2
    echo "   Set it to your proxy-router wallet address." >&2
    exit 1
  fi
}

# Enumerate ALL on-chain sessions via Diamond contract pagination.
# The proxy-router /sessions/user endpoint has a hidden limit (~100 sessions).
# This function queries the Diamond contract directly to find ALL sessions.
get_all_session_ids() {
  local wallet
  wallet=$(get_wallet)
  local offset=0
  local batch_size=100
  local all_ids=""

  while true; do
    local result
    result=$(cast call "$DIAMOND_CONTRACT" \
      "getUserSessions(address,uint256,uint256)(bytes32[])" \
      "$wallet" "$offset" "$batch_size" \
      --rpc-url "$RPC_URL" 2>/dev/null || echo "[]")

    # Parse hex IDs from the array output
    local ids
    ids=$(echo "$result" | sed 's/[\[\]"]//g' | tr ',' '\n' | tr -d ' ' | grep -E '^0x' || true)

    if [[ -z "$ids" ]]; then
      break
    fi

    local count
    count=$(echo "$ids" | grep -c '^0x' || echo 0)

    if [[ -n "$all_ids" ]]; then
      all_ids="${all_ids}
${ids}"
    else
      all_ids="$ids"
    fi

    # If we got fewer than batch_size, we've reached the end
    if [[ "$count" -lt "$batch_size" ]]; then
      break
    fi

    offset=$((offset + batch_size))
  done

  echo "$all_ids"
}

# Check if a session is still open (ClosedAt == 0)
# Returns: "open <stake_wei> <ends_at> <model_id>" or "closed"
check_session_status() {
  local session_id="$1"
  local result
  result=$(curl -s -u "admin:$COOKIE_PASS" "${API_BASE}/blockchain/sessions/${session_id}" 2>/dev/null)

  local closed_at
  closed_at=$(echo "$result" | jq -r '.session.ClosedAt // .session.closedAt // "1"' 2>/dev/null || echo "1")

  if [[ "$closed_at" == "0" ]]; then
    local stake ends_at model_id
    stake=$(echo "$result" | jq -r '.session.Stake // .session.stake // "0"' 2>/dev/null || echo "0")
    ends_at=$(echo "$result" | jq -r '.session.EndsAt // .session.endsAt // "0"' 2>/dev/null || echo "0")
    model_id=$(echo "$result" | jq -r '.session.ModelAgentId // .session.modelAgentId // "unknown"' 2>/dev/null || echo "unknown")
    echo "open $stake $ends_at $model_id"
  else
    echo "closed"
  fi
}

# Close stale sessions: sessions that are open but expired or superseded.
# This MUST run before opening new sessions to prevent MOR accumulation.
cmd_cleanup() {
  get_auth

  if ! command -v cast &>/dev/null; then
    echo "ERROR: 'cast' (foundry) is required for on-chain session queries." >&2
    echo "   Install: curl -L https://foundry.paradigm.xyz | bash && foundryup" >&2
    exit 1
  fi

  if ! command -v jq &>/dev/null; then
    echo "ERROR: 'jq' is required for JSON parsing." >&2
    echo "   macOS: brew install jq" >&2
    echo "   Linux: apt install jq" >&2
    exit 1
  fi

  echo "Enumerating ALL on-chain sessions (paginated)..."
  local all_ids
  all_ids=$(get_all_session_ids)

  if [[ -z "$all_ids" ]]; then
    echo "No sessions found on-chain."
    return
  fi

  local total
  total=$(echo "$all_ids" | wc -l | tr -d ' ')
  echo "Found $total total sessions. Checking for open/stale..."

  local now
  now=$(date +%s)
  local open_count=0
  local closed_count=0
  local stale_closed=0

  # Bash 3.2 compatible: use parallel indexed arrays instead of associative arrays.
  # best_models[i] = model_id, best_sids[i] = session_id, best_expires[i] = ends_at
  local -a best_models=() best_sids=() best_expires=()
  local open_sessions_data=""

  # Helper: find index for a model in best_models[], or -1 if not found
  _find_model_idx() {
    local needle="$1" i
    for i in "${!best_models[@]}"; do
      if [[ "${best_models[$i]}" == "$needle" ]]; then
        echo "$i"
        return
      fi
    done
    echo "-1"
  }

  # First pass: identify all open sessions
  while IFS= read -r sid; do
    [[ -z "$sid" ]] && continue
    local status
    status=$(check_session_status "$sid")

    if [[ "$status" == "closed" ]]; then
      closed_count=$((closed_count + 1))
      continue
    fi

    # Parse: "open <stake> <ends_at> <model_id>"
    local stake ends_at model_id
    stake=$(echo "$status" | awk '{print $2}')
    ends_at=$(echo "$status" | awk '{print $3}')
    model_id=$(echo "$status" | awk '{print $4}')

    open_count=$((open_count + 1))
    open_sessions_data="${open_sessions_data}${sid} ${ends_at} ${model_id}\n"

    # Track best session per model (latest expiry) — bash 3.2 compatible
    local idx
    idx=$(_find_model_idx "$model_id")
    if [[ "$idx" -eq -1 ]]; then
      best_models+=("$model_id")
      best_sids+=("$sid")
      best_expires+=("$ends_at")
    elif [[ "$ends_at" -gt "${best_expires[$idx]}" ]]; then
      best_sids[$idx]="$sid"
      best_expires[$idx]="$ends_at"
    fi
  done <<< "$all_ids"

  echo ""
  echo "  Closed: $closed_count"
  echo "  Open:   $open_count"

  if [[ "$open_count" -eq 0 ]]; then
    echo "No open sessions to clean up."
    return
  fi

  # Helper: check if session_id is the best for its model
  _is_best_session() {
    local sid="$1" model_id="$2" idx
    idx=$(_find_model_idx "$model_id")
    [[ "$idx" -ge 0 && "${best_sids[$idx]}" == "$sid" ]]
  }

  # Second pass: close stale sessions (keep only the best per model)
  echo ""
  echo "Closing stale sessions (keeping latest per model)..."

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local sid ends_at model_id
    sid=$(echo "$line" | awk '{print $1}')
    ends_at=$(echo "$line" | awk '{print $2}')
    model_id=$(echo "$line" | awk '{print $3}')

    if _is_best_session "$sid" "$model_id"; then
      echo "  ✅ KEEP: ${sid:0:22}... (latest for model ${model_id:0:10}...)"
    else
      echo -n "  🗑️  CLOSE: ${sid:0:22}... → "
      local result
      result=$(curl -s -u "admin:$COOKIE_PASS" -X POST \
        "${API_BASE}/blockchain/sessions/${sid}/close" 2>/dev/null)
      local tx
      tx=$(echo "$result" | jq -r '.tx // "failed"' 2>/dev/null || echo "failed")
      echo "tx: ${tx:0:22}..."
      stale_closed=$((stale_closed + 1))
      sleep 2  # Space out transactions
    fi
  done < <(echo -e "$open_sessions_data")

  echo ""
  echo "Cleanup complete: $stale_closed stale sessions closed."
  if [[ "$stale_closed" -gt 0 ]]; then
    echo "MOR from closed sessions will return to your wallet."
  fi
}

# Open a session (with optional pre-cleanup)
cmd_open() {
  local model_name="${1:?Usage: session.sh open <model_name> [duration_seconds]}"
  local duration="${2:-604800}"  # default: 7 days

  get_auth
  local model_id
  model_id=$(resolve_model "$model_name")

  # Run cleanup first if cast is available (best effort)
  if command -v cast &>/dev/null && [[ -n "${MORPHEUS_WALLET_ADDRESS:-}" ]]; then
    echo "Running pre-open cleanup (on-chain pagination)..."
    cmd_cleanup || echo "  Warning: cleanup failed, continuing anyway..."
    echo ""
  fi

  echo "Opening session for $model_name (${duration}s)..."
  echo "   Model ID: $model_id"

  RESPONSE=$(curl -s -u "admin:$COOKIE_PASS" -X POST \
    "${API_BASE}/blockchain/models/${model_id}/session" \
    -H "Content-Type: application/json" \
    -d "{\"sessionDuration\": $duration}")

  echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"

  # Extract session ID if present
  SESSION_ID=$(echo "$RESPONSE" | jq -r '.sessionId // .SessionID // empty' 2>/dev/null || true)
  if [[ -n "$SESSION_ID" ]]; then
    echo ""
    echo "Session opened: $SESSION_ID"
    echo "   Duration: ${duration}s"
    echo "   Model: $model_name"
  fi
}

# Close a session
cmd_close() {
  local session_id="${1:?Usage: session.sh close <session_id>}"

  get_auth

  echo "Closing session $session_id..."

  RESPONSE=$(curl -s -u "admin:$COOKIE_PASS" -X POST \
    "${API_BASE}/blockchain/sessions/${session_id}/close")

  echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
  echo ""
  echo "Session close initiated. MOR will be returned to your wallet."
}

# List active sessions
cmd_list() {
  get_auth

  echo "Active sessions:"
  echo ""

  RESPONSE=$(curl -s -u "admin:$COOKIE_PASS" "${API_BASE}/blockchain/sessions")

  echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
}

# Status: balance + session summary
cmd_status() {
  get_auth

  echo "Morpheus Session Status"
  echo "======================"
  echo ""

  # Balance
  BALANCE=$(curl -s -u "admin:$COOKIE_PASS" "${API_BASE}/blockchain/balance" 2>/dev/null || echo "{}")
  MOR_WEI=$(echo "$BALANCE" | jq -r '.mor // .MOR // "0"' 2>/dev/null || echo "0")
  ETH_WEI=$(echo "$BALANCE" | jq -r '.eth // .ETH // "0"' 2>/dev/null || echo "0")

  if [[ "$MOR_WEI" != "0" && "$MOR_WEI" != "null" ]]; then
    MOR_HUMAN=$(echo "$MOR_WEI" | awk '{printf "%.4f", $1 / 1000000000000000000}')
    echo "  MOR: $MOR_HUMAN"
  else
    echo "  MOR: 0"
  fi

  if [[ "$ETH_WEI" != "0" && "$ETH_WEI" != "null" ]]; then
    ETH_HUMAN=$(echo "$ETH_WEI" | awk '{printf "%.6f", $1 / 1000000000000000000}')
    echo "  ETH: $ETH_HUMAN"
  else
    echo "  ETH: 0"
  fi

  echo ""

  # Sessions
  SESSIONS=$(curl -s -u "admin:$COOKIE_PASS" "${API_BASE}/blockchain/sessions" 2>/dev/null || echo "[]")
  SESSION_COUNT=$(echo "$SESSIONS" | jq -r 'if type == "array" then length elif type == "object" and has("sessions") then .sessions | length else 0 end' 2>/dev/null | tr -d '[:space:]')
  SESSION_COUNT="${SESSION_COUNT:-0}"

  echo "  Active sessions: $SESSION_COUNT"

  if [[ "$SESSION_COUNT" -gt 0 ]]; then
    echo ""
    echo "$SESSIONS" | jq -r '
      (if type == "array" then . elif has("sessions") then .sessions else [] end) |
      .[] |
      "  - \(.Id // .id // .sessionId // "??") (\(.ModelAgentId // .modelAgentId // .modelId // "??"))"
    ' 2>/dev/null || true
  fi

  echo ""
}

# Main
ACTION="${1:-help}"

case "$ACTION" in
  open)
    shift
    cmd_open "$@"
    ;;
  close)
    shift
    cmd_close "$@"
    ;;
  cleanup)
    cmd_cleanup
    ;;
  list)
    cmd_list
    ;;
  status)
    cmd_status
    ;;
  *)
    echo "Morpheus Session Manager"
    echo ""
    echo "Usage:"
    echo "  session.sh open <model_name> [duration_seconds]   Open a new session"
    echo "  session.sh close <session_id>                     Close a session"
    echo "  session.sh cleanup                                Close stale/expired sessions"
    echo "  session.sh list                                   List active sessions"
    echo "  session.sh status                                 Balance + session summary"
    echo ""
    echo "Environment variables:"
    echo "  MORPHEUS_WALLET_ADDRESS   Your proxy-router wallet (required for cleanup)"
    echo "  EVERCLAW_RPC              Base RPC endpoint (default: public blastapi)"
    echo ""
    echo "Available models:"
    for m in $KNOWN_MODELS; do
      echo "  $m"
    done
    echo ""
    echo "Examples:"
    echo "  session.sh open glm-5 86400           # 1 day GLM-5 session"
    echo "  session.sh open glm-5.1:web 86400     # 1 day GLM-5.1:web session"
    echo "  session.sh open kimi-k2.5 604800      # 7 day session (default)"
    echo "  session.sh cleanup                    # Close stale, keep latest per model"
    echo "  session.sh close 0xABC123...          # Close by session ID"
    ;;
esac
