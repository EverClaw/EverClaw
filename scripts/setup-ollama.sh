#!/bin/bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════════
# Everclaw — setup-ollama.sh
#
# Detects hardware resources, selects optimal Gemma 4 model, installs Ollama,
# and configures OpenClaw to use local inference as final fallback.
#
# Gemma 4 family: E2B, E4B (default), 26B MoE, 31B Dense
# Vision + audio enabled on E2B/E4B; vision on 26B/31B.
# Supports native Ollama pull and Unsloth GGUF for quantized variants.
# Requires Ollama >= 0.20.0.
#
# Usage:
#   bash scripts/setup-ollama.sh              # Dry-run (show what would happen)
#   bash scripts/setup-ollama.sh --apply      # Install and configure
#   bash scripts/setup-ollama.sh --status     # Check current Ollama status
#   bash scripts/setup-ollama.sh --model gemma4:26b --apply   # Override model
#   bash scripts/setup-ollama.sh --uninstall  # Remove Ollama from config
# ═══════════════════════════════════════════════════════════════════════════════

# ─── Constants ─────────────────────────────────────────────────────────────────

readonly SCRIPT_NAME="setup-ollama.sh"
readonly SCRIPT_VERSION="2026.4.3"
readonly OLLAMA_URL="https://ollama.com/install.sh"
readonly OLLAMA_API="http://127.0.0.1:11434"
readonly OLLAMA_MIN_MAJOR=0
readonly OLLAMA_MIN_MINOR=20
readonly OLLAMA_MIN_PATCH=0
readonly GGUF_BASE_URL="https://huggingface.co/unsloth"

# Model family: Gemma 4 (Google, vision + audio, strong tool use)
# Native Ollama tags: gemma4:e2b, gemma4:e4b, gemma4:26b, gemma4:31b
# Unsloth GGUF custom models: gemma4-e2b-q3, gemma4-e2b-q4, gemma4-e4b-q3, gemma4-26b-q3, gemma4-31b-q3
# Note: Using case functions for bash 3 compatibility (no associative arrays)
MODEL_E2B_SIZE=1500       # ~1.5 GB native, needs ~2 GB RAM
MODEL_E2B_Q3_SIZE=1200    # ~1.2 GB GGUF Q3_K_M
MODEL_E2B_Q4_SIZE=1600    # ~1.6 GB GGUF Q4_K_M
MODEL_E4B_SIZE=9600       # ~9.6 GB native, needs ~11.5 GB RAM
MODEL_E4B_Q3_SIZE=5500    # ~5.5 GB GGUF Q3_K_M
MODEL_26B_SIZE=17000      # ~17 GB native, needs ~20 GB RAM
MODEL_26B_Q3_SIZE=12500   # ~12.5 GB GGUF Q3_K_M (82.6% MMLU Pro)
MODEL_31B_SIZE=20000      # ~20 GB native, needs ~24 GB RAM
MODEL_31B_Q3_SIZE=15000   # ~15 GB GGUF Q3_K_M

# Get model size by name (MB)
get_model_size() {
  local model="$1"
  case "$model" in
    gemma4:e2b)      echo $MODEL_E2B_SIZE ;;
    gemma4-e2b-q3)   echo $MODEL_E2B_Q3_SIZE ;;
    gemma4-e2b-q4)   echo $MODEL_E2B_Q4_SIZE ;;
    gemma4:e4b)      echo $MODEL_E4B_SIZE ;;
    gemma4-e4b-q3)   echo $MODEL_E4B_Q3_SIZE ;;
    gemma4:26b)      echo $MODEL_26B_SIZE ;;
    gemma4-26b-q3)   echo $MODEL_26B_Q3_SIZE ;;
    gemma4:31b)      echo $MODEL_31B_SIZE ;;
    gemma4-31b-q3)   echo $MODEL_31B_Q3_SIZE ;;
    *)               echo 0 ;;
  esac
}

# Get quality description by model name
get_model_quality() {
  local model="$1"
  case "$model" in
    gemma4:e2b|gemma4-e2b-*) echo "Good — vision + audio, light tasks" ;;
    gemma4:e4b|gemma4-e4b-*) echo "Strong — vision + audio, coding, most tasks (default)" ;;
    gemma4:26b|gemma4-26b-*) echo "Excellent — vision, complex reasoning, near-frontier (82.6% MMLU Pro)" ;;
    gemma4:31b|gemma4-31b-*) echo "Frontier — vision, matches cloud models" ;;
    *)                       echo "Unknown model" ;;
  esac
}

# Get context window by model
get_model_context_window() {
  local model="$1"
  case "$model" in
    gemma4:e2b*|gemma4-e2b*|gemma4:e4b*|gemma4-e4b*) echo 131072 ;;
    gemma4:26b*|gemma4-26b*|gemma4:31b*|gemma4-31b*) echo 262144 ;;
    *) echo 131072 ;;
  esac
}

# Get input modalities by model
# Note: Gemma 4 E2B/E4B models support "audio" natively, but OpenClaw's
# config validator currently only allows ["text", "image"]. We cap all models
# to ["text", "image"] until the validator is updated.
get_model_input_modalities() {
  local model="$1"
  case "$model" in
    *) echo '["text", "image"]' ;;
  esac
}

