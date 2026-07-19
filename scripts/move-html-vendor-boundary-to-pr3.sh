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

OLD2=6f7d9f4d929d1d58fe3a09f976546a6ae735057d
OLD3=4ec180fd4ba3798b04a5de621c15f30275dea541
OLD4=a3afdd9ddfcac33bbd9122780c948e842d6f5927
OLD5=27d078e76a00a9c1cc23783c73cbdd8ac925d7d2
OLD6=9be5fec78d28cc26d59e14d1afac554bd4d5818e
OLD7=57ff44bc19b572ddd7b497bb2420471b1da9b06f
CURRENT2=$(git rev-parse origin/$B2)
CURRENT3=$(git rev-parse origin/$B3)
CURRENT4=$(git rev-parse origin/$B4)
CURRENT5=$(git rev-parse origin/$B5)
CURRENT6=$(git rev-parse origin/$B6)
CURRENT7=$(git rev-parse origin/$B7)
MAIN=$(git rev-parse origin/main)

# The overlay reparenting changed commit IDs but intentionally preserved each
# reviewed tree. Verify those invariants before moving the partial HTML blocks.
for pair in \
  "$OLD2:$CURRENT2" "$OLD3:$CURRENT3" "$OLD4:$CURRENT4" \
  "$OLD5:$CURRENT5" "$OLD6:$CURRENT6" "$OLD7:$CURRENT7"; do
  old=${pair%%:*}; current=${pair##*:}
  if [[ "$(git rev-parse "$old^{tree}")" != "$(git rev-parse "$current^{tree}")" ]]; then
    echo "Reviewed/current tree mismatch before boundary repair: $old vs $current" >&2
    exit 1
  fi
done

HTML_PATHS=(combi.html index.html unfallwerkbank.html werkbank.html werkbank_v2.html)

replace_dependency_blocks() {
  local source_ref=$1
  python3 - "$source_ref" "${HTML_PATHS[@]}" <<'PY'
from pathlib import Path
import subprocess, sys
source_ref = sys.argv[1]
paths = sys.argv[2:]

def show(ref, path):
    return subprocess.check_output(['git', 'show', f'{ref}:{path}'], text=True)

def block_bounds(text, path):
    starts = [
        '  <!-- Browser dependencies are pinned in package-lock.json and copied by npm run build:site. -->',
        '  <!-- Leaflet -->',
    ]
    start = next((text.index(marker) for marker in starts if marker in text), None)
    if start is None:
        raise SystemExit(f'{path}: dependency block start not found')
    end_marker = '  <style>' if path in {'combi.html', 'index.html', 'unfallwerkbank.html'} else '  <!-- App CSS -->'
    end = text.index(end_marker, start)
    return start, end

for path in paths:
    target = Path(path)
    current = target.read_text()
    source = show(source_ref, path)
    cur_start, cur_end = block_bounds(current, path)
    src_start, src_end = block_bounds(source, path)
    target.write_text(current[:cur_start] + source[src_start:src_end] + current[cur_end:])
PY
}

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
      *)
        if [[ "$(git rev-parse "$old_head:$path")" != "$(git rev-parse "$new_head:$path")" ]]; then
          echo "Reviewed delta path changed: $path" >&2
          return 1
        fi
        ;;
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

# PR 2 keeps all accessibility markup and styles, but executes directly from a
# checkout with the already-supported pinned CDN dependencies.
git checkout -B "$B2" "$CURRENT2"
replace_dependency_blocks origin/main
commit_push "$B2" "ux: keep accessibility PR independent of canonical vendor build"
NEW2=$(git rev-parse HEAD)

# Only the five dependency regions may differ from the previous complete PR 2
# tree; all other bytes must remain unchanged.
mapfile -t pr2diff < <(git diff --name-only "$CURRENT2" "$NEW2")
if [[ ${#pr2diff[@]} -ne 5 ]]; then
  echo 'Unexpected PR 2 boundary diff:' >&2
  printf '  %s\n' "${pr2diff[@]}" >&2
  exit 1
fi
for path in "${HTML_PATHS[@]}"; do
  printf '%s\n' "${pr2diff[@]}" | grep -Fx "$path" >/dev/null || { echo "Missing expected PR 2 path: $path" >&2; exit 1; }
done

# PR 3 owns site construction and browser consumption of local vendor bytes.
# Rebuild its reviewed delta on corrected PR 2, then restore only the five
# reviewed local dependency regions from the former complete PR 2 tree.
git checkout -B "$B3" "$NEW2"
apply_changed_paths "$OLD2" "$OLD3"
replace_dependency_blocks "$OLD2"
commit_push "$B3" "build: switch HTML entry points to canonical local vendor assets"
NEW3=$(git rev-parse HEAD)
if [[ "$(git rev-parse "$OLD3^{tree}")" != "$(git rev-parse "$NEW3^{tree}")" ]]; then
  echo 'PR 3 complete tree changed unexpectedly' >&2
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

rebuild_delta "$B4" "$OLD3" "$OLD4" "$NEW3" "build: rebase vendor provenance after HTML boundary fix"
NEW4=$REBUILT_HEAD
rebuild_delta "$B5" "$OLD4" "$OLD5" "$NEW4" "export: rebase video evidence after HTML boundary fix"
NEW5=$REBUILT_HEAD
rebuild_delta "$B6" "$OLD5" "$OLD6" "$NEW5" "docs: rebase media validation after HTML boundary fix"
NEW6=$REBUILT_HEAD
rebuild_delta "$B7" "$OLD6" "$OLD7" "$NEW6" "docs: rebase reviewed media after HTML boundary fix"
NEW7=$REBUILT_HEAD

if [[ "$(git rev-parse "$OLD7^{tree}")" != "$(git rev-parse "$NEW7^{tree}")" ]]; then
  echo 'Final product tree changed after HTML vendor boundary fix' >&2
  exit 1
fi

cat > /tmp/comment.md <<EOF
HTML vendor/build boundary repaired:

- #433 keeps its native controls, modal semantics and responsive UX, but uses the pinned CDN dependencies available from a plain checkout.
- #439 now introduces both the canonical site builder and the five HTML switches to local \`vendor/*\` assets.
- #434–#442 were reconstructed from unchanged reviewed deltas.
- #439 and every later complete tree, including final #442, remain byte-identical to the previously verified stack.

New heads:
- #433 \`$NEW2\`
- #439 \`$NEW3\`
- #434 \`$NEW4\`
- #440 \`$NEW5\`
- #441 \`$NEW6\`
- #442 \`$NEW7\`
EOF
gh pr comment 433 --body-file /tmp/comment.md
