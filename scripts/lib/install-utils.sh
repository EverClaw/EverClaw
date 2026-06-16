#!/bin/bash
# install-utils.sh — Logging and utility functions
# Sourced by install.sh

# Colors (if terminal supports them)
if [[ -t 1 ]] && [[ -n "$TERM" ]] && [[ "$TERM" != "dumb" ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  BOLD='\033[1m'
  NC='\033[0m' # No Color
else
  RED=''
  GREEN=''
  YELLOW=''
  BLUE=''
  BOLD=''
  NC=''
fi

log_info() {
  echo -e "${BLUE}ℹ${NC}  $*"
}

log_success() {
  echo -e "${GREEN}✅${NC} $*"
}

log_warn() {
  echo -e "${YELLOW}⚠️${NC}  $*"
}

log_error() {
  echo -e "${RED}❌${NC} $*" >&2
}

log_header() {
  echo ""
  echo -e "${BOLD}━━━ $* ━━━${NC}"
}

# Detect platform
detect_platform() {
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)

  case "$OS" in
    darwin) PLATFORM="darwin" ;;
    linux)  PLATFORM="linux" ;;
    mingw*|msys*|cygwin*)
      log_error "Unsupported OS: $OS"
      echo "MorpheusSkill requires macOS or Linux."
      echo "Windows users: Install WSL 2 and run inside WSL:"
      echo "  → https://learn.microsoft.com/en-us/windows/wsl/install"
      exit 1 ;;
    *)
      log_error "Unsupported OS: $OS"
      exit 1 ;;
  esac

  case "$ARCH" in
    x86_64)  GOARCH="amd64" ;;
    aarch64) GOARCH="arm64" ;;
    arm64)   GOARCH="arm64" ;;
    *)
      log_error "Unsupported architecture: $ARCH"
      exit 1 ;;
  esac

  export PLATFORM ARCH GOARCH
}

# Check if running in dry-run mode
is_dry_run() {
  [[ "${DRY_RUN:-false}" == "true" ]]
}

# Print what would be done in dry-run mode
dry_run_msg() {
  if is_dry_run; then
    echo -e "${YELLOW}[DRY-RUN]${NC} Would: $*"
    return 0
  fi
  return 1
}

# Calculate estimated install size
estimate_size() {
  local components=("$@")
  local total_mb=0
  
  for comp in "${components[@]}"; do
    case "$comp" in
      core)         total_mb=$((total_mb + 150)) ;;
      ollama)       total_mb=$((total_mb + 100)) ;;
      ollama-small) total_mb=$((total_mb + 8000)) ;;  # gemma4:12b
      ollama-large) total_mb=$((total_mb + 17000)) ;;  # gemma4:26b
      signal)       total_mb=$((total_mb + 400)) ;;
      brave)        total_mb=$((total_mb + 400)) ;;
      ffmpeg)       total_mb=$((total_mb + 100)) ;;
      whisper)      total_mb=$((total_mb + 1500)) ;;
      telegram|discord|slack|matrix) total_mb=$((total_mb + 1)) ;;
      gh) total_mb=$((total_mb + 50)) ;;
    esac
  done
  
  echo "$total_mb"
}

# Format size for display (pure bash, no bc dependency)
format_size() {
  local mb="$1"
  if [[ "$mb" -ge 1000 ]]; then
    local gb=$((mb / 1000))
    local decimal=$(((mb % 1000) / 100))
    if [[ $decimal -gt 0 ]]; then
      echo "${gb}.${decimal}GB"
    else
      echo "${gb}GB"
    fi
  else
    echo "${mb}MB"
  fi
}

# Show component list
show_components() {
  echo ""
  echo "Available components:"
  echo ""
  echo "  ${BOLD}Core (always installed):${NC}"
  echo "    Node.js 24.x LTS, jq, git, curl, Morpheus proxy"
  echo ""
  echo "  ${BOLD}Local Inference:${NC}"
  echo "    ollama        Ollama engine only (~100MB)"
  echo "    ollama-small  + Gemma 4 12B Unified (~8GB)"
  echo "    ollama-large  + Gemma 4 26B (~17GB)"
  echo ""
  echo "  ${BOLD}Communication Channels:${NC}"
  echo "    signal        Signal messaging (~400MB, needs Java)"
  echo "    telegram      Telegram bot (API-based, no install)"
  echo "    discord       Discord bot (API-based, no install)"
  echo "    slack         Slack app (API-based, no install)"
  echo "    matrix        Matrix client (API-based, no install)"
  echo ""
  echo "  ${BOLD}Media Processing:${NC}"
  echo "    ffmpeg        Audio/video processing (~100MB)"
  echo "    whisper       Speech-to-text (~1.5GB with model)"
  echo ""
  echo "  ${BOLD}Browser:${NC}"
  echo "    brave         Brave Browser (~400MB)"
  echo ""
  echo "  ${BOLD}Developer Tools:${NC}"
  echo "    gh            GitHub CLI (~50MB)"
  echo ""
  echo "  ${BOLD}Tiers:${NC}"
  echo "    --standard    ollama-small, signal, ffmpeg"
  echo "    --full        All components"
  echo ""
}
