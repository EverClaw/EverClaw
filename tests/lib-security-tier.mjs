import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, "..", "templates");
const TIER_SCRIPT = join(__dirname, "..", "scripts", "security-tier.mjs");

// ─── Template Validation ─────────────────────────────────────────────────────

describe("Security tier templates", () => {
  const tiers = ["low", "recommended", "maximum"];

  for (const tier of tiers) {
    describe(`exec-approvals-${tier}.json`, () => {
      const filePath = join(TEMPLATES_DIR, `exec-approvals-${tier}.json`);
      let template;

      it("exists", () => {
        assert.ok(existsSync(filePath), `Template missing: ${filePath}`);
      });

      it("is valid JSON", () => {
        template = JSON.parse(readFileSync(filePath, "utf-8"));
        assert.ok(template);
      });

      it("has correct tier value", () => {
        template = JSON.parse(readFileSync(filePath, "utf-8"));
        assert.equal(template.tier, tier);
      });

      it("has schema version", () => {
        template = JSON.parse(readFileSync(filePath, "utf-8"));
        assert.equal(template.$schema, "everclaw-security-tier-v1");
      });

      it("has config.ask set", () => {
        template = JSON.parse(readFileSync(filePath, "utf-8"));
        assert.ok(
          ["off", "on-miss", "always"].includes(template.config.ask),
          `Invalid ask value: ${template.config.ask}`
        );
      });

      it("has config.strictInlineEval set", () => {
        template = JSON.parse(readFileSync(filePath, "utf-8"));
        assert.equal(typeof template.config.strictInlineEval, "boolean");
      });

      it("has bins array", () => {
        template = JSON.parse(readFileSync(filePath, "utf-8"));
        assert.ok(Array.isArray(template.bins));
        assert.ok(template.bins.length > 0, "bins array is empty");
      });

      it("has blocked array", () => {
        template = JSON.parse(readFileSync(filePath, "utf-8"));
        assert.ok(Array.isArray(template.blocked));
        assert.ok(template.blocked.length > 0, "blocked array is empty");
      });

      it("blocks rm in all tiers", () => {
        template = JSON.parse(readFileSync(filePath, "utf-8"));
        assert.ok(template.blocked.includes("rm"), `rm not blocked in ${tier} tier`);
      });

      it("blocks sudo in all tiers", () => {
        template = JSON.parse(readFileSync(filePath, "utf-8"));
        assert.ok(template.blocked.includes("sudo"), `sudo not blocked in ${tier} tier`);
      });

      it("blocks docker in all tiers", () => {
        template = JSON.parse(readFileSync(filePath, "utf-8"));
        assert.ok(template.blocked.includes("docker"), `docker not blocked in ${tier} tier`);
      });

      it("blocks dd in all tiers", () => {
        template = JSON.parse(readFileSync(filePath, "utf-8"));
        assert.ok(template.blocked.includes("dd"), `dd not blocked in ${tier} tier`);
      });
    });
  }

  // ─── Tier-specific assertions ────────────────────────────────────────────

  describe("Low tier specifics", () => {
    let template;
    it("ask is off", () => {
      template = JSON.parse(readFileSync(join(TEMPLATES_DIR, "exec-approvals-low.json"), "utf-8"));
      assert.equal(template.config.ask, "off");
    });

    it("strictInlineEval is false", () => {
      template = JSON.parse(readFileSync(join(TEMPLATES_DIR, "exec-approvals-low.json"), "utf-8"));
      assert.equal(template.config.strictInlineEval, false);
    });

    it("allows node, git, python3, curl", () => {
      template = JSON.parse(readFileSync(join(TEMPLATES_DIR, "exec-approvals-low.json"), "utf-8"));
      for (const bin of ["node", "git", "python3", "curl"]) {
        assert.ok(template.bins.includes(bin), `${bin} not in low tier bins`);
      }
    });
  });

  describe("Recommended tier specifics", () => {
    let template;
    it("ask is on-miss", () => {
      template = JSON.parse(readFileSync(join(TEMPLATES_DIR, "exec-approvals-recommended.json"), "utf-8"));
      assert.equal(template.config.ask, "on-miss");
    });

    it("strictInlineEval is false", () => {
      template = JSON.parse(readFileSync(join(TEMPLATES_DIR, "exec-approvals-recommended.json"), "utf-8"));
      assert.equal(template.config.strictInlineEval, false);
    });
  });

  describe("Maximum tier specifics", () => {
    let template;
    it("ask is on-miss", () => {
      template = JSON.parse(readFileSync(join(TEMPLATES_DIR, "exec-approvals-maximum.json"), "utf-8"));
      assert.equal(template.config.ask, "on-miss");
    });

    it("strictInlineEval is true", () => {
      template = JSON.parse(readFileSync(join(TEMPLATES_DIR, "exec-approvals-maximum.json"), "utf-8"));
      assert.equal(template.config.strictInlineEval, true);
    });

    it("autoAllowSkills is false", () => {
      template = JSON.parse(readFileSync(join(TEMPLATES_DIR, "exec-approvals-maximum.json"), "utf-8"));
      assert.equal(template.config.autoAllowSkills, false);
    });

    it("blocks node and git", () => {
      template = JSON.parse(readFileSync(join(TEMPLATES_DIR, "exec-approvals-maximum.json"), "utf-8"));
      assert.ok(template.blocked.includes("node"), "node not blocked in maximum tier");
      assert.ok(template.blocked.includes("git"), "git not blocked in maximum tier");
    });
  });
});

