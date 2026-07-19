#!/usr/bin/env bash
set -euo pipefail

git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"
git fetch origin main split/405-1-lifecycle-accessibility split/405-2-canonical-build-provenance split/405-3-video-export-contract split/405-4-media-validation split/405-5-reviewed-media-evidence --prune

MAIN=$(git rev-parse origin/main)
OLD_RUNTIME=$(git rev-parse origin/split/405-1-lifecycle-accessibility)
OLD_BUILD=$(git rev-parse origin/split/405-2-canonical-build-provenance)
OLD_VIDEO=$(git rev-parse origin/split/405-3-video-export-contract)
OLD_MEDIA_TOOL=$(git rev-parse origin/split/405-4-media-validation)
OLD_MEDIA_ASSETS=$(git rev-parse origin/split/405-5-reviewed-media-evidence)
BASE_RUNTIME=$(git merge-base "$MAIN" "$OLD_RUNTIME")

B1=split/405-1-runtime-readiness
B2=split/405-2-accessibility-task-surface
B3=split/405-3-canonical-build
B4=split/405-4-vendor-provenance
B5=split/405-5-video-export-contract
B6=split/405-6-media-validation
B7=split/405-7-reviewed-media-evidence

apply_changed_paths() {
  local source=$1 compare_base=$2
  shift 2
  local status path new_path
  while IFS= read -r -d '' status; do
    IFS= read -r -d '' path
    case "$status" in
      D*) git rm -f --ignore-unmatch -- "$path" ;;
      R*|C*) IFS= read -r -d '' new_path; git rm -f --ignore-unmatch -- "$path"; git checkout "$source" -- "$new_path" ;;
      *) git checkout "$source" -- "$path" ;;
    esac
  done < <(git diff --name-status -z "$compare_base" "$source" -- "$@")
}

apply_all_changed() {
  local source=$1 compare_base=$2
  local status path new_path
  while IFS= read -r -d '' status; do
    IFS= read -r -d '' path
    case "$status" in
      D*) git rm -f --ignore-unmatch -- "$path" ;;
      R*|C*) IFS= read -r -d '' new_path; git rm -f --ignore-unmatch -- "$path"; git checkout "$source" -- "$new_path" ;;
      *) git checkout "$source" -- "$path" ;;
    esac
  done < <(git diff --name-status -z "$compare_base" "$source")
}

commit_and_push() {
  local branch=$1 message=$2
  git add -A
  git diff --cached --quiet && { echo "No changes selected for $branch" >&2; exit 1; }
  git commit -m "$message"
  git push --force-with-lease origin "$branch"
}

assert_paths_equal() {
  local expected=$1 actual=$2 compare_base=$3 mismatches=0 path
  while IFS= read -r -d '' path; do
    if ! git diff --quiet "$expected" "$actual" -- "$path"; then
      echo "Mismatch: $path" >&2
      mismatches=$((mismatches + 1))
    fi
  done < <(git diff --name-only -z "$compare_base" "$expected")
  (( mismatches == 0 )) || exit 1
}

git checkout -B "$B1" "$MAIN"
apply_changed_paths "$OLD_RUNTIME" "$BASE_RUNTIME" \
  README.md TESTING.md WERKBANK_V2.md docs/architecture.md docs/qa.md \
  js/ua.app_v2.js js/ua.context_road_layer.js js/ua.core.js js/ua.export_v2.js \
  js/ua.lifecycle.js js/ua.map_v2.js js/ua.osm_context.js js/ua.political-context.js \
  js/ua.popup_context.js js/ua.priorities.js js/ua.report_v2.js js/ua.utils.js \
  tests/e2e/context-data-render.spec.js tests/e2e/fixtures tests/e2e/helpers.js \
  tests/e2e/popup-context.spec.js tests/e2e/url-hydration-berlin-slope.spec.js \
  tests/e2e/url-hydration-bonn.spec.js \
  tests/unit/ua.lifecycle.test.js tests/unit/ua.map_v2.contextOverlays.test.js \
  tests/unit/ua.map_v2.lazyPopup.test.js tests/unit/ua.osm_context.test.js \
  tests/unit/ua.political-context.buildSearchTerms.test.js tests/unit/ua.popup_context.test.js \
  tests/unit/ua.priorities.test.js tests/unit/ua.report_v2.pdfQA.test.js \
  tests/unit/ua.report_v2.test.js tests/unit/uaContextRoadLayer.test.js
