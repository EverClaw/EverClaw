#!/bin/bash
# install-tiered.sh — MorpheusSkill Tiered Installer
# 
# Usage:
#   ./install-tiered.sh                    # Minimal (core only)
#   ./install-tiered.sh --standard         # Standard tier
#   ./install-tiered.sh --full             # Full tier
#   ./install-tiered.sh --with signal,brave # Custom selection
#   ./install-tiered.sh --list             # Show available components
#   ./install-tiered.sh --dry-run --full   # Preview without installing
#
# Tiers:
#   Minimal (default): Node.js, jq, git, curl, Morpheus proxy (~200MB)
#   Standard: + Ollama/qwen3.5:9b, Signal, ffmpeg (~8GB)
#   Full: + Brave, Whisper, gemma4:26b, all channels (~25GB)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVERCLAW_ROOT="$(dirname "$SCRIPT_DIR")"
INSTALL_DIR="$HOME/morpheus"

# Source utility functions
source "$SCRIPT_DIR/lib/install-utils.sh"
source "$SCRIPT_DIR/lib/install-core.sh"
source "$SCRIPT_DIR/lib/install-ollama.sh"
source "$SCRIPT_DIR/lib/install-signal.sh"
source "$SCRIPT_DIR/lib/install-media.sh"
source "$SCRIPT_DIR/lib/install-browser.sh"
source "$SCRIPT_DIR/lib/install-channels.sh"
source "$SCRIPT_DIR/lib/install-dev.sh"

# Default values
TIER="minimal"
CUSTOM_COMPONENTS=()
DRY_RUN=false
SHOW_HELP=false
SHOW_LIST=false

# Parse arguments
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --minimal)
        TIER="minimal"
        shift ;;
      --standard)
        TIER="standard"
        shift ;;
      --full)
        TIER="full"
        shift ;;
      --with)
        TIER="custom"
        if [[ -n "${2:-}" ]] && [[ ! "$2" =~ ^-- ]]; then
          IFS=',' read -ra CUSTOM_COMPONENTS <<< "$2"
          # Trim whitespace from each component
          for i in "${!CUSTOM_COMPONENTS[@]}"; do
            CUSTOM_COMPONENTS[i]=$(echo "${CUSTOM_COMPONENTS[i]}" | xargs)
          done
          shift 2
        else
          log_error "--with requires a comma-separated list of components"
          exit 1
        fi
        ;;
      --dry-run)
        DRY_RUN=true
        shift ;;
      --list)
        SHOW_LIST=true
        shift ;;
      -h|--help)
        SHOW_HELP=true
        shift ;;
      *)
        log_error "Unknown option: $1"
        echo "Use --help for usage information"
        exit 1 ;;
    esac
  done
}

show_help() {
  cat << 'EOF'
MorpheusSkill Tiered Installer

USAGE:
    ./install-tiered.sh [OPTIONS]

OPTIONS:
    --minimal       Install core dependencies only (default)
    --standard      Install standard tier (Ollama, Signal, ffmpeg)
    --full          Install everything
    --with X,Y,Z    Install specific components
    --dry-run       Show what would be installed without doing it
    --list          Show available components
    -h, --help      Show this help message

EXAMPLES:
    ./install-tiered.sh                     # Minimal install
    ./install-tiered.sh --standard          # Standard tier
    ./install-tiered.sh --with signal,brave # Just Signal and Brave
    ./install-tiered.sh --dry-run --full    # Preview full install

TIERS:
    Minimal (~200MB):   Node.js, jq, git, curl, Morpheus proxy
    Standard (~8GB):    + Ollama/qwen3.5:9b, Signal, ffmpeg
    Full (~25GB):       + Brave, Whisper, gemma4:26b, all channels

For more information: https://everclaw.xyz/docs/installation
EOF
}

# Get components for a tier
get_tier_components() {
  local tier="$1"
  
  case "$tier" in
    minimal)
      echo "core" ;;
    standard)
      echo "core ollama-small signal ffmpeg telegram discord" ;;
    full)
      echo "core ollama-large signal ffmpeg whisper brave gh telegram discord slack matrix" ;;
    custom)
      echo "core ${CUSTOM_COMPONENTS[*]}" ;;
  esac
}

