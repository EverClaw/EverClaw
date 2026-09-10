#!/usr/bin/env node
/**
 * migrate-import.mjs — Full-Host Migration Import (Gap 8)
 *
 * Imports a migrate-export bundle on a NEW machine. Ordered flow encodes the
 * 2026-08-27 bernardo3 migration lessons:
 *   L1/L2  deps from manifest → install → skills re-enable
 *   L3     {{HOME}} templated config restored for the NEW user
 *   L4     crons via gateway API only (NEVER SQL)
 *   L5     role=worker bundles import all crons disabled
 *   L6     keychain map decrypted with bundle passphrase
 *   L7     Signal collision warning
 *   L8     version-aware openclaw commands
 *   L9     pre-create ~/.openclaw/credentials (avoids interactive doctor prompt)
 *   L14    burn prompt — refuses silent --keep
 *
 * Usage:
 *   node migrate-import.mjs --import <bundle.tar.gz.enc> [--passphrase <pw|env:MIGRATE_PASSPHRASE>]
 *                           [--force] [--dry-run] [--expected-checksum <sha256>] [--help]
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync,
         createReadStream, createWriteStream, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve, basename } from 'node:path';
import { homedir, tmpdir, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { decryptBuffer, decryptFileStreaming } from './migrate-export.mjs';
import { OPENCLAW_DIR } from './paths.mjs';

const SUPPORTED_SCHEMA = '2.0';

// ── helpers ──────────────────────────────────────────────────────

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout || 300000, stdio: opts.stdio || 'pipe' });
}

function trySh(cmd, args, opts = {}) {
  try { return { ok: true, out: sh(cmd, args, opts) }; }
  catch (err) { return { ok: false, err: err.message, out: err.stdout || '' }; }
}

/**
 * Version-aware OpenClaw gateway command (L8).
 * `openclaw restart` does not exist in all versions (proven 2026-08-27).
 */
export function gatewayCommand(version) {
  // All known versions use the gateway subcommand form (proven 2026-08-27:
  // bare `openclaw restart` does not exist). Kept as a function so version
  // special-casing has one place if an old version ever needs it (Grok R7).
  return { start: 'openclaw gateway start', status: 'openclaw gateway status' };
}

// ── Bundle unpack + verify ───────────────────────────────────────

/**
 * Extract a workspaces tar with member validation (R3 blocking fix).
 * Only workspace/ and workspace-* top-level dirs are allowed; anything with
 * .., absolute paths, symlinks, or unexpected names is rejected, and offending
 * members are extracted nowhere. Uses --no-same-owner to avoid chown attacks on
 * platforms where the tar carries ownership (e.g. root-created bundles).
 */
export function extractSafeWorkspaces(wsTar, openclawDir) {
  const members = sh('tar', ['-tf', wsTar], { timeout: 60000 })
    .split('\n').filter(Boolean);
  const bad = [];
  for (const m of members) {
    const norm = m.replace(/\/\/$/, '');
    if (norm === '.' || norm === '') continue;
    const top = norm.split('/')[0];
    const okTop = top === 'workspace' || top.startsWith('workspace-');
    if (!okTop || norm.includes('..') || norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) {
      bad.push(m);
    }
  }
  if (bad.length > 0) {
    throw new Error(`unsafe workspace tar members rejected: ${bad.slice(0, 5).join(', ')}`);
  }
  // Symlink members are ambiguous to vet reliably; require none.
  // Claude R3: whitelist types — reject hardlinks (h), device nodes (b/c),
  // FIFOs (p) too. Only regular files (-) and directories (d) allowed.
  if (sh('tar', ['-tvf', wsTar], { timeout: 60000 }).split('\n').filter(Boolean).some(l => !/^[\-d]/.test(l))) {
    throw new Error('unsafe workspace tar: only regular files and directories are allowed');
  }
  const extractDirHint = mkdtempSync(join(tmpdir(), 'mig-ws-'));
  try {
    sh('tar', ['-xf', wsTar, '-C', extractDirHint, '--no-same-owner'], { timeout: 600000 });
    for (const top of ['workspace', ...Array.from(new Set(members.map(m => m.split('/')[0]).filter(t => t.startsWith('workspace-'))))]) {
      const src = join(extractDirHint, top);
      const dst = join(openclawDir, top);
      if (existsSync(src)) {
        if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
        mkdirSync(dirname(dst), { recursive: true });
        sh('mv', [src, dst]);
      }
    }
  } finally {
    rmSync(extractDirHint, { recursive: true, force: true });
  }
  return { ok: true, skipped: [] };
}


