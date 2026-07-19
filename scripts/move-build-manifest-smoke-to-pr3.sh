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

OLD2=763add125c446d15bbb62b1a6b89a758a1537310
OLD3=35a77950fbab44a0d28af7eef92b90533f1a7c99
OLD4=2f8000071d71d4c47412026e3e7168908a1851cb
OLD5=1ed29447fe452bb09956e7f7c791eb956a476452
OLD6=5f7905ac0951f1d5fad88246a0dddcd019a90173
OLD7=0e69159adab2606fc58267bd7ebf974da6dcb0b8

for branch in "$B2" "$B3" "$B4" "$B5" "$B6" "$B7"; do
  git rev-parse "origin/$branch" >/dev/null
done

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

verify_delta_paths() {
  local old_base=$1 old_head=$2 new_head=$3
  local status path
  while IFS= read -r -d '' status; do
    IFS= read -r -d '' path
    case "$status" in
      D*) git cat-file -e "$new_head:$path" 2>/dev/null && { echo "Deleted path exists: $path" >&2; return 1; } || true ;;
      *) [[ "$(git rev-parse "$old_head:$path")" == "$(git rev-parse "$new_head:$path")" ]] || { echo "Reviewed path changed: $path" >&2; return 1; } ;;
    esac
  done < <(git diff --no-renames --name-status -z "$old_base" "$old_head")
}

commit_push() {
  local branch=$1 message=$2
  git add -A
  git diff --cached --quiet && { echo "No changes for $branch" >&2; exit 1; }
  git commit -m "$message"
  git push --force-with-lease origin "$branch"
}

# PR 2 must only test capabilities that exist before canonical site building.
git checkout -B "$B2" "$OLD2"
python3 - <<'PY'
from pathlib import Path
p = Path('tests/e2e/smoke.spec.js')
s = p.read_text()
start = s.index("  test('Build-Manifest dokumentiert Daten, lokale Abhängigkeiten und Lizenzprovenienz'")
end = s.index("  test('Stadt-Dropdown ist sichtbar", start)
p.write_text(s[:start] + s[end:])
PY
commit_push "$B2" "test: keep accessibility smoke independent of site build manifest"
NEW2=$(git rev-parse HEAD)
mapfile -t pr2diff < <(git diff --name-only "$OLD2" "$NEW2")
if [[ ${#pr2diff[@]} -ne 1 || "${pr2diff[0]}" != "tests/e2e/smoke.spec.js" ]]; then
  echo 'Unexpected PR 2 smoke-boundary diff' >&2
  printf '  %s\n' "${pr2diff[@]}" >&2
  exit 1
fi

# PR 3 creates build-manifest.json and third-party notices, therefore it owns
# their browser-level contract. Restore the reviewed complete smoke file here.
git checkout -B "$B3" "$NEW2"
apply_changed_paths "$OLD2" "$OLD3"
git checkout "$OLD2" -- tests/e2e/smoke.spec.js
commit_push "$B3" "build: verify manifest and license provenance with canonical site"
NEW3=$(git rev-parse HEAD)
if [[ "$(git rev-parse "$OLD3^{tree}")" != "$(git rev-parse "$NEW3^{tree}")" ]]; then
  echo 'PR 3 tree changed unexpectedly' >&2
  git diff --stat "$OLD3" "$NEW3" >&2 || true
  exit 1
fi

REBUILT_HEAD=
rebuild_delta() {
  local branch=$1 old_base=$2 old_head=$3 new_base=$4 message=$5
  git checkout -B "$branch" "$new_base"
  apply_changed_paths "$old_base" "$old_head"
  git add -A
  git diff --cached --quiet && { echo "Empty delta for $branch" >&2; exit 1; }
  git commit -m "$message"
  REBUILT_HEAD=$(git rev-parse HEAD)
  verify_delta_paths "$old_base" "$old_head" "$REBUILT_HEAD"
  if [[ "$(git rev-parse "$old_head^{tree}")" != "$(git rev-parse "$REBUILT_HEAD^{tree}")" ]]; then
    echo "Complete tree mismatch for $branch" >&2
    exit 1
  fi
  git push --force-with-lease origin "$branch"
}

rebuild_delta "$B4" "$OLD3" "$OLD4" "$NEW3" "build: rebase vendor provenance after smoke boundary fix"
NEW4=$REBUILT_HEAD
rebuild_delta "$B5" "$OLD4" "$OLD5" "$NEW4" "export: rebase video evidence after smoke boundary fix"
NEW5=$REBUILT_HEAD
rebuild_delta "$B6" "$OLD5" "$OLD6" "$NEW5" "docs: rebase media validation after smoke boundary fix"
NEW6=$REBUILT_HEAD
rebuild_delta "$B7" "$OLD6" "$OLD7" "$NEW6" "docs: rebase reviewed media after smoke boundary fix"
NEW7=$REBUILT_HEAD

if [[ "$(git rev-parse "$OLD7^{tree}")" != "$(git rev-parse "$NEW7^{tree}")" ]]; then
  echo 'Final product tree changed after smoke boundary fix' >&2
  exit 1
fi

cat > /tmp/comment.md <<EOF
Build-manifest smoke boundary repaired:

- #433 no longer requests \`build-manifest.json\` or third-party notices before the canonical site builder exists.
- #439 now owns the browser smoke contract for its generated manifest, local dependencies and license provenance.
- #434–#442 were reconstructed from unchanged reviewed deltas.
- #439 and every later complete tree remain byte-identical to the verified stack.

New heads:
- #433 \`$NEW2\`
- #439 \`$NEW3\`
- #434 \`$NEW4\`
- #440 \`$NEW5\`
- #441 \`$NEW6\`
- #442 \`$NEW7\`
EOF
gh pr comment 433 --body-file /tmp/comment.md
