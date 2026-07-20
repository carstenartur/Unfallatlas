#!/usr/bin/env bash
set -euo pipefail

B3=split/405-3-canonical-build
B5=split/405-5-video-export-contract
B6=split/405-6-media-validation
B7=split/405-7-reviewed-media-evidence

C3=edd96913cea640200b9cbe0b55ce17085b88f615
C5=8129088f522edd293e9992e2ad62713dd18e3daa
C6=2877f5b51afa0d7a771e23a9070373465624ac5b
C7=7fe8adab8e6efe9ee1d8533f9e8ebe638404ff26
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

# #439: preserve the current canonical build/provenance/runtime delta and move
# the already-reviewed canonical static-server boundary out of #440. This is the
# earliest point where HTML references local `_site/vendor/*` assets, so the
# Docker/Node server must serve `_site` and the mutable `/out` overlay here.
git checkout -B "$B3" "$NEW_BASE"
apply_delta "$NEW_BASE" "$C3"
python3 <<'PY'
from pathlib import Path
p = Path('server/index.js')
s = p.read_text()

old_import = "const { correlationIdMiddleware, HEADER_NAME: CORRELATION_HEADER } = require('./lib/correlationId.js');\n"
new_import = old_import + "const { createStaticDataOverlay, resolveDataRoot } = require('./lib/staticDataOverlay.js');\nconst { createStaticSiteGuard } = require('./lib/safeStaticPath.js');\n"
if s.count(old_import) != 1:
    raise SystemExit('server static-boundary import anchor not found exactly once')
s = s.replace(old_import, new_import)

old_root = "const ROOT = path.resolve(__dirname, '..');\n"
new_root = old_root + "const SITE_ROOT = path.join(ROOT, '_site');\nconst DATA_ROOT = resolveDataRoot(ROOT, process.env.UNFALLATLAS_DATA_ROOT);\n"
if s.count(old_root) != 1:
    raise SystemExit('server root anchor not found exactly once')
s = s.replace(old_root, new_root)

old_static = """// Statische Werkbank-Dateien aus dem Repository-Root ausliefern
app.use(express.static(ROOT, {
  index: 'werkbank_v2.html',
  extensions: ['html']
}));
"""
new_static = """// Runtime-generierte Kontextdaten sind ein bewusst veränderliches Overlay vor
// dem unveränderlichen Build-Snapshot. Alle übrigen Dateien kommen exklusiv
// aus `_site`, sodass Repository- und Serverquellen nicht per HTTP erreichbar
// sind. Die Context-Generation schreibt standardmäßig nach ROOT/out; ein
// Betreiber kann dafür UNFALLATLAS_DATA_ROOT setzen.
app.use('/out', createStaticDataOverlay(express, DATA_ROOT));

// Pages, Playwright, Screenshots und die API-/Docker-Distribution liefern
// für Anwendungscode und gelockte Browserbibliotheken dasselbe Site-Artefakt.
app.use(createStaticSiteGuard(SITE_ROOT, { index: 'werkbank_v2.html', extensions: ['html'] }));
app.use(express.static(SITE_ROOT, {
  index: 'werkbank_v2.html',
  extensions: ['html']
}));
"""
if s.count(old_static) != 1:
    raise SystemExit('repository-root static server block not found exactly once')
s = s.replace(old_static, new_static)
p.write_text(s)
PY

grep -F "const SITE_ROOT = path.join(ROOT, '_site');" server/index.js >/dev/null
grep -F "app.use('/out', createStaticDataOverlay(express, DATA_ROOT));" server/index.js >/dev/null
grep -F 'app.use(express.static(SITE_ROOT' server/index.js >/dev/null
! grep -F 'app.use(express.static(ROOT' server/index.js >/dev/null
commit_local 'server: serve canonical site with confined data overlay'
NEW3=$(git rev-parse HEAD)

# #440: reapply its existing reviewed delta. Its server/index.js already contains
# the same static boundary plus the video request/evidence additions, so the
# resulting tree must be byte-identical to the previous #440 tree.
git checkout -B "$B5" "$NEW3"
apply_delta "$C3" "$C5"
commit_local 'export: preserve video contract on canonical server boundary'
NEW5=$(git rev-parse HEAD)
[[ "$(git rev-parse "$NEW5^{tree}")" == "$(git rev-parse "$C5^{tree}")" ]] || {
  echo 'Reparented #440 tree differs from its reviewed tree' >&2
  git diff --name-status "$C5" "$NEW5" >&2
  exit 1
}

# #441 and #442 remain content-identical; only ancestry changes.
git checkout -B "$B6" "$NEW5"
apply_delta "$C5" "$C6"
commit_local 'docs: preserve media tooling on canonical server boundary'
NEW6=$(git rev-parse HEAD)
[[ "$(git rev-parse "$NEW6^{tree}")" == "$(git rev-parse "$C6^{tree}")" ]] || {
  echo 'Reparented #441 tree differs from its reviewed tree' >&2
  git diff --name-status "$C6" "$NEW6" >&2
  exit 1
}

git checkout -B "$B7" "$NEW6"
apply_delta "$C6" "$C7"
commit_local 'docs: preserve reviewed media and durable evidence'
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
  "schemaVersion": 4,
  "newBase": "$NEW_BASE",
  "verifiedFinalTree": "$VERIFIED_FINAL_TREE",
  "branches": [
    {"pr":439,"branch":"$B3","expectedRemote":"$C3","localCommit":"$NEW3","message":"server: serve canonical site with confined data overlay"},
    {"pr":440,"branch":"$B5","expectedRemote":"$C5","localCommit":"$NEW5","message":"export: preserve video contract on canonical server boundary"},
    {"pr":441,"branch":"$B6","expectedRemote":"$C6","localCommit":"$NEW6","message":"docs: preserve media tooling on canonical server boundary"},
    {"pr":442,"branch":"$B7","expectedRemote":"$C7","localCommit":"$NEW7","message":"docs: preserve reviewed media and durable evidence"}
  ]
}
EOF
printf 'STATIC_SERVER_BOUNDARY_HEADS=%s %s %s %s\n' "$NEW3" "$NEW5" "$NEW6" "$NEW7"
printf 'FINAL_TREE=%s\n' "$NEW7_TREE"