commit_and_push "$B1" "qa: isolate lifecycle and export readiness"

git checkout -B "$B2" "$B1"
apply_changed_paths "$OLD_RUNTIME" "$BASE_RUNTIME" \
  combi.html css/ua.css index.html unfallwerkbank.html werkbank.html werkbank_v2.html \
  js/ua.tour.js js/ua.ui.js playwright.config.js \
  tests/e2e/accessibility.spec.js tests/e2e/smoke.spec.js tests/e2e/task-surface.spec.js \
  tests/e2e/werkbank.spec.js tests/unit/ua.accessibilityBaseline.test.js \
  tests/unit/ua.modalController.test.js tests/unit/ua.tour.dialogA11y.test.js
commit_and_push "$B2" "ux: isolate accessibility and responsive task surface"
assert_paths_equal "$OLD_RUNTIME" "$B2" "$BASE_RUNTIME"

git checkout -B "$B3" "$B2"
apply_changed_paths "$OLD_BUILD" "$OLD_RUNTIME" \
  .dockerignore .gitignore package.json package-lock.json scripts/build-site.js \
  scripts/build-static-data.js scripts/serve-site.js server/lib/safeStaticPath.js \
  server/lib/staticDataOverlay.js tests/unit/assetVersioning.test.js \
  tests/unit/buildStaticData.test.js tests/unit/safeStaticPath.test.js \
  tests/unit/siteBuildContract.test.js tests/unit/staticDataOverlay.test.js \
  docs/RELEASING.md docs/docker.md docs/release-checklist.md docs/site-build.md
commit_and_push "$B3" "build: isolate canonical site construction"

git checkout -B "$B4" "$B3"
apply_changed_paths "$OLD_BUILD" "$OLD_RUNTIME" \
  .github/workflows/deploy-release.yml .github/workflows/docker-publish.yml \
  .github/workflows/generate-data-deploy-pages.yml docs/THIRD_PARTY_NOTICES.md \
  scripts/validate-vendor-provenance.js scripts/vendor-provenance.js \
  tests/unit/vendorProvenance.test.js vendor/provenance-policy.json
commit_and_push "$B4" "build: isolate vendor and license provenance"
assert_paths_equal "$OLD_BUILD" "$B4" "$OLD_RUNTIME"

git checkout -B "$B5" "$B4"
apply_all_changed "$OLD_VIDEO" "$OLD_BUILD"
commit_and_push "$B5" "export: rebase video evidence contract onto focused stack"
assert_paths_equal "$OLD_VIDEO" "$B5" "$OLD_BUILD"

git checkout -B "$B6" "$B5"
apply_all_changed "$OLD_MEDIA_TOOL" "$OLD_VIDEO"
commit_and_push "$B6" "docs: rebase media validation tooling onto focused stack"
assert_paths_equal "$OLD_MEDIA_TOOL" "$B6" "$OLD_VIDEO"

git checkout -B "$B7" "$B6"
apply_all_changed "$OLD_MEDIA_ASSETS" "$OLD_MEDIA_TOOL"
commit_and_push "$B7" "docs: rebase reviewed media evidence onto focused stack"
assert_paths_equal "$OLD_MEDIA_ASSETS" "$B7" "$OLD_MEDIA_TOOL"
BASE_FINAL=$(git merge-base "$MAIN" "$OLD_MEDIA_ASSETS")
assert_paths_equal "$OLD_MEDIA_ASSETS" "$B7" "$BASE_FINAL"

cat > /tmp/pr1.md <<'EOF'
## Scope
Part 1 of 7 replacing oversized PR #405.

Contains runtime lifecycle, semantic map/data readiness, context-layer correctness and export readiness/error propagation with focused tests. It excludes accessibility/task-surface work, build/release changes, video export and media.

## Order
Merge first.

Relates to #397, #400 and #407.
EOF
cat > /tmp/pr2.md <<EOF
## Scope
Part 2 of 7 replacing oversized PR #405.

