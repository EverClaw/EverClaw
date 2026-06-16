#!/bin/bash
# install-media.sh — Media processing tools (ffmpeg, whisper)
# Sourced by install.sh

install_ffmpeg() {
  if command -v ffmpeg &>/dev/null; then
    log_success "ffmpeg already installed"
    return 0
  fi
  
  log_info "Installing ffmpeg..."
  
  if [[ "$PLATFORM" == "darwin" ]]; then
    ensure_homebrew || return 1
    brew install ffmpeg 2>/dev/null || {
      log_warn "Failed to install ffmpeg via brew"
      return 1
    }
  else
    if command -v apt-get &>/dev/null; then
      sudo apt-get update -qq 2>/dev/null
      sudo apt-get install -y ffmpeg 2>/dev/null
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y ffmpeg 2>/dev/null
    elif command -v pacman &>/dev/null; then
      sudo pacman -S --noconfirm ffmpeg 2>/dev/null
    else
      log_warn "Install ffmpeg manually"
      return 1
    fi
  fi
  
  if command -v ffmpeg &>/dev/null; then
    log_success "ffmpeg installed"
    return 0
  else
    log_warn "ffmpeg installation failed"
    return 1
  fi
}

install_whisper() {
  # Check for openai-whisper or mlx-whisper
  if command -v whisper &>/dev/null || command -v mlx_whisper &>/dev/null; then
    log_success "Whisper already installed"
    return 0
  fi
  
  log_info "Installing Whisper speech-to-text..."
  
  if [[ "$PLATFORM" == "darwin" ]]; then
    # Prefer mlx-whisper on Apple Silicon for Metal acceleration
    local arch
    arch=$(uname -m)
    
    if [[ "$arch" == "arm64" ]]; then
      log_info "Installing mlx-whisper (optimized for Apple Silicon)..."
      pip3 install --user mlx-whisper 2>/dev/null || {
        log_info "mlx-whisper failed, trying openai-whisper..."
        brew install openai-whisper 2>/dev/null || pip3 install --user openai-whisper 2>/dev/null
      }
    else
      ensure_homebrew || return 1
      brew install openai-whisper 2>/dev/null || pip3 install --user openai-whisper 2>/dev/null
    fi
  else
    # Linux — pip install
    pip3 install --user openai-whisper 2>/dev/null || {
      log_warn "Failed to install whisper. Ensure pip3 is available."
      return 1
    }
  fi
  
  if command -v whisper &>/dev/null || command -v mlx_whisper &>/dev/null; then
    log_success "Whisper installed"
    
    # Download base model
    log_info "Downloading Whisper 'turbo' model (~800MB)..."
    if command -v mlx_whisper &>/dev/null; then
      mlx_whisper --model turbo /dev/null 2>/dev/null || true
    elif command -v whisper &>/dev/null; then
      whisper --model turbo /dev/null 2>/dev/null || true
    fi
    
    return 0
  else
    log_warn "Whisper installation failed"
    return 1
  fi
}

install_ytdlp() {
  if command -v yt-dlp &>/dev/null; then
    log_success "yt-dlp already installed"
    return 0
  fi
  
  log_info "Installing yt-dlp..."
  
  if [[ "$PLATFORM" == "darwin" ]]; then
    ensure_homebrew || return 1
    brew install yt-dlp 2>/dev/null
  else
    pip3 install --user yt-dlp 2>/dev/null || {
      if command -v apt-get &>/dev/null; then
        sudo apt-get install -y yt-dlp 2>/dev/null
      fi
    }
  fi
  
  if command -v yt-dlp &>/dev/null; then
    log_success "yt-dlp installed"
    return 0
  else
    log_warn "yt-dlp installation failed"
    return 1
  fi
}
