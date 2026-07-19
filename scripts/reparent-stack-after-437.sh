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
NEW_BASE=$(git rev-parse origin/main)
EXPECTED_MAIN=c545b17e134750662517dcf75cae408ada429cf9

if [[ "$NEW_BASE" != "$EXPECTED_MAIN" ]]; then
  echo "main moved unexpectedly: expected $EXPECTED_MAIN, got $NEW_BASE" >&2
  exit 1
fi
if [[ "$(git rev-parse "$OLD1^{tree}")" != "$(git rev-parse "$NEW_BASE^{tree}")" ]]; then
  echo 'Merged main tree differs from the verified PR 1 tree' >&2
  exit 1
fi

reparent() {
  local branch=$1 old_base=$2 old_head=$3 new_base=$4
  git checkout -B "$branch" "$old_head"
  git rebase --onto "$new_base" "$old_base" "$branch"
  local new_head
  new_head=$(git rev-parse HEAD)
  if [[ "$(git rev-parse "$old_head^{tree}")" != "$(git rev-parse "$new_head^{tree}")" ]]; then
    echo "Tree mismatch while reparenting $branch" >&2
    git diff --stat "$old_head" "$new_head" >&2 || true
    exit 1
  fi
  git push --force-with-lease origin "$branch"
  printf '%s' "$new_head"
}

NEW2=$(reparent "$B2" "$OLD1" "$OLD2" "$NEW_BASE")
NEW3=$(reparent "$B3" "$OLD2" "$OLD3" "$NEW2")
NEW4=$(reparent "$B4" "$OLD3" "$OLD4" "$NEW3")
NEW5=$(reparent "$B5" "$OLD4" "$OLD5" "$NEW4")
NEW6=$(reparent "$B6" "$OLD5" "$OLD6" "$NEW5")
NEW7=$(reparent "$B7" "$OLD6" "$OLD7" "$NEW6")

if [[ "$(git rev-parse "$OLD7^{tree}")" != "$(git rev-parse "$NEW7^{tree}")" ]]; then
  echo 'Final stack tree changed during reparenting' >&2
  exit 1
fi

cat > /tmp/comment.md <<EOF
Stack reparented after squash-merging #437:

- #433 now has parent \`$NEW_BASE\` (current \`main\`) and preserves its previous complete tree.
- #439, #434, #440, #441 and #442 were reparented sequentially onto their new predecessors.
- Every individual branch tree and the final #442 tree are byte-identical to the verified pre-merge stack.

New heads:
- #433 \`$NEW2\`
- #439 \`$NEW3\`
- #434 \`$NEW4\`
- #440 \`$NEW5\`
- #441 \`$NEW6\`
- #442 \`$NEW7\`
EOF
gh pr comment 433 --body-file /tmp/comment.md
