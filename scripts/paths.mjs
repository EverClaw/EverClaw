/**
 * paths.mjs — Shared path constants for Buddy Bots
 *
 * Centralizes all base directory construction so modules don't hardcode
 * ~/.openclaw or ~/.everclaw independently. Supports env overrides and
 * one-time migration from the old ~/.everclaw layout.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, renameSync, readdirSync, mkdirSync } from 'node:fs';

const HOME = process.env.HOME || homedir();

/**
 * Preferred single root for all buddy-bot state going forward.
 * Priority: OPENCLAW_STATE_DIR → EVERCLAW_DIR → ~/.openclaw
 */
export const STATE_DIR = process.env.OPENCLAW_STATE_DIR
  || process.env.EVERCLAW_DIR
  || join(HOME, '.openclaw');

/**
 * OpenClaw config/workspace directory.
 */
export const OPENCLAW_DIR = process.env.OPENCLAW_DIR || join(HOME, '.openclaw');

/**
 * EverClaw directory (legacy — being migrated into OPENCLAW_DIR).
 */
export const EVERCLAW_DIR = process.env.EVERCLAW_DIR || join(HOME, '.everclaw');

/**
 * One-time migration: if ~/.everclaw exists but its subdirs haven't been
 * moved into the state root yet, relocate them.
 *
 * Moves: buddy-registry.json, buddy-groups.json, coordination/, quotas/,
 * xmtp/, buddy-chats/, buddy-registry/, logs/ — whichever exist.
 *
 * Safe to call multiple times — no-ops if already migrated or no source exists.
 */
export function migrateEverclawIfNeeded(stateDir = STATE_DIR, oldDir = EVERCLAW_DIR) {
  // Only migrate if old dir exists and is different from state dir
  if (oldDir === stateDir) return { migrated: false, reason: 'same directory' };
  if (!existsSync(oldDir)) return { migrated: false, reason: 'no legacy dir' };

  const subdirs = [
    'coordination',
    'quotas',
    'xmtp',
    'buddy-chats',
    'buddy-registry',
    'logs',
  ];
  const files = [
    'buddy-registry.json',
    'buddy-groups.json',
    'peers.json',
  ];

  const migrated = [];

  // Migrate subdirs
  for (const sub of subdirs) {
    const src = join(oldDir, sub);
    const dest = join(stateDir, sub);
    if (existsSync(src) && !existsSync(dest)) {
      try {
        mkdirSync(dirnameSafe(dest), { recursive: true });
        renameSync(src, dest);
        migrated.push(sub + '/');
      } catch {
        // best effort — don't fail startup over partial migration
      }
    }
  }

  // Migrate top-level files
  for (const file of files) {
    const src = join(oldDir, file);
    const dest = join(stateDir, file);
    if (existsSync(src) && !existsSync(dest)) {
      try {
        renameSync(src, dest);
        migrated.push(file);
      } catch { /* best effort */ }
    }
  }

  if (migrated.length > 0) {
    process.stderr.write(
      `[paths] Migrated ${migrated.length} item(s) from ${oldDir} → ${stateDir}: ${migrated.join(', ')}\n`
    );
  }

  return { migrated: migrated.length > 0, items: migrated };
}

/** Minimal dirname to avoid importing path.dirname in this helper */
function dirnameSafe(p) {
  const idx = p.lastIndexOf('/');
  return idx > 0 ? p.slice(0, idx) : p;
}
