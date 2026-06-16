#!/bin/bash
# install-ollama.sh — Ollama local inference engine
# Sourced by install.sh

install_ollama() {
  if command -v ollama &>/dev/null; then
    log_success "Ollama already installed ($(ollama --version 2>/dev/null | head -1))"
    return 0
  fi
  
  log_info "Installing Ollama..."
  
  if [[ "$PLATFORM" == "darwin" ]]; then
    ensure_homebrew || return 1
    brew install ollama 2>/dev/null || {
      log_warn "Failed to install Ollama via brew"
      return 1
    }
  else
    # Linux — use official installer
    curl -fsSL https://ollama.com/install.sh | sh || {
      log_warn "Failed to install Ollama"
      return 1
    }
  fi
  
  if command -v ollama &>/dev/null; then
    log_success "Ollama installed"
    
    # Start Ollama service if not running
    if ! pgrep -x ollama &>/dev/null; then
      log_info "Starting Ollama service..."
      if [[ "$PLATFORM" == "darwin" ]]; then
        brew services start ollama 2>/dev/null || ollama serve &>/dev/null &
      else
        systemctl --user start ollama 2>/dev/null || ollama serve &>/dev/null &
      fi
      sleep 2
    fi
    
    return 0
  else
    log_warn "Ollama installation failed"
    return 1
  fi
}

install_ollama_model() {
  local model="$1"
  local model_size="$2"
  
  if ! command -v ollama &>/dev/null; then
    log_warn "Ollama not installed, skipping model download"
    return 1
  fi
  
  # Check if model already exists
  if ollama list 2>/dev/null | grep -q "^${model}"; then
    log_success "Model $model already downloaded"
    return 0
  fi
  
  log_info "Downloading $model (~${model_size})..."
  log_info "This may take several minutes depending on your connection."
  
  if ollama pull "$model" 2>&1; then
    log_success "Model $model downloaded"
    return 0
  else
    log_warn "Failed to download model $model"
    return 1
  fi
}

install_ollama_small() {
  install_ollama || return 1
  install_ollama_model "gemma4:12b" "8GB"
}

install_ollama_large() {
  install_ollama || return 1
  install_ollama_model "gemma4:26b" "17GB"
}
