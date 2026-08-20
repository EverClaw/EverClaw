#!/usr/bin/env bash
# ecosystem-sync.sh — Monorepo-aware ecosystem sync
#
# NEW BEHAVIOR (post-monorepo restructure):
#   - origin + everclaw-org: Push the FULL monorepo
#   - Flavor remotes: Compose core + flavor → push composed result
#
# Usage:
#   ./scripts/ecosystem-sync.sh              # Compose and push all flavors
#   ./scripts/ecosystem-sync.sh --dry-run    # Show what would happen, don't push
#   ./scripts/ecosystem-sync.sh --verify     # Only verify sync status, no push
#   ./scripts/ecosystem-sync.sh --force      # Force push (use after history rewrite)
#   ./scripts/ecosystem-sync.sh --flavor X   # Only sync specific flavor remote
#
# Exit codes:
#   0 — All remotes in sync
#   1 — One or more remotes failed
#   2 — Script error (not in repo, no remotes, etc.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_SCRIPT="$SCRIPT_DIR/flavor-compose.sh"
WORK_DIR="/tmp/everclaw-ecosystem-compose"

# === Concurrent Execution Lock ===
LOCK_DIR="/tmp/morpheus-skill-ecosystem-sync.lock"
if mkdir "$LOCK_DIR" 2>/dev/null; then
  trap 'rm -rf "$LOCK_DIR" "$WORK_DIR"' EXIT
else
  lock_age=0
  if [ -f "$LOCK_DIR/pid" ]; then
    lock_ts=$(stat -f %m "$LOCK_DIR/pid" 2>/dev/null || stat -c %Y "$LOCK_DIR/pid" 2>/dev/null || echo 0)
    lock_age=$(( $(date +%s) - lock_ts ))
  fi
  if [ "$lock_age" -gt 600 ]; then
    echo "⚠️  Stale lock detected (${lock_age}s old), removing..."
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR"
    trap 'rm -rf "$LOCK_DIR" "$WORK_DIR"' EXIT
  else
    echo "❌ Another ecosystem-sync is running (lock age: ${lock_age}s). Exiting."
    exit 2
  fi
fi
echo $$ > "$LOCK_DIR/pid"

# === Parse args ===
DRY_RUN=false
VERIFY_ONLY=false
FORCE=false
SPECIFIC_FLAVOR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)   DRY_RUN=true ;;
    --verify)    VERIFY_ONLY=true ;;
    --force)     FORCE=true ;;
    --flavor)    shift; SPECIFIC_FLAVOR="$1" ;;
    *)           echo "Unknown option: $1"; exit 2 ;;
  esac
  shift
done

cd "$REPO_ROOT"

# === Verify we're in the right repo ===
if [ ! -d ".git" ]; then
  echo "❌ Not a git repository: $REPO_ROOT"
  exit 2
fi

if [ ! -d "packages/core" ]; then
  echo "❌ packages/core/ not found. Is this the monorepo?"
  exit 2
fi

# === Canonical remotes (get full monorepo push) ===
CANONICAL_REMOTES="origin everclaw-org"

# === Collect flavor remotes ===
get_flavor_remotes() {
  git remote | while read remote; do
    # Skip canonical remotes
    case "$remote" in
      origin|everclaw-org) continue ;;
    esac
    # Must have a matching flavors/ directory
    if [ -d "flavors/$remote" ] && [ -f "flavors/$remote/flavor.json" ]; then
      echo "$remote"
    else
      echo "⚠️  Remote '$remote' has no matching flavors/$remote/flavor.json — skipping" >&2
    fi
  done
}

TOTAL_OK=0
TOTAL_FAIL=0
TOTAL_SKIP=0
RESULTS=""

# === Step 1: Push full monorepo to canonical remotes ===
echo "━━━ Ecosystem Sync (Monorepo Mode) ━━━"
echo "Repo: $REPO_ROOT"
echo "Date: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo ""

