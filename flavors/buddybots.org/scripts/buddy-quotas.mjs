#!/usr/bin/env node
/**
 * buddy-quotas.mjs — Per-agent inference quota management
 *
 * Tracks token usage per buddy bot, enforces daily/monthly limits,
 * alerts at configurable thresholds, and degrades to lighter models
 * before hard cutoff.
 *
 * CLI:
 *   node buddy-quotas.mjs status                          — all agents
 *   node buddy-quotas.mjs status --agent-id alice         — single agent
 *   node buddy-quotas.mjs set --agent-id alice --daily 150000 --monthly 3000000
 *   node buddy-quotas.mjs set --default --daily 100000 --monthly 2000000
 *   node buddy-quotas.mjs reset --agent-id alice          — reset daily+monthly
 *   node buddy-quotas.mjs reset --all --period daily      — reset all daily
 *   node buddy-quotas.mjs record --agent-id alice --tokens 1500 --model glm-5 --provider morpheus
 *   node buddy-quotas.mjs alerts                          — show threshold alerts
 *   node buddy-quotas.mjs export                          — dump JSON
 *   node buddy-quotas.mjs import --file backup.json       — restore
 *
 * Library:
 *   import { loadQuotaConfig, recordUsage, getUsage, checkQuota, ... } from './buddy-quotas.mjs';
 *
 * Dependencies: Node built-ins only. Optional: buddy-registry.mjs (for agent names in status).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

// ── Paths ────────────────────────────────────────────────────────

const EVERCLAW_DIR = process.env.EVERCLAW_DIR || join(process.env.HOME || '', '.everclaw');
const QUOTAS_DIR = process.env.BUDDY_QUOTAS_DIR || join(EVERCLAW_DIR, 'quotas');
const CONFIG_PATH = join(QUOTAS_DIR, 'config.json');
const USAGE_DIR = join(QUOTAS_DIR, 'usage');

const CURRENT_CONFIG_VERSION = 1;
const CURRENT_USAGE_VERSION = 1;
const MAX_HISTORY_DAYS = 30;
const MAX_AGENT_ID_LEN = 64;
const AGENT_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

// ── Default Config ───────────────────────────────────────────────

const DEFAULT_LIMITS = {
  daily: 100_000,
  monthly: 2_000_000,
  alertThreshold: 0.8,
  degradeThreshold: 0.9,
  degradeModel: 'ollama/gemma4-26b-q3',
  cutoffAction: 'degrade',  // 'degrade' | 'block' | 'warn'
};

const VALID_CUTOFF_ACTIONS = new Set(['degrade', 'block', 'warn']);

// ── Validation ───────────────────────────────────────────────────

function validateAgentId(agentId) {
  if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) {
    throw new Error(`Invalid agent ID: "${agentId}". Must match ${AGENT_ID_RE}`);
  }
  if (agentId.length > MAX_AGENT_ID_LEN) {
    throw new Error(`Agent ID exceeds ${MAX_AGENT_ID_LEN} characters`);
  }
}

function validateTokens(tokens) {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) {
    throw new Error(`Invalid token count: ${tokens}. Must be a non-negative finite number`);
  }
  if (!Number.isInteger(tokens)) {
    throw new Error(`Token count must be an integer, got: ${tokens}`);
  }
}

function validateLimit(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${name}: ${value}. Must be a non-negative finite number`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer, got: ${value}`);
  }
}

function validateThreshold(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid ${name}: ${value}. Must be between 0 and 1`);
  }
}

function validateCutoffAction(action) {
  if (!VALID_CUTOFF_ACTIONS.has(action)) {
    throw new Error(`Invalid cutoffAction: "${action}". Must be one of: ${[...VALID_CUTOFF_ACTIONS].join(', ')}`);
  }
}

// ── Filesystem Helpers ───────────────────────────────────────────

function ensureDirs() {
  mkdirSync(USAGE_DIR, { recursive: true, mode: 0o700 });
}

function atomicWrite(filePath, data) {
  const tmpPath = filePath + '.tmp.' + randomUUID().slice(0, 8);
  const parentDir = dirname(filePath);
  mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Failed to read ${filePath}: ${err.message}`);
  }
}

function getUsagePath(agentId) {
  validateAgentId(agentId);
  return join(USAGE_DIR, `${agentId}.json`);
}

// ── Date Helpers ─────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function thisMonthStr() {
  return new Date().toISOString().slice(0, 7);
}

// ── Config Management ────────────────────────────────────────────

export function loadConfig() {
  ensureDirs();
  const data = safeReadJson(CONFIG_PATH);
  if (!data) {
    return {
      version: CURRENT_CONFIG_VERSION,
      defaults: { ...DEFAULT_LIMITS },
      agents: {},
    };
  }
  if (data.version !== CURRENT_CONFIG_VERSION) {
    throw new Error(`Unsupported quota config version: ${data.version} (expected ${CURRENT_CONFIG_VERSION})`);
  }

  // Ensure required structure (defensive against corrupted config)
  if (!data.defaults) data.defaults = { ...DEFAULT_LIMITS };
  if (!data.agents) data.agents = {};

  return data;
}

export function saveConfig(config) {
  ensureDirs();
  atomicWrite(CONFIG_PATH, config);
}

export function loadQuotaConfig(agentId) {
  validateAgentId(agentId);
  const config = loadConfig();
  const agentOverrides = config.agents?.[agentId] || {};
  return {
    daily: agentOverrides.daily ?? config.defaults.daily,
    monthly: agentOverrides.monthly ?? config.defaults.monthly,
    alertThreshold: agentOverrides.alertThreshold ?? config.defaults.alertThreshold,
    degradeThreshold: agentOverrides.degradeThreshold ?? config.defaults.degradeThreshold,
    degradeModel: agentOverrides.degradeModel ?? config.defaults.degradeModel,
    cutoffAction: agentOverrides.cutoffAction ?? config.defaults.cutoffAction,
  };
}

export function setLimits(agentId, limits) {
  validateAgentId(agentId);
  const config = loadConfig();
  if (!config.agents) config.agents = {};
  if (!config.agents[agentId]) config.agents[agentId] = {};

  if (limits.daily !== undefined) {
    validateLimit(limits.daily, 'daily limit');
    config.agents[agentId].daily = limits.daily;
  }
  if (limits.monthly !== undefined) {
    validateLimit(limits.monthly, 'monthly limit');
    config.agents[agentId].monthly = limits.monthly;
  }
  if (limits.alertThreshold !== undefined) {
    validateThreshold(limits.alertThreshold, 'alertThreshold');
    config.agents[agentId].alertThreshold = limits.alertThreshold;
  }
  if (limits.degradeThreshold !== undefined) {
    validateThreshold(limits.degradeThreshold, 'degradeThreshold');
    config.agents[agentId].degradeThreshold = limits.degradeThreshold;
  }
  if (limits.degradeModel !== undefined) {
    if (typeof limits.degradeModel !== 'string' || limits.degradeModel.length === 0) {
      throw new Error('degradeModel must be a non-empty string');
    }
    config.agents[agentId].degradeModel = limits.degradeModel;
  }
  if (limits.cutoffAction !== undefined) {
    validateCutoffAction(limits.cutoffAction);
    config.agents[agentId].cutoffAction = limits.cutoffAction;
  }

  saveConfig(config);
  return config.agents[agentId];
}

export function setDefaults(defaults) {
  const config = loadConfig();

  if (defaults.daily !== undefined) {
    validateLimit(defaults.daily, 'daily limit');
    config.defaults.daily = defaults.daily;
  }
  if (defaults.monthly !== undefined) {
    validateLimit(defaults.monthly, 'monthly limit');
    config.defaults.monthly = defaults.monthly;
  }
  if (defaults.alertThreshold !== undefined) {
    validateThreshold(defaults.alertThreshold, 'alertThreshold');
    config.defaults.alertThreshold = defaults.alertThreshold;
  }
  if (defaults.degradeThreshold !== undefined) {
    validateThreshold(defaults.degradeThreshold, 'degradeThreshold');
    config.defaults.degradeThreshold = defaults.degradeThreshold;
  }
  if (defaults.degradeModel !== undefined) {
    if (typeof defaults.degradeModel !== 'string' || defaults.degradeModel.length === 0) {
      throw new Error('degradeModel must be a non-empty string');
    }
    config.defaults.degradeModel = defaults.degradeModel;
  }
  if (defaults.cutoffAction !== undefined) {
    validateCutoffAction(defaults.cutoffAction);
    config.defaults.cutoffAction = defaults.cutoffAction;
  }

  saveConfig(config);
  return config.defaults;
}

// ── Usage Tracking ───────────────────────────────────────────────

function createEmptyUsage(agentId) {
  return {
    version: CURRENT_USAGE_VERSION,
    agentId,
    daily: {
      date: todayStr(),
      tokens: 0,
      requests: 0,
      byModel: {},
      byProvider: {},
    },
    monthly: {
      month: thisMonthStr(),
      tokens: 0,
      requests: 0,
      byModel: {},
      byProvider: {},
    },
    history: [],
  };
}

function rolloverDaily(usage) {
  const today = todayStr();
  if (usage.daily.date === today) return false;

  // Archive current daily into history
  if (usage.daily.tokens > 0 || usage.daily.requests > 0) {
    usage.history.push({
      date: usage.daily.date,
      tokens: usage.daily.tokens,
      requests: usage.daily.requests,
    });
  }

  // Trim history to MAX_HISTORY_DAYS
  if (usage.history.length > MAX_HISTORY_DAYS) {
    usage.history = usage.history.slice(-MAX_HISTORY_DAYS);
  }

  // Reset daily
  usage.daily = {
    date: today,
    tokens: 0,
    requests: 0,
    byModel: {},
    byProvider: {},
  };

  return true;
}

function rolloverMonthly(usage) {
  const month = thisMonthStr();
  if (usage.monthly.month === month) return false;

  // Reset monthly (no monthly history — just reset)
  usage.monthly = {
    month,
    tokens: 0,
    requests: 0,
    byModel: {},
    byProvider: {},
  };

  return true;
}

function loadUsage(agentId) {
  validateAgentId(agentId);
  const usagePath = getUsagePath(agentId);
  const data = safeReadJson(usagePath);
  if (!data) return createEmptyUsage(agentId);
  if (data.version !== CURRENT_USAGE_VERSION) {
    throw new Error(`Unsupported usage version: ${data.version} for agent ${agentId}`);
  }
  return data;
}

function saveUsage(agentId, usage) {
  const usagePath = getUsagePath(agentId);
  atomicWrite(usagePath, usage);
}

export function recordUsage(agentId, tokens, model, provider) {
  validateAgentId(agentId);
  validateTokens(tokens);
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error('model must be a non-empty string');
  }
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new Error('provider must be a non-empty string');
  }

  const usage = loadUsage(agentId);

  // Handle date/month rollovers
  rolloverDaily(usage);
  rolloverMonthly(usage);

  // Increment daily
  usage.daily.tokens += tokens;
  usage.daily.requests += 1;

  if (!usage.daily.byModel[model]) {
    usage.daily.byModel[model] = { tokens: 0, requests: 0 };
  }
  usage.daily.byModel[model].tokens += tokens;
  usage.daily.byModel[model].requests += 1;

  if (!usage.daily.byProvider[provider]) {
    usage.daily.byProvider[provider] = { tokens: 0, requests: 0 };
  }
  usage.daily.byProvider[provider].tokens += tokens;
  usage.daily.byProvider[provider].requests += 1;

  // Increment monthly
  usage.monthly.tokens += tokens;
  usage.monthly.requests += 1;

  if (!usage.monthly.byModel[model]) {
    usage.monthly.byModel[model] = { tokens: 0, requests: 0 };
  }
  usage.monthly.byModel[model].tokens += tokens;
  usage.monthly.byModel[model].requests += 1;

  if (!usage.monthly.byProvider[provider]) {
    usage.monthly.byProvider[provider] = { tokens: 0, requests: 0 };
  }
  usage.monthly.byProvider[provider].tokens += tokens;
  usage.monthly.byProvider[provider].requests += 1;

  saveUsage(agentId, usage);
  return usage;
}

export function getUsage(agentId) {
  validateAgentId(agentId);
  const usage = loadUsage(agentId);
  rolloverDaily(usage);
  rolloverMonthly(usage);
  // Save after rollover so counters are fresh
  saveUsage(agentId, usage);
  return usage;
}

export function checkQuota(agentId) {
  validateAgentId(agentId);
  const usage = getUsage(agentId);
  const limits = loadQuotaConfig(agentId);

  const dailyRatio = limits.daily > 0 ? usage.daily.tokens / limits.daily : 0;
  const monthlyRatio = limits.monthly > 0 ? usage.monthly.tokens / limits.monthly : 0;
  const maxRatio = Math.max(dailyRatio, monthlyRatio);

  const result = {
    agentId,
    allowed: true,
    remaining: {
      daily: Math.max(0, limits.daily - usage.daily.tokens),
      monthly: Math.max(0, limits.monthly - usage.monthly.tokens),
    },
    usage: {
      daily: usage.daily.tokens,
      monthly: usage.monthly.tokens,
    },
    limits: {
      daily: limits.daily,
      monthly: limits.monthly,
    },
    ratios: {
      daily: Math.min(1, dailyRatio),
      monthly: Math.min(1, monthlyRatio),
    },
    degraded: false,
    model: null,
    alert: false,
    alertMessage: null,
    blocked: false,
  };

  // Check alert threshold
  if (maxRatio >= limits.alertThreshold) {
    result.alert = true;
    const which = dailyRatio >= monthlyRatio ? 'daily' : 'monthly';
    const pct = Math.round(maxRatio * 100);
    result.alertMessage = `Agent "${agentId}" at ${pct}% of ${which} quota (${usage[which].tokens}/${limits[which]} tokens)`;
  }

  // Check degrade threshold
  if (maxRatio >= limits.degradeThreshold && maxRatio < 1) {
    result.degraded = true;
    result.model = limits.degradeModel;
  }

  // Check cutoff (100%)
  if (dailyRatio >= 1 || monthlyRatio >= 1) {
    switch (limits.cutoffAction) {
      case 'block':
        result.allowed = false;
        result.blocked = true;
        result.model = null;
        break;
      case 'degrade':
        result.degraded = true;
        result.model = limits.degradeModel;
        result.allowed = true;
        break;
      case 'warn':
        result.alert = true;
        result.allowed = true;
        const warnWhich = dailyRatio >= 1 ? 'daily' : 'monthly';
        result.alertMessage = `Agent "${agentId}" EXCEEDED ${warnWhich} quota (${usage[warnWhich].tokens}/${limits[warnWhich]} tokens)`;
        break;
    }
  }

  return result;
}

// ── Reset Functions ──────────────────────────────────────────────

export function resetDaily(agentId) {
  if (agentId) {
    validateAgentId(agentId);
    const usage = loadUsage(agentId);
    // Archive current daily if it has data
    if (usage.daily.tokens > 0 || usage.daily.requests > 0) {
      usage.history.push({
        date: usage.daily.date,
        tokens: usage.daily.tokens,
        requests: usage.daily.requests,
      });
      if (usage.history.length > MAX_HISTORY_DAYS) {
        usage.history = usage.history.slice(-MAX_HISTORY_DAYS);
      }
    }
    usage.daily = {
      date: todayStr(),
      tokens: 0,
      requests: 0,
      byModel: {},
      byProvider: {},
    };
    saveUsage(agentId, usage);
    return [agentId];
  }

  // Reset all
  ensureDirs();
  const reset = [];
  if (existsSync(USAGE_DIR)) {
    for (const file of readdirSync(USAGE_DIR)) {
      if (!file.endsWith('.json')) continue;
      const id = file.replace(/\.json$/, '');
      try {
        validateAgentId(id);
        resetDaily(id);
        reset.push(id);
      } catch { /* skip invalid filenames */ }
    }
  }
  return reset;
}