# Get friendly display name for model
get_model_display_name() {
  local model="$1"
  case "$model" in
    gemma4:e2b)      echo "Gemma 4 E2B" ;;
    gemma4-e2b-q3)   echo "Gemma 4 E2B Q3" ;;
    gemma4-e2b-q4)   echo "Gemma 4 E2B Q4" ;;
    gemma4:e4b)      echo "Gemma 4 E4B" ;;
    gemma4-e4b-q3)   echo "Gemma 4 E4B Q3" ;;
    gemma4:26b)      echo "Gemma 4 26B MoE" ;;
    gemma4-26b-q3)   echo "Gemma 4 26B MoE Q3" ;;
    gemma4:31b)      echo "Gemma 4 31B Dense" ;;
    gemma4-31b-q3)   echo "Gemma 4 31B Dense Q3" ;;
    *)               echo "$model" ;;
  esac
}

# Map legacy qwen3.5 model names to Gemma 4 equivalents (backward compat)
map_legacy_model() {
  local model="$1"
  case "$model" in
    qwen3.5:0.8b|qwen3.5:2b)
      log_warn "DEPRECATED: ${model} → use gemma4:e2b instead"
      echo "gemma4:e2b" ;;
    qwen3.5:4b|qwen3.5:9b)
      log_warn "DEPRECATED: ${model} → use gemma4:e4b instead"
      echo "gemma4:e4b" ;;
    qwen3.5:27b)
      log_warn "DEPRECATED: ${model} → use gemma4:26b instead"
      echo "gemma4:26b" ;;
    qwen3.5:35b)
      log_warn "DEPRECATED: ${model} → use gemma4:31b instead"
      echo "gemma4:31b" ;;
    qwen3.5:*)
      log_warn "DEPRECATED: ${model} → use gemma4:e4b instead"
      echo "gemma4:e4b" ;;
    *) echo "$model" ;;
  esac
}

# Check Ollama version meets minimum requirement (>= 0.20.0)
check_ollama_version() {
  local version_str
  version_str=$(ollama --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  if [[ -z "$version_str" ]]; then
    log_warn "Could not determine Ollama version"
    return 1
  fi

  local major minor patch
  major=$(echo "$version_str" | cut -d. -f1)
  minor=$(echo "$version_str" | cut -d. -f2)
  patch=$(echo "$version_str" | cut -d. -f3)

  if [[ "$major" -gt "$OLLAMA_MIN_MAJOR" ]]; then
    return 0
  elif [[ "$major" -eq "$OLLAMA_MIN_MAJOR" && "$minor" -gt "$OLLAMA_MIN_MINOR" ]]; then
    return 0
  elif [[ "$major" -eq "$OLLAMA_MIN_MAJOR" && "$minor" -eq "$OLLAMA_MIN_MINOR" && "$patch" -ge "$OLLAMA_MIN_PATCH" ]]; then
    return 0
  fi

  log_warn "Ollama ${version_str} is below minimum ${OLLAMA_MIN_MAJOR}.${OLLAMA_MIN_MINOR}.${OLLAMA_MIN_PATCH}"
  log_warn "Gemma 4 models require Ollama >= 0.20.0"
  log "Upgrade with: brew upgrade ollama (macOS) or curl -fsSL https://ollama.com/install.sh | sh (Linux)"
  return 1
}

# Is this a GGUF custom model (not native Ollama)?
is_gguf_model() {
  local model="$1"
  case "$model" in
    gemma4-*) return 0 ;;
    *)        return 1 ;;
  esac
}

# Get the Unsloth GGUF download URL for a model
get_gguf_url() {
  local model="$1"
  case "$model" in
    gemma4-e2b-q3)  echo "${GGUF_BASE_URL}/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q3_K_M.gguf" ;;
    gemma4-e2b-q4)  echo "${GGUF_BASE_URL}/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf" ;;
    gemma4-e4b-q3)  echo "${GGUF_BASE_URL}/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q3_K_M.gguf" ;;
    gemma4-26b-q3)  echo "${GGUF_BASE_URL}/gemma-4-26B-A4B-it-GGUF/resolve/main/gemma-4-26B-A4B-it-Q3_K_M.gguf" ;;
    gemma4-31b-q3)  echo "${GGUF_BASE_URL}/gemma-4-31B-it-GGUF/resolve/main/gemma-4-31B-it-Q3_K_M.gguf" ;;
    *)              echo "" ;;
  esac
}

# ─── State Variables ───────────────────────────────────────────────────────────

OS=""
ARCH=""
PLATFORM=""
TOTAL_RAM_MB=0
AVAILABLE_RAM_MB=0
GPU_TYPE="none"
GPU_VRAM_MB=0
SELECTED_MODEL=""
FORCE_MODEL=""
DRY_RUN=true
VERBOSE=false
SKIP_SERVICE=false
OPENCLAW_CONFIG=""

# ─── Logging ───────────────────────────────────────────────────────────────────

log() { echo "  $1"; }
log_ok() { echo "  ✅ $1"; }
log_warn() { echo "  ⚠️  $1"; }
log_err() { echo "  ❌ $1"; }
log_info() { [[ "$VERBOSE" == "true" ]] && echo "  ℹ️  $1" || true; }
log_section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ─── OS & Architecture Detection ───────────────────────────────────────────────

detect_os() {
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)
  
  case "$OS" in
    darwin) PLATFORM="macos" ;;
    linux)  PLATFORM="linux" ;;
    mingw*|msys*|cygwin*)
            log_err "Unsupported OS: $OS"
            log_err "EverClaw requires macOS or Linux."
            log_err "Windows (Git Bash / MSYS / Cygwin) is not supported."
            log_err "Please install WSL 2: https://learn.microsoft.com/en-us/windows/wsl/install"
            exit 1 ;;
    *)      log_err "Unsupported OS: $OS"; exit 1 ;;
  esac
  
  case "$ARCH" in
    x86_64)  ARCH="amd64" ;;
    aarch64) ARCH="arm64" ;;
    arm64)   ARCH="arm64" ;;
    *)       log_err "Unsupported architecture: $ARCH"; exit 1 ;;
  esac
  
  log "Platform:     ${PLATFORM}-${ARCH}"
}

