// Entrypoint web_search provider sanitizer regression test (RSI-279137 evidence).
//
// SEC-WAVE fleet incident 2026-10-22: OpenClaw v2026.7.1-2 hard-fails gateway
// boot when tools.web.search.provider references a provider whose plugin is NOT
// bundled in the EverClaw image (e.g. "parallel-free" from the external
// @openclaw/parallel-plugin). docker-entrypoint.sh strips unsupported providers
// at boot. This test extracts the REAL jq program from the entrypoint and pins
// its behavior so a future OpenClaw bump that changes the bundled provider set
// cannot silently regress the sanitizer.
//
// Bundled providers (verbatim, must match entrypoint + this test):
//   searxng, kimi, firecrawl
// If OpenClaw bundles more providers in a future version, update BOTH the
// entrypoint allowlist and this test's KEEP set.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = readFileSync(path.join(root, "scripts/docker-entrypoint.sh"), "utf8");

// Extract the jq program from the WEB_SEARCH_REPAIR_FILTER variable verbatim.
// The filter is applied by the shared repair_json_config() helper.
const m = entrypoint.match(/WEB_SEARCH_REPAIR_FILTER='\n([\s\S]*?)\n'/);
assert.ok(m, "web_search sanitizer jq block not found in docker-entrypoint.sh");
const JQ_PROG = m[1];

// Structural markers (Stage 5 audit finding: extraction regex alone is fragile —
// if the entrypoint is reformatted and the regex grabs the wrong text, these
// markers must all be present or the extraction is rejected).
assert.ok(JQ_PROG.includes(". as $root"), "extracted program missing explicit-root form");
assert.ok(JQ_PROG.includes("del(.tools.web.search.provider)"), "extracted program missing del()");
assert.ok(JQ_PROG.includes('(["searxng", "kimi", "firecrawl"]'), "extracted program missing allowlist");
assert.ok(!JQ_PROG.includes("'"), "extracted program contains a single quote (breaks wrapper-test quoting)");

// Extract the shared repair_json_config() shell helper verbatim so the
// WRAPPER (valid-JSON guard, mktemp/diff/mv atomic swap, return codes) is
// tested end-to-end — not just the isolated jq filter (Stage 5 audit finding).
const fn = entrypoint.match(/^repair_json_config\(\) \{\n([\s\S]*?)\n\}/m);
assert.ok(fn, "repair_json_config() helper not found in docker-entrypoint.sh");
const HELPER = `repair_json_config() {\n${fn[1]}\n}`;

// Run the REAL helper + REAL filter against a temp config file.
// Returns { code, out, after } — out is the echo line, after is file content.
function runHelper(initialContent) {
  const dir = path.join(execFileSync("mktemp", ["-d"]).toString().trim());
  const cfg = path.join(dir, "openclaw.json");
  if (initialContent !== null) writeFileSync(cfg, initialContent);
  const script = `set -eu\n${HELPER}\nCONFIG_FILE=${JSON.stringify(cfg)}\nif repair_json_config '${JQ_PROG}'; then echo CHANGED; else echo UNCHANGED; fi\n`;
  let code = 0, out = "";
  try {
    out = execFileSync("bash", ["-c", script], { encoding: "utf8" }).trim();
  } catch (e) {
    code = e.status ?? 1;
  }
  let after = null;
  try { after = readFileSync(cfg, "utf8"); } catch { after = null; }
  rmSync(dir, { recursive: true, force: true });
  return { code, out, after };
}

const jq = (json) =>
  execFileSync("jq", ["-c", JQ_PROG], { input: json, encoding: "utf8" }).trim();

const cases = [
  // [name, input, expect: "stripped" | "kept" | "unchanged"]
  ["parallel-free stripped", { tools: { web: { search: { provider: "parallel-free" } } } }, "stripped"],
  ["parallel stripped (plugin id)", { tools: { web: { search: { provider: "parallel" } } } }, "stripped"],
  ["tavily stripped", { tools: { web: { search: { provider: "tavily" } } } }, "stripped"],
  ["exa stripped", { tools: { web: { search: { provider: "exa" } } } }, "stripped"],
  ["perplexity stripped", { tools: { web: { search: { provider: "perplexity" } } } }, "stripped"],
  ["empty string stripped (separately blocks boot)", { tools: { web: { search: { provider: "" } } } }, "stripped"],
  ["whitespace-only stripped", { tools: { web: { search: { provider: "   " } } } }, "stripped"],
  ["searxng kept", { tools: { web: { search: { provider: "searxng" } } } }, "kept"],
  ["kimi kept", { tools: { web: { search: { provider: "kimi" } } } }, "kept"],
  ["firecrawl kept", { tools: { web: { search: { provider: "firecrawl" } } } }, "kept"],
  ["whitespace-padded searxng kept (trim)", { tools: { web: { search: { provider: "  searxng  " } } } }, "kept"],
  ["provider absent unchanged", { tools: { web: {} } }, "unchanged"],
  ["provider null unchanged", { tools: { web: { search: { provider: null } } } }, "unchanged"],
  ["provider non-string unchanged (validation ignores)", { tools: { web: { search: { provider: { nested: true } } } } }, "unchanged"],
  ["no tools key unchanged", { gateway: { controlUi: { enabled: true } } }, "unchanged"],
  ["no config at all unchanged", {}, "unchanged"],
];

