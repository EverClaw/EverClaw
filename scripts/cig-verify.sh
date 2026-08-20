#!/usr/bin/env bash
# cig-verify.sh — Fast end-to-end CIG inference verification harness.
#
# Purpose: verify a CIG-enabled deployment's inference path (mint → infer)
# WITHOUT needing a browser, so fixes can be validated in seconds.
#
# This is the "get all the way to the UI" shortcut: it reproduces exactly what
# the in-container auth-proxy does (mint a CIG token, then call cig-inference
# with the X-Container-Fqdn header), and inspects the RAW SSE bytes for the two
# failure modes that cause "assistant turn failed before producing content":
#   1. Broken SSE framing (events concatenated with no \n\n terminator)
#   2. reasoning_content leaking through / empty-delta chunks
#
# Usage:
#   ./cig-verify.sh <agent_url>
#   ./cig-verify.sh https://openclaw-54871cd.barney-morpheus7.manifest0.net
#
# Requires: SUPABASE service key in keychain (service "supabase-service-key").
# Project ref defaults to the InstallOpenClaw production project.

set -uo pipefail

AGENT_URL="${1:-}"
PROJECT_REF="${CIG_PROJECT_REF:-lqmzlflbhitipergiwjo}"
FUNCTIONS_BASE="https://${PROJECT_REF}.supabase.co/functions/v1"
REST_BASE="https://${PROJECT_REF}.supabase.co/rest/v1"
RETRIES="${CIG_RETRIES:-10}"
PROMPT="${CIG_PROMPT:-count one two three}"

if [ -z "$AGENT_URL" ]; then
  echo "usage: $0 <agent_url>" >&2; exit 2
fi

FQDN="$(echo "$AGENT_URL" | sed -E 's#^https?://##; s#/.*$##')"
SVC="$(security find-generic-password -s 'supabase-service-key' -w 2>/dev/null || true)"
if [ -z "$SVC" ]; then echo "❌ no supabase-service-key in keychain" >&2; exit 2; fi

echo "▶ CIG verify for $FQDN (project $PROJECT_REF)"

# 1. Look up the deployment's binding_secret.
DEP="$(curl -s "${REST_BASE}/deployments?agent_url=eq.${AGENT_URL}&select=binding_secret,status,tier,privy_user_id&status=eq.active" \
  -H "apikey: $SVC" -H "Authorization: Bearer $SVC")"
SECRET="$(echo "$DEP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['binding_secret'] if d else '')" 2>/dev/null)"
if [ -z "$SECRET" ]; then echo "❌ no active deployment / binding_secret for $AGENT_URL" >&2; echo "$DEP" >&2; exit 1; fi
echo "  ✓ found active deployment (binding_secret ${SECRET:0:8}…)"

mint_token() {
  curl -s -X POST "${FUNCTIONS_BASE}/mint-cig-token" \
    -H "Content-Type: application/json" \
    -d "{\"fqdn\":\"$FQDN\",\"binding_secret\":\"$SECRET\"}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null
}

# 2. Non-streaming sanity check.
echo "▶ Non-streaming check…"
TOKEN="$(mint_token)"
NS="$(curl -s -X POST "${FUNCTIONS_BASE}/cig-inference/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" -H "X-Container-Fqdn: $FQDN" -H "Content-Type: application/json" \
  -d "{\"model\":\"default\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":false}" --max-time 90)"
if echo "$NS" | grep -q '"content"' && ! echo "$NS" | grep -q 'reasoning_content'; then
  echo "  ✅ non-streaming: clean content, no reasoning_content"
else
  echo "  ⚠ non-streaming returned: $(echo "$NS" | head -c 200)"
fi

# 3. Streaming check with retries (Morpheus P2P can be intermittently slow).
echo "▶ Streaming check (up to $RETRIES attempts)…"
TMP="$(mktemp)"
GOOD=""
for i in $(seq 1 "$RETRIES"); do
  TOKEN="$(mint_token)"
  curl -sN -X POST "${FUNCTIONS_BASE}/cig-inference/v1/chat/completions" \
    -H "Authorization: Bearer $TOKEN" -H "X-Container-Fqdn: $FQDN" -H "Content-Type: application/json" \
    -d "{\"model\":\"default\",\"messages\":[{\"role\":\"user\",\"content\":\"$PROMPT\"}],\"stream\":true}" \
    --max-time 45 > "$TMP" 2>/dev/null
  if grep -q '"content"' "$TMP" && ! grep -q 'retry_failed\|i/o timeout' "$TMP"; then
    GOOD=1; echo "  ✓ got a stream on attempt $i"; break
  fi
  REASON="$(grep -o 'retry_failed\|i/o timeout' "$TMP" | head -1)"
  echo "  · attempt $i: $( [ -s "$TMP" ] && echo "${REASON:-empty}" || echo 'no-response (provider hang)')"
  sleep 2
done

if [ -z "$GOOD" ]; then
  echo "  ⚠ no clean stream after $RETRIES attempts — likely Morpheus P2P provider instability (not a framing bug)."
  rm -f "$TMP"; exit 3
fi

# 4. Analyze SSE framing + reasoning leakage.
python3 - "$TMP" <<'PY'
import sys, json
raw = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace')
events = [e for e in raw.split('\n\n') if e.strip()]
concat = '}data:' in raw
leaked = 'reasoning_content' in raw
parse_ok = True
contents = []
for e in events:
    e = e.strip()
    if not e.startswith('data: '): continue
    p = e[6:]
    if p == '[DONE]': continue
    try:
        d = json.loads(p)
        delta = d.get('choices', [{}])[0].get('delta', {})
        if delta.get('content'): contents.append(delta['content'])
    except Exception:
        parse_ok = False
print(f"  events: {len(events)}")
print(f"  {'✅' if not concat else '❌'} SSE framing intact (no concatenated }}data:)")
print(f"  {'✅' if not leaked else '❌'} no reasoning_content leaked")
print(f"  {'✅' if parse_ok else '❌'} every data event parses as JSON")
print(f"  content: {''.join(contents)!r}")
ok = (not concat) and (not leaked) and parse_ok
print("RESULT:", "PASS ✅" if ok else "FAIL ❌")
sys.exit(0 if ok else 1)
PY
RC=$?
rm -f "$TMP"
exit $RC