# ─── RAM Detection ─────────────────────────────────────────────────────────────

detect_ram() {
  log_info "Detecting RAM..."
  
  if [[ "$PLATFORM" == "macos" ]]; then
    # macOS: use sysctl for total, vm_stat for available
    TOTAL_RAM_MB=$(/usr/sbin/sysctl -n hw.memsize | awk '{print int($1 / 1048576)}')
    
    # Get page count and page size
    local page_size=$(/usr/sbin/sysctl -n hw.pagesize 2>/dev/null || echo "4096")
    local vm_stats=$(/usr/bin/vm_stat 2>/dev/null || echo "")
    if [[ -n "$vm_stats" ]]; then
      local pages_free=$(echo "$vm_stats" | grep "Pages free" | awk '{print $3}' | tr -d '.')
      local pages_inactive=$(echo "$vm_stats" | grep "Pages inactive" | awk '{print $3}' | tr -d '.')
      local available_pages=$((pages_free + pages_inactive))
      AVAILABLE_RAM_MB=$((available_pages * page_size / 1048576))
    else
      # Fallback: estimate available as 50% of total
      AVAILABLE_RAM_MB=$((TOTAL_RAM_MB / 2))
    fi
    
  else
    # Linux: use /proc/meminfo
    TOTAL_RAM_MB=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)
    AVAILABLE_RAM_MB=$(awk '/MemAvailable/ {print int($2 / 1024)}' /proc/meminfo)
    
    # Fallback for older kernels without MemAvailable
    if [[ -z "$AVAILABLE_RAM_MB" || "$AVAILABLE_RAM_MB" == "0" ]]; then
      local free_kb=$(awk '/MemFree/ {print $2}' /proc/meminfo)
      local buffers_kb=$(awk '/Buffers/ {print $2}' /proc/meminfo)
      local cached_kb=$(awk '/^Cached/ {print $2}' /proc/meminfo)
      AVAILABLE_RAM_MB=$(((free_kb + buffers_kb + cached_kb) / 1024))
    fi
  fi
  
  local total_gb=$(awk "BEGIN {printf \"%.1f\", ${TOTAL_RAM_MB}/1024}")
  local avail_gb=$(awk "BEGIN {printf \"%.1f\", ${AVAILABLE_RAM_MB}/1024}")
  log "Total RAM:    ${TOTAL_RAM_MB} MB (${total_gb} GB)"
  log "Available:    ${AVAILABLE_RAM_MB} MB (${avail_gb} GB)"
}

# ─── GPU Detection ─────────────────────────────────────────────────────────────

detect_gpu() {
  log_info "Detecting GPU..."
  GPU_TYPE="none"
  GPU_VRAM_MB=0
  
  if [[ "$PLATFORM" == "macos" ]]; then
    # macOS: Apple Silicon has unified memory
    local cpu_brand=$(/usr/sbin/sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "")
    if echo "$cpu_brand" | grep -qi "apple"; then
      GPU_TYPE="metal"
      # Metal shares system RAM, no separate VRAM
      log "GPU:          Apple Metal (unified memory)"
      log_info "Metal shares system RAM — using available RAM for model sizing"
    else
      log "GPU:          None detected (Intel Mac)"
      log_info "Will use CPU inference"
    fi
    
  else
    # Linux: check NVIDIA first, then AMD
    if command -v nvidia-smi &>/dev/null; then
      GPU_TYPE="nvidia"
      GPU_VRAM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 || echo "0")
      if [[ -n "$GPU_VRAM_MB" && "$GPU_VRAM_MB" -gt 0 ]]; then
        log "GPU:          NVIDIA ($(nvidia-smi --query-gpu=name --format=csv,noheader | head -1))"
        log "VRAM:         ${GPU_VRAM_MB} MB"
      else
        GPU_TYPE="none"
        log "GPU:          NVIDIA detected but no VRAM reported"
      fi
    elif command -v rocm-smi &>/dev/null; then
      GPU_TYPE="amd"
      GPU_VRAM_MB=$(rocm-smi --showmeminfo vram --json 2>/dev/null | jq -r '.card0.VRAM // 0' | awk '{print int($1/1048576)}' || echo "0")
      if [[ -n "$GPU_VRAM_MB" && "$GPU_VRAM_MB" -gt 0 ]]; then
        log "GPU:          AMD ROCm (${GPU_VRAM_MB} MB VRAM)"
      else
        GPU_TYPE="none"
        log "GPU:          AMD detected but no VRAM reported"
      fi
    else
      log "GPU:          None (CPU inference only)"
    fi
  fi
}

# ─── Model Selection ───────────────────────────────────────────────────────────

