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
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = readFileSync(path.join(root, "scripts/docker-entrypoint.sh"), "utf8");

// Extract the jq program from the TMP_WS sanitizer block verbatim.
// Comment lines use [^\n]* (dotAll would let .* span blocks and grab the
// wrong jq program — the Streaming/Timeout block later in the file).
const m = entrypoint.match(/TMP_WS=\$\(mktemp\)\n(?:  # [^\n]*\n)*  if jq '\n([\s\S]*?)\n  ' "\$CONFIG_FILE"/);
assert.ok(m, "web_search sanitizer jq block not found in docker-entrypoint.sh");
const JQ_PROG = m[1];

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
test("sanitizer allowlist is consistent", () => {
  assert.ok(entrypoint.includes('["searxng", "kimi", "firecrawl"]'), "entrypoint jq allowlist mismatch");
  assert.ok(JQ_PROG.includes('["searxng", "kimi", "firecrawl"]'), "extracted jq program allowlist mismatch");
});