for (const [name, input, expect] of cases) {
  test(`sanitizer: ${name}`, () => {
    const inputJson = JSON.stringify(input);
    const output = jq(inputJson);
    const out = JSON.parse(output);
    const hasProvider = out?.tools?.web?.search?.provider !== undefined;
    if (expect === "stripped") {
      assert.equal(hasProvider, false, `provider should be stripped; got ${output}`);
    } else if (expect === "kept") {
      assert.equal(hasProvider, true, `provider should be kept; got ${output}`);
      // KEPT values must round-trip to the same trimmed provider.
      assert.equal(String(out.tools.web.search.provider).trim(), String(input.tools.web.search.provider).trim());
    } else {
      // unchanged: byte-identical JSON semantics
      assert.deepEqual(out, input, `document should be unchanged; got ${output}`);
    }
  });
}

// The KEEP allowlist in this test must match the entrypoint comment + the
// jq program's literal array. If they diverge, the test suite catches it.
const KEEP_CASES = cases.filter(([, , expect]) => expect === "kept").map(([name]) => name);
test("sanitizer allowlist is consistent", () => {
  assert.ok(entrypoint.includes('["searxng", "kimi", "firecrawl"]'), "entrypoint jq allowlist mismatch");
  assert.ok(JQ_PROG.includes('["searxng", "kimi", "firecrawl"]'), "extracted jq program allowlist mismatch");
});

// Stage 5 audit finding #1 (blocking): the WRAPPER (repair_json_config) was
// never tested — only the isolated jq filter. These tests source the REAL
// helper from the entrypoint and run it end-to-end against temp configs.
test("wrapper: strips poisoned provider end-to-end (parallel-free)", () => {
  const poisoned = JSON.stringify({ tools: { web: { search: { provider: "parallel-free" } } }, gateway: { controlUi: { enabled: true } } });
  const { out, after } = runHelper(poisoned);
  assert.equal(out, "CHANGED");
  const doc = JSON.parse(after); // output must still be valid JSON
  assert.equal(doc?.tools?.web?.search?.provider, undefined, "provider should be stripped");
  assert.equal(doc.gateway.controlUi.enabled, true, "rest of config preserved");
});

test("wrapper: no-change config returns UNCHANGED, file byte-identical", () => {
  // Fixture is written in jq's default pretty format: the helper's diff-guard
  // compares bytes, and jq reformats compact input on first pass (pre-existing
  // behavior, stable from the second boot). The no-op path is exercised with
  // an already-jq-formatted file.
  const doc = { tools: { web: { search: { provider: "searxng" } } } };
  const clean = execFileSync("jq", ["."], { input: JSON.stringify(doc), encoding: "utf8" });
  const { out, after } = runHelper(clean);
  assert.equal(out, "UNCHANGED");
  assert.equal(after, clean, "file must be byte-identical on no-op");
});

test("wrapper: malformed JSON returns UNCHANGED, file untouched", () => {
  const broken = "{not json at all";
  const { out, after } = runHelper(broken);
  assert.equal(out, "UNCHANGED");
  assert.equal(after, broken, "malformed config must be left intact");
});

test("wrapper: missing config file returns UNCHANGED, no crash", () => {
  const { out, after } = runHelper(null);
  assert.equal(out, "UNCHANGED");
  assert.equal(after, null, "no file should be created");
});

test("wrapper: failing jq filter leaves config untouched (error path)", () => {
  const cfg = JSON.stringify({ tools: { web: { search: { provider: "parallel-free" } } } });
  // Simulate a jq runtime failure: a filter that errors on this input
  // (gsub on a number). The helper must swallow it and leave the file intact.
  const bad = '.tools.count |= (gsub("x"; "y"))';
  const dir = path.join(execFileSync("mktemp", ["-d"]).toString().trim());
  const file = path.join(dir, "openclaw.json");
  writeFileSync(file, JSON.stringify({ tools: { count: 5 } }));
  const script = `set -eu\n${HELPER}\nCONFIG_FILE=${JSON.stringify(file)}\nif repair_json_config '${bad}'; then echo CHANGED; else echo UNCHANGED; fi\n`;
  const out = execFileSync("bash", ["-c", script], { encoding: "utf8" }).trim();
  const after = readFileSync(file, "utf8");
  rmSync(dir, { recursive: true, force: true });
  assert.equal(out, "UNCHANGED");
  assert.equal(after, JSON.stringify({ tools: { count: 5 } }), "file untouched on jq failure");
});

// Stage 5 audit finding (style): the cases matrix and the allowlist are two
// lists that can drift. Cross-check: every allowlisted provider has a kept case.
test("matrix covers every allowlisted provider as kept", () => {
  for (const p of ["searxng", "kimi", "firecrawl"]) {
    const hasKeep = KEEP_CASES.some((n) => n.includes(p));
    assert.ok(hasKeep, `no kept case for bundled provider '${p}' — matrix/allowlist drift`);
  }
});