Contains native controls, modal semantics, keyboard/focus behavior, responsive mobile task surface and accessibility tests only.

## Stack
Base: \`$B1\`

Relates to #402.
EOF
cat > /tmp/pr3.md <<EOF
## Scope
Part 3 of 7 replacing oversized PR #405.

Contains deterministic site construction, reproducible static-data assembly, safe path handling and focused build-contract tests. Vendor/license policy and publication gates are deferred to the next PR.

## Stack
Base: \`$B2\`

Relates to #403.
EOF
cat > /tmp/pr4.md <<EOF
## Scope
Part 4 of 7 replacing oversized PR #405.

Contains vendor/license provenance policy, third-party notices, validation implementation and public-distribution workflow gates.

## Stack
Base: \`$B3\`

Relates to #406.
EOF
cat > /tmp/pr5.md <<EOF
## Scope
Part 5 of 7 replacing oversized PR #405.

Contains only the canonical video-export request/state contract, browser/server verification, fail-closed validation and real testcontainers integration.

## Stack
Base: \`$B4\`

Relates to #407 and #408.
EOF
cat > /tmp/pr6.md <<EOF
## Scope
Part 6 of 7 replacing oversized PR #405.

Contains documentation-media policy, deterministic screenshot/regeneration tooling, evidence validators, workflow safety and focused tests. No regenerated image assets or checked-in ledger.

## Stack
Base: \`$B5\`

Relates to #397, #400, #404 and #407.
EOF
cat > /tmp/pr7.md <<EOF
## Scope
Part 7 of 7 replacing oversized PRs #405 and #409.

Contains only reviewed documentation images, full map-and-panel control screenshots, readiness sidecars, provenance ledger and artifact documentation.

A path-by-path losslessness check proves that this seven-PR stack reproduces the previously verified final branch exactly.

## Stack
Base: \`$B6\`

Relates to #397, #400, #404 and #407.
EOF

gh pr edit 416 --base main --title "QA split 1/7: runtime lifecycle and export readiness" --body-file /tmp/pr1.md
PR2=$(gh pr list --state open --head "$B2" --json url --jq '.[0].url // empty')
if [[ -z "$PR2" ]]; then
  PR2=$(gh pr create --draft --head "$B2" --base "$B1" --title "QA split 2/7: accessibility and responsive task surface" --body-file /tmp/pr2.md)
fi
gh pr edit 417 --base "$B2" --title "QA split 3/7: canonical site construction" --body-file /tmp/pr3.md
PR4=$(gh pr list --state open --head "$B4" --json url --jq '.[0].url // empty')
if [[ -z "$PR4" ]]; then
  PR4=$(gh pr create --draft --head "$B4" --base "$B3" --title "QA split 4/7: vendor and license provenance" --body-file /tmp/pr4.md)
fi
gh pr edit 418 --base "$B4" --title "QA split 5/7: video export request and evidence contract" --body-file /tmp/pr5.md
gh pr edit 425 --base "$B5" --title "QA split 6/7: documentation media validation tooling" --body-file /tmp/pr6.md
gh pr edit 426 --base "$B6" --title "QA split 7/7: reviewed media assets and durable evidence" --body-file /tmp/pr7.md

SUMMARY=$(cat <<EOF
The final, losslessly verified replacement chain for #405/#409 is now:

1. #416 — runtime lifecycle and export readiness
2. $PR2 — accessibility and responsive task surface
3. #417 — canonical site construction
4. $PR4 — vendor and license provenance
5. #418 — video export request/evidence contract
6. #425 — media validation tooling
7. #426 — reviewed media assets/evidence

The final branch is path-by-path identical to the previously verified final media branch. Only history and review boundaries changed.
EOF
)
gh pr comment 405 --body "$SUMMARY"
gh issue comment 397 --body "$SUMMARY"

for branch in split/405-1-lifecycle-accessibility split/405-2-canonical-build-provenance split/405-3-video-export-contract split/405-4-media-validation split/405-5-reviewed-media-evidence automation/refine-split-405 automation/refine-split-405-trigger; do
  git push origin --delete "$branch" 2>/dev/null || true
done