export function resetMonthly(agentId) {
  if (agentId) {
    validateAgentId(agentId);
    const usage = loadUsage(agentId);
    usage.monthly = {
      month: thisMonthStr(),
      tokens: 0,
      requests: 0,
      byModel: {},
      byProvider: {},
    };
    saveUsage(agentId, usage);
    return [agentId];
  }

  // Reset all
  ensureDirs();
  const reset = [];
  if (existsSync(USAGE_DIR)) {
    for (const file of readdirSync(USAGE_DIR)) {
      if (!file.endsWith('.json')) continue;
      const id = file.replace(/\.json$/, '');
      try {
        validateAgentId(id);
        resetMonthly(id);
        reset.push(id);
      } catch { /* skip invalid filenames */ }
    }
  }
  return reset;
}

// ── Status & Alerts ──────────────────────────────────────────────

export function getAgentStatus(agentId) {
  validateAgentId(agentId);
  const quota = checkQuota(agentId);
  const usage = getUsage(agentId);

  return {
    agentId,
    daily: {
      used: usage.daily.tokens,
      limit: quota.limits.daily,
      remaining: quota.remaining.daily,
      ratio: quota.ratios.daily,
      requests: usage.daily.requests,
      byModel: usage.daily.byModel,
      byProvider: usage.daily.byProvider,
    },
    monthly: {
      used: usage.monthly.tokens,
      limit: quota.limits.monthly,
      remaining: quota.remaining.monthly,
      ratio: quota.ratios.monthly,
      requests: usage.monthly.requests,
      byModel: usage.monthly.byModel,
      byProvider: usage.monthly.byProvider,
    },
    alert: quota.alert,
    alertMessage: quota.alertMessage,
    degraded: quota.degraded,
    degradeModel: quota.model,
    blocked: quota.blocked,
    history: usage.history,
  };
}