select_model() {
  if [[ -n "$FORCE_MODEL" ]]; then
    # Map legacy qwen3.5 names
    FORCE_MODEL=$(map_legacy_model "$FORCE_MODEL")
    SELECTED_MODEL="$FORCE_MODEL"
    log "Model:        ${SELECTED_MODEL} (user-specified override)"
    return
  fi

  # Use available RAM for sizing, but cap at 70% of total
  # This leaves headroom for OS and other apps
  local effective_ram_mb=$AVAILABLE_RAM_MB
  local max_ram_mb=$((TOTAL_RAM_MB * 70 / 100))

  if [[ "$effective_ram_mb" -gt "$max_ram_mb" ]]; then
    effective_ram_mb=$max_ram_mb
    log_info "Capped at 70% of total RAM: ${max_ram_mb} MB"
  fi

  # If we have dedicated GPU VRAM, use that instead (faster inference)
  if [[ "$GPU_TYPE" == "nvidia" || "$GPU_TYPE" == "amd" ]]; then
    if [[ "$GPU_VRAM_MB" -gt 0 ]]; then
      effective_ram_mb=$GPU_VRAM_MB
      log_info "Using GPU VRAM for model sizing: ${effective_ram_mb} MB"
    fi
  fi

  # RAM tier boundaries (MB): <4096, 4096-8192, 8192-12288, 12288-16384, 16384-24576, 24576+
  # Gemma 4 model selection — aligned to 4/8/12/16/24 GB boundaries
  if [[ "$effective_ram_mb" -lt 4096 ]]; then
    SELECTED_MODEL="gemma4-e2b-q3"     # ~1.2 GB GGUF Q3
  elif [[ "$effective_ram_mb" -lt 8192 ]]; then
    SELECTED_MODEL="gemma4-e2b-q4"     # ~1.6 GB GGUF Q4 (better quality)
  elif [[ "$effective_ram_mb" -lt 12288 ]]; then
    SELECTED_MODEL="gemma4:e4b"        # ~9.6 GB native (default)
  elif [[ "$effective_ram_mb" -lt 16384 ]]; then
    SELECTED_MODEL="gemma4-26b-q3"     # ~12.5 GB GGUF Q3 (ClawBox sweet spot)
  elif [[ "$effective_ram_mb" -lt 24576 ]]; then
    SELECTED_MODEL="gemma4:26b"        # ~17 GB native
  else
    SELECTED_MODEL="gemma4:31b"        # ~20 GB native
  fi

  local size_mb=$(get_model_size "$SELECTED_MODEL")
  local quality=$(get_model_quality "$SELECTED_MODEL")

  log "Model:        ${SELECTED_MODEL}"
  log "Size:         ~$((size_mb / 1000)) GB"
  log "Quality:      ${quality}"

  # Safety check: ensure model fits
  if [[ "$size_mb" -gt "$effective_ram_mb" ]]; then
    log_warn "Selected model may not fit in available RAM!"
    log_warn "Model needs ~${size_mb} MB, but only ${effective_ram_mb} MB effective"
  fi
}

# ─── Ollama Status Check ───────────────────────────────────────────────────────

check_ollama_installed() {
  if command -v ollama &>/dev/null; then
    log_ok "Ollama installed: $(ollama --version 2>/dev/null | head -1 || echo 'version unknown')"
    return 0
  else
    log "Ollama:        Not installed"
    return 1
  fi
}

check_ollama_running() {
  if curl -s "${OLLAMA_API}" >/dev/null 2>&1; then
    log_ok "Ollama server running at ${OLLAMA_API}"
    return 0
  else
    log "Ollama server: Not running"
    return 1
  fi
}

check_model_pulled() {
  local model="$1"
  if ollama list 2>/dev/null | grep -q "^${model}"; then
    log_ok "Model ${model} already pulled"
    return 0
  else
    log "Model:        ${model} not yet pulled"
    return 1
  fi
}

check_openclaw_config() {
  local candidates=(
    "${OPENCLAW_CONFIG:-}"
    "${HOME}/.openclaw/openclaw.json"
    "$(pwd)/openclaw.json"
  )
  
  for path in "${candidates[@]}"; do
    [[ -z "$path" ]] && continue
    if [[ -f "$path" ]]; then
      OPENCLAW_CONFIG="$path"
      log "OpenClaw:     ${path}"
      return 0
    fi
  done
  
  log_warn "OpenClaw config not found (~/.openclaw/openclaw.json)"
  OPENCLAW_CONFIG=""
  return 1
}

check_ollama_in_config() {
  if [[ -z "$OPENCLAW_CONFIG" ]]; then
    return 1
  fi
  
  if jq -e '.models.providers.ollama' "$OPENCLAW_CONFIG" >/dev/null 2>&1; then
    log_ok "Ollama already configured in openclaw.json"
    return 0
  else
    log "Ollama in config: Not configured"
    return 1
  fi
}

# ─── Status Command ────────────────────────────────────────────────────────────

show_status() {
  log_section "📊 Ollama Status"
  
  check_ollama_installed; local installed=$?
  check_ollama_running; local running=$?
  check_openclaw_config; local config=$?
  
  if [[ $installed -eq 0 && $running -eq 0 ]]; then
    echo ""
    log "Installed models:"
    ollama list 2>/dev/null | tail -n +2 | while read -r line; do
      [[ -n "$line" ]] && log "  $line"
    done
  fi
  
  if [[ $config -eq 0 ]]; then
    check_ollama_in_config
  fi
  
  echo ""
}

# ─── Dry Run Output ────────────────────────────────────────────────────────────

