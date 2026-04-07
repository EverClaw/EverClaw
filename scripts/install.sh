#!/bin/bash
set -euo pipefail

# Everclaw -- Install Script
# Downloads the latest proxy-router release and sets up ~/morpheus/

INSTALL_DIR="$HOME/morpheus"
REPO="MorpheusAIs/Morpheus-Lumerin-Node"

echo "Everclaw -- Installer"
echo "======================================"

# Check required tools
for cmd in curl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is required but not found. Install it first."
    exit 1
  fi
done

# Check for unzip (needed for legacy zip assets)
if ! command -v unzip &>/dev/null; then
  echo "WARNING: unzip not found. Will fail if release uses zip format."
fi

# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
  darwin) PLATFORM="darwin" ;;
  linux)  PLATFORM="linux" ;;
  *)      echo "ERROR:Unsupported OS: $OS"; exit 1 ;;
esac

case "$ARCH" in
  x86_64)  GOARCH="amd64" ;;
  aarch64) GOARCH="arm64" ;;
  arm64)   GOARCH="arm64" ;;
  *)       echo "ERROR:Unsupported architecture: $ARCH"; exit 1 ;;
esac

echo "Platform: ${PLATFORM}-${GOARCH}"

# ── Install system dependencies (backup/restore, agent-download) ─────────
install_system_deps() {
  local missing=()
  command -v age &>/dev/null    || missing+=("age")
  command -v zstd &>/dev/null   || missing+=("zstd")
  command -v jq &>/dev/null     || missing+=("jq")

  if [[ ${#missing[@]} -eq 0 ]]; then
    echo "✅ System dependencies present (age, zstd, jq)"
    return 0
  fi

  echo "📦 Installing missing system dependencies: ${missing[*]}..."

  if [[ "$PLATFORM" == "darwin" ]]; then
    # macOS — use Homebrew
    if ! command -v brew &>/dev/null; then
      echo "  Homebrew not found. Installing..."
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || {
        echo "⚠️  Homebrew install failed. Install manually: ${missing[*]}"
        return 0
      }
      eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || \
        eval "$(/usr/local/bin/brew shellenv)" 2>/dev/null || true
    fi
    for pkg in "${missing[@]}"; do
      brew install "$pkg" 2>/dev/null || echo "⚠️  Failed to install $pkg via brew"
    done
  else
    # Linux — detect package manager
    if command -v apt-get &>/dev/null; then
      sudo apt-get update -qq 2>/dev/null
      for pkg in "${missing[@]}"; do
        sudo apt-get install -y "$pkg" 2>/dev/null || echo "⚠️  Failed to install $pkg via apt"
      done
    elif command -v dnf &>/dev/null; then
      for pkg in "${missing[@]}"; do
        sudo dnf install -y "$pkg" 2>/dev/null || echo "⚠️  Failed to install $pkg via dnf"
      done
    elif command -v pacman &>/dev/null; then
      for pkg in "${missing[@]}"; do
        sudo pacman -S --noconfirm "$pkg" 2>/dev/null || echo "⚠️  Failed to install $pkg via pacman"
      done
    elif command -v apk &>/dev/null; then
      for pkg in "${missing[@]}"; do
        sudo apk add "$pkg" 2>/dev/null || echo "⚠️  Failed to install $pkg via apk"
      done
    else
      echo "⚠️  No supported package manager found. Install manually: ${missing[*]}"
    fi
  fi

  # Verify
  local still_missing=()
  command -v age &>/dev/null    || still_missing+=("age")
  command -v zstd &>/dev/null   || still_missing+=("zstd")
  command -v jq &>/dev/null     || still_missing+=("jq")
  if [[ ${#still_missing[@]} -gt 0 ]]; then
    echo "⚠️  Could not install: ${still_missing[*]}"
    echo "   Backup/restore features will be unavailable until installed."
  else
    echo "✅ System dependencies installed (age, zstd, jq)"
  fi
}

install_system_deps

# Issue #13 5B: Version pinning for reproducible builds
# Use VERSION env var to pin a specific release tag, e.g.:
#   VERSION=v2026.4.1 ./install.sh
# Default: fetch latest from GitHub API
if [[ -n "${VERSION:-}" ]]; then
  echo "Using pinned version: ${VERSION}"
  LATEST_TAG="${VERSION}"
else

# Get latest release tag (Issue #12, 4A: detect rate limiting)
echo "Finding latest release..."
# Use GITHUB_TOKEN for authenticated requests if available
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  GH_RESPONSE=$(curl -sL -w "\n%{http_code}" --fail -H "Authorization: Bearer ${GITHUB_TOKEN}" "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null || true)
else
  GH_RESPONSE=$(curl -sL -w "\n%{http_code}" --fail "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null || true)
fi
GH_HTTP_CODE=$(echo "$GH_RESPONSE" | tail -1)
GH_BODY=$(echo "$GH_RESPONSE" | sed '$d')

# Detect network failure (empty response = curl couldn't connect at all)
if [[ -z "$GH_HTTP_CODE" ]] || [[ "$GH_HTTP_CODE" == "000" ]]; then
  echo "ERROR: Cannot reach GitHub API (network failure)."
  echo "   Possible causes:"
  echo "   - No internet connectivity"
  echo "   - DNS resolution failure"
  echo "   - Firewall blocking api.github.com"
  echo "   - SSL/TLS handshake failure"
  echo ""
  echo "   Test connectivity: curl -sL https://api.github.com/rate_limit"
  exit 1
fi

if [[ "$GH_HTTP_CODE" == "403" ]] || [[ "$GH_HTTP_CODE" == "429" ]]; then
  echo "ERROR: GitHub API rate limit exceeded (HTTP $GH_HTTP_CODE)."
  echo "   Unauthenticated requests are limited to 60/hour."
  echo ""
  echo "   Options:"
  echo "   1. Wait up to an hour for the rate limit to reset"
  echo "   2. Set GITHUB_TOKEN to use authenticated requests (5,000/hour):"
  echo "        export GITHUB_TOKEN=ghp_your_token_here"
  echo "        bash install.sh"
  echo ""
  echo "   Check your rate limit: curl -sL https://api.github.com/rate_limit | grep -A2 rate"
  exit 1
fi

LATEST_TAG=$(echo "$GH_BODY" | grep '"tag_name"' | head -1 | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')

if [[ -z "$LATEST_TAG" ]]; then
  echo "ERROR: Could not determine latest release (HTTP $GH_HTTP_CODE)."
  echo "   Possible causes:"
  echo "   - No network connectivity"
  echo "   - GitHub API rate limit (60/hr unauthenticated)"
  echo "   - Repository not found: ${REPO}"
  echo ""
  echo "   Try: curl -sL https://api.github.com/rate_limit | grep -A2 rate"
  exit 1
fi

echo "Latest release: ${LATEST_TAG}"

fi  # end VERSION pinning block

# Use GITHUB_TOKEN if available for authenticated requests (5,000/hr vs 60/hr)
GH_AUTH_HEADER=""
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  GH_AUTH_HEADER="Authorization: Bearer ${GITHUB_TOKEN}"
  echo "   Using authenticated GitHub API (higher rate limit)"
fi

# Fetch release asset list from GitHub API
echo "Querying release assets..."
if [[ -n "$GH_AUTH_HEADER" ]]; then
  ASSETS_RESPONSE=$(curl -sL -w "\n%{http_code}" -H "$GH_AUTH_HEADER" "https://api.github.com/repos/${REPO}/releases/tags/${LATEST_TAG}" 2>/dev/null || true)
else
  ASSETS_RESPONSE=$(curl -sL -w "\n%{http_code}" "https://api.github.com/repos/${REPO}/releases/tags/${LATEST_TAG}" 2>/dev/null || true)
fi
ASSETS_HTTP_CODE=$(echo "$ASSETS_RESPONSE" | tail -1)
ASSETS_JSON=$(echo "$ASSETS_RESPONSE" | sed '$d')

if [[ "$ASSETS_HTTP_CODE" == "403" ]] || [[ "$ASSETS_HTTP_CODE" == "429" ]]; then
  echo "ERROR: GitHub API rate limit hit while fetching assets (HTTP $ASSETS_HTTP_CODE)."
  echo "   The first API call succeeded but the second was rate-limited."
  echo "   Set GITHUB_TOKEN for authenticated requests (5,000/hour):"
  echo "     export GITHUB_TOKEN=ghp_your_token_here && bash install.sh"
  exit 1
fi

# Map platform names used in release assets
# Older releases: mor-launch-darwin-arm64.zip
# v5.11.0+: mac-arm64-morpheus-router-<version> (standalone binary)
if [[ "$PLATFORM" == "darwin" ]]; then
  PLATFORM_PATTERN="mac"
else
  PLATFORM_PATTERN="$PLATFORM"
fi

TMPDIR_DL=$(mktemp -d)

# Create install directory
mkdir -p "$INSTALL_DIR"

# --- Strategy 1: Try new naming convention (standalone binaries) ---
# Pattern: <platform>-<arch>-morpheus-router-<version>
ROUTER_ASSET=$(echo "$ASSETS_JSON" | grep -o '"name": *"[^"]*"' | sed 's/"name": *"//;s/"//' | grep -i "${PLATFORM_PATTERN}-${GOARCH}-morpheus-router" | head -1)
CLI_ASSET=$(echo "$ASSETS_JSON" | grep -o '"name": *"[^"]*"' | sed 's/"name": *"//;s/"//' | grep -i "${PLATFORM_PATTERN}-${GOARCH}-morpheus-cli" | head -1)

if [[ -n "$ROUTER_ASSET" ]]; then
  echo "Found standalone binary: ${ROUTER_ASSET}"

  # Issue #12 (4C): Back up existing binaries before overwriting
  if [[ -f "$INSTALL_DIR/proxy-router" ]]; then
    BACKUP_NAME="$INSTALL_DIR/proxy-router.bak.$(date +%Y%m%d%H%M%S)"
    echo "   ⚠️  Backing up existing proxy-router → $(basename "$BACKUP_NAME")"
    cp "$INSTALL_DIR/proxy-router" "$BACKUP_NAME"
  fi

  ROUTER_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}/${ROUTER_ASSET}"
  echo "Downloading ${ROUTER_ASSET}..."
  if ! curl -sL -o "$INSTALL_DIR/proxy-router" "$ROUTER_URL"; then
    echo "ERROR:Download failed. URL: $ROUTER_URL"
    rm -rf "$TMPDIR_DL"
    exit 1
  fi
  chmod +x "$INSTALL_DIR/proxy-router"

  if [[ -n "$CLI_ASSET" ]]; then
    if [[ -f "$INSTALL_DIR/mor-cli" ]]; then
      BACKUP_NAME="$INSTALL_DIR/mor-cli.bak.$(date +%Y%m%d%H%M%S)"
      echo "   ⚠️  Backing up existing mor-cli → $(basename "$BACKUP_NAME")"
      cp "$INSTALL_DIR/mor-cli" "$BACKUP_NAME"
    fi
    CLI_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}/${CLI_ASSET}"
    echo "Downloading ${CLI_ASSET}..."
    if ! curl -sL -o "$INSTALL_DIR/mor-cli" "$CLI_URL"; then
      echo "ERROR: CLI download failed. URL: $CLI_URL"
    else
      chmod +x "$INSTALL_DIR/mor-cli"
    fi
  fi

else
  # --- Strategy 2: Try legacy naming convention (zip archive) ---
  # Pattern: mor-launch-<platform>-<arch>.zip
  ZIP_ASSET=$(echo "$ASSETS_JSON" | grep -o '"name": *"[^"]*"' | sed 's/"name": *"//;s/"//' | grep -i "mor-launch-${PLATFORM}-${GOARCH}" | head -1)

  if [[ -z "$ZIP_ASSET" ]]; then
    echo "ERROR:No matching release asset found for ${PLATFORM}-${GOARCH}."
    echo "   Available assets:"
    echo "$ASSETS_JSON" | grep -o '"name": *"[^"]*"' | sed 's/"name": *"/  /;s/"//'
    echo ""
    echo "   Check releases at: https://github.com/${REPO}/releases"
    rm -rf "$TMPDIR_DL"
    exit 1
  fi

  echo "Found zip archive: ${ZIP_ASSET}"
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}/${ZIP_ASSET}"
  ZIPFILE="${TMPDIR_DL}/${ZIP_ASSET}"

  echo "Downloading ${ZIP_ASSET}..."
  if ! curl -sL -o "$ZIPFILE" "$DOWNLOAD_URL"; then
    echo "ERROR:Download failed. URL: $DOWNLOAD_URL"
    rm -rf "$TMPDIR_DL"
    exit 1
  fi

  # Check the file is actually a zip
  if ! file "$ZIPFILE" | grep -q -i "zip"; then
    echo "ERROR:Downloaded file is not a valid zip archive."
    echo "   URL might be wrong. Check releases at: https://github.com/${REPO}/releases"
    rm -rf "$TMPDIR_DL"
    exit 1
  fi

  # Issue #12 (4C): Back up existing binaries before overwriting
  for existing_bin in "$INSTALL_DIR/proxy-router" "$INSTALL_DIR/mor-cli"; do
    if [[ -f "$existing_bin" ]]; then
      BACKUP_NAME="${existing_bin}.bak.$(date +%Y%m%d%H%M%S)"
      echo "   ⚠️  Backing up existing $(basename "$existing_bin") → $(basename "$BACKUP_NAME")"
      cp "$existing_bin" "$BACKUP_NAME"
    fi
  done

  echo "Extracting to ${INSTALL_DIR}..."
  # Note: unzip -o still overwrites non-binary files (.env, models-config.json, etc.)
  # but those are only created below if they DON'T already exist (idempotent).
  unzip -o -q "$ZIPFILE" -d "$INSTALL_DIR"
fi

# Clean up temp
rm -rf "$TMPDIR_DL"

# Remove macOS quarantine flags
if [[ "$PLATFORM" == "darwin" ]]; then
  echo "Removing macOS quarantine flags..."
  xattr -cr "$INSTALL_DIR" 2>/dev/null || true
fi

# Make binaries executable
chmod +x "$INSTALL_DIR/proxy-router" 2>/dev/null || true
chmod +x "$INSTALL_DIR/mor-cli" 2>/dev/null || true

# Create data/logs directory
mkdir -p "$INSTALL_DIR/data/logs"

# Create .env if it doesn't exist
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  echo "Creating .env..."
  cat > "$INSTALL_DIR/.env" << 'ENVEOF'
# Morpheus Proxy-Router Configuration (Consumer Mode)
# Base Mainnet

# RPC endpoint -- MUST be set or router silently fails
ETH_NODE_ADDRESS=https://base-mainnet.public.blastapi.io

# Chain
ETH_NODE_CHAIN_ID=8453
ETH_NODE_LEGACY_TX=false
ETH_NODE_USE_SUBSCRIPTIONS=false
ETH_NODE_POLLING_INTERVAL=10
ETH_NODE_MAX_RECONNECTS=30

# Contracts (Base mainnet)
DIAMOND_CONTRACT_ADDRESS=0x6aBE1d282f72B474E54527D93b979A4f64d3030a
MOR_TOKEN_ADDRESS=0x7431aDa8a591C955a994a21710752EF9b882b8e3

# WALLET_PRIVATE_KEY intentionally left blank -- inject at runtime via 1Password
WALLET_PRIVATE_KEY=

# Proxy settings
PROXY_ADDRESS=0.0.0.0:3333
PROXY_STORAGE_PATH=./data/badger/
PROXY_STORE_CHAT_CONTEXT=true
PROXY_FORWARD_CHAT_CONTEXT=true
MODELS_CONFIG_PATH=./models-config.json

# Web API
WEB_ADDRESS=0.0.0.0:8082
WEB_PUBLIC_URL=http://localhost:8082

# Auth
AUTH_CONFIG_FILE_PATH=./proxy.conf
COOKIE_FILE_PATH=./.cookie

# Logging
LOG_COLOR=true
LOG_LEVEL_APP=info
LOG_LEVEL_TCP=warn
LOG_LEVEL_ETH_RPC=warn
LOG_LEVEL_STORAGE=warn
LOG_FOLDER_PATH=./data/logs

# Environment
ENVIRONMENT=production

# === v5.12.0 Configurable Timeouts ===
# Consumer Node → Provider Node timeout (seconds)
# Total wait: 3 retries × 90s = 270s for streaming to start or full response
CONSUMER_TO_PROVIDER_TIMEOUT=90
CONSUMER_TO_PROVIDER_RETRIES=3

# Provider Node → downstream LLM timeout (seconds)
# 360s = 6 min for long-thinking models on complex reasoning tasks
PROVIDER_TO_LLM_TIMEOUT=360
ENVEOF
fi

# Create models-config.json if it doesn't exist
if [[ ! -f "$INSTALL_DIR/models-config.json" ]]; then
  echo "Creating models-config.json..."
  cat > "$INSTALL_DIR/models-config.json" << 'MODEOF'
{
  "$schema": "./internal/config/models-config-schema.json",
  "models": [
    { "modelId": "0xb487ee62516981f533d9164a0a3dcca836b06144506ad47a5c024a7a2a33fc58", "modelName": "kimi-k2.5:web", "apiType": "openai", "apiUrl": "" },
    { "modelId": "0xbb9e920d94ad3fa2861e1e209d0a969dbe9e1af1cf1ad95c49f76d7b63d32d93", "modelName": "kimi-k2.5", "apiType": "openai", "apiUrl": "" },
    { "modelId": "0xc40b6871d0c0c24ddc3abde6565e8e60ab26a093d77f6b91c0b10f05fa823d7a", "modelName": "kimi-k2-thinking", "apiType": "openai", "apiUrl": "" },
    { "modelId": "0xfdc54de0b7f3e3525b4173f49e3819aebf1ed31e06d96be4eefaca04f2fcaeff", "modelName": "glm-4.7-flash", "apiType": "openai", "apiUrl": "" },
    { "modelId": "0xed0a2161f215f576b6d0424540b0ba5253fc9f2c58dff02c79e28d0a5fdd04f1", "modelName": "glm-4.7", "apiType": "openai", "apiUrl": "" },
    { "modelId": "0x2a7100f530e6f0f388e77e48f5a1bef5f31a5be3d1c460f73e0b6cc13d0e7f5f", "modelName": "qwen3-235b", "apiType": "openai", "apiUrl": "" },
    { "modelId": "0x470c71e89d3d9e05da58ec9a637e1ac96f73db0bf7e6ec26f5d5f46c7e5a37b3", "modelName": "qwen3-coder-480b-a35b-instruct", "apiType": "openai", "apiUrl": "" },
    { "modelId": "0x7e146f012beda5cbf6d6a01abf1bfbe4f8fb18f1e22b5bc3e2c1d0e9f8a7b6c5", "modelName": "hermes-3-llama-3.1-405b", "apiType": "openai", "apiUrl": "" },
    { "modelId": "0xc753061a5d2640decffa6f20a84f52a59ef4a6096d5ccf4eb5e1cbbaed39fe14", "modelName": "llama-3.3-70b", "apiType": "openai", "apiUrl": "" },
    { "modelId": "0x2e7228fe07523d84308d5a39f6dbf03d94c2be3fc4f73bf0b68c8e920f9a1c5a", "modelName": "gpt-oss-120b", "apiType": "openai", "apiUrl": "" }
  ]
}
MODEOF
fi

# Install Node.js dependencies (viem for wallet/contract interaction)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVERCLAW_ROOT="$(dirname "$SCRIPT_DIR")"

if command -v npm &>/dev/null; then
  echo "📦 Installing Node.js dependencies..."
  (cd "$EVERCLAW_ROOT" && npm install --production 2>/dev/null) || {
    echo "⚠️  npm install failed. Run manually: cd $EVERCLAW_ROOT && npm install"
  }

  # Install deps for skills with their own package.json
  for skill_dir in "$EVERCLAW_ROOT"/skills/*/; do
    if [ -f "$skill_dir/package.json" ]; then
      skill_name="$(basename "$skill_dir")"
      echo "📦 Installing $skill_name dependencies..."
      (cd "$skill_dir" && npm install --production 2>/dev/null) || {
        echo "⚠️  $skill_name npm install failed. Run manually: cd $skill_dir && npm install"
      }
    fi
  done
else
  echo "⚠️  npm not found. Install Node.js, then run: cd $EVERCLAW_ROOT && npm install"
fi

# --- Ensure node-llama-cpp for OpenClaw local embeddings ---
if command -v npm &>/dev/null && command -v node &>/dev/null; then
  echo "🧠 Checking local embeddings (node-llama-cpp)..."
  NPM_GLOBAL_ROOT="$(npm root -g 2>/dev/null)"
  if NODE_PATH="$NPM_GLOBAL_ROOT" node -e "try { require.resolve('node-llama-cpp'); process.exit(0) } catch { process.exit(1) }" 2>/dev/null; then
    echo "  ✅ node-llama-cpp already installed"
  else
    echo "  📦 Installing local embedding engine (node-llama-cpp@3.18.1)..."
    echo "     One-time install, ~30-90s. May need build tools on some systems."
    if npm install -g node-llama-cpp@3.18.1; then
      # Post-install verification
      if NODE_PATH="$NPM_GLOBAL_ROOT" node -e "try { require.resolve('node-llama-cpp'); process.exit(0) } catch { process.exit(1) }" 2>/dev/null; then
        echo "  ✅ node-llama-cpp installed — local memory search enabled"
      else
        echo "  ⚠️  node-llama-cpp installed but import failed"
        echo "     You may need build tools: Xcode CLT (macOS) or build-essential (Linux)"
      fi
    else
      echo "  ⚠️  node-llama-cpp install failed (not critical)"
      echo "     Install manually: npm install -g node-llama-cpp@3.18.1"
      echo "     If build fails, you may need: Xcode CLT (macOS) or build-essential + cmake (Linux)"
    fi
  fi
fi

# --- Bootstrap EverClaw Key (GLM-5 Starter Access) ---
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  EverClaw Bootstrap — GLM-5 Starter Key"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if command -v node &>/dev/null; then
  echo "  Getting your starter key for GLM-5 inference..."
  if node "$SCRIPT_DIR/bootstrap-everclaw.mjs" --setup 2>/dev/null; then
    : # Success message already printed by the script
  else
    echo "  ⚠️  Could not reach EverClaw key server."
    echo "  Run manually later: node scripts/bootstrap-everclaw.mjs"
  fi
else
  echo "  ⚠️  Node.js not found. Install Node.js, then run:"
  echo "     node scripts/bootstrap-everclaw.mjs"
fi

# --- Optional: Agent-Chat XMTP Daemon ---
AGENT_CHAT_SKILL="$SCRIPT_DIR/../skills/agent-chat"
if [[ -d "$AGENT_CHAT_SKILL" ]] && [[ -f "$AGENT_CHAT_SKILL/daemon.mjs" ]] && [[ -f "$SCRIPT_DIR/setup-agent-chat.sh" ]]; then
  echo ""
  echo "💬 Setting up agent-chat XMTP daemon..."
  bash "$SCRIPT_DIR/setup-agent-chat.sh" --skip-deps 2>&1 | tail -10 || {
    echo "   ⚠️  Agent-chat daemon setup had issues — not critical"
    echo "      Run manually: bash scripts/setup-agent-chat.sh"
  }
fi

echo ""
echo "Everclaw (Morpheus Lumerin Node) installed to ${INSTALL_DIR}"
echo ""
echo "Next steps:"
echo "  1. Edit ~/morpheus/.env if you need a custom RPC endpoint"
echo "  2. Update models-config.json with correct model IDs from the blockchain"
echo "  3. Run: bash skills/everclaw/scripts/start.sh"
echo ""
echo "Before first use:"
echo "  - Ensure you have MOR tokens on Base mainnet"
echo "  - Ensure you have ETH on Base for gas"
echo "  - Set up 1Password with your wallet private key"
