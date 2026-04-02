#!/usr/bin/env bash
set -euo pipefail

# restore-agent.sh — Self-contained EverClaw agent restore installer
#
# Downloads, decrypts, and installs an EverClaw agent backup on a new machine.
# Handles dependencies, config adaptation, service setup, and verification.
#
# Usage:
#   bash restore-agent.sh [options] [/path/to/backup.tar.zst.age]
#   curl -fsSL https://get.everclaw.xyz/restore | bash -s -- [options] [path]
#
# Spec: memory/planning/restore-agent-1C-spec.md (v1C-rev1)

# ── Constants ────────────────────────────────────────────────────────
readonly VERSION="2026.4.2"
readonly STAGING_PREFIX="/tmp/everclaw-restore"
readonly OPENCLAW_DIR="$HOME/.openclaw"
readonly MORPHEUS_DIR="$HOME/.morpheus"
readonly EVERCLAW_DIR="$HOME/.everclaw"
readonly OPENCLAW_JSON="$OPENCLAW_DIR/openclaw.json"

# ── State ────────────────────────────────────────────────────────────
ARCHIVE=""
PASSPHRASE=""
DOCKER_MODE=false
NO_DEPS=false
NO_START=false
NO_VERIFY=false
FORCE=false
BACKUP_EXISTING=true
DRY_RUN=false
JSON_OUTPUT=false
QUIET=false
VERBOSE=false
STAGING_DIR=""
WALLET_RESTORED="no"

# ── Cleanup trap ───────────────���─────────────────────────────────────
cleanup() {
  if [ -n "$STAGING_DIR" ] && [ -d "$STAGING_DIR" ]; then
    rm -rf "$STAGING_DIR"
  fi
}
trap cleanup EXIT

# ── Helpers ──────────────────────────────────────────────────────────
log() { [ "$QUIET" = true ] || echo "  $1"; }
warn() { echo "  ⚠️  $1" >&2; }
err() { echo "  ❌ $1" >&2; }
debug() { [ "$VERBOSE" = true ] && echo "  [debug] $1" || true; }

die() {
  err "$1"
  exit "${2:-1}"
}

# ── CLI Parsing ──────────────────────────────────────────────────────
show_help() {
  cat << 'EOF'
Usage: restore-agent.sh [options] [/path/to/backup.tar.zst.age]

Options:
  --docker              Generate docker-compose.yml instead of native install
  --passphrase <str>    Passphrase for decryption (prompted if omitted)
  --no-deps             Skip dependency installation
  --no-start            Restore files but don't start services
  --no-verify           Skip post-restore verification
  --force               Overwrite existing installation without prompting
  --no-backup-existing  Don't backup existing installation before overwriting
  --dry-run             Show what would happen without doing it
  --json                Output dry-run results as JSON
  -q, --quiet           Minimal output
  -v, --verbose         Detailed output
  -h, --help            Show this help

Examples:
  bash restore-agent.sh ~/Downloads/everclaw-backup-2026-04-02.tar.zst.age
  bash restore-agent.sh --docker --passphrase "my-secret-phrase"
  curl -fsSL https://get.everclaw.xyz/restore | bash -s -- --docker
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --docker)           DOCKER_MODE=true ;;
      --passphrase)       PASSPHRASE="$2"; shift ;;
      --no-deps)          NO_DEPS=true ;;
      --no-start)         NO_START=true ;;
      --no-verify)        NO_VERIFY=true ;;
      --force)            FORCE=true ;;
      --no-backup-existing) BACKUP_EXISTING=false ;;
      --dry-run)          DRY_RUN=true ;;
      --json)             JSON_OUTPUT=true ;;
      -q|--quiet)         QUIET=true ;;
      -v|--verbose)       VERBOSE=true ;;
      -h|--help)          show_help; exit 0 ;;
      -*)                 die "Unknown option: $1" 1 ;;
      *)                  ARCHIVE="$1" ;;
    esac
    shift
  done
}

# ── OS Detection ─────────────────────────────────────────────────────
detect_os() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux)  echo "linux" ;;
    *)      die "Unsupported OS: $(uname -s). Only macOS and Linux are supported." 2 ;;
  esac
}