# Install a single component
install_component() {
  local component="$1"
  
  if is_dry_run; then
    dry_run_msg "Install $component"
    return 0
  fi
  
  case "$component" in
    core)
      install_core_deps
      install_nodejs
      ;;
    ollama)
      install_ollama
      ;;
    ollama-small)
      install_ollama_small
      ;;
    ollama-large)
      install_ollama_large
      ;;
    signal)
      install_signal
      create_signal_config_template
      ;;
    telegram)
      install_telegram
      ;;
    discord)
      install_discord
      ;;
    slack)
      install_slack
      ;;
    matrix)
      install_matrix
      ;;
    ffmpeg)
      install_ffmpeg
      ;;
    whisper)
      install_whisper
      ;;
    brave)
      install_brave
      ;;
    gh)
      install_gh
      ;;
    *)
      log_warn "Unknown component: $component"
      return 1
      ;;
  esac
}

# Main installation flow
main() {
  parse_args "$@"
  
  if [[ "$SHOW_HELP" == "true" ]]; then
    show_help
    exit 0
  fi
  
  if [[ "$SHOW_LIST" == "true" ]]; then
    show_components
    exit 0
  fi
  
  # Detect platform
  detect_platform
  
  # Get components for selected tier
  local components
  components=$(get_tier_components "$TIER")
  read -ra COMPONENTS <<< "$components"
  
  # Calculate size
  local estimated_mb
  estimated_mb=$(estimate_size "${COMPONENTS[@]}")
  local size_str
  size_str=$(format_size "$estimated_mb")
  
  # Show plan
  log_header "MorpheusSkill Installer"
  echo ""
  echo "  Platform: ${PLATFORM}-${GOARCH}"
  echo "  Tier: ${TIER}"
  echo "  Components: ${COMPONENTS[*]}"
  echo "  Estimated size: ${size_str}"
  echo ""
  
  if is_dry_run; then
    log_header "Dry Run — No changes will be made"
    echo ""
  fi
  
  # Install each component
  local failed=()
  for component in "${COMPONENTS[@]}"; do
    log_header "Installing: $component"
    if ! install_component "$component"; then
      failed+=("$component")
    fi
  done
  
  # Install Morpheus proxy (always part of core)
  if ! is_dry_run; then
    log_header "Installing Morpheus Proxy"
    # Delegate to existing install.sh for proxy installation
    # This reuses the battle-tested proxy download logic
    if [[ -f "$SCRIPT_DIR/install.sh" ]]; then
      if ! SKIP_DEPS=true bash "$SCRIPT_DIR/install.sh" 2>&1 | grep -v "^Everclaw"; then
        failed+=("morpheus-proxy")
        log_warn "Morpheus proxy installation had issues"
      fi
    fi
  fi
  
  # Summary
  echo ""
  log_header "Installation Complete"
  echo ""
  
  if [[ ${#failed[@]} -gt 0 ]]; then
    log_warn "Some components failed to install: ${failed[*]}"
    echo "  You can retry with: ./install-tiered.sh --with ${failed[*]// /,}"
  else
    log_success "All components installed successfully"
  fi
  
  echo ""
  echo "  Morpheus proxy installed to: $INSTALL_DIR"
  echo ""
  echo "  Next steps:"
  echo "    1. Configure channels in ~/.openclaw/openclaw.json"
  echo "    2. Run: openclaw doctor"
  echo "    3. Start: openclaw gateway start"
  echo ""
  
  # Show channel setup if channels were installed
  if [[ " ${COMPONENTS[*]} " =~ " telegram " ]] || \
     [[ " ${COMPONENTS[*]} " =~ " discord " ]] || \
     [[ " ${COMPONENTS[*]} " =~ " slack " ]] || \
     [[ " ${COMPONENTS[*]} " =~ " matrix " ]]; then
    echo "  Channel setup instructions shown above."
    echo "  For Signal: signal-cli -a +PHONE register"
    echo ""
  fi
}

main "$@"