export function getAllStatus() {
  ensureDirs();
  const statuses = [];

  if (!existsSync(USAGE_DIR)) return statuses;

  for (const file of readdirSync(USAGE_DIR)) {
    if (!file.endsWith('.json')) continue;
    const id = file.replace(/\.json$/, '');
    try {
      validateAgentId(id);
      statuses.push(getAgentStatus(id));
    } catch { /* skip invalid files */ }
  }

  // Also include agents with configured limits but no usage yet
  const config = loadConfig();
  for (const id of Object.keys(config.agents || {})) {
    if (!statuses.find(s => s.agentId === id)) {
      try {
        statuses.push(getAgentStatus(id));
      } catch { /* skip */ }
    }
  }

  return statuses.sort((a, b) => a.agentId.localeCompare(b.agentId));
}

export function getAlerts(threshold) {
  const statuses = getAllStatus();
  return statuses.filter(s => {
    const effectiveThreshold = threshold ?? loadQuotaConfig(s.agentId).alertThreshold;
    return s.daily.ratio >= effectiveThreshold || s.monthly.ratio >= effectiveThreshold;
  });
}

// ── Export/Import ────────────────────────────────────────────────

export function exportAll() {
  const config = loadConfig();
  const usage = {};

  ensureDirs();
  if (existsSync(USAGE_DIR)) {
    for (const file of readdirSync(USAGE_DIR)) {
      if (!file.endsWith('.json')) continue;
      const id = file.replace(/\.json$/, '');
      try {
        validateAgentId(id);
        usage[id] = loadUsage(id);
      } catch { /* skip */ }
    }
  }

  return {
    exportVersion: 1,
    exportedAt: new Date().toISOString(),
    config,
    usage,
  };
}