detect_pkg_manager() {
  if command -v brew &>/dev/null; then echo "brew"
  elif command -v apt-get &>/dev/null; then echo "apt"
  elif command -v dnf &>/dev/null; then echo "dnf"
  elif command -v pacman &>/dev/null; then echo "pacman"
  elif command -v apk &>/dev/null; then echo "apk"
  else echo "none"
  fi
}

# ── Dependency Installation ──────────────────────────────────────────
install_pkg() {
  local pkg="$1"
  local pkg_mgr
  pkg_mgr=$(detect_pkg_manager)

  log "Installing $pkg..."
  case "$pkg_mgr" in
    brew)   brew install "$pkg" 2>/dev/null ;;
    apt)    sudo apt-get install -y "$pkg" 2>/dev/null ;;
    dnf)    sudo dnf install -y "$pkg" 2>/dev/null ;;
    pacman) sudo pacman -S --noconfirm "$pkg" 2>/dev/null ;;
    apk)    sudo apk add "$pkg" 2>/dev/null ;;
    none)   die "No package manager found. Install $pkg manually." 2 ;;
  esac
}

install_homebrew() {
  if command -v brew &>/dev/null; then return 0; fi
  log "Homebrew not found. Installing..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Add to PATH for current session
  eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || \
    eval "$(/usr/local/bin/brew shellenv)" 2>/dev/null || true
}

check_deps() {
  [ "$NO_DEPS" = true ] && { debug "Skipping dependency check (--no-deps)"; return 0; }

  local os
  os=$(detect_os)
  local missing=()

  # Check each required dependency
  command -v age &>/dev/null    || missing+=("age")
  command -v zstd &>/dev/null   || missing+=("zstd")
  command -v tar &>/dev/null    || missing+=("tar")
  command -v jq &>/dev/null     || missing+=("jq")
  command -v curl &>/dev/null   || missing+=("curl")

  # Check Node.js
  if command -v node &>/dev/null; then
    local node_major
    node_major=$(node --version | sed 's/^v//' | cut -d. -f1)
    if [ "$node_major" -lt 18 ]; then
      warn "Node.js $node_major is too old (need ≥18)"
      missing+=("node")
    fi
  else
    missing+=("node")
  fi

  if [ ${#missing[@]} -eq 0 ]; then
    debug "All dependencies present"
    return 0
  fi

  log "Missing dependencies: ${missing[*]}"

  # macOS: ensure Homebrew first
  if [ "$os" = "macos" ]; then
    install_homebrew
  fi

  for dep in "${missing[@]}"; do
    case "$dep" in
      node)
        if [ "$os" = "macos" ]; then
          install_pkg node
        else
          # Use NodeSource for Linux
          if command -v curl &>/dev/null; then
            curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - 2>/dev/null
            sudo apt-get install -y nodejs 2>/dev/null
          else
            install_pkg nodejs
          fi
        fi
        ;;
      *)
        install_pkg "$dep"
        ;;
    esac

    # Verify installed
    if ! command -v "$dep" &>/dev/null; then
      die "Failed to install $dep. Install it manually and retry." 2
    fi
  done

  log "All dependencies installed ✓"
}

# ── Docker Dependency Check ─────────────────────────────────────────
check_docker_deps() {
  if [ "$DOCKER_MODE" != true ]; then return 0; fi

  if ! command -v docker &>/dev/null; then
    die "Docker not found. Install Docker first: https://docs.docker.com/get-docker/" 2
  fi

  if ! docker info &>/dev/null 2>&1; then
    die "Docker daemon not running. Start Docker and retry." 2
  fi

  # Check for docker compose (v2) or docker-compose (v1)
  if docker compose version &>/dev/null 2>&1; then
    debug "Docker Compose v2 found"
  elif command -v docker-compose &>/dev/null; then
    debug "Docker Compose v1 found"
  else
    die "Docker Compose not found. Install it: https://docs.docker.com/compose/install/" 2
  fi
}

