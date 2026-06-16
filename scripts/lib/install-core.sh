#!/bin/bash
# install-core.sh — Core dependencies (Node.js, jq, git, curl)
# Sourced by install.sh

install_core_deps() {
  local missing=()
  
  command -v curl &>/dev/null || missing+=("curl")
  command -v git &>/dev/null  || missing+=("git")
  command -v jq &>/dev/null   || missing+=("jq")
  
  if [[ ${#missing[@]} -eq 0 ]]; then
    log_success "Core dependencies present (curl, git, jq)"
    return 0
  fi
  
  log_info "Installing missing core dependencies: ${missing[*]}..."
  
  if [[ "$PLATFORM" == "darwin" ]]; then
    ensure_homebrew || return 1
    for pkg in "${missing[@]}"; do
      brew install "$pkg" 2>/dev/null || log_warn "Failed to install $pkg via brew"
    done
  else
    install_linux_packages "${missing[@]}"
  fi
  
  # Verify
  local still_missing=()
  command -v curl &>/dev/null || still_missing+=("curl")
  command -v git &>/dev/null  || still_missing+=("git")
  command -v jq &>/dev/null   || still_missing+=("jq")
  
  if [[ ${#still_missing[@]} -gt 0 ]]; then
    log_warn "Could not install: ${still_missing[*]}"
    return 1
  fi
  
  log_success "Core dependencies installed"
  return 0
}

install_nodejs() {
  if command -v node &>/dev/null; then
    local node_version
    node_version=$(node --version 2>/dev/null | sed 's/v//')
    local major_version
    major_version=$(echo "$node_version" | cut -d. -f1)
    
    if [[ "$major_version" -ge 20 ]] && [[ "$major_version" -le 24 ]]; then
      log_success "Node.js $node_version installed (supported)"
      return 0
    elif [[ "$major_version" -ge 25 ]]; then
      log_warn "Node.js $node_version detected — v25+ has SSE bugs on macOS"
      log_warn "Signal receiving may not work. Consider using v24 LTS."
      return 0
    fi
  fi
  
  log_info "Installing Node.js 24.x LTS (Krypton)..."
  
  if [[ "$PLATFORM" == "darwin" ]]; then
    ensure_homebrew || return 1
    brew install node@24 2>/dev/null || {
      log_warn "Failed to install Node.js via brew"
      return 1
    }
    # Link if not already
    brew link --overwrite node@24 2>/dev/null || true
  else
    # Linux — try NodeSource
    if command -v apt-get &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - 2>/dev/null
      sudo apt-get install -y nodejs 2>/dev/null
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y nodejs 2>/dev/null
    elif command -v pacman &>/dev/null; then
      sudo pacman -S --noconfirm nodejs npm 2>/dev/null
    else
      log_warn "No supported package manager. Install Node.js 22.x manually."
      return 1
    fi
  fi
  
  if command -v node &>/dev/null; then
    log_success "Node.js $(node --version) installed"
    return 0
  else
    log_warn "Node.js installation failed"
    return 1
  fi
}

ensure_homebrew() {
  if command -v brew &>/dev/null; then
    return 0
  fi
  
  log_info "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || {
    log_error "Homebrew installation failed"
    return 1
  }
  
  # Add to PATH for this session
  eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || \
    eval "$(/usr/local/bin/brew shellenv)" 2>/dev/null || true
  
  return 0
}

install_linux_packages() {
  local packages=("$@")
  
  if command -v apt-get &>/dev/null; then
    sudo apt-get update -qq 2>/dev/null
    for pkg in "${packages[@]}"; do
      sudo apt-get install -y "$pkg" 2>/dev/null || log_warn "Failed to install $pkg via apt"
    done
  elif command -v dnf &>/dev/null; then
    for pkg in "${packages[@]}"; do
      sudo dnf install -y "$pkg" 2>/dev/null || log_warn "Failed to install $pkg via dnf"
    done
  elif command -v pacman &>/dev/null; then
    for pkg in "${packages[@]}"; do
      sudo pacman -S --noconfirm "$pkg" 2>/dev/null || log_warn "Failed to install $pkg via pacman"
    done
  elif command -v apk &>/dev/null; then
    for pkg in "${packages[@]}"; do
      sudo apk add "$pkg" 2>/dev/null || log_warn "Failed to install $pkg via apk"
    done
  else
    log_warn "No supported package manager found. Install manually: ${packages[*]}"
    return 1
  fi
  
  return 0
}
