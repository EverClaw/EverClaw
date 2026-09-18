# Download Agent Guide

**One page, read top to bottom. Do not skip steps.** This guide restores your
Download Agent bundle onto a fresh machine. It includes every dependency and
prerequisite, learned from real test runs on Debian.

---

## The one thing to remember

Your agent bundle is **NOT an openssl file**. It is **AES-256-GCM**, a custom
format. That is why `openssl enc -d -aes-256-cbc` always fails with
**"bad magic number"** — even with the correct passphrase. **Never use
`openssl` on it. Ever.** Use our script instead. Your bundle is almost
certainly fine; only the command was wrong.

---

## Step 0 — Check the machine has the 3 prerequisites

Run these three checks. Fix any that fail before continuing.

**1. Node.js version 22 or newer**

```bash
node --version
```

- `v22.x.x` or higher → OK.
- Missing or older → install Node 22 with **nvm** (works on every Debian
  version, including Debian 13 "trixie" where the NodeSource apt route fails):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc            # or open a new terminal
# If sourcing .bashrc silently does nothing (non-interactive shell), load nvm
# directly instead:  source ~/.nvm/nvm.sh
nvm install 22
nvm use 22
node --version              # should now print v22.x
```

> If you are on **Debian 12** and prefer apt: `curl -fsSL
> https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs`.
> Do not use this on Debian 13 — it is unsupported there.

**2. `curl`**

```bash
curl --version
```

- Prints a version → OK.
- `command not found` → install it:
  `apt-get update && apt-get install -y curl`

**3. OpenClaw itself (the app that runs your agent)**

```bash
openclaw --version
```

- Prints a version → OK. Skip ahead to Step 1.
- `command not found` → **do NOT install it yet.** Install it in Step 5,
  after the import, at the exact version your bundle pins. Doing it now risks
  installing the wrong version.

---

## Step 1 — Download 3 script files + get your bundle and passphrase

All three scripts are **required** — `migrate-import.mjs` loads the other two.
Download them all into **one folder**, and put your bundle in the same folder.
On a fresh Linux server use `/root` or a folder you own:

```bash
cd /root          # or the folder that holds your bundle
curl -fsSL -o migrate-import.mjs https://raw.githubusercontent.com/EverClaw/EverClaw/main/scripts/migrate-import.mjs
curl -fsSL -o migrate-export.mjs https://raw.githubusercontent.com/EverClaw/EverClaw/main/scripts/migrate-export.mjs
curl -fsSL -o paths.mjs          https://raw.githubusercontent.com/EverClaw/EverClaw/main/scripts/paths.mjs
ls -l migrate-*.mjs paths.mjs
```

- **Your bundle** — the `.tar.gz.enc` file you downloaded from the Dashboard.
  Put it in the same folder.
- **Your passphrase** — the one the Dashboard showed at download time. Lost it?
  Dashboard → **Download Agent** → run a fresh export for a new passphrase +
  bundle.
- ⚠️ **Permission denied reading the bundle?** Fix ownership/perms for **your**
  user (do not world-open your home):

  ```bash
  chmod u+rx "$HOME"           # you need traverse on home
  chmod u+r your-bundle.tar.gz.enc
  # If the bundle lives in a subfolder, also: chmod u+rx /path/to/folder
  ```

  If the bundle is owned by another user (for example it was downloaded by
  root while you run as a normal user), fix ownership instead:
  `sudo chown "$USER": your-bundle.tar.gz.enc`.

> ⚠️ **Zenity / "Failed to open display" error?** That is the GUI password
> popup failing because you are root without a desktop. Ignore it. This guide
> is 100% terminal-only; zenity is never involved.

---

## Step 2 — Health-check the file (2 seconds, NO passphrase needed)

```bash
node migrate-import.mjs --diagnose your-bundle.tar.gz.enc
```

(Replace `your-bundle.tar.gz.enc` with your real filename. Pro tip: type
`node migrate-import.mjs --diagnose ` then press **Tab** — the shell completes
the filename for you.)

Diagnose does **not** know your real passphrase and **cannot** fully validate
the bundle. It only rules out obvious bad downloads. Read the `kind` field in
the JSON output:

- ✅ **`wrong_passphrase`** → **expected** without the real passphrase. The
  file shape is OK (GCM auth failed on the throwaway probe). The passphrase
  is verified in Step 3. Go to Step 3.
- ❌ **`html` or `json`** → the download saved a web error page, not the bundle.
  Re-download (links expire after ~1 hour).
- ❌ **`too_small`** → the download got cut off. Re-download.
- ❌ **`openssl_salted`** → you grabbed the wrong file (an OpenSSL "Salted__"
  file). Re-download; never use `openssl` on migrate bundles.
- ❌ **`plain_gzip` / `unknown` / `unreadable`** → not a readable migrate
  bundle. Re-download, or re-export from the Dashboard.

Do **not** look for the strings "possible migrate bundle" or "valid bundle" —
the shipped script never prints them.

---

## Step 3 — Dry-run import (nothing changes yet)

Put the passphrase in an environment variable — safer than pasting it in a
command (it would be visible in `ps` and history), and it survives
multi-line passphrases. Paste it with a hidden prompt so it never lands in
shell history:

```bash
read -rs MIGRATE_PASSPHRASE   # paste your passphrase, press Enter (nothing echoes)
export MIGRATE_PASSPHRASE
node migrate-import.mjs --import your-bundle.tar.gz.enc --dry-run
unset MIGRATE_PASSPHRASE      # not needed anymore; do not leave it exported
```

(If you prefer, `export MIGRATE_PASSPHRASE='paste-here'` also works, but that
line lands in your shell history — scrub it afterwards as shown in Step 4.)

Passphrases must be at least 16 characters (enforced by the script). If the
Dashboard passphrase looks shorter, you likely truncated the copy.

- ✅ **Plan prints** and `checks` has no blocker with `ok: false` (in
  particular `config-conflict` is absent or `ok: true`) → passphrase
  correct, bundle works. Go to Step 4.
- ⚠️ **Plan prints, but `config-conflict` has `ok: false`** → passphrase and
  bundle are fine; dry-run does **not** stop on this. The real import in
  Step 4 **will** refuse to overwrite. Back up and move aside the existing
  OpenClaw config directory (default under `~/.openclaw/`), then re-run the
  dry-run until that check is clean before Step 4.
- ❌ **"wrong passphrase"** → re-copy the passphrase carefully (watch for a
  trailing space or a missing first character). Re-run the two commands above.
- ❌ **"passphrase required (min 16 chars"** → passphrase missing/truncated.
  Re-copy the full Dashboard passphrase (must be ≥ 16 characters).
- ❌ **"Cannot find module" (with `migrate-export.mjs` or `paths.mjs` in the
  path)** → you only downloaded one script. Go back to Step 1 and download
  **all 3** into the same folder.
- ❌ **Still stuck?** Jump to Step 6 and send us the packet.

---

## Step 4 — Real import

```bash
node migrate-import.mjs --import your-bundle.tar.gz.enc
```

The script restores your config, workspaces, and runbook. It also prints a
verification checklist — run through it. If it says **`openclaw NOT installed`**,
that is expected on a fresh machine; it does not mean the import failed. Your
data is now on disk and safe. Do **not** delete the bundle yet (see Step 5).

**Clean up the passphrase** once the import is done (do not leave it exported):

```bash
unset MIGRATE_PASSPHRASE
```

If you used the `export MIGRATE_PASSPHRASE='...'` form instead of `read -rs`,
that line landed in the shell history. Remove it before leaving the machine:
run `history | grep MIGRATE_PASSPHRASE`, note the line number(s), delete them
highest-first with `history -d <N>`, and after exiting the shell confirm
`~/.bash_history` has no MIGRATE_PASSPHRASE line.

---

## Step 5 — Install OpenClaw (only if Step 4 said it was missing), start, verify

The import saved a **runbook** for you. Open it — it names the exact OpenClaw
version your setup needs:

```bash
ls -l ~/Documents/migration-runbook-*.md
# If you ran the import as root and ~ is /root, that path is:
# /root/Documents/migration-runbook-*.md
```

Read it. It has a **"Core runtime + dependencies"** section and an
**"OpenClaw PIN"** line (for example `openclaw@2026.7.1-2`). Install that exact
version — **do not install `@latest`**:

```bash
npm install -g openclaw@<the-pinned-version>
openclaw --version          # should match the pinned version
openclaw gateway start
openclaw gateway status     # should show it running
```

- ✅ **Gateway is running** → everything is restored and usable. **Now** you can
  delete the bundle:
  `shred -u your-bundle.tar.gz.enc` — it holds your agent's private config.
- ⚠️ **Gateway starts then stops (exit 0)?** The restored config may reference
  services (EverClaw/Morpheus) that are not running on this machine. That is
  not a migration failure — check the runbook's dependency section and re-enable
  those services. Keep the bundle until it is fully working.
- ⚠️ **Signal** is not portable. If you used Signal, re-link it separately
  after the gateway is up.

**Do I need to install EverClaw / the Morpheus Skill separately?** No — and here is the
real mechanism, not a hand-wave. On an InstallOpenClaw container, the EverClaw /
Morpheus Skill monorepo ships as part of the container image
(`ghcr.io/everclaw/everclaw`), baked into the workspace at
`~/.openclaw/workspace/skills/everclaw/`. That folder is inside your workspace, so
the Download Agent bundle captures it and restores it automatically. There is no
separate EverClaw install.

Two things to know:

1. **The bundle ships the skill FILES, not its runtime dependencies.** The bundle
deliberately strips `node_modules` and `.git` to stay small. So after the import
the skill files are back, but its dependencies (npm packages, Ollama models,
plugin binaries) are not. Install them from the runbook's **"Core runtime +
dependencies"** section, then:

   ```bash
   openclaw skills list        # shows your skill pack folders
   openclaw skills check       # shows ready / missing-requirements
   openclaw skills enable <name>   # only if a skill is disabled
   ```

2. **The restored skill is a snapshot** — the version the source container had at
export time. Newer MorpheusSkill / EverClaw versions reach live InstallOpenClaw
containers as a new image (`ghcr.io/everclaw/everclaw:<version>`) applied via a
platform update (image swap). That update path does not apply to a bare local
restore. If you want the latest skill on a bare machine, re-pull it from the
EverClaw / EverClaw monorepo (git pull in that skill folder, then reinstall its
dependencies).

Done! 🎉

---

## Step 6 — If anything still fails, send us this output

Copy and paste **all** of this to our support team:

```bash
node --version
openclaw --version
node migrate-import.mjs --diagnose your-bundle.tar.gz.enc
ls -l your-bundle.tar.gz.enc        # file size in bytes
file your-bundle.tar.gz.enc         # what the OS thinks the file is
```

With that output we can tell exactly what went wrong on the first look.

---

*Guide v2 FINAL — 2026-09-18. Revised from the v1 guide using a real Debian 13
test run. Script docs: `node migrate-import.mjs --help`.*
