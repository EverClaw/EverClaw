#!/usr/bin/env bash
# flavor-compose.sh — Compose a deployable flavor repo from core + flavor overlay
#
# Usage:
#   ./scripts/flavor-compose.sh <flavor-dir> <output-dir>
#
# Example:
#   ./scripts/flavor-compose.sh flavors/bitcoinclaw.ai /tmp/composed/bitcoinclaw.ai
#
# What it does:
#   1. Copies packages/core/* into output-dir (common infrastructure)
#   2. Overlays flavor-specific files on top (README.md, flavor.json, templates/)
#   3. Result is a standalone repo ready to push to the flavor's remote
#
# NOTE: Flavor repos are GENERATED artifacts from the monorepo.
#       PRs and issues should target the monorepo, not individual flavor repos.
#
# Exit codes:
#   0 — Success
#   1 — Missing arguments or directories

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  echo "Usage: $0 <flavor-dir> <output-dir>"
  echo ""
  echo "  flavor-dir   Path to a flavor directory (e.g., flavors/bitcoinclaw.ai)"
  echo "  output-dir   Path where the composed repo will be written"
  exit 1
}

[ $# -lt 2 ] && usage

FLAVOR_DIR="$1"
OUTPUT_DIR="$2"

# Validate
if [ ! -d "$REPO_ROOT/$FLAVOR_DIR" ] && [ ! -d "$FLAVOR_DIR" ]; then
  echo "Error: Flavor directory not found: $FLAVOR_DIR"
  exit 1
fi

# Resolve relative paths
if [ -d "$REPO_ROOT/$FLAVOR_DIR" ]; then
  FLAVOR_DIR="$REPO_ROOT/$FLAVOR_DIR"
fi

if [ ! -f "$FLAVOR_DIR/flavor.json" ]; then
  echo "Error: No flavor.json found in $FLAVOR_DIR"
  exit 1
fi

# Check for jq
if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not installed. Install with: brew install jq"
  exit 1
fi

CORE_DIR="$REPO_ROOT/packages/core"
if [ ! -d "$CORE_DIR" ]; then
  echo "Error: packages/core/ not found at $CORE_DIR"
  exit 1
fi

# Read flavor metadata using jq
FLAVOR_NAME=$(jq -r '.name' "$FLAVOR_DIR/flavor.json")
FLAVOR_DOMAIN=$(jq -r '.domain' "$FLAVOR_DIR/flavor.json")

echo "Composing flavor: $FLAVOR_NAME ($FLAVOR_DOMAIN)"
echo "  Core:   $CORE_DIR"
echo "  Flavor: $FLAVOR_DIR"
echo "  Output: $OUTPUT_DIR"

# Clean and create output
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# Step 1: Copy entire core infrastructure via rsync
# This ensures new files added to packages/core/ are automatically included.
echo "  → Copying core infrastructure (rsync)..."
rsync -a \
  --exclude='.git' \
  --exclude='.DS_Store' \
  --exclude='node_modules' \
  --exclude='*.tgz' \
  "$CORE_DIR/" "$OUTPUT_DIR/"

# Step 2: Copy root-level files (LICENSE, CHANGELOG, config files)
echo "  → Copying root-level files..."
for item in LICENSE CHANGELOG.md .gitignore .clawhubignore .dockerignore .gitleaks.toml; do
  if [ -e "$REPO_ROOT/$item" ]; then
    cp -a "$REPO_ROOT/$item" "$OUTPUT_DIR/$item"
  fi
done

# Copy root package.json and lockfile (these are the canonical versions)
if [ -f "$REPO_ROOT/package.json" ]; then
  cp "$REPO_ROOT/package.json" "$OUTPUT_DIR/package.json"
fi
if [ -f "$REPO_ROOT/package-lock.json" ]; then
  cp "$REPO_ROOT/package-lock.json" "$OUTPUT_DIR/package-lock.json"
fi

# Copy .github workflows
if [ -d "$REPO_ROOT/.github" ]; then
  cp -a "$REPO_ROOT/.github" "$OUTPUT_DIR/.github"
fi

# Copy .clawhub
if [ -d "$REPO_ROOT/.clawhub" ]; then
  cp -a "$REPO_ROOT/.clawhub" "$OUTPUT_DIR/.clawhub"
fi

# Step 3: Copy bundled skills
if [ -d "$REPO_ROOT/skills" ]; then
  echo "  → Copying bundled skills..."
  mkdir -p "$OUTPUT_DIR/skills"
  for skill_dir in "$REPO_ROOT/skills"/*/; do
    [ ! -d "$skill_dir" ] && continue
    skill_name=$(basename "$skill_dir")
    if [ -f "$skill_dir/SKILL.md" ] || [ -f "$skill_dir/README.md" ]; then
      cp -a "$skill_dir" "$OUTPUT_DIR/skills/$skill_name"
    fi
  done
fi

# Step 4: Overlay flavor-specific files (these OVERRIDE core files)
echo "  → Overlaying flavor files..."
cp "$FLAVOR_DIR/README.md" "$OUTPUT_DIR/README.md"
cp "$FLAVOR_DIR/flavor.json" "$OUTPUT_DIR/flavor.json"

# Copy flavor-specific SKILL.md if present (overrides core SKILL.md)
if [ -f "$FLAVOR_DIR/SKILL.md" ]; then
  cp "$FLAVOR_DIR/SKILL.md" "$OUTPUT_DIR/SKILL.md"
fi

# Copy flavor-specific scripts (merged into scripts/, e.g. buddy-*.mjs)
if [ -d "$FLAVOR_DIR/scripts" ]; then
  echo "  → Merging flavor-specific scripts..."
  mkdir -p "$OUTPUT_DIR/scripts"
  cp -a "$FLAVOR_DIR/scripts"/* "$OUTPUT_DIR/scripts/"
fi

# Copy flavor-specific root files (e.g. buddy-bots-install.sh)
for extra in "$FLAVOR_DIR"/*.sh; do
  [ -f "$extra" ] && cp "$extra" "$OUTPUT_DIR/$(basename "$extra")"
done

# Copy flavor templates into templates/active-flavor/
if [ -d "$FLAVOR_DIR/templates" ]; then
  mkdir -p "$OUTPUT_DIR/templates/active-flavor"
  if ls "$FLAVOR_DIR/templates"/* &>/dev/null; then
    cp -a "$FLAVOR_DIR/templates"/* "$OUTPUT_DIR/templates/active-flavor/"
  fi
fi

FILE_COUNT=$(find "$OUTPUT_DIR" -type f | wc -l | tr -d ' ')
echo "  ✓ Composed: $OUTPUT_DIR ($FILE_COUNT files)"
