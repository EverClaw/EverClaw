#!/bin/bash
# install-browser.sh — Brave browser for web automation
# Sourced by install.sh

install_brave() {
  # Check if Brave is already installed
  if [[ "$PLATFORM" == "darwin" ]]; then
    if [[ -d "/Applications/Brave Browser.app" ]]; then
      log_success "Brave Browser already installed"
      return 0
    fi
  else
    if command -v brave-browser &>/dev/null || command -v brave &>/dev/null; then
      log_success "Brave Browser already installed"
      return 0
    fi
  fi
  
  log_info "Installing Brave Browser..."
  
  if [[ "$PLATFORM" == "darwin" ]]; then
    ensure_homebrew || return 1
    brew install --cask brave-browser 2>/dev/null || {
      log_warn "Failed to install Brave via brew cask"
      log_info "Download manually from: https://brave.com/download/"
      return 1
    }
  else
    # Linux — add Brave repository
    if command -v apt-get &>/dev/null; then
      # Debian/Ubuntu
      sudo curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg \
        https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg 2>/dev/null
      echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg] https://brave-browser-apt-release.s3.brave.com/ stable main" | \
        sudo tee /etc/apt/sources.list.d/brave-browser-release.list >/dev/null
      sudo apt-get update -qq 2>/dev/null
      sudo apt-get install -y brave-browser 2>/dev/null
    elif command -v dnf &>/dev/null; then
      # Fedora
      sudo dnf install -y dnf-plugins-core 2>/dev/null
      sudo dnf config-manager --add-repo https://brave-browser-rpm-release.s3.brave.com/brave-browser.repo 2>/dev/null
      sudo rpm --import https://brave-browser-rpm-release.s3.brave.com/brave-core.asc 2>/dev/null
      sudo dnf install -y brave-browser 2>/dev/null
    elif command -v pacman &>/dev/null; then
      # Arch — AUR
      if command -v yay &>/dev/null; then
        yay -S --noconfirm brave-bin 2>/dev/null
      elif command -v paru &>/dev/null; then
        paru -S --noconfirm brave-bin 2>/dev/null
      else
        log_warn "Install brave-bin from AUR manually"
        return 1
      fi
    else
      log_warn "Download Brave manually from: https://brave.com/download/"
      return 1
    fi
  fi
  
  # Verify installation
  if [[ "$PLATFORM" == "darwin" ]]; then
    if [[ -d "/Applications/Brave Browser.app" ]]; then
      log_success "Brave Browser installed"
      return 0
    fi
  else
    if command -v brave-browser &>/dev/null || command -v brave &>/dev/null; then
      log_success "Brave Browser installed"
      return 0
    fi
  fi
  
  log_warn "Brave Browser installation could not be verified"
  return 1
}

install_playwright() {
  # For headless/Docker environments
  if command -v playwright &>/dev/null; then
    log_success "Playwright already installed"
    return 0
  fi
  
  log_info "Installing Playwright (headless browser automation)..."
  
  npm install -g playwright 2>/dev/null || {
    log_warn "Failed to install Playwright globally"
    return 1
  }
  
  # Install browser binaries
  npx playwright install chromium 2>/dev/null || {
    log_warn "Failed to install Playwright Chromium"
    return 1
  }
  
  log_success "Playwright installed with Chromium"
  return 0
}
