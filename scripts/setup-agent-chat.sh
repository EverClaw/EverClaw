#!/bin/bash
# setup-agent-chat.sh — Install and manage the XMTP agent-chat daemon
#
# Sets up the always-on XMTP daemon for agent-to-agent messaging.
# Supports macOS (launchd) and Linux (user-level systemd).
#
# Usage:
#   bash scripts/setup-agent-chat.sh              # Auto-detect OS, install
#   bash scripts/setup-agent-chat.sh --status     # Check daemon status
#   bash scripts/setup-agent-chat.sh --uninstall  # Remove daemon
#   bash scripts/setup-agent-chat.sh --restart    # Restart daemon
#   bash scripts/setup-agent-chat.sh --logs       # Show recent logs
#   bash scripts/setup-agent-chat.sh --skip-start # Install but don't start
#
# Template variables (substituted at install time):
#   {{NODE_BIN}}      — Path to node binary (resolves nvm/brew/system)
#   {{EVERCLAW_PATH}} — Path to EverClaw skill directory
#
# Requirements:
#   - Node.js >= 20.0.0
#   - XMTP identity already generated (run setup-identity.mjs first)
#
# Security:
#   - ~/.everclaw/xmtp/ directory: chmod 700
#   - ~/.everclaw/xmtp/.secrets.json: chmod 600
#   - Runs as current user (no sudo required)

set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
AGENT_CHAT_DIR="$SKILL_DIR/skills/agent-chat"
EVERCLAW_HOME="${EVERCLAW_HOME:-$HOME/.everclaw}"
XMTP_DIR="$EVERCLAW_HOME/xmtp"
LOG_DIR="$EVERCLAW_HOME/logs"
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || echo "")}"

# Service names
SERVICE_NAME="com.everclaw.agent-chat"
SERVICE_NAME_SYSTEMD="everclaw-agent-chat"