export function importAll(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Import data must be a non-null object');
  }
  if (data.exportVersion !== 1) {
    throw new Error(`Unsupported export version: ${data.exportVersion}`);
  }
  if (!data.config || typeof data.config !== 'object') {
    throw new Error('Import data missing config');
  }
  if (!data.usage || typeof data.usage !== 'object') {
    throw new Error('Import data missing usage');
  }

  ensureDirs();

  // Validate config structure before writing
  if (data.config.version !== CURRENT_CONFIG_VERSION) {
    throw new Error(`Unsupported config version in import: ${data.config.version}`);
  }

  saveConfig(data.config);

  for (const [id, usageData] of Object.entries(data.usage)) {
    try {
      validateAgentId(id);
      if (usageData.version !== CURRENT_USAGE_VERSION) {
        throw new Error(`Unsupported usage version for ${id}: ${usageData.version}`);
      }
      saveUsage(id, usageData);
    } catch (err) {
      // Skip invalid entries but continue import
      process.stderr.write(`Warning: skipped import for "${id}": ${err.message}\n`);
    }
  }

  return { configImported: true, agentsImported: Object.keys(data.usage).length };
}

// ── Cleanup (for deprovision) ────────────────────────────────────

export function removeAgentData(agentId) {
  validateAgentId(agentId);

  // Remove usage file
  const usagePath = getUsagePath(agentId);
  try {
    unlinkSync(usagePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  // Remove from config overrides
  const config = loadConfig();
  if (config.agents?.[agentId]) {
    delete config.agents[agentId];
    saveConfig(config);
  }

  return true;
}

// ── Initialize (for provision) ───────────────────────────────────

export function initializeAgent(agentId, overrides) {
  validateAgentId(agentId);
  ensureDirs();

  // Create empty usage file
  const usage = createEmptyUsage(agentId);
  saveUsage(agentId, usage);

  // Set per-agent limits if provided
  if (overrides && Object.keys(overrides).length > 0) {
    setLimits(agentId, overrides);
  }

  return { agentId, usage, limits: loadQuotaConfig(agentId) };
}

// ── CLI ──────────────────────────────────────────────────────────

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatRatio(r) {
  return `${Math.round(r * 100)}%`;
}

function printStatus(status) {
  const { agentId, daily, monthly, alert, alertMessage, degraded, degradeModel, blocked } = status;
  const flags = [];
  if (blocked) flags.push('🚫 BLOCKED');
  if (degraded) flags.push(`⚠️  DEGRADED → ${degradeModel}`);
  if (alert && !blocked && !degraded) flags.push('🔔 ALERT');

  console.log(`\n  Agent: ${agentId} ${flags.join(' ')}`);
  console.log(`  Daily:   ${formatTokens(daily.used)} / ${formatTokens(daily.limit)} (${formatRatio(daily.ratio)}) — ${daily.requests} requests`);
  console.log(`  Monthly: ${formatTokens(monthly.used)} / ${formatTokens(monthly.limit)} (${formatRatio(monthly.ratio)}) — ${monthly.requests} requests`);

  if (Object.keys(daily.byModel).length > 0) {
    console.log('  Models (today):');
    for (const [model, data] of Object.entries(daily.byModel)) {
      console.log(`    ${model}: ${formatTokens(data.tokens)} (${data.requests} req)`);
    }
  }
  if (Object.keys(daily.byProvider).length > 0) {
    console.log('  Providers (today):');
    for (const [prov, data] of Object.entries(daily.byProvider)) {
      console.log(`    ${prov}: ${formatTokens(data.tokens)} (${data.requests} req)`);
    }
  }

  if (alertMessage) {
    console.log(`  ⚠️  ${alertMessage}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(`Usage: buddy-quotas.mjs <command> [options]

Commands:
  status [--agent-id <id>]              Show usage vs limits
  set --agent-id <id> [options]         Set per-agent limits
  set --default [options]               Set default limits
  reset --agent-id <id>                 Reset agent counters
  reset --all --period <daily|monthly>  Reset all counters
  record --agent-id <id> --tokens <n> --model <m> --provider <p>
  alerts                                Show threshold alerts
  export                                Dump all data as JSON
  import --file <path>                  Restore from JSON`);
    process.exit(0);
  }

  try {
    switch (command) {
      case 'status': {
        const { values } = parseArgs({
          args: args.slice(1),
          options: { 'agent-id': { type: 'string' } },
          strict: false,
        });
        if (values['agent-id']) {
          printStatus(getAgentStatus(values['agent-id']));
        } else {
          const all = getAllStatus();
          if (all.length === 0) {
            console.log('No agents with quota data found.');
          } else {
            console.log(`Buddy Bot Quota Status (${all.length} agents):`);
            for (const s of all) printStatus(s);
          }
        }
        break;
      }

      case 'set': {
        const { values } = parseArgs({
          args: args.slice(1),
          options: {
            'agent-id': { type: 'string' },
            'default': { type: 'boolean', default: false },
            daily: { type: 'string' },
            monthly: { type: 'string' },
            'alert-threshold': { type: 'string' },
            'degrade-threshold': { type: 'string' },
            'degrade-model': { type: 'string' },
            'cutoff-action': { type: 'string' },
          },
          strict: false,
        });

        const limits = {};
        if (values.daily) limits.daily = parseInt(values.daily, 10);
        if (values.monthly) limits.monthly = parseInt(values.monthly, 10);
        if (values['alert-threshold']) limits.alertThreshold = parseFloat(values['alert-threshold']);
        if (values['degrade-threshold']) limits.degradeThreshold = parseFloat(values['degrade-threshold']);
        if (values['degrade-model']) limits.degradeModel = values['degrade-model'];
        if (values['cutoff-action']) limits.cutoffAction = values['cutoff-action'];

        if (Object.keys(limits).length === 0) {
          console.error('Error: no limits specified. Use --daily, --monthly, etc.');
          process.exit(1);
        }

        if (values['default']) {
          const result = setDefaults(limits);
          console.log('Default limits updated:', JSON.stringify(result, null, 2));
        } else if (values['agent-id']) {
          const result = setLimits(values['agent-id'], limits);
          console.log(`Limits for "${values['agent-id']}" updated:`, JSON.stringify(result, null, 2));
        } else {
          console.error('Error: specify --agent-id <id> or --default');
          process.exit(1);
        }
        break;
      }

      case 'reset': {
        const { values } = parseArgs({
          args: args.slice(1),
          options: {
            'agent-id': { type: 'string' },
            all: { type: 'boolean', default: false },
            period: { type: 'string' },
          },
          strict: false,
        });

        if (values['agent-id']) {
          resetDaily(values['agent-id']);
          resetMonthly(values['agent-id']);
          console.log(`Counters reset for agent "${values['agent-id']}".`);
        } else if (values.all) {
          const period = values.period || 'daily';
          if (period === 'daily') {
            const reset = resetDaily(null);
            console.log(`Daily counters reset for ${reset.length} agents: ${reset.join(', ') || 'none'}`);
          } else if (period === 'monthly') {
            const reset = resetMonthly(null);
            console.log(`Monthly counters reset for ${reset.length} agents: ${reset.join(', ') || 'none'}`);
          } else {
            console.error(`Error: invalid period "${period}". Use "daily" or "monthly".`);
            process.exit(1);
          }
        } else {
          console.error('Error: specify --agent-id <id> or --all');
          process.exit(1);
        }
        break;
      }

      case 'record': {
        const { values } = parseArgs({
          args: args.slice(1),
          options: {
            'agent-id': { type: 'string' },
            tokens: { type: 'string' },
            model: { type: 'string' },
            provider: { type: 'string' },
          },
          strict: false,
        });

        if (!values['agent-id'] || !values.tokens || !values.model || !values.provider) {
          console.error('Error: --agent-id, --tokens, --model, and --provider are all required');
          process.exit(1);
        }

        const tokens = parseInt(values.tokens, 10);
        const usage = recordUsage(values['agent-id'], tokens, values.model, values.provider);
        console.log(`Recorded ${formatTokens(tokens)} tokens for "${values['agent-id']}" (${values.model} via ${values.provider})`);
        console.log(`Daily total: ${formatTokens(usage.daily.tokens)} | Monthly total: ${formatTokens(usage.monthly.tokens)}`);
        break;
      }

      case 'alerts': {
        const alerts = getAlerts();
        if (alerts.length === 0) {
          console.log('No quota alerts. All agents within limits.');
        } else {
          console.log(`Quota Alerts (${alerts.length} agents):`);
          for (const s of alerts) printStatus(s);
        }
        break;
      }

      case 'export': {
        const data = exportAll();
        console.log(JSON.stringify(data, null, 2));
        break;
      }

      case 'import': {
        const { values } = parseArgs({
          args: args.slice(1),
          options: { file: { type: 'string' } },
          strict: false,
        });

        if (!values.file) {
          console.error('Error: --file <path> is required');
          process.exit(1);
        }

        const data = JSON.parse(readFileSync(values.file, 'utf8'));
        const result = importAll(data);
        console.log(`Import complete: config imported, ${result.agentsImported} agent(s) restored.`);
        break;
      }

      default:
        console.error(`Unknown command: "${command}". Run with --help for usage.`);
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

// Run CLI if invoked directly
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main();
}
