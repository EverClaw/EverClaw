#!/bin/bash
#
# EverClaw Dependency Check — External URLs & CLI Commands
#
# Verifies all external URLs and CLI commands that EverClaw depends on.
# Run weekly via cron or manually to catch broken dependencies early.
#
# Usage:
#   bash scripts/check-deps.sh              # Full check
#   bash scripts/check-deps.sh --urls-only  # Only check URLs
#   bash scripts/check-deps.sh --cli-only   # Only check CLI commands
#   bash scripts/check-deps.sh --json       # JSON output for automation
#
# Exit codes:
#   0 = all checks passed
#   1 = one or more checks failed
#
# Last updated: 2026-03-13 (SOP-001 External Dependency Verification)
#

set -e

# ─── Colors ──────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ─── Options ─────────────────────────────────────────────────────

URLS_ONLY=false
CLI_ONLY=false
JSON_OUTPUT=false
TIMEOUT=10

for arg in "$@"; do
  case $arg in
    --urls-only)  URLS_ONLY=true ;;
    --cli-only)   CLI_ONLY=true ;;
    --json)       JSON_OUTPUT=true ;;
    --help)
      echo "EverClaw Dependency Check"
      echo ""
      echo "Usage: bash scripts/check-deps.sh [options]"
      echo ""
      echo "Options:"
      echo "  --urls-only   Only check external URLs"
      echo "  --cli-only    Only check CLI commands"
      echo "  --json        Output results as JSON"
      echo "  --help        Show this help"
      exit 0
      ;;
  esac
done

# ─── Counters ────────────────────────────────────────────────────

TOTAL=0
PASSED=0
FAILED=0
WARNINGS=0
FAILURES=""

# ─── URL Check Function ─────────────────────────────────────────

check_url() {
  local url="$1"
  local method="${2:-GET}"
  local description="$3"
  local expected="${4:-200}"

  TOTAL=$((TOTAL + 1))

  if [[ "$method" == "POST" ]]; then
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
      -X POST -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
      "$url" 2>/dev/null || echo "000")
  else
    code=$(curl -fsSL -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "$url" 2>/dev/null || echo "000")
  fi

  if [[ "$code" == "$expected" ]] || [[ "$code" == "200" ]] || [[ "$code" == "301" ]] || [[ "$code" == "302" ]]; then
    PASSED=$((PASSED + 1))
    if [[ "$JSON_OUTPUT" != true ]]; then
      echo -e "  ${GREEN}✓${NC} ${code} ${description:-$url}"
    fi
  else
    FAILED=$((FAILED + 1))
    FAILURES="${FAILURES}\n  ❌ ${code} ${url} — ${description}"
    if [[ "$JSON_OUTPUT" != true ]]; then
      echo -e "  ${RED}✗${NC} ${code} ${description:-$url}"
      echo -e "       URL: ${url}"
    fi
  fi
}

# ─── CLI Check Function ─────────────────────────────────────────

check_cli() {
  local cmd="$1"
  local description="$2"
  local test_flag="${3:---version}"

  TOTAL=$((TOTAL + 1))

  if command -v "$cmd" &>/dev/null; then
    local version=""
    version=$($cmd $test_flag 2>/dev/null | head -1 || echo "installed")
    PASSED=$((PASSED + 1))
    if [[ "$JSON_OUTPUT" != true ]]; then
      echo -e "  ${GREEN}✓${NC} ${description} (${version})"
    fi
  else
    WARNINGS=$((WARNINGS + 1))
    if [[ "$JSON_OUTPUT" != true ]]; then
      echo -e "  ${YELLOW}⚠${NC}  ${description} (not installed)"
    fi
  fi
}

# ─── NPM Package Check ──────────────────────────────────────────

check_npm_pkg() {
  local pkg="$1"
  local description="$2"

  TOTAL=$((TOTAL + 1))

  if command -v npm &>/dev/null; then
    local version
    version=$(npm show "$pkg" version 2>/dev/null || echo "")
    if [[ -n "$version" ]]; then
      PASSED=$((PASSED + 1))
      if [[ "$JSON_OUTPUT" != true ]]; then
        echo -e "  ${GREEN}✓${NC} ${description} (v${version} on npm)"
      fi
    else
      FAILED=$((FAILED + 1))
      FAILURES="${FAILURES}\n  ❌ npm package '${pkg}' not found"
      if [[ "$JSON_OUTPUT" != true ]]; then
        echo -e "  ${RED}✗${NC} ${description} (not found on npm)"
      fi
    fi
  else
    WARNINGS=$((WARNINGS + 1))
    if [[ "$JSON_OUTPUT" != true ]]; then
      echo -e "  ${YELLOW}⚠${NC}  ${description} (npm not available)"
    fi
  fi
}

# ─── Banner ──────────────────────────────────────────────────────

if [[ "$JSON_OUTPUT" != true ]]; then
  echo ""
  echo -e "${CYAN}♾️  EverClaw Dependency Check${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "  $(date '+%Y-%m-%d %H:%M %Z')"
  echo ""
fi

# ═══════════════════════════════════════════════════════════════════
# EXTERNAL URLS
# ═══════════════════════════════════════════════════════════════════

