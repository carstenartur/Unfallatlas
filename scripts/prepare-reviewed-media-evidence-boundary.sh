#!/usr/bin/env bash
set -euo pipefail

PARENT_BRANCH=main
TARGET_BRANCH=split/405-7-reviewed-media-evidence
VALIDATED_BRANCH=automation/validated-reviewed-media-evidence
EXPECTED_PARENT_HEAD=4c988c2aa4ff63f8710a36c9b325eaa81a014dd7
EXPECTED_TARGET_HEAD=d48b1e067684c1076bef50bf1da3da048e65c17f
OLD_PARENT=505326c49b6d7170823d949032dde067517527ff
OLD_TARGET=d48b1e067684c1076bef50bf1da3da048e65c17f
CONTROL_ROOT=$(pwd)
WORKTREE_ROOT=$(mktemp -d)

cleanup() {
  cd "$CONTROL_ROOT"
  git worktree remove --force "$WORKTREE_ROOT" >/dev/null 2>&1 || rm -rf "$WORKTREE_ROOT"
}
trap cleanup EXIT

git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"
git fetch --no-tags --depth=1 origin "$PARENT_BRANCH:refs/remotes/origin/$PARENT_BRANCH"
git fetch --no-tags --depth=2 origin "$TARGET_BRANCH:refs/remotes/origin/$TARGET_BRANCH"
[[ "$(git rev-parse "origin/$PARENT_BRANCH")" == "$EXPECTED_PARENT_HEAD" ]] || {
  echo "Unexpected main head; refusing stale #442 reconstruction" >&2
  exit 1
}
[[ "$(git rev-parse "origin/$TARGET_BRANCH")" == "$EXPECTED_TARGET_HEAD" ]] || {
  echo "Unexpected #442 head; refusing to overwrite a moved review branch" >&2
  exit 1
}
git cat-file -e "$OLD_PARENT^{commit}"
git cat-file -e "$OLD_TARGET^{commit}"

git worktree add --detach "$WORKTREE_ROOT" "origin/$PARENT_BRANCH"
cd "$WORKTREE_ROOT"
git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"

apply_changed_paths() {
  local base=$1 head=$2
  local status path
  while IFS= read -r -d '' status; do
    IFS= read -r -d '' path
    case "$status" in
      D*) git rm -f --ignore-unmatch -- "$path" ;;
      *) git checkout "$head" -- "$path" ;;
    esac
  done < <(git diff --no-renames --name-status -z "$base" "$head")
}

apply_changed_paths "$OLD_PARENT" "$OLD_TARGET"

python3 <<'PY'
from pathlib import Path

workflow = Path('.github/workflows/test.yml')
source = workflow.read_text()
old = """      - name: Validate documentation media policy boundary
        id: validate_checked_media
        run: npm run validate:media:policy -- --report out/qa/documentation-media.json"""
new = """      - name: Validate documentation media and durable evidence
        id: validate_checked_media
        run: npm run validate:media -- --report out/qa/documentation-media.json"""
if source.count(old) != 1:
    raise SystemExit(f'strict media gate insertion point found {source.count(old)} times')
workflow.write_text(source.replace(old, new))
PY

git diff --check
npm ci
npm run build:site
npm run validate:media -- --report out/qa/documentation-media.json
npx jest --runInBand \
  tests/unit/docMediaPolicy.test.js \
  tests/unit/screenshotEvidencePolicy.test.js \
  tests/unit/screenshotWorkflowSafety.test.js \
  tests/unit/siteBuildContract.test.js

mapfile -t changed_paths < <(git diff --name-only "$EXPECTED_PARENT_HEAD" | sort)
[[ "${#changed_paths[@]}" -eq 58 ]] || {
  echo "Expected 58 reviewed-evidence boundary files, got ${#changed_paths[@]}" >&2
  printf '%s\n' "${changed_paths[@]}" >&2
  exit 1
}
printf '%s\n' "${changed_paths[@]}" | grep -Fx '.github/workflows/test.yml' >/dev/null

git add -A
git diff --cached --check
git diff --cached --quiet && { echo "No reviewed-media boundary to commit" >&2; exit 1; }
git commit -m "docs: bind reviewed media to durable evidence"
NEW_HEAD=$(git rev-parse HEAD)

echo "VALIDATED_HEAD=$NEW_HEAD"
echo "VALIDATED_TREE=$(git rev-parse HEAD^{tree})"
set +e
git push --force origin "$NEW_HEAD:refs/heads/$VALIDATED_BRANCH"
PUSH_STATUS=$?
set -e
if [[ "$PUSH_STATUS" -ne 0 ]]; then
  echo "Validation ref publication was rejected after object upload; administrative ref update is required."
fi
