#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/smoke.sh – Smoke-Test-Helfer für die Unfallwerkbank
#
# Deckt die in docs/release-checklist.md beschriebenen vier Betriebsarten ab,
# soweit sie ohne Browser/E2E prüfbar sind:
#
#   1. ohne Server               – nicht hier, das ist Browser-only
#   2. Server ohne KI            – Health, Status, political-context, AI v2 Fallback
#   3. Server mit KI             – zusätzlich: AI v2 'source' != fallback
#   4. Docker                    – wie 2/3, dieselben URL-Aufrufe
#
# Verwendung:
#   ./scripts/smoke.sh                        # gegen http://localhost:8000
#   BASE=http://localhost:8000 ./scripts/smoke.sh
#
# Exit-Code 0 = alle Pflicht-Checks bestanden.
# ─────────────────────────────────────────────────────────────────────────────

set -u

BASE="${BASE:-http://localhost:8000}"
PASS=0
FAIL=0

pass() { echo "  ✓ $*"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $*"; FAIL=$((FAIL+1)); }
note() { echo "  · $*"; }

curl_json() {
  # $1 = url, $2 = optional method (default GET), $3 = optional JSON body
  local url="$1"
  local method="${2:-GET}"
  local body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" -H 'Content-Type: application/json' -d "$body" "$url"
  else
    curl -sS -X "$method" "$url"
  fi
}

http_status() {
  local url="$1"
  local method="${2:-GET}"
  local body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -o /dev/null -w '%{http_code}' -X "$method" -H 'Content-Type: application/json' -d "$body" "$url"
  else
    curl -sS -o /dev/null -w '%{http_code}' -X "$method" "$url"
  fi
}

echo "Smoke-Tests gegen ${BASE}"
echo "─────────────────────────────────────────────"

# 0. Server überhaupt erreichbar?
echo "[0] Server-Reachability"
if [ "$(http_status "${BASE}/api/health")" = "200" ]; then
  pass "/api/health 200"
else
  fail "/api/health nicht erreichbar – Server läuft? (npm run start:server)"
  echo "Abbruch."
  exit 2
fi

# 1. /api/status – aggregierte Capabilities
echo "[1] /api/status"
status_body="$(curl_json "${BASE}/api/status")"
if echo "$status_body" | grep -q '"capabilities"'; then
  pass "Antwort enthält capabilities"
else
  fail "Antwort enthält keine capabilities ($status_body)"
fi
if echo "$status_body" | grep -q '"aiAssessmentV2"'; then
  pass "aiAssessmentV2 ist gelistet"
else
  fail "aiAssessmentV2 fehlt"
fi
ai_v1_avail="$(echo "$status_body" | grep -oE '"aiAssessmentV1":\{[^}]*"available":(true|false)' | grep -oE '(true|false)' | head -n1)"
note "aiAssessmentV1.available = ${ai_v1_avail:-?}"

# 2. Single-Feature-Flags (Backward Compat)
echo "[2] Bestehende Single-Feature-Flag-Endpunkte"
for ep in /api/ai-assessment-available /api/video-export-available /api/political-context/supported; do
  if [ "$(http_status "${BASE}${ep}")" = "200" ]; then
    pass "GET ${ep} 200"
  else
    fail "GET ${ep} nicht 200"
  fi
done

# 3. political-context: invalid request → 400 mit code/category
echo "[3] political-context Fehler-Envelope"
err_body="$(curl_json "${BASE}/api/political-context/search" POST '{}')"
if echo "$err_body" | grep -q '"category":"invalid_request"'; then
  pass "Fehler-Envelope enthält category=invalid_request"
else
  fail "Fehler-Envelope ohne category=invalid_request: $err_body"
fi
if echo "$err_body" | grep -q '"code":"CITY_REQUIRED"'; then
  pass "Fehler-Envelope enthält code=CITY_REQUIRED"
else
  fail "Fehler-Envelope ohne code=CITY_REQUIRED"
fi

# 4. AI v2 – Fallback-Pfad (auch ohne API-Key sollte 200 + source=fallback antworten)
echo "[4] AI v2 (Fallback erlaubt)"
ai_body="$(curl_json "${BASE}/api/ai/export-assessment/v2" POST '{"structured":{"meta":{"city":"Hannover"}}}')"
ai_status="$(http_status "${BASE}/api/ai/export-assessment/v2" POST '{"structured":{"meta":{"city":"Hannover"}}}')"
if [ "$ai_status" = "200" ]; then
  pass "POST /api/ai/export-assessment/v2 → 200"
else
  fail "POST /api/ai/export-assessment/v2 → $ai_status (erwartet 200)"
fi
if echo "$ai_body" | grep -qE '"source":"(ai|cache|ai-repaired|fallback)"'; then
  src="$(echo "$ai_body" | grep -oE '"source":"[^"]*"' | head -n1 | cut -d'"' -f4)"
  pass "source-Feld gesetzt (=${src})"
else
  fail "source-Feld fehlt im AI v2 Response"
fi

# 5. Optional: political-context search funktional (nur Soft-Check)
echo "[5] political-context search (best effort)"
ps_body="$(curl_json "${BASE}/api/political-context/search" POST '{"city":"Hannover","searchTerms":["Limmerstraße"],"maxResults":3}')"
ps_status="$(http_status "${BASE}/api/political-context/search" POST '{"city":"Hannover","searchTerms":["Limmerstraße"],"maxResults":3}')"
if [ "$ps_status" = "200" ]; then
  pass "POST /api/political-context/search → 200"
  if echo "$ps_body" | grep -q '"references"'; then
    pass "Antwort enthält references-Feld"
  else
    fail "Antwort ohne references-Feld"
  fi
else
  note "political-context lieferte $ps_status (Stadt-Portal evtl. offline – non-fatal)"
fi

echo "─────────────────────────────────────────────"
echo "Ergebnis: ${PASS} OK, ${FAIL} Fehler"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
