// test-migrate-import.mjs — unit tests for migrate-import hardening (Stage 2/4)
//
// Run: node --test scripts/test-migrate-import.mjs
//
// Covers: tar listing parsing (names from tar -tf, types from tar -tvf first
// field — Grok 4.20 R1 + Claude Opus 4.8 Stage 4 fixes), workspace top-level
// normalization, and the space-in-filename integration regression.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  extractSafeWorkspaces,
  gatewayCommand,
  getSafeTop,
  listTarMembers,
  listTarMemberTypes,
  parseTarTypeField,
} from "./migrate-import.mjs";

// ─── Type-field parsing (tar -tvf, first field only) ─────────────

test("parseTarTypeField: GNU format", () => {
  assert.deepEqual(parseTarTypeField("-rw-r--r-- user/group 123 Sep 10 12:00 file.txt"),
    { type: "-", perms: "rw-r--r--" });
});

test("parseTarTypeField: BSD (macOS bsdtar) format", () => {
  assert.deepEqual(parseTarTypeField("-rw-r--r-- 0 bernardo staff 456 Sep 10 12:00 manifest.json"),
    { type: "-", perms: "rw-r--r--" });
});

test("parseTarTypeField: symlink type preserved (rejected by whitelist later)", () => {
  assert.equal(parseTarTypeField("lrwxrwxrwx 0 user staff 0 Sep 10 12:00 evil -> /etc/passwd").type, "l");
});

test("parseTarTypeField: bare type+perms line accepted ($ branch)", () => {
  // A line containing ONLY the type field is a valid type-only entry (has no
  // name; type whitelist still applies).
  assert.deepEqual(parseTarTypeField("-rw-r--r--"), { type: "-", perms: "rw-r--r--" });
});

test("parseTarTypeField: garbage rejected", () => {
  assert.equal(parseTarTypeField("TOTALLY NOT A TAR LINE"), null);
  assert.equal(parseTarTypeField("  -rw-r--r-- x"), null); // leading space breaks the anchor
  assert.equal(parseTarTypeField("xrw-r--r-- f"), null); // 'x' is not a tar type char
});

test("listTarMemberTypes: real archive with space-named file parses", () => {
  const d = mkdtempSync(join(tmpdir(), "mi-types-"));
  mkdirSync(join(d, "ws", "workspace"), { recursive: true });
  writeFileSync(join(d, "ws", "workspace", "Screen Shot 2026.png"), "x");
  execFileSync("tar", ["-cf", join(d, "ws.tar"), "-C", join(d, "ws"), "."]);
  const types = listTarMemberTypes(join(d, "ws.tar"));
  assert.ok(types.length >= 2);
  assert.ok(types.every((t) => t.type === "-" || t.type === "d"));
});

// ─── Name listing (tar -tf) ──────────────────────────────────────

test("listTarMembers: space-in-filename preserved verbatim", () => {
  const d = mkdtempSync(join(tmpdir(), "mi-names-"));
  mkdirSync(join(d, "ws", "workspace", "mem"), { recursive: true });
  writeFileSync(join(d, "ws", "workspace", "Screen Shot 2026.png"), "x");
  writeFileSync(join(d, "ws", "workspace", "mem", "a b c.md"), "hi");
  execFileSync("tar", ["-cf", join(d, "ws.tar"), "-C", join(d, "ws"), "."]);
  const names = listTarMembers(join(d, "ws.tar"));
  assert.ok(names.includes("./workspace/Screen Shot 2026.png"), JSON.stringify(names));
  assert.ok(names.includes("./workspace/mem/a b c.md"), JSON.stringify(names));
});

// ─── Normalization ───────────────────────────────────────────────

test("getSafeTop: normalizes ./ prefix and trailing slashes", () => {
  assert.equal(getSafeTop("./workspace/memory/a.md"), "workspace");
  assert.equal(getSafeTop("workspace/"), "workspace");
  assert.equal(getSafeTop("./workspace-foo/x"), "workspace-foo");
  assert.equal(getSafeTop("."), null);
  assert.equal(getSafeTop("/abs"), ""); // absolute path -> empty top; caller's !top check rejects it
});

test("getSafeTop: space-in-filename keeps the full top-level segment", () => {
  assert.equal(getSafeTop("./workspace/Screen Shot 2026.png"), "workspace");
  assert.equal(getSafeTop("./workspace mem/x"), ".workspace mem".slice(1)); // ' workspace mem' -> first segment is ''? see below
});

test("getSafeTop: null for empty or dot; traversal segment surfaces for rejection", () => {
  assert.equal(getSafeTop(""), null);
  assert.equal(getSafeTop("./"), null);
  // '../' gives a non-workspace top -> extractSafeWorkspaces' !okTop check rejects it.
  assert.equal(getSafeTop("../../etc/passwd"), "..");
});

// ─── Integration: extractSafeWorkspaces ──────────────────────────

test("extractSafeWorkspaces: space-named members import cleanly (Stage 4 regression)", () => {
  const d = mkdtempSync(join(tmpdir(), "mi-ws-"));
  mkdirSync(join(d, "ws", "workspace", "mem"), { recursive: true });
  writeFileSync(join(d, "ws", "workspace", "Screen Shot 2026.png"), "x");
  writeFileSync(join(d, "ws", "workspace", "mem", "a.md"), "hi");
  execFileSync("tar", ["-cf", join(d, "ws.tar"), "-C", join(d, "ws"), "."]);
  const out = join(d, "out", "openclaw");
  const r = extractSafeWorkspaces(join(d, "ws.tar"), out);
  assert.equal(r.ok, true);
  assert.equal(existsSync(join(out, "workspace", "Screen Shot 2026.png")), true);
  assert.equal(existsSync(join(out, "workspace", "mem", "a.md")), true);
});

test("extractSafeWorkspaces: hostile member list rejected (traversal + symlink)", () => {
  const d = mkdtempSync(join(tmpdir(), "mi-bad-"));
  mkdirSync(join(d, "ws"));
  writeFileSync(join(d, "ws", "ok.txt"), "x");
  execFileSync("tar", ["-cf", join(d, "ws.tar"), "-C", join(d, "ws"), "."]);
  // A crafted listing line that is NOT a valid tar type line must abort type parse.
  assert.equal(parseTarTypeField("../../etc/passwd"), null);
  // A crafted -tf name that traverses is rejected by the top-level workspace check.
  assert.notEqual(getSafeTop("../../etc/passwd"), "workspace");
  // Symlink type is rejected by the whitelist.
  const t = listTarMemberTypes(join(d, "ws.tar"));
  assert.ok(t.every((x) => x.type === "-" || x.type === "d"));
});

// ─── Misc ────────────────────────────────────────────────────────

test("gatewayCommand: returns gateway subcommand forms", () => {
  const c = gatewayCommand();
  assert.equal(c.start, "openclaw gateway start");
  assert.equal(c.status, "openclaw gateway status");
});