export async function unpackBundle(bundlePath, passphrase, stagingDir, expectedChecksum = null) {
  if (!existsSync(bundlePath)) throw new Error(`bundle not found: ${bundlePath}`);
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

  // Out-of-band integrity gate (R3, Claude B1 fix): the ENCRYPTED FILE is
  // verified against the SHA-256 printed by export BEFORE decryption. The
  // exporter hashes the exact artifact the operator holds, so any tampering
  // (including a passphrase holder re-tarring the contents) breaks the match.
  if (expectedChecksum) {
    const h = createHash('sha256');
    await pipeline(createReadStream(bundlePath, { highWaterMark: 1024 * 1024 * 8 }), h);
    const actual = h.digest('hex');
    if (actual !== expectedChecksum) {
      throw new Error(`bundle checksum MISMATCH — expected ${expectedChecksum}, got ${actual}; do not import (possible tampering)`);
    }
  }

  // Streaming decryption (handles >2 GiB bundles).
  const tmpTar = join(stagingDir, 'bundle.tar');
  try {
    await decryptFileStreaming(bundlePath, tmpTar, passphrase);
  } catch {
    throw new Error('decryption failed — wrong passphrase or corrupt bundle');
  }
  const extractDir = join(stagingDir, 'extracted');
  mkdirSync(extractDir, { recursive: true, mode: 0o700 });
  // Claude R2 Security fix: validate outer tar members BEFORE extraction.
  // The inner workspace tar is carefully vetted; the outer tar must be too —
  // a passphrase holder can craft hostile members (and supply the matching
  // out-of-band checksum, so --expected-checksum does not help here).
  const EXPECTED_MEMBERS = new Set(['manifest.json', 'dependency-manifest.json',
    'config.json.tmpl', 'skills-state.json', 'cron-jobs.json',
    'workspaces.tar', 'workspaces.tar.gz', 'keychain.json.enc', 'RUNBOOK.md', '.']);
  const members = sh('tar', ['-tf', tmpTar], { timeout: 60000 })
    .split('\n').filter(Boolean);
  for (const m of members) {
    const rel = m.replace(/\/+$/, '').replace(/^\.\//, '');
    if (rel === '.' || rel === '') continue;
    if (rel.includes('..') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || !EXPECTED_MEMBERS.has(rel)) {
      throw new Error(`unsafe bundle member rejected: ${m}`);
    }
  }
  // Claude R3 Security fix: whitelist member types (regular files + dirs only).
  // Reject symlinks (l), hardlinks (h), device nodes (b/c), FIFOs (p).
  if (sh('tar', ['-tvf', tmpTar], { timeout: 60000 }).split('\n').filter(Boolean).some(l => !/^[\-d]/.test(l))) {
    throw new Error('unsafe bundle: only regular files and directories are allowed');
  }
  sh('tar', ['-xf', tmpTar, '-C', extractDir, '--no-same-owner'], { timeout: 600000 });
  rmSync(tmpTar, { force: true });

  const manifestPath = join(extractDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('invalid bundle: manifest.json missing');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== SUPPORTED_SCHEMA) {
    throw new Error(`unsupported bundle schema: ${manifest.schemaVersion} (supported: ${SUPPORTED_SCHEMA})`);
  }

  // In-bundle checksums are MANDATORY (R3 blocking fix: optional checksums were
  // a bypass — stripping the field disabled the gate entirely). They verify
  // every payload file against ACCIDENTAL corruption (malicious tampering by a
  // passphrase holder is covered by the out-of-band expectedChecksum).
  if (!manifest.checksums || typeof manifest.checksums !== 'object') {
    throw new Error('invalid bundle: missing checksums — refusing to import');
  }
  const bad = [];
  for (const [file, expected] of Object.entries(manifest.checksums)) {
    const p = join(extractDir, file);
    if (!existsSync(p)) { bad.push(`${file}: missing`); continue; }
    let content = readFileSync(p);
    if (file === 'manifest.json') {
      // Self-checksum: the manifest's own digest is computed over the manifest
      // with its self-reference normalized to '' (matches export, R9/R10).
      const m = JSON.parse(content.toString('utf8'));
      if (m.checksums) m.checksums['manifest.json'] = '';
      content = Buffer.from(JSON.stringify(m, null, 2) + '\n', 'utf8');
    }
    const actual = createHash('sha256').update(content).digest('hex');
    if (actual !== expected) bad.push(`${file}: checksum mismatch`);
  }
  if (bad.length > 0) {
    throw new Error(`bundle integrity check FAILED: ${bad.join('; ')}`);
  }
  return { manifest, extractDir };
}

// ── Import steps ─────────────────────────────────────────────────

/**
 * Step: preflight (read-only checks). Returns findings, never throws for
 * warnings; throws only when import cannot proceed.
 */
export function preflight(manifest, opts = {}) {
  const checks = [];
  const home = homedir();

  const samePlatform = platform() === manifest.source.platform;
  // Claude R2 Operational fix: platform mismatch is a WARNING, not a hard
  // block. The exporter's --target-platform flag exists for cross-platform
  // (hosted-linux → macOS ClawBox). Config/workspaces are portable; binaries
  // may differ. If cross-platform is explicitly out of scope for a release,
  // gate behind --force instead — but the unconditional throw defeats an
  // intended migration scenario.
  checks.push({ id: 'platform', ok: true, warn: !samePlatform,
    note: `bundle from ${manifest.source.platform}/${manifest.source.arch}, target ${platform()}${samePlatform ? '' : ' — MISMATCH (workspaces/config still portable; verify binaries)'}` });

  const ocVersion = (() => { try { return sh('openclaw', ['--version'], { timeout: 15000 }).trim(); } catch { return null; } })();
  // Claude R3 Operational fix: openclaw not installed is NORMAL on a fresh
  // migration target. None of the restore steps need the binary. Downgrade
  // to a warning (same treatment as the platform check in R2).
  checks.push({ id: 'openclaw', ok: true, warn: !ocVersion,
    note: ocVersion ? `openclaw ${ocVersion}` : 'openclaw NOT installed — install from dependency manifest before starting the gateway' });

  // L9: pre-create credentials dir to avoid interactive doctor prompt
  const creds = join(home, '.openclaw', 'credentials');
  checks.push({ id: 'credentials-dir', ok: true,
    note: existsSync(creds) ? 'credentials dir exists' : 'will pre-create (avoids doctor prompt)' });

  // L7: Signal collision warning
  if (manifest.excluded?.signalLink) {
    checks.push({ id: 'signal', ok: true, warn: true,
      note: 'Signal account NOT portable — one number per instance. Relink separately.' });
  }

  if (opts.configExists && !opts.force) {
    checks.push({ id: 'config-conflict', ok: false,
      note: 'openclaw.json already exists — re-run with --force to overwrite' });
  }

  return checks;
}

/**
 * Step: write config from template with {{HOME}} → new home (L3).
 */
export function restoreConfig(template, targetHome, openclawDir = OPENCLAW_DIR, force = false) {
  const target = join(openclawDir, 'openclaw.json');
  if (existsSync(target) && !force) {
    throw new Error('openclaw.json exists — use --force to overwrite');
  }
  const content = template.split('{{HOME}}').join(targetHome);
  JSON.parse(content); // validate before writing
  mkdirSync(openclawDir, { recursive: true, mode: 0o700 });
  writeFileSync(target, content, { mode: 0o600 });
  return target;
}

/**
 * Step: restore keychain secrets from decrypted map (L6).
 */
export function restoreKeychain(keychainData, account = process.env.USER || 'openclaw') {
  const restored = [];
  const skipped = [];
  if (platform() !== 'darwin') return { restored, skipped, note: 'non-macOS — keychain restore skipped' };
  for (const [svc, item] of Object.entries(keychainData.secrets || {})) {
    // The value may be a plain string (older bundles) or { value, account }
    // (R8: source account captured so the same -a is used on the target).
    const val = typeof item === 'string' ? item : item.value;
    const acct = typeof item === 'object' && item?.account ? item.account : account;
    const exists = trySh('security', ['find-generic-password', '-a', acct, '-s', svc, '-w'], { timeout: 10000 }).ok;
    if (exists && !process.env.MIGRATE_OVERWRITE_KEYS) { skipped.push(svc); continue; }
    // macOS `security` CLI has NO stdin form: `-w -` stores the literal '-'. The
    // secret appears briefly in argv for the short-lived execFileSync (Grok R7
    // verified: accepted trade-off; process is ours and exits immediately).
    const r = trySh('security', ['add-generic-password', '-a', acct, '-s', svc, '-w', val], { timeout: 10000 });
    if (r.ok) restored.push(svc); else skipped.push(svc);
  }
  return { restored, skipped };
}

/**
 * Step: re-enable skills whose binaries now exist (L2/L10).
 * Only flips skills the bundle says were enabled at source.
 */
export function reenableSkills(skillsState, cfg) {
  // Read-only: returns the list of skills to flip. The caller is the single
  // writer. Honours the DESIRED map (.wanted) from export (Grok R8): skills
  // that are wanted but currently disabled get re-enabled after dependency
  // install — this is what repair the doctor-disabled-on-source case (L2/L10).
  const flipped = [];
  const entries = cfg?.skills?.entries || {};
  for (const [name, want] of Object.entries(skillsState || {})) {
    const desired = want?.wanted ?? want?.enabled ?? false;
    if (!desired) continue;
    if (entries[name] && entries[name].enabled === false) {
      flipped.push(name);
    }
  }
  return flipped;
}

/**
 * Step: import cron jobs via gateway cron API (L4 — NEVER SQL).
 * Import-only function: the gateway-side add is performed by the agent's cron
 * tool (see RUNBOOK); here we validate + stage the job file and report what
 * the agent must create.
 */
export function stageCronImport(extractDir, manifest) {
  const cronPath = join(extractDir, 'cron-jobs.json');
  if (!existsSync(cronPath)) {
    return { staged: false, reason: 'no crons in bundle (excluded)' };
  }
  const jobs = JSON.parse(readFileSync(cronPath, 'utf8'));
  const disabled = manifest.role === 'worker';
  const staged = jobs.map(j => ({
    name: j.name,
    enabled: disabled ? false : (j.enabled !== false),
    schedule: j.schedule,
    payload: j.payload,
    delivery: j.delivery,
  }));
  return { staged: true, role: manifest.role, count: staged.length, allDisabled: disabled, jobs: staged };
}

/**
 * Step: burn prompt (L14). Returns the command to run; refuses silent keep.
 */
export function burnCommand(bundlePath) {
  return `rm -f '${resolve(bundlePath)}'   # bundle contains live secrets — delete after verification`;
}

// ── Orchestrator ─────────────────────────────────────────────────

export async function importMigrateBundle(options = {}) {
  const {
    importPath,
    expectedChecksum = null,
    force = false,
    openclawDir = OPENCLAW_DIR,
    dryRun = false,
  } = options;
  // Claude R2 B2: parseArgs seeds `passphrase: null`, which bypasses the
  // `= default` form; use nullish resolution so MIGRATE_PASSPHRASE works.
  const passphrase = options.passphrase ?? process.env.MIGRATE_PASSPHRASE ?? null;

  if (!passphrase || passphrase.length < 16) throw new Error('passphrase required (min 16 chars; prefer MIGRATE_PASSPHRASE env over argv)');
  const home = homedir();
  const staging = mkdtempSync(join(tmpdir(), 'migrate-import-'));
  const report = { steps: [], warnings: [], ok: true };

  try {
    const { manifest, extractDir } = await unpackBundle(importPath, passphrase, staging, expectedChecksum);
    report.manifest = { created: manifest.created, role: manifest.role, source: manifest.source };

    // Preflight
    const pf = preflight(manifest, { configExists: existsSync(join(openclawDir, 'openclaw.json')), force });
    const blocker = pf.find(c => c.ok === false);
    if (blocker && !dryRun) throw new Error(`preflight blocked: ${blocker.id} — ${blocker.note}`);
    report.steps.push({ step: 'preflight', checks: pf });

    if (dryRun) {
      report.dryRun = true;
      const cronInfo = stageCronImport(extractDir, manifest);
      report.cronPlan = cronInfo;
      return report;
    }

    // L9: credentials dir
    mkdirSync(join(home, '.openclaw', 'credentials'), { recursive: true, mode: 0o700 });
    report.steps.push({ step: 'credentials-dir', ok: true });

    // Config (L3)
    const tmplPath = join(extractDir, 'config.json.tmpl');
    if (existsSync(tmplPath)) {
      const cfgPath = restoreConfig(readFileSync(tmplPath, 'utf8'), home, openclawDir, force);
      report.steps.push({ step: 'config', ok: true, path: cfgPath });
    }

    // Keychain (L6)
    const kcPath = join(extractDir, 'keychain.json.enc');
    if (existsSync(kcPath)) {
      const kc = JSON.parse(decryptBuffer(readFileSync(kcPath), passphrase).toString('utf8'));
      const kcRes = restoreKeychain(kc);
      report.steps.push({ step: 'keychain', restored: kcRes.restored, skipped: kcRes.skipped });
    } else {
      report.warnings.push('keychain: no encrypted map in bundle');
    }

    // Workspaces (L12). Export writes UNCOMPRESSED workspaces.tar (bsdtar 2 GiB
    // gzip limit — Claude Stage4 R3: previously looked only for .tar.gz and
    // silently skipped every restore). Accept either name; tar -xf auto-detects.
    // Vet every member before anything lands in ~/.openclaw (path traversal).
    const wsTar = [
      join(extractDir, 'workspaces.tar'),
      join(extractDir, 'workspaces.tar.gz'),
    ].find((p) => existsSync(p));
    if (wsTar) {
      const safe = extractSafeWorkspaces(wsTar, openclawDir);
      report.steps.push({ step: 'workspaces', ok: safe.ok, dir: openclawDir, skipped: safe.skipped, source: basename(wsTar) });
    } else if (manifest.excluded?.workspaces !== true) {
      report.warnings.push('workspaces: no workspaces.tar in bundle — nothing restored');
    }

    // Skills re-enable (L2/L10)
    const ssPath = join(extractDir, 'skills-state.json');
    if (existsSync(ssPath)) {
      const skillsState = JSON.parse(readFileSync(ssPath, 'utf8'));
      let cfg = {};
      try { cfg = JSON.parse(readFileSync(join(openclawDir, 'openclaw.json'), 'utf8')); } catch { /* fresh */ }
      const flipped = reenableSkills(skillsState, cfg);
      if (flipped.length > 0) {
        // Defensive writer (R3 major): entries may be missing entirely on a
        // fresh target — initialize before mutating.
        cfg.skills = cfg.skills || {};
        cfg.skills.entries = cfg.skills.entries || {};
        for (const name of flipped) {
          if (!cfg.skills.entries[name] || typeof cfg.skills.entries[name] !== 'object') {
            cfg.skills.entries[name] = { enabled: true };
          } else {
            cfg.skills.entries[name].enabled = true;
          }
        }
        writeFileSync(join(openclawDir, 'openclaw.json'), JSON.stringify(cfg, null, 2), { mode: 0o600 });
      }
      report.steps.push({ step: 'skills', reenabled: flipped });
    }

    // Crons (L4/L5) — stage only; the agent's cron tool performs the adds
    const cronInfo = stageCronImport(extractDir, manifest);
    if (cronInfo.staged) {
      const cronOut = join(openclawDir, 'pending-cron-import.json');
      writeFileSync(cronOut, JSON.stringify(cronInfo.jobs, null, 2), { mode: 0o600 });
      report.steps.push({ step: 'crons', staged: cronInfo.count, allDisabled: cronInfo.allDisabled, file: cronOut,
        note: 'Agent must now create each job with the cron tool (gateway API, never SQL).' });
    } else {
      report.steps.push({ step: 'crons', staged: 0, note: cronInfo.reason });
    }

    // L7 reminder
    report.warnings.push('Signal: relink separately — one Signal number per instance.');
    report.warnings.push('Session history: not portable (by design).');

    // Gateway start hint (L8)
    report.gateway = gatewayCommand(manifest.source.openclaw);

    // Deliver the bundle's RUNBOOK to a durable location (Grok R2 major fix:
    // staging is deleted, so without this the human-readable runbook never
    // reaches the non-technical user / ClawBox first-boot script).
    const runbookSrc = join(extractDir, 'RUNBOOK.md');
    if (existsSync(runbookSrc)) {
      const docsDir = join(homedir(), 'Documents');
      mkdirSync(docsDir, { recursive: true });
      const runbookOut = join(docsDir, `migration-runbook-${Date.now()}.md`);
      writeFileSync(runbookOut, readFileSync(runbookSrc), { mode: 0o600 });
      report.runbook = runbookOut;
    }

    // L14: burn
    report.burn = burnCommand(importPath);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  return report;
}

// ── CLI ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { importPath: null, passphrase: null, expectedChecksum: null, force: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) { console.error(`❌ ${a} requires a value`); process.exit(1); } return argv[++i]; };
    switch (a) {
      case '--import': args.importPath = val(); break;
      case '--passphrase': args.passphrase = val(); break;
      case '--expected-checksum': args.expectedChecksum = val(); break;
      case '--force': args.force = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--help': args.help = true; break;
      default: console.error(`❌ Unknown flag: ${a}`); process.exit(1);
    }
  }
  return args;
}

if (process.argv[1]?.endsWith('migrate-import.mjs')) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.importPath) {
    console.log(`migrate-import — Full-Host Migration Import (Gap 8)

Usage:
  node migrate-import.mjs --import <bundle.tar.gz.enc> [--force] [--dry-run] [--expected-checksum <sha256>]

Flags:
  --import <path>       Bundle to import (required)
  --passphrase <pw>     Bundle passphrase — PREFER MIGRATE_PASSPHRASE env
                        (argv is visible in ps/history). Min 16 chars.
  --expected-checksum <sha256>  Out-of-band SHA-256 of the ENCRYPTED bundle file
                        (printed by export). Refuses import on mismatch —
                        protects against re-tarred tampering.
  --force               Overwrite existing openclaw.json
  --dry-run             Show plan without changing anything

AFTER IMPORT: run the verification checklist, then DELETE the bundle.`);
    process.exit(args.help ? 0 : 1);
  }
  try {
    importMigrateBundle(args).then(res => {
      console.log(JSON.stringify(res, null, 2));
      if (!res.dryRun && res.burn) {
        console.error('\n⚠️  DELETE the bundle after verification:');
        console.error(`   ${res.burn}`);
      }
    }).catch(err => {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    });
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}
