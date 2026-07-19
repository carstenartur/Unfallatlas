#!/usr/bin/env bash
set -euo pipefail

git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"
git fetch origin main \
  split/405-2-accessibility-task-surface \
  split/405-3-canonical-build \
  split/405-4-vendor-provenance \
  split/405-5-video-export-contract \
  split/405-6-media-validation \
  split/405-7-reviewed-media-evidence \
  --prune

B2=split/405-2-accessibility-task-surface
B3=split/405-3-canonical-build
B4=split/405-4-vendor-provenance
B5=split/405-5-video-export-contract
B6=split/405-6-media-validation
B7=split/405-7-reviewed-media-evidence

OLD1=1191849835c0d9170baa0271492791464a48a595
OLD2=67305824a55d2ee20c6170d7697c2ebc1f8c21a1
OLD3=06f975c05ee4755a032e503a7c22736acde79f00
OLD4=ab669b64ee77bf813f0c7316df7b82d5fbb9bae0
OLD5=d1b24772030066fe512fc2c12555fdaeef3122be
OLD6=e03bc5c5206a95904b8f64d548b6f30054061ca3
OLD7=64b16159608a29a22ddbe1e1e7904cdc705e58bd
MERGED1=c545b17e134750662517dcf75cae408ada429cf9
NEW_BASE=$(git rev-parse origin/main)

if ! git merge-base --is-ancestor "$MERGED1" "$NEW_BASE"; then
  echo "Current main $NEW_BASE is not descended from merged #437 $MERGED1" >&2
  exit 1
fi

apply_changed_paths() {
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

verify_changed_paths() {
  local old_base=$1 old_head=$2 new_head=$3
  local status path old_blob new_blob
  while IFS= read -r -d '' status; do
    IFS= read -r -d '' path
    case "$status" in
      D*)
        if git cat-file -e "$new_head:$path" 2>/dev/null; then
          echo "Deleted path unexpectedly exists in rebuilt head: $path" >&2
          return 1
        fi
        ;;
      *)
        old_blob=$(git rev-parse "$old_head:$path")
        new_blob=$(git rev-parse "$new_head:$path")
        if [[ "$old_blob" != "$new_blob" ]]; then
          echo "Changed path differs from reviewed head: $path" >&2
          return 1
        fi
        ;;
    esac
  done < <(git diff --no-renames --name-status -z "$old_base" "$old_head")
}

REBUILT_HEAD=
rebuild_delta() {
  local branch=$1 old_base=$2 old_head=$3 new_base=$4 message=$5
  git checkout -B "$branch" "$new_base"
  apply_changed_paths "$old_base" "$old_head"
  git add -A
  if git diff --cached --quiet; then
    echo "Rebuilt delta for $branch is empty" >&2
    exit 1
  fi
  git commit -m "$message"
  REBUILT_HEAD=$(git rev-parse HEAD)
  verify_changed_paths "$old_base" "$old_head" "$REBUILT_HEAD"
  git push --force-with-lease origin "$branch"
}

rebuild_delta "$B2" "$OLD1" "$OLD2" "$NEW_BASE" "ux: reparent accessibility task surface after #437"
NEW2=$REBUILT_HEAD
rebuild_delta "$B3" "$OLD2" "$OLD3" "$NEW2" "build: reparent canonical site construction after #437"
NEW3=$REBUILT_HEAD
rebuild_delta "$B4" "$OLD3" "$OLD4" "$NEW3" "build: reparent vendor provenance after #437"
NEW4=$REBUILT_HEAD
rebuild_delta "$B5" "$OLD4" "$OLD5" "$NEW4" "export: reparent video evidence contract after #437"
NEW5=$REBUILT_HEAD
rebuild_delta "$B6" "$OLD5" "$OLD6" "$NEW5" "docs: reparent media validation after #437"
NEW6=$REBUILT_HEAD
rebuild_delta "$B7" "$OLD6" "$OLD7" "$NEW6" "docs: reparent reviewed media evidence after #437"
NEW7=$REBUILT_HEAD

# The post-merge main commit changed only screenshot paths that are deliberately
# replaced or removed by PR 7. The fully reconstructed product tree must thus
# still equal the previously verified final tree exactly.
if [[ "$(git rev-parse "$OLD7^{tree}")" != "$(git rev-parse "$NEW7^{tree}")" ]]; then
  echo 'Final stack tree changed during overlay reconstruction' >&2
  git diff --stat "$OLD7" "$NEW7" >&2 || true
  git diff --name-only "$OLD7" "$NEW7" >&2 || true
  exit 1
fi

cat > /tmp/comment.md <<EOF
Stack reconstructed after squash-merging #437 and the subsequent automatic screenshot commit:

- #433 now starts from current \`main\` \`$NEW_BASE\` and contains only its reviewed accessibility/modal delta.
- #439, #434, #440, #441 and #442 were reconstructed sequentially from their reviewed path deltas.
- Main's interim automatic screenshot changes are preserved through PR 6 and deliberately replaced/removed by PR 7.
- Every changed path matches its reviewed old head, and the final #442 Git tree is byte-identical to \`$OLD7\`.

New heads:
- #433 \`$NEW2\`
- #439 \`$NEW3\`
- #434 \`$NEW4\`
- #440 \`$NEW5\`
- #441 \`$NEW6\`
- #442 \`$NEW7\`
EOF
gh pr comment 433 --body-file /tmp/comment.md