# Colors (disabled if not a terminal)
if [[ -t 1 ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  NC='\033[0m' # No Color
else
  RED=''
  GREEN=''
  YELLOW=''
  BLUE=''
  NC=''
fi

# ─── Helpers ─────────────────────────────────────────────────────────────────

log() { echo -e "${GREEN}[agent-chat]${NC} $1"; }
warn() { echo -e "${YELLOW}[agent-chat]${NC} ⚠️  $1"; }
err() { echo -e "${RED}[agent-chat]${NC} ❌ $1"; }
info() { echo -e "${BLUE}[agent-chat]${NC} $1"; }

die() {
  err "$1"
  exit "${2:-1}"
}

# Find node binary, handling nvm/brew/system paths
find_node() {
  # Check nvm first (most common for Node 20+)
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    source "$HOME/.nvm/nvm.sh" 2>/dev/null || true
    local nvm_node
    nvm_node="$(nvm which current 2>/dev/null || echo "")"
    if [[ -x "$nvm_node" ]]; then
      echo "$nvm_node"
      return 0
    fi
  fi

  # Check Homebrew
  local brew_node
  brew_node="$(command -v brew 2>/dev/null && brew --prefix node 2>/dev/null)/bin/node"
  if [[ -x "$brew_node" ]]; then
    echo "$brew_node"
    return 0
  fi

  # Fallback to PATH
  local path_node
  path_node="$(command -v node 2>/dev/null || echo "")"
  if [[ -x "$path_node" ]]; then
    echo "$path_node"
    return 0
  fi

  return 1
}

# Check Node version >= 20
check_node_version() {
  local node_path="${1:-$NODE_BIN}"
  if [[ ! -x "$node_path" ]]; then
    return 1
  fi
  
  local version
  version="$("$node_path" --version 2>/dev/null | sed 's/^v//')"
  local major
  major="$(echo "$version" | cut -d. -f1)"
  
  if [[ "$major" -lt 20 ]]; then
    return 1
  fi
  
  return 0
}

# Ensure XMTP identity exists
check_identity() {
  if [[ ! -f "$XMTP_DIR/.secrets.json" ]]; then
    return 1
  fi
  if [[ ! -f "$XMTP_DIR/identity.json" ]]; then
    return 1
  fi
  return 0
}

# Set secure permissions on XMTP directory
secure_permissions() {
  mkdir -p "$XMTP_DIR"
  chmod 700 "$XMTP_DIR"
  
  if [[ -f "$XMTP_DIR/.secrets.json" ]]; then
    chmod 600 "$XMTP_DIR/.secrets.json"
  fi
  
  # Also secure the log directory
  mkdir -p "$LOG_DIR"
  chmod 700 "$LOG_DIR"
}

# ─── macOS launchd ───────────────────────────────────────────────────────────

install_launchd() {
  log "Installing launchd service for macOS..."
  
  local plist_dir="$HOME/Library/LaunchAgents"
  local plist_path="$plist_dir/$SERVICE_NAME.plist"
  
  mkdir -p "$plist_dir"
  mkdir -p "$LOG_DIR"
  
  # Unload existing if present (modern API)
  if [[ -f "$plist_path" ]]; then
    launchctl bootout "gui/$(id -u)/$SERVICE_NAME" 2>/dev/null || true
  fi
  
  # Resolve node path
  local node_path
  node_path="$(find_node)" || die "Node.js not found. Please install Node.js >= 20.0.0"
  
  if ! check_node_version "$node_path"; then
    die "Node.js version too old. Need >= 20.0.0, found: $($node_path --version)"
  fi
  
  log "Using Node.js at: $node_path"
  
  # Substitute template variables
  sed \
    -e "s|{{NODE_BIN}}|$node_path|g" \
    -e "s|{{EVERCLAW_PATH}}|$SKILL_DIR|g" \
    -e "s|{{LOG_DIR}}|$LOG_DIR|g" \
    "$AGENT_CHAT_DIR/templates/launchd/$SERVICE_NAME.plist" > "$plist_path"
  
  log "Created $plist_path"
  
  # Secure permissions
  secure_permissions
  
  # Load service (modern API)
  launchctl bootstrap "gui/$(id -u)" "$plist_path" 2>/dev/null || {
    warn "Failed to bootstrap launchd service"
    return 1
  }
  
  log "Service loaded: $SERVICE_NAME"
  return 0
}

uninstall_launchd() {
  log "Uninstalling launchd service..."
  
  local plist_dir="$HOME/Library/LaunchAgents"
  local plist_path="$plist_dir/$SERVICE_NAME.plist"
  
  # Unload (modern API)
  launchctl bootout "gui/$(id -u)/$SERVICE_NAME" 2>/dev/null || true
  
  # Remove plist
  if [[ -f "$plist_path" ]]; then
    rm -f "$plist_path"
    log "Removed $plist_path"
  fi
  
  log "Service uninstalled"
}

status_launchd() {
  local plist_dir="$HOME/Library/LaunchAgents"
  local plist_path="$plist_dir/$SERVICE_NAME.plist"
  
  if [[ ! -f "$plist_path" ]]; then
    echo "Status: not installed"
    return 1
  fi
  
  # Check if running
  if launchctl list "$SERVICE_NAME" &>/dev/null; then
    local pid
    pid="$(launchctl list "$SERVICE_NAME" 2>/dev/null | awk '/PID/ {print $2}')"
    echo "Status: running (PID: $pid)"
    
    # Show recent health
    if [[ -f "$XMTP_DIR/health.json" ]]; then
      local health_status
      health_status="$(jq -r '.status // "unknown"' "$XMTP_DIR/health.json" 2>/dev/null || echo "unknown")"
      local messages
      messages="$(jq -r '.messagesProcessed // 0' "$XMTP_DIR/health.json" 2>/dev/null || echo "0")"
      echo "Health: $health_status"
      echo "Messages processed: $messages"
    fi
    return 0
  else
    echo "Status: stopped"
    return 1
  fi
}

restart_launchd() {
  local plist_dir="$HOME/Library/LaunchAgents"
  local plist_path="$plist_dir/$SERVICE_NAME.plist"
  
  if [[ ! -f "$plist_path" ]]; then
    err "Service not installed. Run without arguments to install."
    return 1
  fi
  
  log "Restarting service..."
  launchctl bootout "gui/$(id -u)/$SERVICE_NAME" 2>/dev/null || true
  sleep 1
  launchctl bootstrap "gui/$(id -u)" "$plist_path" 2>/dev/null || {
    err "Failed to restart service"
    return 1
  }
  log "Service restarted"
  return 0
}

# ─── Linux systemd (user-level) ──────────────────────────────────────────────

install_systemd() {
  log "Installing systemd user service for Linux..."
  
  local systemd_dir="$HOME/.config/systemd/user"
  local service_path="$systemd_dir/$SERVICE_NAME_SYSTEMD.service"
  
  mkdir -p "$systemd_dir"
  mkdir -p "$LOG_DIR"
  
  # Stop existing if running
  systemctl --user stop "$SERVICE_NAME_SYSTEMD" 2>/dev/null || true
  
  # Resolve node path
  local node_path
  node_path="$(find_node)" || die "Node.js not found. Please install Node.js >= 20.0.0"
  
  if ! check_node_version "$node_path"; then
    die "Node.js version too old. Need >= 20.0.0, found: $($node_path --version)"
  fi
  
  log "Using Node.js at: $node_path"
  
  # Substitute template variables
  # Note: We use user-level systemd (no sudo required)
  sed \
    -e "s|{{NODE_BIN}}|$node_path|g" \
    -e "s|{{EVERCLAW_PATH}}|$SKILL_DIR|g" \
    -e "s|{{INSTALL_USER}}|$USER|g" \
    -e "s|{{LOG_DIR}}|$LOG_DIR|g" \
    "$AGENT_CHAT_DIR/templates/systemd/$SERVICE_NAME_SYSTEMD.service" > "$service_path"
  
  log "Created $service_path"
  
  # Secure permissions
  secure_permissions
  
  # Ensure lingering is enabled (allows services to run after logout)
  if command -v loginctl &>/dev/null; then
    loginctl enable-linger "$USER" 2>/dev/null || {
      warn "Could not enable lingering. Service may stop after logout."
      info "Run: loginctl enable-linger $USER"
    }
  fi
  
  # Reload systemd
  systemctl --user daemon-reload
  
  # Enable and start
  systemctl --user enable "$SERVICE_NAME_SYSTEMD" 2>/dev/null
  systemctl --user start "$SERVICE_NAME_SYSTEMD" 2>/dev/null || {
    warn "Failed to start service"
    return 1
  }
  
  log "Service enabled and started: $SERVICE_NAME_SYSTEMD"
  return 0
}

uninstall_systemd() {
  log "Uninstalling systemd user service..."
  
  # Stop and disable
  systemctl --user stop "$SERVICE_NAME_SYSTEMD" 2>/dev/null || true
  systemctl --user disable "$SERVICE_NAME_SYSTEMD" 2>/dev/null || true
  
  # Remove service file
  local systemd_dir="$HOME/.config/systemd/user"
  local service_path="$systemd_dir/$SERVICE_NAME_SYSTEMD.service"
  
  if [[ -f "$service_path" ]]; then
    rm -f "$service_path"
    systemctl --user daemon-reload
    log "Removed $service_path"
  fi
  
  log "Service uninstalled"
}

status_systemd() {
  local systemd_dir="$HOME/.config/systemd/user"
  local service_path="$systemd_dir/$SERVICE_NAME_SYSTEMD.service"
  
  if [[ ! -f "$service_path" ]]; then
    echo "Status: not installed"
    return 1
  fi
  
  # Check if running
  local is_active
  is_active="$(systemctl --user is-active "$SERVICE_NAME_SYSTEMD" 2>/dev/null || echo "inactive")"
  
  if [[ "$is_active" == "active" ]]; then
    echo "Status: running"
    
    # Show recent health
    if [[ -f "$XMTP_DIR/health.json" ]]; then
      local health_status
      health_status="$(jq -r '.status // "unknown"' "$XMTP_DIR/health.json" 2>/dev/null || echo "unknown")"
      local messages
      messages="$(jq -r '.messagesProcessed // 0' "$XMTP_DIR/health.json" 2>/dev/null || echo "0")"
      echo "Health: $health_status"
      echo "Messages processed: $messages"
    fi
    return 0
  else
    echo "Status: $is_active"
    return 1
  fi
}

restart_systemd() {
  local systemd_dir="$HOME/.config/systemd/user"
  local service_path="$systemd_dir/$SERVICE_NAME_SYSTEMD.service"
  
  if [[ ! -f "$service_path" ]]; then
    err "Service not installed. Run without arguments to install."
    return 1
  fi
  
  log "Restarting service..."
  systemctl --user restart "$SERVICE_NAME_SYSTEMD" 2>/dev/null || {
    err "Failed to restart service"
    return 1
  }
  log "Service restarted"
  return 0
}

# ─── Logs ───────────────────────────────────────────────────────────────────

show_logs() {
  local log_file="$LOG_DIR/agent-chat.log"
  local err_file="$LOG_DIR/agent-chat.err"
  
  # Check for log files (macOS launchd) or use journalctl (Linux systemd)
  if [[ "$(uname)" == "Darwin" ]]; then
    if [[ -f "$log_file" ]]; then
      log "Recent logs from $log_file:"
      tail -n 50 "$log_file"
    else
      warn "No log file found at $log_file"
      info "Check: /tmp/everclaw-agent-chat.log (launchd default)"
    fi
  else
    # Linux - use journalctl
    if command -v journalctl &>/dev/null; then
      log "Recent journal logs:"
      journalctl --user -u "$SERVICE_NAME_SYSTEMD" -n 50 --no-pager
    else
      warn "journalctl not available"
    fi
  fi
}

# ─── Health Check ────────────────────────────────────────────────────────────

verify_daemon() {
  log "Verifying daemon health..."
  
  sleep 3  # Give daemon time to start
  
  # Check health file
  if [[ -f "$XMTP_DIR/health.json" ]]; then
    local health_status
    health_status="$(jq -r '.status // "unknown"' "$XMTP_DIR/health.json" 2>/dev/null || echo "unknown")"
    
    if [[ "$health_status" == "running" ]]; then
      local address
      address="$(jq -r '.address // "unknown"' "$XMTP_DIR/health.json" 2>/dev/null || echo "unknown")"
      log "✓ Daemon is healthy"
      log "  Address: $address"
      return 0
    else
      warn "Daemon status: $health_status"
      info "Check logs: bash $0 --logs"
      return 1
    fi
  else
    warn "Health file not found. Daemon may not have started yet."
    info "Wait a few seconds and run: bash $0 --status"
    return 1
  fi
}

# ─── Main ───────────────────────────────────────────────────────────────────

show_usage() {
  cat << 'EOF'
Usage: bash setup-agent-chat.sh [COMMAND]

Commands:
  (none)      Install and start the XMTP agent-chat daemon
  --status    Check daemon status
  --uninstall Remove the daemon service
  --restart   Restart the daemon
  --logs      Show recent daemon logs
  --skip-start Install service but don't start it
  --help      Show this help message

Environment variables:
  NODE_BIN           Path to Node.js binary (auto-detected if not set)
  EVERCLAW_HOME      Path to ~/.everclaw (default: ~/.everclaw)

Requirements:
  - Node.js >= 20.0.0
  - XMTP identity (run: node skills/agent-chat/setup-identity.mjs)

Supported platforms:
  - macOS (launchd)
  - Linux (systemd user service, no sudo required)

Log files:
  - macOS: ~/Library/Logs/everclaw-agent-chat.log (or /tmp)
  - Linux: journalctl --user -u everclaw-agent-chat

EOF
}

main() {
  local command="${1:-install}"
  
  case "$command" in
    --help|-h)
      show_usage
      exit 0
      ;;
    --status)
      if [[ "$(uname)" == "Darwin" ]]; then
        status_launchd
      else
        status_systemd
      fi
      ;;
    --uninstall)
      if [[ "$(uname)" == "Darwin" ]]; then
        uninstall_launchd
      else
        uninstall_systemd
      fi
      ;;
    --restart)
      if [[ "$(uname)" == "Darwin" ]]; then
        restart_launchd
      else
        restart_systemd
      fi
      ;;
    --logs)
      show_logs
      ;;
    --skip-start)
      do_install --skip-start
      ;;
    install|"")
      do_install
      ;;
    *)
      err "Unknown command: $command"
      show_usage
      exit 1
      ;;
  esac
}