if [[ "$CLI_ONLY" != true ]]; then

  if [[ "$JSON_OUTPUT" != true ]]; then
    echo -e "${BOLD}External URLs${NC}"
    echo ""
    echo -e "${BOLD}  EverClaw Infrastructure:${NC}"
  fi

  check_url "https://get.everclaw.xyz" GET "EverClaw installer redirect"
  check_url "https://keys.everclaw.xyz/health" GET "EverClaw bootstrap key server"  # root / has no route; /health is the liveness endpoint

  if [[ "$JSON_OUTPUT" != true ]]; then
    echo ""
    echo -e "${BOLD}  Morpheus Network:${NC}"
  fi

  check_url "https://api.mor.org/api/v1/models" GET "Morpheus Gateway API"
  check_url "https://app.mor.org" GET "Morpheus app (user-facing)"

  if [[ "$JSON_OUTPUT" != true ]]; then
    echo ""
    echo -e "${BOLD}  Venice AI:${NC}"
  fi

  check_url "https://api.venice.ai/api/v1/models" GET "Venice API models endpoint"

  if [[ "$JSON_OUTPUT" != true ]]; then
    echo ""
    echo -e "${BOLD}  Ollama:${NC}"
  fi

  check_url "https://ollama.com/download" GET "Ollama download page"
  check_url "https://ollama.com/install.sh" GET "Ollama Linux installer"
  check_url "https://ollama.com/download/Ollama-darwin.zip" GET "Ollama macOS download"

  if [[ "$JSON_OUTPUT" != true ]]; then
    echo ""
    echo -e "${BOLD}  Package Managers & Installers:${NC}"
  fi

  check_url "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh" GET "Homebrew installer"
  check_url "https://deb.nodesource.com/setup_22.x" GET "NodeSource 22.x setup"
  check_url "https://clawd.bot/install.sh" GET "OpenClaw installer (clawd.bot)"

  if [[ "$JSON_OUTPUT" != true ]]; then
    echo ""
    echo -e "${BOLD}  Blockchain & DeFi:${NC}"
  fi

  check_url "https://base-mainnet.public.blastapi.io" POST "Base RPC (BlastAPI, JSON-RPC POST)"
  check_url "https://api.coingecko.com/api/v3/simple/price?ids=morpheusai,ethereum&vs_currencies=usd" GET "CoinGecko price feed"
  check_url "https://aerodrome.finance" GET "Aerodrome swap interface"
  check_url "https://app.uniswap.org" GET "Uniswap interface"

  if [[ "$JSON_OUTPUT" != true ]]; then
    echo ""
    echo -e "${BOLD}  GitHub Releases:${NC}"
  fi

  check_url "https://github.com/MorpheusAIs/Morpheus-Lumerin-Node/releases" GET "Morpheus proxy-router releases"
  check_url "https://github.com/EverClaw/EverClaw/releases" GET "EverClaw releases"

  if [[ "$JSON_OUTPUT" != true ]]; then
    echo ""
    echo -e "${BOLD}  Documentation & Reference:${NC}"
  fi

  check_url "https://foundry.paradigm.xyz" GET "Foundry install page"
  check_url "https://x402.org" GET "x402 protocol"
  check_url "https://docs.cdp.coinbase.com/x402/welcome" GET "x402 Coinbase docs"

  if [[ "$JSON_OUTPUT" != true ]]; then
    echo ""
  fi

fi

# ═══════════════════════════════════════════════════════════════════
# CLI COMMANDS
# ═══════════════════════════════════════════════════════════════════

if [[ "$URLS_ONLY" != true ]]; then

  if [[ "$JSON_OUTPUT" != true ]]; then
    echo -e "${BOLD}CLI Commands${NC}"
    echo ""
    echo -e "${BOLD}  Core Dependencies:${NC}"
  fi

  check_cli "node" "Node.js" "--version"
  check_cli "npm" "npm" "--version"
  check_cli "git" "git" "--version"
  check_cli "curl" "curl" "--version"
  check_cli "jq" "jq" "--version"

  if [[ "$JSON_OUTPUT" != true ]]; then
    echo ""
    echo -e "${BOLD}  Agent Runtime:${NC}"
  fi

  check_cli "openclaw" "OpenClaw" "--version"

  if [[ "$JSON_OUTPUT" != true ]]; then
    echo ""
    echo -e "${BOLD}  Optional Components:${NC}"
  fi

  check_cli "ollama" "Ollama" "--version"
  check_cli "brew" "Homebrew" "--version"

  if [[ "$JSON_OUTPUT" != true ]]; then
    echo ""
    echo -e "${BOLD}  npm Packages:${NC}"
  fi

  check_npm_pkg "openclaw" "openclaw on npm registry"

  if [[ "$JSON_OUTPUT" != true ]]; then
    echo ""
  fi

fi

# ═══════════════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════════════

if [[ "$JSON_OUTPUT" == true ]]; then
  echo "{\"date\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"total\":${TOTAL},\"passed\":${PASSED},\"failed\":${FAILED},\"warnings\":${WARNINGS}}"
else
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}  Summary${NC}"
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "  Total checks:  ${TOTAL}"
  echo -e "  ${GREEN}Passed:${NC}        ${PASSED}"
  if [[ $FAILED -gt 0 ]]; then
    echo -e "  ${RED}Failed:${NC}        ${FAILED}"
  else
    echo -e "  Failed:        0"
  fi
  if [[ $WARNINGS -gt 0 ]]; then
    echo -e "  ${YELLOW}Warnings:${NC}      ${WARNINGS}"
  fi
  echo ""

  if [[ $FAILED -gt 0 ]]; then
    echo -e "${RED}  ❌ DEPENDENCY CHECK FAILED${NC}"
    echo -e "${RED}  Broken dependencies:${NC}"
    echo -e "$FAILURES"
    echo ""
  else
    echo -e "${GREEN}  ✅ All dependency checks passed${NC}"
    echo ""
  fi
fi

# Exit with failure if any checks failed
[[ $FAILED -eq 0 ]]