# ── Archive Discovery ──────────────────────────────────────────────
find_archive() {
  # If archive already set via CLI arg, validate it
  if [ -n "$ARCHIVE" ]; then
    [ -f "$ARCHIVE" ] || die "Archive not found: $ARCHIVE" 3
    [ -r "$ARCHIVE" ] || die "Archive not readable: $ARCHIVE" 3
    return 0
  fi

  # Bundled-script detection: check if restore script is next to a backup
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local co_located
  co_located=$(ls -t "$script_dir"/everclaw-backup-*.tar.zst.age 2>/dev/null | head -1)
  if [ -n "$co_located" ]; then
    log "Found co-located backup: $(basename "$co_located")"
    ARCHIVE="$co_located"
    return 0
  fi

  # Auto-discovery: search common locations (newest first)
  local search_dirs=("$HOME/Downloads" "." "/tmp")
  for dir in "${search_dirs[@]}"; do
    local found
    found=$(ls -t "$dir"/everclaw-backup-*.tar.zst.age 2>/dev/null | head -1)
    if [ -n "$found" ]; then
      log "Found backup: $found"
      ARCHIVE="$found"
      return 0
    fi
  done

  die "No EverClaw backup found. Expected: everclaw-backup-YYYY-MM-DD.tar.zst.age

Try:
  bash restore-agent.sh /path/to/your-backup.tar.zst.age" 3
}

# ── Passphrase Prompt ──────────────────────────────────────────────
get_passphrase() {
  if [ -n "$PASSPHRASE" ]; then return 0; fi

  # Non-TTY: passphrase must be provided via flag
  if [ ! -t 0 ]; then
    die "Passphrase required in non-interactive mode. Use: --passphrase \"your passphrase\"" 4
  fi

  # Interactive prompt (hidden input)
  local attempts=0
  while [ $attempts -lt 3 ]; do
    echo -n "  🔐 Enter backup passphrase: " >&2
    read -rs PASSPHRASE
    echo >&2
    if [ -n "$PASSPHRASE" ]; then
      return 0
    fi
    warn "Passphrase cannot be empty"
    attempts=$((attempts + 1))
  done
  die "Too many failed attempts" 4
}

# ── Portable stat size ─────────────────────────────────────────────
stat_size() {
  stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || wc -c < "$1" 2>/dev/null || echo 0
}

