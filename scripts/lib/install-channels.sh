#!/bin/bash
# install-channels.sh — Channel configuration templates
# Sourced by install.sh
#
# Most channels are API-based and don't need software installation,
# just configuration templates.

create_channel_templates() {
  local template_dir="$SCRIPT_DIR/templates"
  
  log_info "Channel setup instructions:"
  echo ""
  echo "  Most channels only need API tokens. Add to ~/.openclaw/openclaw.json:"
  echo ""
}

show_telegram_setup() {
  echo "  ┌─ Telegram ─────────────────────────────────────────────────┐"
  echo "  │ 1. Message @BotFather on Telegram                          │"
  echo "  │ 2. Send /newbot and follow prompts                         │"
  echo "  │ 3. Copy the bot token                                      │"
  echo "  │ 4. Add to openclaw.json:                                   │"
  echo '  │    "channels": { "telegram": { "token": "BOT_TOKEN" } }    │'
  echo "  └────────────────────────────────────────────────────────────┘"
  echo ""
}

show_discord_setup() {
  echo "  ┌─ Discord ──────────────────────────────────────────────────┐"
  echo "  │ 1. Go to https://discord.com/developers/applications       │"
  echo "  │ 2. Create New Application → Bot → Reset Token              │"
  echo "  │ 3. Enable MESSAGE CONTENT INTENT under Bot settings        │"
  echo "  │ 4. Add to openclaw.json:                                   │"
  echo '  │    "channels": { "discord": { "token": "BOT_TOKEN" } }     │'
  echo "  └────────────────────────────────────────────────────────────┘"
  echo ""
}

show_slack_setup() {
  echo "  ┌─ Slack ────────────────────────────────────────────────────┐"
  echo "  │ 1. Go to https://api.slack.com/apps                        │"
  echo "  │ 2. Create New App → From scratch                           │"
  echo "  │ 3. OAuth & Permissions → Bot Token Scopes: chat:write,     │"
  echo "  │    channels:history, groups:history, im:history,           │"
  echo "  │    mpim:history, app_mentions:read                         │"
  echo "  │ 4. Install to Workspace → Copy Bot User OAuth Token        │"
  echo "  │ 5. Add to openclaw.json:                                   │"
  echo '  │    "channels": { "slack": { "botToken": "xoxb-..." } }     │'
  echo "  └────────────────────────────────────────────────────────────┘"
  echo ""
}

show_matrix_setup() {
  echo "  ┌─ Matrix ───────────────────────────────────────────────────┐"
  echo "  │ 1. Create a bot account on your Matrix homeserver          │"
  echo "  │ 2. Get an access token (Settings → Help & About → Access)  │"
  echo "  │ 3. Add to openclaw.json:                                   │"
  echo '  │    "channels": {                                           │'
  echo '  │      "matrix": {                                           │'
  echo '  │        "homeserver": "https://matrix.org",                 │'
  echo '  │        "userId": "@bot:matrix.org",                        │'
  echo '  │        "accessToken": "TOKEN"                              │'
  echo '  │      }                                                     │'
  echo '  │    }                                                       │'
  echo "  └────────────────────────────────────────────────────────────┘"
  echo ""
}

install_telegram() {
  show_telegram_setup
  log_success "Telegram is API-based — no software needed"
  return 0
}

install_discord() {
  show_discord_setup
  log_success "Discord is API-based — no software needed"
  return 0
}

install_slack() {
  show_slack_setup
  log_success "Slack is API-based — no software needed"
  return 0
}

install_matrix() {
  show_matrix_setup
  log_success "Matrix is API-based — no software needed"
  return 0
}

show_all_channel_setup() {
  create_channel_templates
  show_telegram_setup
  show_discord_setup
  show_slack_setup
  show_matrix_setup
  
  echo "  For Signal setup, run: ./install.sh --with signal"
  echo ""
}
