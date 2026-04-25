#!/usr/bin/env bash
# version-stamp.sh — Generate or apply CalVer version: vYYYY.M.DD.HHMM (UTC)
#
# Usage:
#   ./version-stamp.sh              # Print git tag format:    v2026.3.20.1935
#   ./version-stamp.sh --pkg        # Print package.json format: 2026.3.20.1935
#   ./version-stamp.sh --apply      # Update package.json, SKILL.md, Dockerfile, docker-compose.yml
#   ./version-stamp.sh --dry-run    # Show what --apply would change without writing
#
# All times are UTC. Leading zeros in HHMM are preserved for git tags (strings)
# but may drop in package.json when parsed as integers (e.g., 0800 → 800).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Determine correct package.json location. In monorepo the root package.json
# lives two directories above packages/core/. In composed flavor repos both
# live in the same directory.
PKG_JSON="$REPO_DIR/package.json"
if [ ! -f "$PKG_JSON" ] && [ -f "$REPO_DIR/SKILL.md" ]; then
  CANDIDATE="$(cd "$REPO_DIR/../.." && pwd)/package.json"
  if [ -f "$CANDIDATE" ]; then
    PKG_JSON="$CANDIDATE"
  fi
fi
if [ ! -f "$PKG_JSON" ]; then
  echo "ERROR: package.json not found (tried $PKG_JSON)" >&2
  exit 1
fi

# Generate version components from current UTC time
YEAR=$(date -u +%Y)
MONTH=$(date -u +%-m)       # no leading zero
DAY=$(date -u +%-d)         # no leading zero
HHMM=$(date -u +%H%M)      # 4 digits, leading zero preserved

# Full version strings
TAG_VERSION="v${YEAR}.${MONTH}.${DAY}.${HHMM}"
PKG_VERSION="${YEAR}.${MONTH}.${DAY}.${HHMM}"

# Parse args
ACTION="print-tag"
for arg in "$@"; do
  case "$arg" in
    --pkg)     ACTION="print-pkg" ;;
    --apply)   ACTION="apply" ;;
    --dry-run) ACTION="dry-run" ;;
    --help|-h)
      echo "Usage: $0 [--pkg] [--apply] [--dry-run]"
      echo ""
      echo "  (no args)   Print git tag version:     ${TAG_VERSION}"
      echo "  --pkg       Print package.json version: ${PKG_VERSION}"
      echo "  --apply     Update version in package.json, SKILL.md, Dockerfile, docker-compose.yml"
      echo "  --dry-run   Show what --apply would change"
      exit 0
      ;;
  esac
done

