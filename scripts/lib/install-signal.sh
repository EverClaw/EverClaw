#!/bin/bash
# install-signal.sh — signal-cli for Signal messaging
# Sourced by install.sh
#
# Requirements:
#   - signal-cli >= 0.14.3 (SSE fix for OpenClaw)
#   - Java 21+ (signal-cli dependency)

SIGNAL_CLI_MIN_VERSION="0.14.5"

install_signal() {
  # Check if already installed with correct version
  if command -v signal-cli &>/dev/null; then
    local installed_version
    installed_version=$(signal-cli --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    
    if version_gte "$installed_version" "$SIGNAL_CLI_MIN_VERSION"; then
      log_success "signal-cli $installed_version installed (>= $SIGNAL_CLI_MIN_VERSION)"
      return 0
    else
      log_warn "signal-cli $installed_version is below minimum $SIGNAL_CLI_MIN_VERSION"
      log_info "Upgrading signal-cli..."
    fi
  fi
  
  # Install Java first
  install_java || {
    log_warn "Java installation failed, signal-cli requires Java 21+"
    return 1
  }
  
  log_info "Installing signal-cli..."
  
  if [[ "$PLATFORM" == "darwin" ]]; then
    ensure_homebrew || return 1
    brew install signal-cli 2>/dev/null || brew upgrade signal-cli 2>/dev/null || {
      log_warn "Failed to install signal-cli via brew"
      return 1
    }
  else
    # Linux — manual installation
    install_signal_linux
  fi
  
  if command -v signal-cli &>/dev/null; then
    local final_version
    final_version=$(signal-cli --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    log_success "signal-cli $final_version installed"
    return 0
  else
    log_warn "signal-cli installation failed"
    return 1
  fi
}

install_java() {
  # Check if Java 21+ is available
  if command -v java &>/dev/null; then
    local java_version
    java_version=$(java -version 2>&1 | grep -oE '"[0-9]+' | head -1 | tr -d '"')
    
    if [[ "$java_version" -ge 21 ]]; then
      log_success "Java $java_version installed"
      return 0
    fi
  fi
  
  log_info "Installing Java 21..."
  
  if [[ "$PLATFORM" == "darwin" ]]; then
    ensure_homebrew || return 1
    brew install openjdk@21 2>/dev/null || {
      log_warn "Failed to install Java via brew"
      return 1
    }
    # Create symlink for system Java
    sudo ln -sfn /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk /Library/Java/JavaVirtualMachines/openjdk-21.jdk 2>/dev/null || true
  else
    if command -v apt-get &>/dev/null; then
      sudo apt-get update -qq 2>/dev/null
      sudo apt-get install -y openjdk-21-jre-headless 2>/dev/null
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y java-21-openjdk-headless 2>/dev/null
    elif command -v pacman &>/dev/null; then
      sudo pacman -S --noconfirm jre21-openjdk-headless 2>/dev/null
    else
      log_warn "Install Java 21+ manually"
      return 1
    fi
  fi
  
  return 0
}

install_signal_linux() {
  local latest_version
  
  # Use jq for safe JSON parsing (jq is in core deps)
  if command -v jq &>/dev/null; then
    latest_version=$(curl -sL -H "Accept: application/vnd.github.v3+json" \
      "https://api.github.com/repos/AsamK/signal-cli/releases/latest" | \
      jq -r '.tag_name // empty' | sed 's/^v//')
  else
    # Fallback to grep/sed (less safe)
    latest_version=$(curl -sL "https://api.github.com/repos/AsamK/signal-cli/releases/latest" | \
      grep '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')
  fi
  
  if [[ -z "$latest_version" ]]; then
    log_warn "Could not determine latest signal-cli version"
    latest_version="0.14.5"  # Fallback
  fi
  
  local download_url="https://github.com/AsamK/signal-cli/releases/download/v${latest_version}/signal-cli-${latest_version}.tar.gz"
  local install_dir="/opt/signal-cli"
  
  log_info "Downloading signal-cli $latest_version..."
  
  local tmpdir
  tmpdir=$(mktemp -d)
  trap 'rm -rf "$tmpdir"' EXIT
  
  if ! curl -sL -o "$tmpdir/signal-cli.tar.gz" "$download_url"; then
    log_warn "Failed to download signal-cli"
    return 1
  fi
  
  # Verify download is a valid gzip file
  if ! file "$tmpdir/signal-cli.tar.gz" | grep -qi 'gzip'; then
    log_warn "Downloaded file is not a valid gzip archive"
    return 1
  fi
  
  # Extract
  if ! tar -xzf "$tmpdir/signal-cli.tar.gz" -C "$tmpdir"; then
    log_warn "Failed to extract signal-cli archive"
    return 1
  fi
  
  # Install
  sudo rm -rf "$install_dir"
  sudo mv "$tmpdir/signal-cli-$latest_version" "$install_dir"
  sudo ln -sf "$install_dir/bin/signal-cli" /usr/local/bin/signal-cli
  
  trap - EXIT
  rm -rf "$tmpdir"
  return 0
}

# Version comparison: returns 0 if $1 >= $2
version_gte() {
  local v1="$1"
  local v2="$2"
  
  # Split into arrays
  IFS='.' read -ra V1 <<< "$v1"
  IFS='.' read -ra V2 <<< "$v2"
  
  for i in 0 1 2; do
    local n1="${V1[$i]:-0}"
    local n2="${V2[$i]:-0}"
    
    if [[ "$n1" -gt "$n2" ]]; then
      return 0
    elif [[ "$n1" -lt "$n2" ]]; then
      return 1
    fi
  done
  
  return 0  # Equal
}

create_signal_config_template() {
  local config_dir="$HOME/.openclaw"
  
  if [[ ! -d "$config_dir" ]]; then
    mkdir -p "$config_dir"
  fi
  
  # Don't overwrite existing config
  if [[ -f "$config_dir/openclaw.json" ]] && grep -q '"signal"' "$config_dir/openclaw.json" 2>/dev/null; then
    log_info "Signal config already exists in openclaw.json"
    return 0
  fi
  
  log_info "Signal setup instructions:"
  echo ""
  echo "  1. Register your phone number with signal-cli:"
  echo "     signal-cli -a +1XXXXXXXXXX register"
  echo ""
  echo "  2. Verify with the SMS code:"
  echo "     signal-cli -a +1XXXXXXXXXX verify CODE"
  echo ""
  echo "  3. Add to ~/.openclaw/openclaw.json:"
  echo '     "channels": {'
  echo '       "signal": {'
  echo '         "phone": "+1XXXXXXXXXX"'
  echo '       }'
  echo '     }'
  echo ""
}
