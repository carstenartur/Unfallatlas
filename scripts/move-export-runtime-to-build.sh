#!/usr/bin/env bash
set -euo pipefail

git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"
git fetch origin \
  main \
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

# PR 1/2 must remain runnable directly from a checkout. Restore the exact
# CDN/fallback loader from main; tests intercept those pinned URLs locally.
git checkout -B "$B1" "origin/$B1"
python3 - <<'PY'
from pathlib import Path
import subprocess
p = Path('js/ua.report_v2.js')
current = p.read_text()
main = subprocess.check_output(['git', 'show', 'origin/main:js/ua.report_v2.js'], text=True)
cur_start = current.index('  /**\n   * Ensure export libraries are loaded.')
main_start = main.index('  /**\n   * Try loading a script from a list of CDN URLs')
marker = '  // =====================================================================\n  // Map Image Export'
cur_end = current.index(marker)
main_end = main.index(marker)
p.write_text(current[:cur_start] + main[main_start:main_end] + current[cur_end:])
PY
commit_push "$B1" "fix: keep early runtime export loading checkout-compatible"
NEW1=$(git rev-parse HEAD)

# Rebuild accessibility delta unchanged on corrected PR 1.
git checkout -B "$B2" "$NEW1"
apply_changed_paths "$OLD2" "$OLD1"
commit_push "$B2" "ux: rebase accessibility after export runtime boundary fix"
NEW2=$(git rev-parse HEAD)

# Canonical build owns both materialisation and runtime consumption of exact
# vendor bytes. Restore the old local-loader implementation here and serve the
# built _site in all Playwright jobs/local runs.
git checkout -B "$B3" "$NEW2"
apply_changed_paths "$OLD3" "$OLD2"
git checkout "$OLD3" -- js/ua.report_v2.js
python3 - <<'PY'
from pathlib import Path
p = Path('playwright.config.js')
s = p.read_text()
old = "command: 'python3 -m http.server 8000'"
new = "command: 'npm run serve:site'"
if old not in s:
    raise SystemExit('expected source-tree Playwright server command not found')
s = s.replace(old, new, 1)
s = s.replace(
    '// Only start a local web server when not targeting a live/remote BASE_URL.\n'
    '  // The generated-context runner supplies BASE_URL and owns its isolated server.',
    '// Serve the canonical built site so browser QA executes the same vendored bytes\n'
    '  // as Pages, Docker and release artifacts. The generated-context runner supplies\n'
    '  // BASE_URL and owns its isolated server.',
    1
)
p.write_text(s)
PY
commit_push "$B3" "build: make browser QA consume canonical site artifact"
NEW3=$(git rev-parse HEAD)

# Remaining deltas are reconstructed unchanged on the corrected predecessor.
rebuild() {
  local new_base=$1 branch=$2 old_base=$3 old_head=$4 message=$5
  git checkout -B "$branch" "$new_base"
  apply_changed_paths "$old_head" "$old_base"
  commit_push "$branch" "$message"
}

rebuild "$NEW3" "$B4" "$OLD3" "$OLD4" "build: rebase vendor provenance on canonical browser runtime"
NEW4=$(git rev-parse HEAD)
rebuild "$NEW4" "$B5" "$OLD4" "$OLD5" "export: rebase video evidence contract"
NEW5=$(git rev-parse HEAD)
rebuild "$NEW5" "$B6" "$OLD5" "$OLD6" "docs: rebase media validation tooling"
NEW6=$(git rev-parse HEAD)
rebuild "$NEW6" "$B7" "$OLD6" "$OLD7" "docs: rebase reviewed media evidence"
NEW7=$(git rev-parse HEAD)

# The only intended final-tree difference from the previously reviewed stack is
# Playwright's canonical-site server command. ua.report_v2 is restored by PR 3.
mapfile -t final_diff < <(git diff --name-only "$OLD7" "$NEW7")
if [[ ${#final_diff[@]} -ne 1 || "${final_diff[0]}" != "playwright.config.js" ]]; then
  echo 'Unexpected final tree difference:' >&2
  printf '  %s\n' "${final_diff[@]}" >&2
  git diff --stat "$OLD7" "$NEW7" >&2 || true
  exit 1
fi

cat > /tmp/comment.md <<EOF
Export-runtime split boundary repaired:

- #437 and #433 use the pinned CDN/fallback loader and remain runnable directly from a checkout; E2E routes those URLs to locked local npm bytes.
- #439 now owns both canonical vendor materialisation and the switch to relative \`vendor/export/*\` URLs.
- Playwright starts \`npm run serve:site\`, so browser QA executes the same built \`_site\` bytes as deployment artifacts.
- #434–#442 were reconstructed from their unchanged deltas.
- The final tree differs from the previously reviewed stack only in \`playwright.config.js\`, the intentional canonical-site server fix.

New final stack head: \`$NEW7\`.
EOF
gh pr comment 437 --body-file /tmp/comment.md
