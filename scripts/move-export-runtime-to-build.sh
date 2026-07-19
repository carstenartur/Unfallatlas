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

# Immutable reviewed heads before the partial boundary-repair attempt.
OLD1=ec2c5b94e1fcaff79ed419ba0f46b07999f7db9b
OLD2=9d5a7c328e541b2ca920f6be00015bb8ea5b5d1d
OLD3=1535ef889715cf9f1baf2b3e0a24a21a28939af2
OLD4=8d9c58da405dd0ffb6c9caaedf02a03a0af82e74
OLD5=a2bd7f798b76fa1658b90ef4bc7c91a3a447c61f
OLD6=5b8245c2ff60d365007882a84f3dc38a88a7548f
OLD7=5bf78091c731635751e14a24b1b4e85171bdb04a
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

# 1/7: original runtime delta, but checkout-compatible pinned CDN/fallback
# loading. All other previously reviewed runtime bytes stay unchanged.
git checkout -B "$B1" "$MAIN"
apply_changed_paths "$OLD1" "$BASE1"
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
commit_push "$B1" "qa: isolate checkout-compatible runtime and export readiness"
NEW1=$(git rev-parse HEAD)

# 2/7: apply the reviewed accessibility delta, but keep Playwright on the
# checkout server because build/serve:site does not exist until PR 3.
git checkout -B "$B2" "$NEW1"
apply_changed_paths "$OLD2" "$OLD1"
git checkout "$NEW1" -- playwright.config.js
commit_push "$B2" "ux: isolate accessibility without canonical-build dependency"
NEW2=$(git rev-parse HEAD)

# 3/7: apply the reviewed build delta and take ownership of both coupled
# runtime seams: exact local vendor URLs and canonical _site Playwright server.
git checkout -B "$B3" "$NEW2"
apply_changed_paths "$OLD3" "$OLD2"
git checkout "$OLD3" -- js/ua.report_v2.js
git checkout "$OLD2" -- playwright.config.js
commit_push "$B3" "build: construct and consume canonical browser artifact"
NEW3=$(git rev-parse HEAD)

rebuild() {
  local new_base=$1 branch=$2 old_base=$3 old_head=$4 message=$5
  git checkout -B "$branch" "$new_base"
  apply_changed_paths "$old_head" "$old_base"
  commit_push "$branch" "$message"
}

rebuild "$NEW3" "$B4" "$OLD3" "$OLD4" "build: rebase vendor and license provenance"
NEW4=$(git rev-parse HEAD)
rebuild "$NEW4" "$B5" "$OLD4" "$OLD5" "export: rebase video evidence contract"
NEW5=$(git rev-parse HEAD)
rebuild "$NEW5" "$B6" "$OLD5" "$OLD6" "docs: rebase media validation tooling"
NEW6=$(git rev-parse HEAD)
rebuild "$NEW6" "$B7" "$OLD6" "$OLD7" "docs: rebase reviewed media evidence"
NEW7=$(git rev-parse HEAD)

# This is a pure review-boundary repair. The final delivered tree must be byte
# identical to the already reviewed final tree.
if [[ "$(git rev-parse "$OLD7^{tree}")" != "$(git rev-parse "$NEW7^{tree}")" ]]; then
  echo 'Final tree mismatch after boundary repair' >&2
  git diff --stat "$OLD7" "$NEW7" >&2 || true
  git diff --name-only "$OLD7" "$NEW7" >&2 || true
  exit 1
fi

cat > /tmp/comment.md <<EOF
Export/build boundary repaired without changing the delivered product tree:

- #437 uses the pinned CDN/fallback loader and remains runnable directly from a checkout; E2E replaces those exact URLs with locked npm bytes.
- #433 no longer depends on \`serve:site\` before that command exists.
- #439 now owns both canonical \`_site/vendor\` materialisation and browser consumption via \`npm run serve:site\` plus relative \`vendor/export/*\` URLs.
- #434–#442 were reconstructed from their unchanged reviewed deltas.
- The final Git tree is byte-identical to reviewed head \`$OLD7\`.

New final stack head: \`$NEW7\`.
EOF
gh pr comment 437 --body-file /tmp/comment.md