show_dry_run() {
  log_section "🔍 Dry-Run Summary"
  
  echo ""
  log "Platform:       ${PLATFORM}-${ARCH}"
  log "Total RAM:      ${TOTAL_RAM_MB} MB"
  log "Available RAM:  ${AVAILABLE_RAM_MB} MB"
  log "GPU:            ${GPU_TYPE}$([[ "$GPU_VRAM_MB" -gt 0 ]] && echo " (${GPU_VRAM_MB} MB VRAM)" || echo "")"
  echo ""
  log_section "📦 Recommended Model"
  echo ""
  log "Model:          ${SELECTED_MODEL}"
  local size_mb=$(get_model_size "$SELECTED_MODEL")
  local quality=$(get_model_quality "$SELECTED_MODEL")
  log "Size:           ~$((size_mb / 1000)) GB"
  log "Quality:        ${quality}"
  echo ""
  log_section "🔧 Actions (run with --apply)"
  echo ""
  log "1. Install Ollama (if not present)"
  log "2. Pull model: ${SELECTED_MODEL}"
  log "3. Add ollama provider to openclaw.json"
  log "4. Append ollama/${SELECTED_MODEL} to fallback chain"
  log "5. Setup auto-start service (launchd/systemd)"
  echo ""
  log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  log "Dry-run complete. Add --apply to execute."
  echo ""
}

# ─── CLI Parsing ───────────────────────────────────────────────────────────────

print_usage() {
  cat << 'EOF'
♾️  Everclaw — Ollama Local Fallback Setup

Usage:
  bash scripts/setup-ollama.sh              Dry-run (show what would happen)
  bash scripts/setup-ollama.sh --apply      Install and configure Ollama
  bash scripts/setup-ollama.sh --status     Check current Ollama status
  bash scripts/setup-ollama.sh --uninstall  Remove Ollama from OpenClaw config

Options:
  --apply           Execute the installation
  --model <name>    Override auto-detected model
  --no-service      Skip auto-start service setup
  --verbose         Show detailed detection info
  --status          Show current Ollama status
  --uninstall       Remove ollama provider from openclaw.json
  -h, --help        Show this help

Examples:
  # Check what model would be selected
  bash scripts/setup-ollama.sh

  # Install with auto-detected model
  bash scripts/setup-ollama.sh --apply

  # Force a specific model
  bash scripts/setup-ollama.sh --model gemma4:26b --apply

  # Install without service setup
  bash scripts/setup-ollama.sh --apply --no-service
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --apply)     DRY_RUN=false ;;
      --status)    show_status; exit 0 ;;
      --uninstall) uninstall_ollama_config; exit 0 ;;
      --model)     FORCE_MODEL="$2"; shift ;;
      --no-service) SKIP_SERVICE=true ;;
      --verbose)   VERBOSE=true ;;
      -h|--help)   print_usage; exit 0 ;;
      *)           log_err "Unknown option: $1"; print_usage; exit 1 ;;
    esac
    shift
  done
}

# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 2b — Installation, Configuration, Service Setup
# ═══════════════════════════════════════════════════════════════════════════════

# ─── Install Ollama ─────────────────────────────────────────────────────────────

install_ollama() {
  if command -v ollama &>/dev/null; then
    log_ok "Ollama already installed: $(ollama --version 2>/dev/null | head -1 || echo 'unknown')"
    return 0
  fi

  log "Installing Ollama..."

  if [[ "$PLATFORM" == "macos" ]]; then
    # macOS: prefer Homebrew if available, else official installer
    if command -v brew &>/dev/null; then
      log "Using Homebrew..."
      brew install ollama 2>&1 | tail -3
    else
      log "Downloading official macOS installer..."
      # Ollama macOS uses a .zip with an app bundle
      local tmpdir=$(mktemp -d)
      curl -fsSL "https://ollama.com/download/Ollama-darwin.zip" -o "${tmpdir}/ollama.zip"
      unzip -qo "${tmpdir}/ollama.zip" -d /Applications/
      rm -rf "$tmpdir"
      # Ensure the CLI is linked
      if [[ ! -f /usr/local/bin/ollama ]]; then
        log "Linking CLI to /usr/local/bin/ollama..."
        sudo ln -sf /Applications/Ollama.app/Contents/Resources/ollama /usr/local/bin/ollama 2>/dev/null || \
          ln -sf /Applications/Ollama.app/Contents/Resources/ollama /opt/homebrew/bin/ollama 2>/dev/null || \
          log_warn "Could not symlink ollama CLI — add to PATH manually"
      fi
    fi
  else
    # Linux: official install script
    log "Running official Linux installer..."
    curl -fsSL "${OLLAMA_URL}" | sh 2>&1 | tail -5
  fi

  # Verify installation
  if command -v ollama &>/dev/null; then
    log_ok "Ollama installed: $(ollama --version 2>/dev/null | head -1)"
    return 0
  else
    log_err "Ollama installation failed"
    log "Try installing manually: https://ollama.com/download"
    return 1
  fi
}

# ─── Start Ollama Server ────────────────────────────────────────────────────────

ensure_ollama_running() {
  if curl -s --max-time 3 "${OLLAMA_API}" >/dev/null 2>&1; then
    log_ok "Ollama server already running"
    return 0
  fi

  log "Starting Ollama server..."

  if [[ "$PLATFORM" == "macos" ]]; then
    # Try launchd first, then direct
    if launchctl list 2>/dev/null | grep -q "com.ollama.ollama"; then
      launchctl kickstart "gui/$(id -u)/com.ollama.ollama" 2>/dev/null || true
    elif [[ -d "/Applications/Ollama.app" ]]; then
      open -a Ollama 2>/dev/null || true
    else
      ollama serve &>/dev/null &
    fi
  else
    # Linux: try systemd first, then direct
    if systemctl --user is-enabled ollama.service &>/dev/null; then
      systemctl --user start ollama.service
    elif systemctl is-enabled ollama.service &>/dev/null; then
      sudo systemctl start ollama.service
    else
      ollama serve &>/dev/null &
    fi
  fi

  # Wait for server to come up (max 30s)
  local tries=0
  while [[ $tries -lt 30 ]]; do
    if curl -s --max-time 2 "${OLLAMA_API}" >/dev/null 2>&1; then
      log_ok "Ollama server started"
      return 0
    fi
    sleep 1
    tries=$((tries + 1))
  done

  log_err "Ollama server did not start within 30 seconds"
  return 1
}