// ─── Config Template Validation ──────────────────────────────────────────────

describe("OpenClaw config templates", () => {
  const configs = [
    "openclaw-config-mac.json",
    "openclaw-config-linux.json",
    "openclaw-config-gateway-only.json",
  ];

  for (const configFile of configs) {
    describe(configFile, () => {
      const filePath = join(TEMPLATES_DIR, configFile);
      let config;

      it("exists", () => {
        assert.ok(existsSync(filePath), `Config missing: ${filePath}`);
      });

      it("is valid JSON", () => {
        config = JSON.parse(readFileSync(filePath, "utf-8"));
        assert.ok(config);
      });

      it("has tools.exec.ask set to off", () => {
        config = JSON.parse(readFileSync(filePath, "utf-8"));
        assert.equal(config.tools?.exec?.ask, "off", `tools.exec.ask not set to off in ${configFile}`);
      });

      it("has tools.exec.strictInlineEval set to false", () => {
        config = JSON.parse(readFileSync(filePath, "utf-8"));
        assert.equal(config.tools?.exec?.strictInlineEval, false, `strictInlineEval not false in ${configFile}`);
      });

      it("has agents.defaults.model.primary set", () => {
        config = JSON.parse(readFileSync(filePath, "utf-8"));
        assert.ok(config.agents?.defaults?.model?.primary, `No primary model in ${configFile}`);
      });

      it("has agents.defaults.timeoutSeconds >= 180", () => {
        config = JSON.parse(readFileSync(filePath, "utf-8"));
        assert.ok(
          config.agents?.defaults?.timeoutSeconds >= 180,
          `Timeout too low in ${configFile}: ${config.agents?.defaults?.timeoutSeconds}`
        );
      });
    });
  }
});

// ─── CLI Invocation Tests ────────────────────────────────────────────────────

describe("security-tier.mjs CLI", () => {
  it("--status runs without error", () => {
    const result = execSync(`node ${TIER_SCRIPT} --status`, {
      encoding: "utf-8",
      timeout: 10000,
    });
    assert.ok(result.includes("Security Status"), "Missing status output");
  });

  it("--tier low --apply --dry-run succeeds", () => {
    const result = execSync(`node ${TIER_SCRIPT} --tier low --apply --dry-run`, {
      encoding: "utf-8",
      timeout: 15000,
    });
    assert.ok(result.includes("Low Security"), "Missing tier label");
  });

  it("--tier recommended --apply --dry-run succeeds", () => {
    const result = execSync(`node ${TIER_SCRIPT} --tier recommended --apply --dry-run`, {
      encoding: "utf-8",
      timeout: 15000,
    });
    assert.ok(result.includes("Recommended"), "Missing tier label");
  });

  it("--tier maximum --apply --dry-run succeeds", () => {
    const result = execSync(`node ${TIER_SCRIPT} --tier maximum --apply --dry-run`, {
      encoding: "utf-8",
      timeout: 15000,
    });
    assert.ok(result.includes("Maximum"), "Missing tier label");
  });

  it("invalid tier shows error", () => {
    assert.throws(
      () => execSync(`node ${TIER_SCRIPT} --tier invalid --apply --dry-run`, {
        encoding: "utf-8",
        timeout: 10000,
      }),
      "Should fail on invalid tier"
    );
  });
});