case "$ACTION" in
  print-tag)
    echo "$TAG_VERSION"
    ;;
  print-pkg)
    echo "$PKG_VERSION"
    ;;
  dry-run|apply)
    cd "$REPO_DIR"
    FILES_UPDATED=0

    # 1. package.json — update "version" field
    # PKG_JSON resolved at script start (handles both monorepo and composed repos)
    if [ -f "$PKG_JSON" ]; then
      OLD_VER=$(grep -o '"version": *"[^"]*"' "$PKG_JSON" | head -1 | grep -o '"[^"]*"$' | tr -d '"')
      if [ "$ACTION" = "dry-run" ]; then
        echo "package.json: \"$OLD_VER\" → \"$PKG_VERSION\""
      else
        # Use sed to replace the version value (first match only)
        if [[ "$OSTYPE" == "darwin"* ]]; then
          sed -i '' "s/\"version\": *\"${OLD_VER}\"/\"version\": \"${PKG_VERSION}\"/" "$PKG_JSON"
        else
          sed -i "s/\"version\": *\"${OLD_VER}\"/\"version\": \"${PKG_VERSION}\"/" "$PKG_JSON"
        fi
        echo "✅ package.json: $OLD_VER → $PKG_VERSION"
        FILES_UPDATED=$((FILES_UPDATED + 1))
      fi
    else
      echo "⚠️  package.json not found"
    fi

    # 2. SKILL.md — update top-level "version:" line (with or without v prefix)
    #    Matches: "version: 2026.3.23" or "version: v2026.3.23" or "version: v2026.3.20.1935"
    if [ -f "SKILL.md" ]; then
      # Extract the first "version: <ver>" line at the top level (YAML front matter style)
      OLD_SKILL_LINE=$(grep -m1 '^version:' SKILL.md || echo "")
      OLD_SKILL_VER=$(echo "$OLD_SKILL_LINE" | grep -o '[0-9]\{4\}\.[0-9]*\.[0-9]*\(\.[0-9]*\)\?' || echo "")
      if [ -n "$OLD_SKILL_VER" ]; then
        # Preserve whether the original had a v prefix or not
        if echo "$OLD_SKILL_LINE" | grep -q 'v[0-9]'; then
          NEW_SKILL_VER="${TAG_VERSION}"  # keep v prefix
        else
          NEW_SKILL_VER="${PKG_VERSION}"  # no v prefix
        fi
        if [ "$ACTION" = "dry-run" ]; then
          echo "SKILL.md: \"$OLD_SKILL_VER\" → \"$NEW_SKILL_VER\""
        else
          if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "0,/${OLD_SKILL_VER}/s|${OLD_SKILL_VER}|${NEW_SKILL_VER}|" SKILL.md
          else
            sed -i "0,/${OLD_SKILL_VER}/s|${OLD_SKILL_VER}|${NEW_SKILL_VER}|" SKILL.md
          fi
          echo "✅ SKILL.md: $OLD_SKILL_VER → $NEW_SKILL_VER"
          FILES_UPDATED=$((FILES_UPDATED + 1))
        fi
      else
        echo "⚠️  SKILL.md: no version string found to replace"
      fi
    else
      echo "⚠️  SKILL.md not found"
    fi

    # 3. Dockerfile — update EVERCLAW_VERSION ARG
    if [ -f "Dockerfile" ]; then
      OLD_DOCKER_VER=$(grep -o 'EVERCLAW_VERSION=[^ ]*' Dockerfile | head -1 | cut -d= -f2 || echo "")
      if [ -n "$OLD_DOCKER_VER" ]; then
        if [ "$ACTION" = "dry-run" ]; then
          echo "Dockerfile: EVERCLAW_VERSION=\"$OLD_DOCKER_VER\" → \"$PKG_VERSION\""
        else
          if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s|EVERCLAW_VERSION=${OLD_DOCKER_VER}|EVERCLAW_VERSION=${PKG_VERSION}|g" Dockerfile
          else
            sed -i "s|EVERCLAW_VERSION=${OLD_DOCKER_VER}|EVERCLAW_VERSION=${PKG_VERSION}|g" Dockerfile
          fi
          echo "✅ Dockerfile: EVERCLAW_VERSION $OLD_DOCKER_VER → $PKG_VERSION"
          FILES_UPDATED=$((FILES_UPDATED + 1))
        fi
      else
        echo "⚠️  Dockerfile: no EVERCLAW_VERSION found"
      fi
    else
      echo "⚠️  Dockerfile not found"
    fi

    # 4. docker-compose.yml — update image tag
    if [ -f "docker-compose.yml" ]; then
      OLD_COMPOSE_VER=$(grep -o 'everclaw/everclaw:[^ ]*' docker-compose.yml | head -1 | cut -d: -f2 || echo "")
      if [ -n "$OLD_COMPOSE_VER" ]; then
        if [ "$ACTION" = "dry-run" ]; then
          echo "docker-compose.yml: image tag \"$OLD_COMPOSE_VER\" → \"$PKG_VERSION\""
        else
          if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s|everclaw/everclaw:${OLD_COMPOSE_VER}|everclaw/everclaw:${PKG_VERSION}|g" docker-compose.yml
          else
            sed -i "s|everclaw/everclaw:${OLD_COMPOSE_VER}|everclaw/everclaw:${PKG_VERSION}|g" docker-compose.yml
          fi
          echo "✅ docker-compose.yml: image tag $OLD_COMPOSE_VER → $PKG_VERSION"
          FILES_UPDATED=$((FILES_UPDATED + 1))
        fi
      else
        echo "⚠️  docker-compose.yml: no everclaw image tag found"
      fi
    else
      echo "⚠️  docker-compose.yml not found"
    fi

    if [ "$ACTION" = "apply" ]; then
      echo ""
      echo "📦 Version: $TAG_VERSION"
      echo "📝 Files updated: $FILES_UPDATED"
      echo ""
      echo "Next steps:"
      echo "  git add -A && git commit -m \"release: $TAG_VERSION\""
      echo "  git tag -a $TAG_VERSION -m \"Release $TAG_VERSION\""
      echo "  git push origin main --tags"
    fi
    ;;
esac
