#!/usr/bin/env bash
set -euo pipefail

REPO=carstenartur/Unfallatlas
B5=split/405-5-video-export-contract
B6=split/405-6-media-validation
B7=split/405-7-reviewed-media-evidence
MERGED_439=c5d86b2b81fc6b756e3e30a5d2cd9d089e8b8f59
OLD5=feab6357e40c74ba75ad70b550c2e5a6df09e73b
FIXED5=6c90f7c7006396e88a240bf6535fe43e01ba697a
OLD6=cd465ab3d47c95019ee1eee9e721475e94471db0
OLD7=e398c630a2ea360cfb8ce65ed1baf5d58bbf4539
EXPECTED_OLD_FINAL_TREE=0e3994ccc9ec84970b5343fcd76804229a03eda3

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

commit_local() {
  git add -A
  git diff --cached --check
  git diff --cached --quiet && { echo "empty reconstructed delta" >&2; exit 1; }
  git commit -m "$1" >/dev/null
  git rev-parse HEAD
}

git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"
git fetch origin main "$B5" "$B6" "$B7" --prune
NEW_BASE=$(git rev-parse origin/main)
[[ "$(git rev-parse origin/$B5)" == "$FIXED5" ]] || { echo "Unexpected #440 head" >&2; exit 1; }
[[ "$(git rev-parse origin/$B6)" == "$OLD6" ]] || { echo "Unexpected #441 head" >&2; exit 1; }
[[ "$(git rev-parse origin/$B7)" == "$OLD7" ]] || { echo "Unexpected #442 head" >&2; exit 1; }
[[ "$(git rev-parse "$OLD7^{tree}")" == "$EXPECTED_OLD_FINAL_TREE" ]] || { echo "Old final tree changed" >&2; exit 1; }
git merge-base --is-ancestor "$MERGED_439" "$NEW_BASE"
while IFS= read -r path; do
  [[ "$path" == docs/screenshots/*.png ]] || { echo "Unexpected main drift: $path" >&2; exit 1; }
done < <(git diff --name-only "$MERGED_439" "$NEW_BASE")

# #440: squash the complete fixed video boundary onto current main.
git checkout -B "$B5" "$NEW_BASE"
apply_changed_paths "$MERGED_439" "$FIXED5"
NEW5=$(commit_local "export: close codec-safe video evidence contract")

# #441: reapply only its reviewed media-tooling delta.
git checkout -B "$B6" "$NEW5"
apply_changed_paths "$OLD5" "$OLD6"
NEW6=$(commit_local "docs: close media tooling and workflow boundary")

# #442: reapply only reviewed media/evidence.
git checkout -B "$B7" "$NEW6"
apply_changed_paths "$OLD6" "$OLD7"
NEW7=$(commit_local "docs: restore reviewed media and durable evidence")

# Expected final content = old reviewed final + the exact complete #440 repair.
git checkout -B expected-final "$OLD7"
apply_changed_paths "$OLD5" "$FIXED5"
git add -A
git diff --cached --check
EXPECTED_TREE=$(git write-tree)
ACTUAL_TREE=$(git rev-parse "$NEW7^{tree}")
[[ "$ACTUAL_TREE" == "$EXPECTED_TREE" ]] || {
  echo "Final tree differs from reviewed final plus complete #440 repair" >&2
  git diff --name-status "$EXPECTED_TREE" "$ACTUAL_TREE" >&2 || true
  exit 1
}

# Ensure final-tree drift is exactly the six independently reviewed codec files.
mapfile -t final_drift < <(git diff --name-only "$OLD7" "$NEW7")
printf '%s\n' "${final_drift[@]}" | sort > /tmp/actual-drift
printf '%s\n' \
  Dockerfile \
  bin/ffmpeg \
  server/video-export-filters.js \
  server/video-export.js \
  tests/unit/videoExportCodecWrapper.test.js \
  tests/unit/videoExportEncodingContract.test.js \
  | sort > /tmp/expected-drift
diff -u /tmp/expected-drift /tmp/actual-drift

mkdir -p rechain-plan
cat > rechain-plan/plan.json <<EOF
{
  "schemaVersion": 1,
  "base": "$NEW_BASE",
  "heads": {
    "440": "$NEW5",
    "441": "$NEW6",
    "442": "$NEW7"
  },
  "trees": {
    "440": "$(git rev-parse "$NEW5^{tree}")",
    "441": "$(git rev-parse "$NEW6^{tree}")",
    "442": "$ACTUAL_TREE",
    "expectedFinal": "$EXPECTED_TREE"
  }
}
EOF
cat rechain-plan/plan.json
