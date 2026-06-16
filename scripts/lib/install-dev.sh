#!/bin/bash
# install-dev.sh — Developer tools (GitHub CLI, etc.)
# Sourced by install.sh

install_gh() {
  if command -v gh &>/dev/null; then
    log_success "GitHub CLI already installed ($(gh --version | head -1))"
    return 0
  fi
  
  log_info "Installing GitHub CLI..."
  
  if [[ "$PLATFORM" == "darwin" ]]; then
    ensure_homebrew || return 1
    brew install gh 2>/dev/null || {
      log_warn "Failed to install gh via brew"
      return 1
    }
  else
    # Linux — use official package repo
    if command -v apt-get &>/dev/null; then
      # Debian/Ubuntu
      curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
        sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
        sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
      sudo apt-get update -qq 2>/dev/null
      sudo apt-get install -y gh 2>/dev/null
    elif command -v dnf &>/dev/null; then
      # Fedora
      sudo dnf install -y 'dnf-command(config-manager)' 2>/dev/null
      sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo 2>/dev/null
      sudo dnf install -y gh 2>/dev/null
    elif command -v pacman &>/dev/null; then
      # Arch
      sudo pacman -S --noconfirm github-cli 2>/dev/null
    else
      log_warn "Install GitHub CLI manually: https://cli.github.com"
      return 1
    fi
  fi
  
  if command -v gh &>/dev/null; then
    log_success "GitHub CLI installed"
    echo ""
    echo "  To authenticate, run: gh auth login"
    echo ""
    return 0
  else
    log_warn "GitHub CLI installation failed"
    return 1
  fi
}