# ── Decryption & Extraction ─────────────────────────────────────────
decrypt_and_extract() {
  STAGING_DIR="${STAGING_PREFIX}-$(date +%s)"
  mkdir -p "$STAGING_DIR"
  chmod 700 "$STAGING_DIR"

  local archive_name
  archive_name=$(basename "$ARCHIVE")
  local is_encrypted=true

  # Check if unencrypted (.tar.zst without .age)
  if [[ "$archive_name" == *.tar.zst ]] && [[ "$archive_name" != *.tar.zst.age ]]; then
    is_encrypted=false
    warn "Archive is NOT encrypted. Proceeding without decryption."
    if [ "$FORCE" != true ] && [ -t 0 ]; then
      echo -n "  Continue with unencrypted archive? [y/N]: " >&2
      read -r confirm
      [[ "$confirm" =~ ^[Yy] ]] || die "Aborted" 3
    fi
  fi

  log "Extracting $(du -h "$ARCHIVE" | cut -f1) archive..."

  local attempts=0
  while true; do
    if [ "$is_encrypted" = true ]; then
      # Streaming: age decrypt → zstd decompress → tar extract
      # age uses AGE_PASSPHRASE env var for scrypt-encrypted archives (not -i which is for identity/key files)
      export AGE_PASSPHRASE="$PASSPHRASE"
      if command -v pv &>/dev/null; then
        local archive_size
        archive_size=$(stat_size "$ARCHIVE")
        if age --decrypt "$ARCHIVE" 2>/dev/null | pv -s "$archive_size" -p -e 2>/dev/null | zstd -d 2>/dev/null | tar -xf - -C "$STAGING_DIR" 2>/dev/null; then
          unset AGE_PASSPHRASE
          break
        fi
      else
        if age --decrypt "$ARCHIVE" 2>/dev/null | zstd -d 2>/dev/null | tar -xf - -C "$STAGING_DIR" 2>/dev/null; then
          unset AGE_PASSPHRASE
          break
        fi
      fi
      unset AGE_PASSPHRASE

      attempts=$((attempts + 1))
      if [ $attempts -ge 3 ]; then
        die "Decryption failed after 3 attempts. Check your passphrase." 4
      fi

      # Clear staging for retry
      rm -rf "${STAGING_DIR:?}"/*

      if [ -t 0 ]; then
        warn "Decryption failed. Wrong passphrase?"
        echo -n "  🔐 Try again: " >&2
        read -rs PASSPHRASE
        echo >&2
      else
        die "Decryption failed. Check passphrase." 4
      fi
    else
      # Unencrypted: just decompress + extract
      if zstd -d < "$ARCHIVE" | tar -xf - -C "$STAGING_DIR" 2>/dev/null; then
        break
      fi
      die "Extraction failed. Archive may be corrupted." 4
    fi
  done

  log "Extraction complete ✓"
  debug "Staging directory: $STAGING_DIR"
}

# ── Manifest Validation ────────────────────────────────────────────
validate_manifest() {
  local manifest="$STAGING_DIR/manifest.json"

  if [ ! -f "$manifest" ]; then
    die "No manifest.json in archive — invalid or corrupted backup" 5
  fi

  debug "Manifest found: $manifest"

  # Check version
  local version
  version=$(jq -r '.version // empty' "$manifest" 2>/dev/null)
  if [ -z "$version" ]; then
    warn "No version in manifest (legacy backup). Proceeding."
  else
    debug "Backup version: $version"
    # Compare major version (year)
    local backup_year
    backup_year=$(echo "$version" | cut -d. -f1)
    if [ "$backup_year" != "2026" ] && [ "$backup_year" != "2025" ]; then
      warn "Backup version ($version) may be incompatible with restore $VERSION"
      if [ "$FORCE" != true ] && [ -t 0 ]; then
        echo -n "  Continue anyway? [Y/n]: " >&2
        read -r confirm
        [[ "$confirm" =~ ^[Nn] ]] && die "Aborted by user" 5
      fi
    fi
  fi

  # Log source platform
  local src_os src_arch
  src_os=$(jq -r '.platform.os // "unknown"' "$manifest" 2>/dev/null)
  src_arch=$(jq -r '.platform.arch // "unknown"' "$manifest" 2>/dev/null)
  log "Source: $src_os/$src_arch → Target: $(uname -s)/$(uname -m)"

  # Check created timestamp
  local created
  created=$(jq -r '.created // empty' "$manifest" 2>/dev/null)
  if [ -n "$created" ]; then
    debug "Backup created: $created"
  fi
}

# ── Conflict Detection ────────────────────────────────────────────
check_conflicts() {
  local has_existing=false
  local existing_info=""

  for dir in "$OPENCLAW_DIR" "$MORPHEUS_DIR" "$EVERCLAW_DIR"; do
    if [ -d "$dir" ] && [ "$(ls -A "$dir" 2>/dev/null)" ]; then
      has_existing=true
      local size
      size=$(du -sh "$dir" 2>/dev/null | cut -f1)
      existing_info="$existing_info\n   • $dir ($size)"
    fi
  done

  [ "$has_existing" = false ] && return 0

  if [ "$FORCE" = true ]; then
    if [ "$BACKUP_EXISTING" = true ]; then
      backup_existing
    fi
    return 0
  fi

  # Non-TTY without --force: abort
  if [ ! -t 0 ]; then
    die "Existing installation detected. Use --force to overwrite." 6
  fi

  # Interactive prompt
  echo "" >&2
  echo "  ⚠️  Existing EverClaw installation detected:" >&2
  echo -e "$existing_info" >&2
  echo "" >&2
  echo "   [B]ackup existing + restore  (recommended)" >&2
  echo "   [O]verwrite without backup" >&2
  echo "   [A]bort" >&2
  echo "" >&2
  echo -n "   Choice [B/o/a]: " >&2
  read -r choice

  case "${choice,,}" in
    b|"")
      backup_existing
      ;;
    o)
      warn "Overwriting without backup"
      ;;
    a)
      die "Aborted by user" 6
      ;;
    *)
      die "Invalid choice. Aborting." 6
      ;;
  esac
}

backup_existing() {
  local timestamp
  timestamp=$(date +%Y-%m-%d-%H%M%S)
  log "Backing up existing installation..."

  for dir in "$OPENCLAW_DIR" "$MORPHEUS_DIR" "$EVERCLAW_DIR"; do
    if [ -d "$dir" ]; then
      local backup="${dir}.bak-${timestamp}"
      mv "$dir" "$backup"
      debug "Moved $dir → $backup"
    fi
  done

  log "Backup complete: *.bak-$timestamp"
}

# ── File Restoration ───────────────────────────────────────────────
restore_files_native() {
  log "Restoring files (native mode)..."

  # OpenClaw state + workspace
  if [ -d "$STAGING_DIR/openclaw" ]; then
    cp -R "$STAGING_DIR/openclaw" "$OPENCLAW_DIR"
    chmod 700 "$OPENCLAW_DIR"
    [ -f "$OPENCLAW_JSON" ] && chmod 600 "$OPENCLAW_JSON"
  elif [ -d "$STAGING_DIR/.openclaw" ]; then
    cp -R "$STAGING_DIR/.openclaw" "$OPENCLAW_DIR"
    chmod 700 "$OPENCLAW_DIR"
    [ -f "$OPENCLAW_JSON" ] && chmod 600 "$OPENCLAW_JSON"
  else
    die "No OpenClaw data found in archive" 5
  fi

  # Morpheus data (optional)
  for src in "$STAGING_DIR/morpheus" "$STAGING_DIR/.morpheus"; do
    if [ -d "$src" ]; then
      cp -R "$src" "$MORPHEUS_DIR"
      chmod 700 "$MORPHEUS_DIR"
      break
    fi
  done

  # EverClaw config (optional)
  for src in "$STAGING_DIR/everclaw" "$STAGING_DIR/.everclaw"; do
    if [ -d "$src" ]; then
      cp -R "$src" "$EVERCLAW_DIR"
      chmod 700 "$EVERCLAW_DIR"
      break
    fi
  done

  log "Files restored ✓"
}

restore_files_docker() {
  log "Restoring files (Docker mode)..."

  local restore_dir="./everclaw-restore-$(date +%Y-%m-%d)"
  mkdir -p "$restore_dir"/{openclaw,morpheus,everclaw}

  # Copy state files to subdirectories
  for src in "$STAGING_DIR/openclaw" "$STAGING_DIR/.openclaw"; do
    [ -d "$src" ] && { cp -R "$src/"* "$restore_dir/openclaw/" 2>/dev/null || true; break; }
  done
  for src in "$STAGING_DIR/morpheus" "$STAGING_DIR/.morpheus"; do
    [ -d "$src" ] && { cp -R "$src/"* "$restore_dir/morpheus/" 2>/dev/null || true; break; }
  done
  for src in "$STAGING_DIR/everclaw" "$STAGING_DIR/.everclaw"; do
    [ -d "$src" ] && { cp -R "$src/"* "$restore_dir/everclaw/" 2>/dev/null || true; break; }
  done

  # Generate docker-compose.yml
  cat > "$restore_dir/docker-compose.yml" << 'COMPOSE'
version: '3.8'
services:
  everclaw:
    image: ghcr.io/everclaw/everclaw:latest
    container_name: everclaw
    restart: unless-stopped
    ports:
      - "18789:18789"
      - "18790:18790"
    volumes:
      - ./openclaw:/root/.openclaw
      - ./morpheus:/root/.morpheus
      - ./everclaw:/root/.everclaw
    environment:
      - EVERCLAW_SECURITY_TIER=recommended
COMPOSE

  log "Docker restore directory: $restore_dir"
  log "docker-compose.yml generated ✓"
}

# ── Config Adaptation ─────────────────────────────────────────────
adapt_config() {
  local config_file

  if [ "$DOCKER_MODE" = true ]; then
    config_file="./everclaw-restore-$(date +%Y-%m-%d)/openclaw/openclaw.json"
  else
    config_file="$OPENCLAW_JSON"
  fi

  if [ ! -f "$config_file" ]; then
    warn "No openclaw.json found — skipping config adaptation"
    return 0
  fi

  log "Adapting config for target environment..."

  # Backup original
  cp "$config_file" "${config_file}.pre-adapt"

  local new_token
  new_token=$(openssl rand -hex 32)
  local signal_path
  signal_path=$(which signal-cli 2>/dev/null || echo '')

  if [ "$DOCKER_MODE" = true ]; then
    # Docker: keep bind as 0.0.0.0, keep container paths
    jq \
      --arg newToken "$new_token" \
      '
        .gateway.remote.url = null |
        .gateway.auth.token = $newToken
      ' "$config_file" > "${config_file}.tmp" && mv "${config_file}.tmp" "$config_file"
  else
    # Native: adapt paths and bindings
    jq \
      --arg newToken "$new_token" \
      --arg workspace "$HOME/.openclaw/workspace" \
      --arg signalPath "$signal_path" \
      '
        .gateway.bind = "loopback" |
        .gateway.remote.url = null |
        .gateway.auth.token = $newToken |
        (.agents.defaults.workspace) = $workspace |
        del(.channels.signal.account) |
        (if .channels.signal then .channels.signal.cliPath = $signalPath else . end)
      ' "$config_file" > "${config_file}.tmp" && mv "${config_file}.tmp" "$config_file"
  fi

  chmod 600 "$config_file"
  log "Config adapted ✓ (new auth token generated)"
}

# ── Wallet Restoration ────────────────────────────────────────────
restore_wallet() {
  # Check if wallet data exists in staging
  local wallet_file=""
  for candidate in "$STAGING_DIR/wallet/wallet.enc" "$STAGING_DIR/everclaw/wallet.enc" "$STAGING_DIR/.everclaw/wallet.enc"; do
    if [ -f "$candidate" ]; then
      wallet_file="$candidate"
      break
    fi
  done

  [ -z "$wallet_file" ] && { debug "No wallet data in archive"; return 0; }

  # Non-interactive: skip wallet (safety)
  if [ ! -t 0 ]; then
    log "Wallet found in backup but skipping (non-interactive mode)"
    return 0
  fi

  echo "" >&2
  echo "  🔐 This backup includes an encrypted wallet key." >&2
  echo "     The wallet was encrypted with your backup passphrase." >&2
  echo "" >&2
  echo "     [R]estore wallet" >&2
  echo "     [S]kip wallet" >&2
  echo "" >&2
  echo -n "     Choice [R/s]: " >&2
  read -r choice

  case "${choice,,}" in
    r|"")
      log "Restoring wallet..."
      local os
      os=$(detect_os)

      if [ "$os" = "macos" ]; then
        # macOS: store in Keychain
        local decrypted
        decrypted=$(AGE_PASSPHRASE="$PASSPHRASE" age --decrypt "$wallet_file" 2>/dev/null) || {
          warn "Failed to decrypt wallet. Skipping."
          return 0
        }
        security add-generic-password -a "everclaw-agent" -s "everclaw-wallet-key" \
          -w "$decrypted" -U 2>/dev/null || {
          warn "Failed to add wallet to Keychain. Skipping."
          return 0
        }
        log "Wallet restored to macOS Keychain ✓"
      else
        # Linux: copy encrypted file to ~/.everclaw/
        mkdir -p "$EVERCLAW_DIR"
        cp "$wallet_file" "$EVERCLAW_DIR/wallet.enc"
        chmod 600 "$EVERCLAW_DIR/wallet.enc"
        log "Wallet restored to $EVERCLAW_DIR/wallet.enc ✓"
      fi
      WALLET_RESTORED="yes"
      ;;
    s)
      log "Skipping wallet restoration"
      ;;
    *)
      log "Skipping wallet restoration"
      ;;
  esac
}

# ── Migration Note ────────────────────────────────────────────────
write_migration_note() {
  local memory_dir
  if [ "$DOCKER_MODE" = true ]; then
    memory_dir="./everclaw-restore-$(date +%Y-%m-%d)/openclaw/workspace/memory/daily"
  else
    memory_dir="$OPENCLAW_DIR/workspace/memory/daily"
  fi
  mkdir -p "$memory_dir"

  local migration_date
  migration_date=$(date -u +%Y-%m-%d)
  local manifest="$STAGING_DIR/manifest.json"
  local src_host src_os src_arch archive_date
  src_host=$(jq -r '.sourceHost // .hostname // "unknown host"' "$manifest" 2>/dev/null || echo "unknown host")
  src_os=$(jq -r '.platform.os // "unknown"' "$manifest" 2>/dev/null || echo "unknown")
  src_arch=$(jq -r '.platform.arch // "unknown"' "$manifest" 2>/dev/null || echo "unknown")
  archive_date=$(jq -r '.created // "unknown date"' "$manifest" 2>/dev/null || echo "unknown date")

  cat >> "$memory_dir/$migration_date.md" << EOF

## 📦 Agent Migration

Agent migrated from **$src_host** ($src_os/$src_arch) to this $(uname -s) $(uname -m) machine at $(date -u +%Y-%m-%dT%H:%M:%SZ).

- **Backup created:** $archive_date
- **Archive:** $(basename "$ARCHIVE")
- **Wallet:** $([ "$WALLET_RESTORED" = "yes" ] && echo "included and restored" || echo "excluded")
- **Docker mode:** $DOCKER_MODE

Some services may need reconfiguration:
- Signal: re-link with new phone number
- Gateway URL: update gateway.remote.url if using remote access
- Tailscale: re-authenticate if using Tailscale
EOF

  debug "Migration note written to $memory_dir/$migration_date.md"
}

# ── Service Installation ────────────────────────────────────────────
install_services() {
  [ "$NO_START" = true ] && { debug "Skipping service install (--no-start)"; return 0; }
  [ "$DOCKER_MODE" = true ] && {
    echo "" >&2
    log "🐳 Docker mode: To start your agent:"
    log "   cd everclaw-restore-$(date +%Y-%m-%d)"
    log "   docker compose up -d"
    log ""
    log "   View logs: docker compose logs -f"
    return 0
  }

  # Install OpenClaw if not present
  if ! command -v openclaw &>/dev/null; then
    log "Installing OpenClaw..."
    curl -fsSL https://get.openclaw.ai | bash 2>/dev/null || {
      warn "OpenClaw auto-install failed. Install manually: https://get.openclaw.ai"
      return 0
    }
  fi

  local os
  os=$(detect_os)

  if [ "$os" = "macos" ]; then
    # macOS: launchd
    local plist_dir="$HOME/Library/LaunchAgents"
    local plist_file="$plist_dir/com.openclaw.gateway.plist"
    mkdir -p "$plist_dir"

    local openclaw_path
    openclaw_path=$(which openclaw 2>/dev/null || echo "/opt/homebrew/bin/openclaw")

    mkdir -p "$OPENCLAW_DIR/logs"

    cat > "$plist_file" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.openclaw.gateway</string>
    <key>ProgramArguments</key>
    <array>
        <string>$openclaw_path</string>
        <string>gateway</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$OPENCLAW_DIR/logs/gateway.log</string>
    <key>StandardErrorPath</key>
    <string>$OPENCLAW_DIR/logs/gateway.log</string>
</dict>
</plist>
PLIST

    launchctl load "$plist_file" 2>/dev/null || true
    log "macOS LaunchAgent installed ✓"
  else
    # Linux: systemd (user-level, no sudo)
    local systemd_dir="$HOME/.config/systemd/user"
    mkdir -p "$systemd_dir"

    local openclaw_path
    openclaw_path=$(which openclaw 2>/dev/null || echo "/usr/local/bin/openclaw")

    cat > "$systemd_dir/openclaw-gateway.service" << UNIT
[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
ExecStart=$openclaw_path gateway start
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
UNIT

    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user enable openclaw-gateway 2>/dev/null || true
    systemctl --user start openclaw-gateway 2>/dev/null || true
    log "systemd service installed and started ✓"
  fi

  # Start gateway directly as well
  openclaw gateway start 2>/dev/null || true
  log "Gateway started ✓"
}

# ── Verification ───────────────────────────────────────────────────
run_verification() {
  [ "$NO_VERIFY" = true ] && { debug "Skipping verification (--no-verify)"; return 0; }
  [ "$DOCKER_MODE" = true ] && { debug "Skipping verification (Docker mode)"; return 0; }

  log "Running verification..."
  if command -v openclaw &>/dev/null; then
    if openclaw status &>/dev/null; then
      log "Verification passed ✓"
    else
      warn "Verification had issues (non-fatal). Run 'openclaw status' to check."
    fi
  else
    warn "OpenClaw not found — skipping verification"
  fi
}

# ── Dry Run ──────────────────────────────────────────────────────
do_dry_run() {
  find_archive

  local archive_size
  archive_size=$(du -h "$ARCHIVE" 2>/dev/null | cut -f1)
  local is_encrypted=true
  [[ "$ARCHIVE" != *.age ]] && is_encrypted=false

  local has_existing=false
  for dir in "$OPENCLAW_DIR" "$MORPHEUS_DIR" "$EVERCLAW_DIR"; do
    [ -d "$dir" ] && [ "$(ls -A "$dir" 2>/dev/null)" ] && has_existing=true
  done

  # Check deps
  local deps_installed=() deps_missing=()
  for dep in age zstd tar jq curl node; do
    if command -v "$dep" &>/dev/null; then
      deps_installed+=("$dep")
    else
      deps_missing+=("$dep")
    fi
  done

  if [ "$JSON_OUTPUT" = true ]; then
    # JSON output for agent preview
    cat << ENDJSON
{
  "ok": true,
  "dryRun": true,
  "archive": "$(basename "$ARCHIVE")",
  "sizeMB": "$archive_size",
  "encrypted": $is_encrypted,
  "sourcePlatform": "unknown",
  "targetPlatform": "$(uname -s)/$(uname -m)",
  "mode": "$([ "$DOCKER_MODE" = true ] && echo docker || echo native)",
  "existingInstallation": $has_existing,
  "docker": $DOCKER_MODE,
  "supportsDockerRestore": true,
  "depsInstalled": [$(printf '"%s",' "${deps_installed[@]}" | sed 's/,$//')],
  "depsMissing": [$(printf '"%s",' "${deps_missing[@]}" | sed 's/,$//')],
  "includesWallet": false,
  "migrationNotePath": "~/.openclaw/workspace/memory/daily/$(date -u +%Y-%m-%d).md"
}
ENDJSON
  else
    echo ""
    echo "  📦 Dry Run — What would happen:"
    echo ""
    echo "  Archive: $ARCHIVE"
    echo "  Size: $archive_size"
    echo "  Encrypted: $is_encrypted"
    echo ""
    echo "  Target:"
    echo "    Platform: $(uname -s) $(uname -m)"
    echo "    Mode: $([ "$DOCKER_MODE" = true ] && echo Docker || echo Native)"
    echo "    Location: ~/.openclaw, ~/.morpheus, ~/.everclaw"
    echo ""
    echo "  Existing installation: $has_existing"
    echo ""
    echo "  Dependencies:"
    for dep in "${deps_installed[@]}"; do echo "    ✓ $dep (installed)"; done
    for dep in "${deps_missing[@]}"; do echo "    ✗ $dep (MISSING)"; done
    echo ""
  fi
}

# ── Main ──────────────────────────────────────────────────────────
main() {
  echo ""
  echo "  🚀 EverClaw Agent Restore (v$VERSION)"
  echo ""

  # Dry run (before any real work)
  if [ "$DRY_RUN" = true ]; then
    do_dry_run
    exit 0
  fi

  # Step 1: Dependencies
  check_deps
  check_docker_deps

  # Step 2: Find archive
  find_archive

  # Step 3: Get passphrase
  get_passphrase

  # Step 4: Decrypt & extract
  decrypt_and_extract

  # Step 5: Validate manifest
  validate_manifest

  # Step 6: Check for conflicts
  check_conflicts

  # Step 7: Restore files
  if [ "$DOCKER_MODE" = true ]; then
    restore_files_docker
  else
    restore_files_native
  fi

  # Step 8: Adapt config
  adapt_config

  # Step 9: Wallet
  restore_wallet

  # Step 10: Migration note
  write_migration_note

  # Step 11: Services
  install_services

  # Step 12: Verify
  run_verification

  # Done!
  echo ""
  log "✅ Agent restored successfully!"
  echo ""
  if [ "$DOCKER_MODE" = true ]; then
    log "Next steps:"
    log "  1. cd everclaw-restore-$(date +%Y-%m-%d)"
    log "  2. Review docker-compose.yml"
    log "  3. docker compose up -d"
  else
    log "Next steps:"
    log "  1. Run 'openclaw status' to verify"
    log "  2. Update gateway.remote.url if using remote access"
    log "  3. Re-link Signal if needed"
  fi
  echo ""
}

# ── Entry Point ───────────────────────────────────────────────────
parse_args "$@"
main