if [ -z "$SPECIFIC_FLAVOR" ]; then
  echo "📦 Phase 1: Push full monorepo to canonical remotes"
  for remote in $CANONICAL_REMOTES; do
    if ! git remote get-url "$remote" >/dev/null 2>&1; then
      echo "  ⚠️  $remote — remote not found, skipping"
      TOTAL_SKIP=$((TOTAL_SKIP + 1))
      continue
    fi
    
    url=$(git remote get-url "$remote")
    echo -n "  → $remote ($url) ... "
    
    if $VERIFY_ONLY; then
      echo "VERIFY MODE — skipping push"
      continue
    fi
    
    if $DRY_RUN; then
      echo "DRY RUN — would push main"
      continue
    fi
    
    PUSH_ARGS="main"
    $FORCE && PUSH_ARGS="--force main"
    
    if git push --no-verify "$remote" $PUSH_ARGS 2>/dev/null; then
      echo "✅"
      TOTAL_OK=$((TOTAL_OK + 1))
      RESULTS="${RESULTS}✅ $remote\n"
    else
      echo "❌"
      TOTAL_FAIL=$((TOTAL_FAIL + 1))
      RESULTS="${RESULTS}❌ $remote\n"
    fi
  done
  echo ""
fi

# === Step 2: Compose and push flavor repos ===
echo "🧩 Phase 2: Compose and push flavor repos"

if [ -n "$SPECIFIC_FLAVOR" ]; then
  FLAVOR_REMOTES="$SPECIFIC_FLAVOR"
else
  FLAVOR_REMOTES=$(get_flavor_remotes)
fi

for remote in $FLAVOR_REMOTES; do
  if [ ! -d "flavors/$remote" ]; then
    echo "  ⚠️  $remote — no flavors/$remote directory, skipping"
    TOTAL_SKIP=$((TOTAL_SKIP + 1))
    continue
  fi
  
  url=$(git remote get-url "$remote" 2>/dev/null || echo "UNKNOWN")
  flavor_name=$(jq -r ".name" "flavors/$remote/flavor.json" 2>/dev/null || echo "$remote")
  echo -n "  → $remote ($flavor_name) ... "
  
  if $VERIFY_ONLY; then
    echo "VERIFY MODE — skipping"
    continue
  fi
  
  if $DRY_RUN; then
    echo "DRY RUN — would compose and push"
    continue
  fi
  
  # Compose the flavor
  COMPOSE_OUT="$WORK_DIR/$remote"
  if ! "$COMPOSE_SCRIPT" "flavors/$remote" "$COMPOSE_OUT" >/dev/null 2>&1; then
    echo "❌ (compose failed)"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    RESULTS="${RESULTS}❌ $remote (compose)\n"
    continue
  fi
  
  # Clone the remote into a temp bare repo for pushing
  PUSH_DIR="$WORK_DIR/${remote}-push"
  rm -rf "$PUSH_DIR"
  
  # Clone existing remote (shallow)
  if ! git clone --depth 1 "$url" "$PUSH_DIR" 2>/dev/null; then
    echo "❌ (clone failed)"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    RESULTS="${RESULTS}❌ $remote (clone)\n"
    continue
  fi
  
  # Replace contents with composed output
  cd "$PUSH_DIR"
  # Remove all tracked files except .git
  git ls-files -z | xargs -0 rm -f 2>/dev/null || true
  # Copy composed files
  cp -a "$COMPOSE_OUT"/* "$PUSH_DIR/" 2>/dev/null || true
  cp -a "$COMPOSE_OUT"/.[!.]* "$PUSH_DIR/" 2>/dev/null || true
  
  # Stage, commit, push
  git add -A
  if git diff --cached --quiet; then
    echo "✅ (no changes)"
    TOTAL_OK=$((TOTAL_OK + 1))
    RESULTS="${RESULTS}✅ $remote (no changes)\n"
  else
    COMMIT_MSG="sync: compose from monorepo $(date '+%Y-%m-%d %H:%M')"
    git commit -m "$COMMIT_MSG" >/dev/null 2>&1
    
    PUSH_ARGS="main"
    $FORCE && PUSH_ARGS="--force main"
    
    if git push --no-verify origin $PUSH_ARGS 2>/dev/null; then
      echo "✅"
      TOTAL_OK=$((TOTAL_OK + 1))
      RESULTS="${RESULTS}✅ $remote\n"
    else
      echo "❌ (push failed)"
      TOTAL_FAIL=$((TOTAL_FAIL + 1))
      RESULTS="${RESULTS}❌ $remote\n"
    fi
  fi
  
  cd "$REPO_ROOT"
done

# === Summary ===
echo ""
echo "━━━ Summary ━━━"
echo -e "$RESULTS"
echo "✅ OK: $TOTAL_OK | ❌ Failed: $TOTAL_FAIL | ⚠️ Skipped: $TOTAL_SKIP"

if [ "$TOTAL_FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
