#!/usr/bin/env bash
set -euo pipefail

git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"
git fetch origin main --prune

B1=split/405-1-runtime-readiness
B2=split/405-2-accessibility-task-surface
B3=split/405-3-canonical-build
B4=split/405-4-vendor-provenance
B5=split/405-5-video-export-contract
B6=split/405-6-media-validation
B7=split/405-7-reviewed-media-evidence

OLD1=14c390421937fd167a66f845a2c9864b22f0e103
OLD2=fa351946081ab434de0079d8c2f4198fcb3805d6
OLD3=5c0553323a6b00d77680fbd775671c7b5a420287
OLD4=3f5fab3bf0f3c410fa80e952ba308b6d4114fc55
OLD5=61d3f9da544b9a4cfa15548484adb78610904e60
OLD6=255ebc3de78d74441cfd4c65e282d97a1130bb0e
OLD7=d543f01cf2769afd8678eaa152783f02616cb62a
MAIN=$(git rev-parse origin/main)
BASE1=$(git merge-base "$MAIN" "$OLD1")

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

# PR 1: retain data/lifecycle/export correctness only. All shared modal
# implementation, modal callers and focus/keyboard tests belong to PR 2.
git checkout -B "$B1" "$MAIN"
apply_changed_paths "$OLD1" "$BASE1"
git checkout origin/main -- \
  js/ua.utils.js \
  js/ua.priorities.js \
  js/ua.political-context.js \
  tests/unit/ua.priorities.test.js \
  tests/unit/ua.political-context.buildSearchTerms.test.js
python3 - <<'PY'
from pathlib import Path
import subprocess
p = Path('js/ua.app_v2.js')
current = p.read_text()
main = subprocess.check_output(['git', 'show', 'origin/main:js/ua.app_v2.js'], text=True)
start_marker = '  function bindExport(ctx){\n'
body_marker = '    // Returns true on a successful render, false if report generation failed.\n'
cur_start = current.index(start_marker)
cur_end = current.index(body_marker, cur_start)
main_start = main.index(start_marker)
main_end = main.index(body_marker, main_start)
p.write_text(current[:cur_start] + main[main_start:main_end] + current[cur_end:])
PY
commit_push "$B1" "qa: keep modal implementation and callers out of runtime PR"
NEW1=$(git rev-parse HEAD)

# PR 2: pair native accessible markup with the modal primitive, all modal
# callers and their focus/Escape tests.
git checkout -B "$B2" "$NEW1"
apply_changed_paths "$OLD2" "$OLD1"
git checkout "$OLD1" -- \
  js/ua.utils.js \
  js/ua.app_v2.js \
  js/ua.priorities.js \
  js/ua.political-context.js \
  tests/unit/ua.priorities.test.js \
  tests/unit/ua.political-context.buildSearchTerms.test.js
commit_push "$B2" "ux: introduce modal primitive callers and accessible controls together"
NEW2=$(git rev-parse HEAD)
if [[ "$(git rev-parse "$OLD2^{tree}")" != "$(git rev-parse "$NEW2^{tree}")" ]]; then
  echo 'PR 2 tree changed unexpectedly' >&2
  git diff --stat "$OLD2" "$NEW2" >&2 || true
  exit 1
fi

rebuild() {
  local new_base=$1 branch=$2 old_base=$3 old_head=$4 message=$5
  git checkout -B "$branch" "$new_base"
  apply_changed_paths "$old_head" "$old_base"
  commit_push "$branch" "$message"
}

rebuild "$NEW2" "$B3" "$OLD2" "$OLD3" "build: rebase canonical site after modal boundary fix"
NEW3=$(git rev-parse HEAD)
rebuild "$NEW3" "$B4" "$OLD3" "$OLD4" "build: rebase vendor provenance after modal boundary fix"
NEW4=$(git rev-parse HEAD)
rebuild "$NEW4" "$B5" "$OLD4" "$OLD5" "export: rebase video evidence after modal boundary fix"
NEW5=$(git rev-parse HEAD)
rebuild "$NEW5" "$B6" "$OLD5" "$OLD6" "docs: rebase media validation after modal boundary fix"
NEW6=$(git rev-parse HEAD)
rebuild "$NEW6" "$B7" "$OLD6" "$OLD7" "docs: rebase reviewed media after modal boundary fix"
NEW7=$(git rev-parse HEAD)

if [[ "$(git rev-parse "$OLD7^{tree}")" != "$(git rev-parse "$NEW7^{tree}")" ]]; then
  echo 'Final product tree changed after modal boundary fix' >&2
  git diff --stat "$OLD7" "$NEW7" >&2 || true
  exit 1
fi

cat > /tmp/comment.md <<EOF
Modal/accessibility boundary completed:

- #437 no longer introduces the modal primitive, ARIA state or any modal caller/test before accessible controls exist.
- #433 now contains \`createModalController\`, export/priorities/political-context callers and their focus/Escape tests together with native markup.
- #439–#442 were reconstructed from unchanged reviewed deltas.
- The final complete Git tree remains byte-identical to \`$OLD7\`.

New final stack head: \`$NEW7\`.
EOF
gh pr comment 437 --body-file /tmp/comment.md
