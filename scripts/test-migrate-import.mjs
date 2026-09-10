// test-migrate-import.mjs — unit tests for migrate-import hardening (Stage 2/3)
//
// Run: node --test scripts/test-migrate-import.mjs
//
// Covers the Grok 4.20 audit fixes: tar listing parsing (GNU + BSD formats,
// crafted newline smuggling rejected) and workspace top-level normalization.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTarVerboseLine, gatewayCommand, getSafeTop } from "./migrate-import.mjs";

test("parseTarVerboseLine: GNU format", () => {
  assert.deepEqual(parseTarVerboseLine("-rw-r--r-- user/group 123 Sep 10 12:00 file.txt"),
    { type: "-", perms: "rw-r--r--", name: "file.txt" });
});

test("parseTarVerboseLine: GNU directory with year date", () => {
  const p = parseTarVerboseLine("drwxr-xr-x user/group 0 Sep 10 2025 workspace");
  assert.equal(p.type, "d");
  assert.equal(p.name, "workspace");
});

test("parseTarVerboseLine: BSD (macOS bsdtar) format", () => {
  assert.deepEqual(parseTarVerboseLine("-rw-r--r-- 0 bernardo staff 456 Sep 10 12:00 manifest.json"),
    { type: "-", perms: "rw-r--r--", name: "manifest.json" });
});

test("parseTarVerboseLine: BSD with double-space date (Oct  1)", () => {
  const p = parseTarVerboseLine("drwxr-xr-x 0 user staff 0 Oct  1 2025 workspace-foo");
  assert.equal(p.type, "d");
  assert.equal(p.name, "workspace-foo");
});

test("parseTarVerboseLine: ISO date variant (2 tokens)", () => {
  const p = parseTarVerboseLine("-rw-r--r-- user/group 123 2026-09-10 12:00 iso.txt");
  assert.equal(p.name, "iso.txt");
});

test("parseTarVerboseLine: full-time variant (4 date tokens)", () => {
  const p = parseTarVerboseLine("-rw-r--r-- user/group 123 2026-09-10 12:00:00 file.txt");
  assert.equal(p.name, "file.txt");
});

test("parseTarVerboseLine: symlink parses with type l (rejected by whitelist later)", () => {
  const p = parseTarVerboseLine("lrwxrwxrwx user/group 0 Sep 10 12:00 evil -> /etc/passwd");
  assert.equal(p.type, "l");
});

test("parseTarVerboseLine: crafted garbage line is rejected", () => {
  assert.equal(parseTarVerboseLine("TOTALLY NOT A TAR LINE"), null);
  assert.equal(parseTarVerboseLine("-rw-r--r--"), null);
});

test("parseTarVerboseLine: newline-smuggled member breaks the full-line match", () => {
  // A crafted member name with an embedded newline prints as two lines.
  // The first line's "name" would be the truncated prefix — parse it and
  // confirm the type/name would fail the whitelist or expected-member check.
  const [l1, l2] = "-rw-r--r-- user/group 123 Sep 10 12:00 good\n../../etc/passwd".split("\n");
  const p1 = parseTarVerboseLine(l1);
  assert.equal(p1.name, "good"); // safe-looking, but...
  // ...the full member name cannot be discovered from the listing; the
  // embedded newline means `tar -tf` output cannot faithfully represent it.
  // listTarMembersVerbose rejects such lines via the strict full-line parse
  // of the SECOND line (which is not a valid tar listing line).
  assert.equal(parseTarVerboseLine(l2), null);
});

test("getSafeTop: normalizes ./ prefix and trailing slashes", () => {
  assert.equal(getSafeTop("./workspace/memory/a.md"), "workspace");
  assert.equal(getSafeTop("workspace/"), "workspace");
  assert.equal(getSafeTop("./workspace-foo/x"), "workspace-foo");
  assert.equal(getSafeTop("."), null);
  assert.equal(getSafeTop("/abs"), ""); // absolute path -> empty top; caller's !top check rejects it
});

test("getSafeTop: null for empty or dot", () => {
  assert.equal(getSafeTop(""), null);
  assert.equal(getSafeTop("./"), null);
});

test("gatewayCommand: returns gateway subcommand forms", () => {
  const c = gatewayCommand();
  assert.equal(c.start, "openclaw gateway start");
  assert.equal(c.status, "openclaw gateway status");
});
