#!/usr/bin/env bash
set -euo pipefail

git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"
git fetch origin \
  split/405-1-runtime-readiness \
  split/405-2-accessibility-task-surface \
  split/405-3-canonical-build \
  split/405-4-vendor-provenance \
  split/405-5-video-export-contract \
  split/405-6-media-validation \
  split/405-7-reviewed-media-evidence \
  --prune

B1=split/405-1-runtime-readiness
B2=split/405-2-accessibility-task-surface
B3=split/405-3-canonical-build
B4=split/405-4-vendor-provenance
B5=split/405-5-video-export-contract
B6=split/405-6-media-validation
B7=split/405-7-reviewed-media-evidence

OLD1=$(git rev-parse origin/$B1)
OLD2=$(git rev-parse origin/$B2)
OLD3=$(git rev-parse origin/$B3)
OLD4=$(git rev-parse origin/$B4)
OLD5=$(git rev-parse origin/$B5)
OLD6=$(git rev-parse origin/$B6)
OLD7=$(git rev-parse origin/$B7)

apply_changed_paths() {
  local source=$1 compare_base=$2
  local status path new_path
  while IFS= read -r -d '' status; do
    IFS= read -r -d '' path
    case "$status" in
      D*) git rm -f --ignore-unmatch -- "$path" ;;
      R*|C*)
        IFS= read -r -d '' new_path
        git rm -f --ignore-unmatch -- "$path"
        git checkout "$source" -- "$new_path"
        ;;
      *) git checkout "$source" -- "$path" ;;
    esac
  done < <(git diff --name-status -z "$compare_base" "$source")
}

commit_push() {
  local branch=$1 message=$2
  git add -A
  git diff --cached --quiet && { echo "No changes for $branch" >&2; exit 1; }
  git commit -m "$message"
  git push --force-with-lease origin "$branch"
}

# PRs 1–5 still run the source-tree Playwright server. Their PDF scenario must
# intercept only the export libraries and must not block Leaflet/unpkg itself.
git checkout -B "$B1" "origin/$B1"
python3 - <<'PY'
from pathlib import Path
p = Path('tests/e2e/helpers.js')
s = p.read_text()
start = s.index('/**\n * Legacy-named guard retained')
func_start = s.index('export async function setupCDNRoutes(page)', start)
end = s.index('\n\n/**', func_start)
replacement = r'''/**
 * Richtet CDN-Routen auf lokale node_modules um, damit Export-Bibliotheken
 * offline verfügbar sind. PRs vor dem kanonischen Site-Build dürfen die noch
 * extern geladenen Leaflet-Ressourcen nicht pauschal blockieren.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function setupCDNRoutes(page) {
  const path = await import('path');
  const fs = await import('fs');
  const root = path.resolve(process.cwd());

  const routes = [
    { url: 'https://cdn.jsdelivr.net/npm/docx@9.6.1/dist/index.iife.js', file: path.join(root, 'node_modules/docx/dist/index.iife.js') },
    { url: 'https://cdn.jsdelivr.net/npm/pdfmake@0.3.8/build/pdfmake.min.js', file: path.join(root, 'node_modules/pdfmake/build/pdfmake.min.js') },
    { url: 'https://cdn.jsdelivr.net/npm/pdfmake@0.3.8/build/vfs_fonts.js', file: path.join(root, 'node_modules/pdfmake/build/vfs_fonts.js') },
    { url: 'https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js', file: path.join(root, 'node_modules/file-saver/dist/FileSaver.min.js') },
    { url: 'https://unpkg.com/docx@9.6.1/dist/index.iife.js', file: path.join(root, 'node_modules/docx/dist/index.iife.js') },
    { url: 'https://unpkg.com/pdfmake@0.3.8/build/pdfmake.min.js', file: path.join(root, 'node_modules/pdfmake/build/pdfmake.min.js') },
    { url: 'https://unpkg.com/pdfmake@0.3.8/build/vfs_fonts.js', file: path.join(root, 'node_modules/pdfmake/build/vfs_fonts.js') },
    { url: 'https://unpkg.com/file-saver@2.0.5/dist/FileSaver.min.js', file: path.join(root, 'node_modules/file-saver/dist/FileSaver.min.js') }
  ];

  const missing = routes.filter(route => !fs.existsSync(route.file));
  if (missing.length) {
    throw new Error('Missing local CDN test assets:\n' + missing.map(route => `- ${route.url} -> ${route.file}`).join('\n'));
  }
  for (const route of routes) {
    await page.route(route.url, async request => {
      await request.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(route.file) });
    });
  }
}'''
s = s[:start] + replacement + s[end:]
p.write_text(s)
PY
commit_push "$B1" "test: keep source-tree PDF harness from blocking Leaflet"
NEW1=$(git rev-parse HEAD)

rebuild() {
  local new_base=$1 branch=$2 old_base=$3 old_head=$4 message=$5
  git checkout -B "$branch" "$new_base"
  apply_changed_paths "$old_head" "$old_base"
  commit_push "$branch" "$message"
}

rebuild "$NEW1" "$B2" "$OLD1" "$OLD2" "ux: rebase accessibility after visual harness seam fix"
NEW2=$(git rev-parse HEAD)
rebuild "$NEW2" "$B3" "$OLD2" "$OLD3" "build: rebase canonical site construction after harness seam fix"
NEW3=$(git rev-parse HEAD)
rebuild "$NEW3" "$B4" "$OLD3" "$OLD4" "build: rebase vendor provenance after harness seam fix"
NEW4=$(git rev-parse HEAD)
rebuild "$NEW4" "$B5" "$OLD4" "$OLD5" "export: rebase video evidence after harness seam fix"
NEW5=$(git rev-parse HEAD)

# PR 6 owns the canonical-site visual contract. Restore its old fail-closed
# helper explicitly while applying its old media-tooling delta.
git checkout -B "$B6" "$NEW5"
apply_changed_paths "$OLD6" "$OLD5"
git checkout "$OLD6" -- tests/e2e/helpers.js
commit_push "$B6" "docs: restore fail-closed CDN guard with canonical media tooling"
NEW6=$(git rev-parse HEAD)

# The PR 6 and PR 7 complete trees must remain exactly the reviewed old trees.
if [[ "$(git rev-parse "$OLD6^{tree}")" != "$(git rev-parse "$NEW6^{tree}")" ]]; then
  echo 'PR 6 tree mismatch' >&2
  git diff --stat "$OLD6" "$NEW6" >&2 || true
  exit 1
fi

git checkout -B "$B7" "$NEW6"
apply_changed_paths "$OLD7" "$OLD6"
commit_push "$B7" "docs: rebase reviewed media evidence after harness seam fix"
NEW7=$(git rev-parse HEAD)
if [[ "$(git rev-parse "$OLD7^{tree}")" != "$(git rev-parse "$NEW7^{tree}")" ]]; then
  echo 'PR 7 tree mismatch' >&2
  git diff --stat "$OLD7" "$NEW7" >&2 || true
  exit 1
fi

cat > /tmp/comment.md <<EOF
Visual split seam repaired:

- PRs 1–5 now intercept only DOCX/PDF/FileSaver test assets and no longer block the source HTML's Leaflet CDN resources.
- PR 6 restores the strict "any CDN request is a regression" helper together with the canonical-site visual workflow.
- PR 6 and PR 7 retain exactly their previously reviewed complete Git trees.

New stack head: \`$NEW7\`.
EOF
gh pr comment 437 --body-file /tmp/comment.md
