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

OLD1=673edf4cc1051e0c852ed0624065ce79a47b1d97
OLD2=929a92725a1edfe6068fbf98e8f70d3870a41926
OLD3=23af5753146ba70712fd1abd18f1f98057edf0be
OLD4=425a54f3330c130582a58ad3bdce498dba4a53ce
OLD5=0f29e2bcb91fa555c10061d86880f56cac650a75
OLD6=0daff54db1c2dfcdff07822fee1b7125541e2ab7
OLD7=76b50d9c3661b56ab1436a617012113dcb323834
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

# PR 1: retain lifecycle/export correctness but remove the two accessibility
# halves that are invalid without PR 2's native button/modal markup.
git checkout -B "$B1" "$MAIN"
apply_changed_paths "$OLD1" "$BASE1"
git checkout origin/main -- js/ua.utils.js
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
commit_push "$B1" "qa: keep runtime lifecycle independent of accessibility semantics"
NEW1=$(git rev-parse HEAD)

# PR 2: apply its reviewed UI/markup delta, then add the ARIA button state,
# shared modal controller and export modal wiring that semantically belong here.
git checkout -B "$B2" "$NEW1"
apply_changed_paths "$OLD2" "$OLD1"
git checkout "$OLD1" -- js/ua.utils.js js/ua.app_v2.js
commit_push "$B2" "ux: pair native controls with ARIA and modal semantics"
NEW2=$(git rev-parse HEAD)
if [[ "$(git rev-parse "$OLD2^{tree}")" != "$(git rev-parse "$NEW2^{tree}")" ]]; then
  echo 'PR 2 complete tree changed unexpectedly' >&2
  git diff --stat "$OLD2" "$NEW2" >&2 || true
  exit 1
fi

rebuild() {
  local new_base=$1 branch=$2 old_base=$3 old_head=$4 message=$5
  git checkout -B "$branch" "$new_base"
  apply_changed_paths "$old_head" "$old_base"
  commit_push "$branch" "$message"
}

rebuild "$NEW2" "$B3" "$OLD2" "$OLD3" "build: rebase canonical site construction after a11y seam fix"
NEW3=$(git rev-parse HEAD)
rebuild "$NEW3" "$B4" "$OLD3" "$OLD4" "build: rebase vendor provenance after a11y seam fix"
NEW4=$(git rev-parse HEAD)
rebuild "$NEW4" "$B5" "$OLD4" "$OLD5" "export: rebase video evidence contract after a11y seam fix"
NEW5=$(git rev-parse HEAD)
rebuild "$NEW5" "$B6" "$OLD5" "$OLD6" "docs: rebase media validation after a11y seam fix"
NEW6=$(git rev-parse HEAD)
rebuild "$NEW6" "$B7" "$OLD6" "$OLD7" "docs: rebase reviewed media evidence after a11y seam fix"
NEW7=$(git rev-parse HEAD)

if [[ "$(git rev-parse "$OLD7^{tree}")" != "$(git rev-parse "$NEW7^{tree}")" ]]; then
  echo 'Final product tree changed after accessibility seam fix' >&2
  git diff --stat "$OLD7" "$NEW7" >&2 || true
  exit 1
fi

cat > /tmp/comment.md <<EOF
Accessibility split seam repaired:

- #437 no longer sets \`aria-pressed\` on legacy \`div.btn\` elements and no longer depends on the shared modal controller before accessible markup exists.
- #433 now introduces native controls, ARIA state synchronization, focus-trapped modal behavior and export-modal wiring together.
- #439–#442 were reconstructed from their unchanged reviewed deltas.
- The final complete Git tree remains byte-identical to \`$OLD7\`.

New final stack head: \`$NEW7\`.
EOF
gh pr comment 437 --body-file /tmp/comment.md