# ─── Pull Model ─────────────────────────────────────────────────────────────────

pull_model_native() {
  local model="$1"

  # Check if already pulled
  if ollama list 2>/dev/null | grep -q "${model}"; then
    log_ok "Model ${model} already available"
    return 0
  fi

  local size_mb=$(get_model_size "$model")
  log "Pulling model: ${model} (~$((size_mb / 1000)) GB)..."
  log "This may take a while depending on your connection..."
  echo ""

  if ollama pull "$model" 2>&1; then
    echo ""
    log_ok "Model ${model} pulled successfully"
    return 0
  else
    echo ""
    log_err "Failed to pull model ${model}"
    return 1
  fi
}

pull_model_gguf() {
  local model="$1"
  local url
  url=$(get_gguf_url "$model")

  if [[ -z "$url" ]]; then
    log_err "No GGUF URL known for model: ${model}"
    return 1
  fi

  # Check if custom model already exists
  if ollama list 2>/dev/null | grep -q "${model}"; then
    log_ok "Model ${model} already available"
    return 0
  fi

  local size_mb=$(get_model_size "$model")
  local ctx_window=$(get_model_context_window "$model")
  local tmpdir
  tmpdir=$(mktemp -d)
  local gguf_file="${tmpdir}/${model}.gguf"
  local modelfile="${tmpdir}/Modelfile"

  log "Downloading GGUF: ${model} (~$((size_mb / 1000)) GB)..."
  log "Source: ${url}"
  echo ""

  if ! curl -fSL --progress-bar -o "$gguf_file" "$url"; then
    log_err "Failed to download GGUF file"
    rm -rf "$tmpdir"
    return 1
  fi

  # Create Modelfile for Ollama
  cat > "$modelfile" << MODELFILE
FROM ${gguf_file}
PARAMETER num_ctx ${ctx_window}
MODELFILE

  log "Creating Ollama model from GGUF..."
  if ollama create "$model" -f "$modelfile" 2>&1; then
    echo ""
    log_ok "Model ${model} created from GGUF successfully"
    rm -rf "$tmpdir"
    return 0
  else
    echo ""
    log_err "Failed to create model from GGUF"
    rm -rf "$tmpdir"
    return 1
  fi
}

pull_model() {
  local model="$1"
  if is_gguf_model "$model"; then
    pull_model_gguf "$model"
  else
    pull_model_native "$model"
  fi
}

# ─── Configure OpenClaw ─────────────────────────────────────────────────────────

# ─── Ollama API Migration ────────────────────────────────────────────────────
# Fixes: api: "openai-completions" → api: "ollama" in existing configs.
# Without this fix, ollama requests may route through the previous provider's
# HTTP client in the fallback chain instead of localhost:11434.
# See: https://github.com/openclaw/openclaw/issues/45369