do_install() {
  local skip_start="${1:-}"
  
  # Check prerequisites
  if [[ -z "$NODE_BIN" ]]; then
    NODE_BIN="$(find_node)" || die "Node.js not found. Please install Node.js >= 20.0.0"
  fi
  
  if ! check_node_version "$NODE_BIN"; then
    die "Node.js version too old. Need >= 20.0.0, found: $($NODE_BIN --version)"
  fi
  
  if ! check_identity; then
    warn "XMTP identity not found at $XMTP_DIR"
    info "Generate one first: node $AGENT_CHAT_DIR/setup-identity.mjs"
    die "Run setup-identity.mjs before installing the daemon"
  fi
  
  log "Node.js: $($NODE_BIN --version)"
  log "EverClaw: $SKILL_DIR"
  log "XMTP dir: $XMTP_DIR"
  echo ""
  
  # Install based on OS
  if [[ "$(uname)" == "Darwin" ]]; then
    install_launchd
  elif [[ "$(uname)" == "Linux" ]] && command -v systemctl &>/dev/null; then
    install_systemd
  else
    die "Unsupported platform. Only macOS (launchd) and Linux (systemd) are supported."
  fi
  
  # Verify unless --skip-start
  if [[ -z "$skip_start" ]]; then
    verify_daemon
  else
    log "Service installed but not started (--skip-start)"
    log "To start: bash $0 --restart"
  fi
  
  echo ""
  log "═════════════════════════════════════════"
  log "  XMTP agent-chat daemon is installed!"
  log "═════════════════════════════════════════"
  echo ""
  info "Check status: bash $0 --status"
  info "View logs:    bash $0 --logs"
  info "Send message: node $AGENT_CHAT_DIR/cli.mjs send <address> <message>"
}

main "$@"