#!/usr/bin/env bash
set -euo pipefail

git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"
git fetch origin main split/405-3-video-export-contract split/405-4-reviewed-media-evidence --prune

BASE=origin/split/405-3-video-export-contract
SOURCE=origin/split/405-4-reviewed-media-evidence
TOOL_BRANCH=split/405-4-media-validation
ASSET_BRANCH=split/405-5-reviewed-media-evidence

apply_changed_paths() {
  local source=$1
  local compare_base=$2
  shift 2
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
  done < <(git diff --name-status -z "$compare_base" "$source" -- "$@")
}

git checkout -B "$TOOL_BRANCH" "$BASE"
apply_changed_paths "$SOURCE" "$BASE" \
  .github/workflows/generate-screenshots.yml \
  .github/workflows/test.yml \
  .github/workflows/visual-check.yml \
  docs/media-manifest.json \
  docs/screenshots/README.md \
  scripts/gif-timeline.js \
  scripts/regen-context-assets.js \
  scripts/regen-readme-demo.js \
  scripts/validate-doc-media.js \
  scripts/validate-screenshot-evidence.js \
  tests/e2e/demo.spec.js \
  tests/e2e/helpers.js \
  tests/e2e/screenshots.spec.js \
  tests/unit/docMediaPolicy.test.js \
  tests/unit/regen-readme-demo.test.js \
  tests/unit/screenshotEvidencePolicy.test.js \
  tests/unit/screenshotHelperSafety.test.js \
  tests/unit/screenshotNetworkFixtureRouting.test.js \
  tests/unit/screenshotPdfEmbeddedScript.test.js \
  tests/unit/screenshotWorkflowSafety.test.js

git add -A
git commit -m "qa: isolate documentation media validation tooling"
git push --force-with-lease origin "$TOOL_BRANCH"

git checkout -B "$ASSET_BRANCH" "$TOOL_BRANCH"
mapfile -d '' changed < <(git diff --name-only -z "$BASE" "$SOURCE")
for path in "${changed[@]}"; do
  if ! git diff --quiet "$SOURCE" -- "$path"; then
    if git cat-file -e "$SOURCE:$path" 2>/dev/null; then
      git checkout "$SOURCE" -- "$path"
    else
      git rm -f --ignore-unmatch -- "$path"
    fi
  fi
done

git add -A
git commit -m "docs: adopt reviewed media assets and durable evidence"
git push --force-with-lease origin "$ASSET_BRANCH"

mismatches=0
for path in "${changed[@]}"; do
  if ! git diff --quiet "$SOURCE" -- "$path"; then
    echo "Final media split mismatch: $path" >&2
    mismatches=$((mismatches + 1))
  fi
done
(( mismatches == 0 ))

cat > /tmp/pr4.md <<'EOF'
## Scope
Fourth part of the reviewed replacement for oversized PR #405.

This PR contains only the documentation-media policy, deterministic screenshot/regeneration tooling, evidence validators, workflow safety changes and focused tests. It does **not** contain the regenerated PNG/GIF files or checked-in evidence ledger.

## Stack
Base: `split/405-3-video-export-contract`

Relates to #397, #400, #404 and #407.
EOF

cat > /tmp/pr5.md <<'EOF'
## Scope
Final part of the reviewed replacement for oversized PRs #405 and #409.

This PR contains the actually reviewed documentation images, the complete map-and-panel control screenshots from #409, durable readiness sidecars, provenance ledger and the documentation that describes those reviewed artifacts.

It deliberately excludes the validator implementation, which is reviewed independently in the preceding PR.

A path-by-path losslessness check proves that the combined fourth and fifth branches reproduce the previously verified media branch exactly.

## Stack
Base: `split/405-4-media-validation`

Relates to #397, #400, #404 and #407. Supersedes #409 and the asset/evidence portion of #419.
EOF

create_pr() {
  local head=$1 base=$2 title=$3 body=$4
  local number
  number=$(gh pr list --state open --head "$head" --json number --jq '.[0].number // empty')
  if [[ -z "$number" ]]; then
    gh pr create --draft --head "$head" --base "$base" --title "$title" --body-file "$body"
  else
    gh pr edit "$number" --base "$base" --title "$title" --body-file "$body"
    gh pr view "$number" --json url --jq .url
  fi
}

PR4=$(create_pr "$TOOL_BRANCH" split/405-3-video-export-contract \
  "QA split 4/5: documentation media validation tooling" /tmp/pr4.md)
PR5=$(create_pr "$ASSET_BRANCH" "$TOOL_BRANCH" \
  "QA split 5/5: reviewed media assets and durable evidence" /tmp/pr5.md)

SUMMARY=$(cat <<EOF
The former media PR #419 has been split again for reviewability:

4. $PR4
5. $PR5

The combined branches passed a path-by-path equality check against the previously verified #419 head.
EOF
)

gh pr comment 419 --body "$SUMMARY"
gh pr close 419
gh issue comment 397 --body "$SUMMARY"
gh pr comment 405 --body "$SUMMARY"