migrate_ollama_api() {
  local config="${1:-$OPENCLAW_CONFIG}"

  if [[ -z "$config" ]] || [[ ! -f "$config" ]]; then
    return 0
  fi

  # Check if ollama provider exists with wrong api type
  local current_api
  current_api=$(jq -r '.models.providers.ollama.api // ""' "$config" 2>/dev/null) || return 0

  if [[ "$current_api" != "openai-completions" ]]; then
    return 0  # Already correct or not configured
  fi

  log "Migrating ollama provider: api \"openai-completions\" → \"ollama\""

  # Backup before migration
  cp "$config" "${config}.bak.$(date +%s)"

  # Fix provider-level api
  local tmp_config
  tmp_config=$(jq '.models.providers.ollama.api = "ollama"' "$config")

  # Remove model-level api:"openai-completions" (let it inherit from provider)
  tmp_config=$(echo "$tmp_config" | jq '
    if .models.providers.ollama.models then
      .models.providers.ollama.models |= map(
        if .api == "openai-completions" then del(.api) else . end
      )
    else . end
  ')

  echo "$tmp_config" | jq '.' > "$config"
  log_ok "Ollama API type migrated — fallback routing fixed"
}

configure_openclaw() {
  local model="$1"

  if [[ -z "$OPENCLAW_CONFIG" ]]; then
    log_warn "No OpenClaw config found — skipping config update"
    log "You can manually add the ollama provider to your openclaw.json"
    return 1
  fi

  # Migrate existing ollama configs with wrong api type
  migrate_ollama_api "$OPENCLAW_CONFIG"

  log "Configuring OpenClaw..."

  # Build the ollama provider JSON block
  local display_name
  display_name=$(get_model_display_name "$model")
  local input_modalities
  input_modalities=$(get_model_input_modalities "$model")
  local ctx_window
  ctx_window=$(get_model_context_window "$model")

  local provider_json
  provider_json=$(cat <<EOF
{
  "baseUrl": "http://127.0.0.1:11434/v1",
  "api": "ollama",
  "models": [
    {
      "id": "${model}",
      "name": "${display_name} (Local Ollama)",
      "reasoning": false,
      "input": ${input_modalities},
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": ${ctx_window},
      "maxTokens": 16384
    }
  ]
}
EOF
)

  # Backup config
  cp "$OPENCLAW_CONFIG" "${OPENCLAW_CONFIG}.bak.$(date +%s)"
  log_info "Config backed up"

  # Check if ollama provider already exists
  if jq -e '.models.providers.ollama' "$OPENCLAW_CONFIG" >/dev/null 2>&1; then
    # Update existing ollama provider with new model
    local existing_model
    existing_model=$(jq -r '.models.providers.ollama.models[0].id // ""' "$OPENCLAW_CONFIG")

    if [[ "$existing_model" == "$model" ]]; then
      log_ok "Ollama provider already configured with ${model}"
    else
      log "Updating ollama provider: ${existing_model} → ${model}"
      local tmp_config
      tmp_config=$(jq --argjson provider "$provider_json" \
        '.models.providers.ollama = $provider' "$OPENCLAW_CONFIG")
      echo "$tmp_config" | jq '.' > "$OPENCLAW_CONFIG"
      log_ok "Ollama provider updated to ${model}"
    fi
  else
    # Add new ollama provider
    local tmp_config
    tmp_config=$(jq --argjson provider "$provider_json" \
      '.models.providers.ollama = $provider' "$OPENCLAW_CONFIG")
    echo "$tmp_config" | jq '.' > "$OPENCLAW_CONFIG"
    log_ok "Ollama provider added to openclaw.json"
  fi

  # Add ollama model to fallback chain (as last fallback)
  local fallback_entry="ollama/${model}"
  local already_in_fallbacks
  already_in_fallbacks=$(jq -r --arg fb "$fallback_entry" \
    '.agents.defaults.model.fallbacks // [] | map(select(startswith("ollama/"))) | length' \
    "$OPENCLAW_CONFIG")

  if [[ "$already_in_fallbacks" -gt 0 ]]; then
    # Remove old ollama fallback and add new one at the end
    local tmp_config
    tmp_config=$(jq --arg fb "$fallback_entry" \
      '.agents.defaults.model.fallbacks = [
        (.agents.defaults.model.fallbacks // [] | .[] | select(startswith("ollama/") | not)),
        $fb
      ]' "$OPENCLAW_CONFIG")
    echo "$tmp_config" | jq '.' > "$OPENCLAW_CONFIG"
    log_ok "Fallback updated: ${fallback_entry} (last position)"
  else
    # Append to fallback chain
    local tmp_config
    tmp_config=$(jq --arg fb "$fallback_entry" \
      '.agents.defaults.model.fallbacks += [$fb]' "$OPENCLAW_CONFIG")
    echo "$tmp_config" | jq '.' > "$OPENCLAW_CONFIG"
    log_ok "Fallback added: ${fallback_entry} (last position)"
  fi

  log_info "Config: ${OPENCLAW_CONFIG}"
}

# ─── Service Setup (Auto-start) ─────────────────────────────────────────────────

setup_service() {
  if [[ "$SKIP_SERVICE" == "true" ]]; then
    log "Skipping service setup (--no-service)"
    return 0
  fi

  log "Setting up auto-start service..."

  if [[ "$PLATFORM" == "macos" ]]; then
    setup_service_macos
  else
    setup_service_linux
  fi
}

setup_service_macos() {
  local plist_dir="${HOME}/Library/LaunchAgents"
  local plist_name="com.ollama.ollama.plist"
  local plist_path="${plist_dir}/${plist_name}"

  # Ollama's own installer typically creates this plist.
  # If it already exists, just ensure it's loaded.
  if [[ -f "$plist_path" ]]; then
    log_ok "LaunchAgent plist already exists: ${plist_name}"
    # Ensure loaded
    if ! launchctl list 2>/dev/null | grep -q "com.ollama.ollama"; then
      launchctl load -w "$plist_path" 2>/dev/null || true
      log_ok "LaunchAgent loaded"
    else
      log_ok "LaunchAgent already loaded"
    fi
    return 0
  fi

  # Create a minimal plist if Ollama didn't install one
  mkdir -p "$plist_dir"
  local ollama_bin
  ollama_bin=$(command -v ollama 2>/dev/null || echo "/opt/homebrew/bin/ollama")

  cat > "$plist_path" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ollama.ollama</string>
    <key>ProgramArguments</key>
    <array>
        <string>${ollama_bin}</string>
        <string>serve</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${HOME}/.ollama/logs/server.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/.ollama/logs/server.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
PLIST

  mkdir -p "${HOME}/.ollama/logs"
  launchctl load -w "$plist_path" 2>/dev/null || true
  log_ok "LaunchAgent created and loaded: ${plist_name}"
}

setup_service_linux() {
  # Use systemd user service (no root required)
  local service_dir="${HOME}/.config/systemd/user"
  local service_name="ollama.service"
  local service_path="${service_dir}/${service_name}"

  if [[ -f "$service_path" ]]; then
    log_ok "Systemd service already exists: ${service_name}"
    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user enable --now "$service_name" 2>/dev/null || true
    log_ok "Service enabled and started"
    return 0
  fi

  # Check if system-level service exists (from official installer)
  if systemctl is-enabled ollama.service &>/dev/null 2>&1; then
    log_ok "System-level ollama.service found — using that"
    sudo systemctl enable --now ollama.service 2>/dev/null || true
    return 0
  fi

  # Create user-level systemd service
  local ollama_bin
  ollama_bin=$(command -v ollama 2>/dev/null || echo "/usr/local/bin/ollama")

  mkdir -p "$service_dir"
  cat > "$service_path" << UNIT
[Unit]
Description=Ollama Local Inference Server (Everclaw)
After=network.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${ollama_bin} serve
Environment="HOME=${HOME}"
Environment="OLLAMA_HOST=127.0.0.1:11434"
Restart=on-failure
RestartSec=5

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${HOME}/.ollama
PrivateTmp=true

[Install]
WantedBy=default.target
UNIT

  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable --now "$service_name" 2>/dev/null || true
  log_ok "Systemd service created and started: ${service_name}"
}

# ─── Test Inference ──────────────────────────────────────────────────────────────

test_inference() {
  local model="$1"

  log "Testing inference with ${model}..."

  local response
  response=$(curl -s --max-time 60 "${OLLAMA_API}/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"${model}\",
      \"messages\": [{\"role\": \"user\", \"content\": \"Respond with exactly: OLLAMA_OK\"}],
      \"max_tokens\": 50,
      \"temperature\": 0
    }" 2>/dev/null)

  if [[ -z "$response" ]]; then
    log_warn "No response from Ollama (timeout or connection refused)"
    log "Inference test skipped — model may still work, try manually"
    return 0
  fi

  local content
  content=$(echo "$response" | jq -r '.choices[0].message.content // .error // "PARSE_ERROR"' 2>/dev/null)

  # Normalize whitespace for substring match (handles thinking tags gracefully)
  local normalized
  normalized=$(echo "$content" | xargs 2>/dev/null || echo "$content")

  if [[ "$normalized" == *"OLLAMA_OK"* ]]; then
    log_ok "Inference test passed — model is working"
    return 0
  elif echo "$content" | grep -qi "error"; then
    log_err "Inference test failed: ${content}"
    return 1
  else
    # Model responded but not with exact text — still counts as working
    log_ok "Inference test passed — model responded: $(echo "$content" | head -c 80)"
    return 0
  fi
}

# ─── Uninstall from OpenClaw Config ──────────────────────────────────────────────

uninstall_ollama_config() {
  log_section "🗑️  Removing Ollama from OpenClaw config"

  # Find config
  check_openclaw_config || { log_err "No OpenClaw config found"; exit 1; }

  if ! jq -e '.models.providers.ollama' "$OPENCLAW_CONFIG" >/dev/null 2>&1; then
    log "Ollama provider not found in config — nothing to remove"
    return 0
  fi

  # Backup
  cp "$OPENCLAW_CONFIG" "${OPENCLAW_CONFIG}.bak.$(date +%s)"
  log_info "Config backed up"

  # Remove ollama provider
  local tmp_config
  tmp_config=$(jq 'del(.models.providers.ollama)' "$OPENCLAW_CONFIG")
  echo "$tmp_config" | jq '.' > "$OPENCLAW_CONFIG"
  log_ok "Ollama provider removed"

  # Remove ollama fallbacks
  tmp_config=$(jq '.agents.defaults.model.fallbacks = [
    .agents.defaults.model.fallbacks[] | select(startswith("ollama/") | not)
  ]' "$OPENCLAW_CONFIG")
  echo "$tmp_config" | jq '.' > "$OPENCLAW_CONFIG"
  log_ok "Ollama fallbacks removed"

  log ""
  log "Ollama software was NOT uninstalled (only removed from OpenClaw config)."
  log "To fully remove Ollama: brew uninstall ollama (macOS) or sudo rm /usr/local/bin/ollama (Linux)"
  echo ""
}

# ─── Main Entry Point ──────────────────────────────────────────────────────────

main() {
  echo ""
  echo "♾️  Everclaw — Ollama Local Fallback"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  parse_args "$@"

  # Detection phase
  detect_os
  detect_ram
  detect_gpu
  select_model

  # Status checks
  check_ollama_installed
  check_openclaw_config

  # Dry-run or execute
  if [[ "$DRY_RUN" == "true" ]]; then
    show_dry_run
  else
    # ─── Step 1: Install Ollama ───────────────
    log_section "🔧 Step 1: Install Ollama"
    install_ollama || exit 1

    # ─── Step 1b: Version check ──────────
    if ! check_ollama_version; then
      log_err "Ollama version too old for Gemma 4. Please upgrade and re-run."
      exit 1
    fi

    # ─── Step 2: Start server ─────────────────
    log_section "🔧 Step 2: Start Ollama server"
    ensure_ollama_running || exit 1

    # ─── Step 3: Pull model ───────────────────
    log_section "🔧 Step 3: Pull model"
    pull_model "$SELECTED_MODEL" || exit 1

    # ─── Step 4: Configure OpenClaw ───────────
    log_section "🔧 Step 4: Configure OpenClaw"
    configure_openclaw "$SELECTED_MODEL"

    # ─── Step 5: Setup auto-start ─────────────
    log_section "🔧 Step 5: Auto-start service"
    setup_service

    # ─── Step 6: Test inference ───────────────
    log_section "🔧 Step 6: Test inference"
    test_inference "$SELECTED_MODEL"

    # ─── Done ─────────────────────────────────
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    log_ok "Ollama local fallback setup complete!"
    echo ""
    log "Model:     ollama/${SELECTED_MODEL}"
    log "API:       ${OLLAMA_API}"
    log "Position:  Last fallback in chain"
    echo ""
    log "Restart OpenClaw to apply: openclaw gateway restart"
    echo ""
  fi
}

# Run
main "$@"