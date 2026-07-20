#!/usr/bin/env bash
set -euo pipefail

B3=split/405-3-canonical-build
B5=split/405-5-video-export-contract
B6=split/405-6-media-validation
B7=split/405-7-reviewed-media-evidence

C3=cacd04dac0af8cb273aea36f337604d01161b45c
C5=107dfd3a588f0b2be2347495e922c5c46198f10f
C6=61c5cf06c9fa0b1a28a27c97381313077fd5b51b
C7=0305edd65501a0df19dbc0d6000ef07cf86db30d
VERIFIED_FINAL_TREE=0e3994ccc9ec84970b5343fcd76804229a03eda3
PLAN_DIR=boundary-repair-plan

git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"
git fetch origin main "$B3" "$B5" "$B6" "$B7" --prune

NEW_BASE=$(git rev-parse origin/main)
[[ "$(git rev-parse origin/$B3)" == "$C3" ]] || { echo 'Unexpected current #439 head' >&2; exit 1; }
[[ "$(git rev-parse origin/$B5)" == "$C5" ]] || { echo 'Unexpected current #440 head' >&2; exit 1; }
[[ "$(git rev-parse origin/$B6)" == "$C6" ]] || { echo 'Unexpected current #441 head' >&2; exit 1; }
[[ "$(git rev-parse origin/$B7)" == "$C7" ]] || { echo 'Unexpected current #442 head' >&2; exit 1; }
[[ "$(git rev-parse "$C7^{tree}")" == "$VERIFIED_FINAL_TREE" ]] || {
  echo 'Current #442 no longer has the verified final tree' >&2
  exit 1
}

apply_delta() {
  local old_base=$1 old_head=$2
  local status path
  while IFS= read -r -d '' status; do
    IFS= read -r -d '' path
    case "$status" in
      D*) git rm -f --ignore-unmatch -- "$path" ;;
      *)  git checkout "$old_head" -- "$path" ;;
    esac
  done < <(git diff --no-renames --name-status -z "$old_base" "$old_head")
}

commit_local() {
  local message=$1
  git add -A
  git diff --cached --check
  git diff --cached --quiet && { echo "Empty rebuilt delta: $message" >&2; exit 1; }
  git commit -m "$message" >/dev/null
}

# #439: preserve the complete current build/provenance delta, move the canonical
# context-data runner here, and remove the browser reference to a contract file
# that is intentionally introduced only by #440.
git checkout -B "$B3" "$NEW_BASE"
apply_delta "$NEW_BASE" "$C3"
git checkout "$C7" -- scripts/run-context-data-e2e.js
python3 <<'PY'
from pathlib import Path
p = Path('werkbank_v2.html')
s = p.read_text()
line = '  <script src="js/ua.video-export-contract.js?v=2026-07-19"></script>\n'
if s.count(line) != 1:
    raise SystemExit('video contract script reference not found exactly once in #439 source')
p.write_text(s.replace(line, ''))
PY

test -f scripts/vendor-provenance.js
test -f scripts/validate-vendor-provenance.js
grep -F "const { buildSite } = require('./build-site');" scripts/run-context-data-e2e.js >/dev/null
! grep -F 'ua.video-export-contract.js' werkbank_v2.html >/dev/null
commit_local 'build: close canonical site and runtime boundary'
NEW3=$(git rev-parse HEAD)

# #440: apply only the current video delta, then restore the exact reviewed HTML
# load order that introduces the video-contract script together with its file.
git checkout -B "$B5" "$NEW3"
apply_delta "$C3" "$C5"
git checkout "$C5" -- werkbank_v2.html

test -f js/ua.video-export-contract.js
grep -F 'ua.video-export-contract.js?v=2026-07-19' werkbank_v2.html >/dev/null
! grep -F 'use_prebuilt' .github/workflows/test.yml >/dev/null
! grep -F 'UNFALLATLAS_IMAGE:' .github/workflows/test.yml >/dev/null
commit_local 'export: own video contract and hermetic container evidence'
NEW5=$(git rev-parse HEAD)

# #441: reuse the already corrected media-tooling delta unchanged.
git checkout -B "$B6" "$NEW5"
apply_delta "$C5" "$C6"
commit_local 'docs: preserve closed media tooling boundary'
NEW6=$(git rev-parse HEAD)

mapfile -t pre_evidence_diff < <(git diff --name-only "$C6" "$NEW6")
if [[ ${#pre_evidence_diff[@]} -ne 1 || "${pre_evidence_diff[0]}" != 'scripts/run-context-data-e2e.js' ]]; then
  echo 'Unexpected #441 tree drift after moving canonical context runner:' >&2
  printf '  %s\n' "${pre_evidence_diff[@]}" >&2
  exit 1
fi

# #442: reapply the reviewed evidence delta. It writes the same final context
# runner bytes again and must reproduce the exact verified final tree.
git checkout -B "$B7" "$NEW6"
apply_delta "$C6" "$C7"
commit_local 'docs: restore reviewed media and durable evidence'
NEW7=$(git rev-parse HEAD)
NEW7_TREE=$(git rev-parse "$NEW7^{tree}")
[[ "$NEW7_TREE" == "$VERIFIED_FINAL_TREE" ]] || {
  echo "Final tree mismatch: expected $VERIFIED_FINAL_TREE, got $NEW7_TREE" >&2
  git diff --name-status "$C7" "$NEW7" >&2
  exit 1
}
git diff --quiet "$C7" "$NEW7" || {
  echo 'Final reconstructed #442 contents differ from the verified head' >&2
  git diff --name-status "$C7" "$NEW7" >&2
  exit 1
}

rm -rf "$PLAN_DIR"
mkdir -p "$PLAN_DIR"
cat > "$PLAN_DIR/plan.json" <<EOF
{
  "schemaVersion": 3,
  "newBase": "$NEW_BASE",
  "verifiedFinalTree": "$VERIFIED_FINAL_TREE",
  "branches": [
    {"pr":439,"branch":"$B3","expectedRemote":"$C3","localCommit":"$NEW3","message":"build: close canonical site and runtime boundary"},
    {"pr":440,"branch":"$B5","expectedRemote":"$C5","localCommit":"$NEW5","message":"export: own video contract and hermetic container evidence"},
    {"pr":441,"branch":"$B6","expectedRemote":"$C6","localCommit":"$NEW6","message":"docs: preserve closed media tooling boundary"},
    {"pr":442,"branch":"$B7","expectedRemote":"$C7","localCommit":"$NEW7","message":"docs: restore reviewed media and durable evidence"}
  ]
}
EOF
printf 'RUNTIME_BOUNDARY_HEADS=%s %s %s %s\n' "$NEW3" "$NEW5" "$NEW6" "$NEW7"
printf 'FINAL_TREE=%s\n' "$NEW7_TREE"
