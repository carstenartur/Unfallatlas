#!/usr/bin/env bash
set -euo pipefail

REPO="carstenartur/Unfallatlas"
B3="split/405-3-canonical-build"
B5="split/405-5-video-export-contract"
B6="split/405-6-media-validation"
B7="split/405-7-reviewed-media-evidence"

# Last reviewed/reconstructed heads before this ownership repair.
MERGED_433="078d8b1f8ef61f4a9ce1dcae423dceec262d59b6"
OLD_BUILD_BASE="6847ec2e35ff3b7469f4dbc820a6e3735bdf171d"
OLD3="903244b7d5a91347c7f4795183b1388195559cc0"
OLD4="ccab4b516e23922073ebcbfffe3c3550f099f02f"
OLD5="73c8781fcdff9d65bd4459933171ef47d414d6be"
OLD6="4baeda2e8775ddb07e33c6edba5a3962865cb49e"
OLD7="582d92ed33354da148a2abf1c251c3013e6243b7"

MEDIA_OWNER_FILES=(
  package.json
  docs/release-checklist.md
  docs/site-build.md
  tests/unit/siteBuildContract.test.js
  .github/workflows/deploy-release.yml
  .github/workflows/generate-data-deploy-pages.yml
)

git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"
git fetch origin main "$B3" split/405-4-vendor-provenance "$B5" "$B6" "$B7" --prune

NEW_BASE=$(git rev-parse origin/main)
[[ "$(git rev-parse origin/$B3)" == "$OLD3" ]] || { echo "Unexpected #439 head" >&2; exit 1; }
[[ "$(git rev-parse origin/split/405-4-vendor-provenance)" == "$OLD4" ]] || { echo "Unexpected #434 head" >&2; exit 1; }
[[ "$(git rev-parse origin/$B5)" == "$OLD5" ]] || { echo "Unexpected #440 head" >&2; exit 1; }
[[ "$(git rev-parse origin/$B6)" == "$OLD6" ]] || { echo "Unexpected #441 head" >&2; exit 1; }
[[ "$(git rev-parse origin/$B7)" == "$OLD7" ]] || { echo "Unexpected #442 head" >&2; exit 1; }

git merge-base --is-ancestor "$MERGED_433" "$NEW_BASE" || {
  echo "main no longer descends from merged #433" >&2
  exit 1
}

# Since #433, only the automatic documentation screenshot refresh may have
# advanced main. Any product/configuration change requires a fresh review.
mapfile -t post_433_paths < <(git diff --name-only "$MERGED_433" "$NEW_BASE")
for path in "${post_433_paths[@]}"; do
  [[ "$path" == docs/screenshots/*.png ]] || {
    echo "Unexpected main change after #433: $path" >&2
    exit 1
  }
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

commit_and_push() {
  local branch=$1 expected_remote=$2 message=$3
  git add -A
  git diff --cached --check
  git diff --cached --quiet && { echo "Empty rebuilt delta for $branch" >&2; exit 1; }
  git commit -m "$message"
  git push --force-with-lease="refs/heads/$branch:$expected_remote" origin "HEAD:refs/heads/$branch"
}

strip_media_from_combined_build() {
  python3 <<'PY'
from pathlib import Path
import re

# The canonical build/provenance PR must not advertise media commands whose
# implementation is intentionally owned by the later media-tooling PR.
p = Path('package.json')
s = p.read_text()
for line in (
    '    "validate:media": "node scripts/validate-doc-media.js",\n',
    '    "validate:screenshot-evidence": "node scripts/validate-screenshot-evidence.js",\n',
):
    if s.count(line) != 1:
        raise SystemExit(f'expected exactly one package script line: {line.strip()}')
    s = s.replace(line, '')
p.write_text(s)

p = Path('docs/release-checklist.md')
s = p.read_text()
line = '- [ ] `npm run validate:media` besteht (Abmessungen, Budget, Referenzen)\n'
if s.count(line) != 1:
    raise SystemExit('release checklist media line not found exactly once')
p.write_text(s.replace(line, ''))

p = Path('docs/site-build.md')
s = p.read_text()
marker = '\n## Dokumentationsmedien\n'
if s.count(marker) != 1:
    raise SystemExit('site-build media section boundary not found exactly once')
p.write_text(s.split(marker, 1)[0].rstrip() + '\n')

p = Path('tests/unit/siteBuildContract.test.js')
s = p.read_text()
media_order = """      if (workflowPath !== '.github/workflows/docker-publish.yml') {
        expect(workflow.indexOf('npm run validate:media'))
          .toBeLessThan(workflow.indexOf('npm run validate:vendor-provenance -- --require-complete'));
      }
"""
if s.count(media_order) != 1:
    raise SystemExit('site-build media-order assertion not found exactly once')
s = s.replace(media_order, '')
for line in (
    "    expect(pages).toContain('npm run validate:media -- --report out/qa/pages-documentation-media.json');\n",
    "    expect(pages).toContain('pages-documentation-media-report');\n",
):
    if s.count(line) != 1:
        raise SystemExit(f'site-build media assertion not found exactly once: {line.strip()}')
    s = s.replace(line, '')
video_test = re.compile(
    r"\n  test\('container integration always builds the exact checked-out Docker context', \(\) => \{.*?\n  \}\);\n",
    re.S,
)
s, count = video_test.subn('\n', s)
if count != 1:
    raise SystemExit('video workflow ownership test not found exactly once')
p.write_text(s)

p = Path('.github/workflows/deploy-release.yml')
s = p.read_text()
pattern = re.compile(
    r"\n      - name: Validate release documentation media\n.*?(?=\n      - name: Require complete vendor provenance before publication)",
    re.S,
)
s, count = pattern.subn('\n', s)
if count != 1:
    raise SystemExit('release media workflow block not found exactly once')
p.write_text(s)

p = Path('.github/workflows/generate-data-deploy-pages.yml')
s = p.read_text()
line = '          npm run validate:media -- --report out/qa/pages-documentation-media.json\n'
if s.count(line) != 1:
    raise SystemExit('pages media validation command not found exactly once')
s = s.replace(line, '')
pattern = re.compile(
    r"\n      - name: Upload Pages media QA evidence\n.*?(?=\n      - name: Require complete vendor provenance before deployment)",
    re.S,
)
s, count = pattern.subn('\n', s)
if count != 1:
    raise SystemExit('pages media upload block not found exactly once')
p.write_text(s)
PY
}

make_provenance_only_dockerfile() {
  git show "$OLD5:Dockerfile" > Dockerfile
  python3 <<'PY'
from pathlib import Path
import re
p = Path('Dockerfile')
s = p.read_text()
pattern = re.compile(
    r"ARG REQUIRE_COMPLETE_VENDOR_PROVENANCE=0\nARG VIDEO_EXPORT_INTEGRATION_FIXTURE=0\nRUN case \"\$VIDEO_EXPORT_INTEGRATION_FIXTURE\" in \\\n.*?\n       esac\n",
    re.S,
)
replacement = """ARG REQUIRE_COMPLETE_VENDOR_PROVENANCE=0
RUN npm run build:site \\
    && case "$REQUIRE_COMPLETE_VENDOR_PROVENANCE" in \\
         0) ;; \\
         1) npm run validate:vendor-provenance -- --require-complete ;; \\
         *) echo "REQUIRE_COMPLETE_VENDOR_PROVENANCE must be 0 or 1" >&2; exit 2 ;; \\
       esac
"""
s, count = pattern.subn(replacement, s)
if count != 1:
    raise SystemExit('combined Docker provenance/video block not found exactly once')
p.write_text(s)
PY
}

make_hermetic_video_workflow() {
  python3 <<'PY'
from pathlib import Path
import re
p = Path('.github/workflows/test.yml')
s = p.read_text()
patterns = [
    re.compile(r"\n      - name: Decide video export image source\n.*?(?=\n      - name: Install dependencies\n)", re.S),
    re.compile(r"\n      - name: Try to pull pre-built image\n.*?(?=\n      - name: Run testcontainers integration test\n)", re.S),
]
for pattern in patterns:
    s, count = pattern.subn('\n', s)
    if count != 1:
        raise SystemExit('video image-source workflow block not found exactly once')
old = """      - name: Run testcontainers integration test
        env:
          UNFALLATLAS_IMAGE: ${{ steps.pull.outputs.image }}
        run: npm run test:integration:tc
"""
new = """      - name: Run testcontainers integration test
        run: npm run test:integration:tc
"""
if s.count(old) != 1:
    raise SystemExit('testcontainers image environment block not found exactly once')
p.write_text(s.replace(old, new))
PY
}

add_video_workflow_contract_test() {
  python3 <<'PY'
from pathlib import Path
p = Path('tests/unit/siteBuildContract.test.js')
s = p.read_text()
block = """
  test('container integration always builds the exact checked-out Docker context', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
    expect(workflow).toContain('npm run test:integration:tc');
    expect(workflow).not.toContain('use_prebuilt');
    expect(workflow).not.toContain('ghcr.io/carstenartur/unfallatlas:latest');
    expect(workflow).not.toContain('UNFALLATLAS_IMAGE:');
  });
"""
if block.strip() in s:
    raise SystemExit('video workflow contract test already present')
marker = '\n});\n'
if not s.endswith(marker):
    raise SystemExit('site build contract suite end not found')
p.write_text(s[:-len(marker)] + block + marker)
PY
}

# ---------------------------------------------------------------------------
# #439: canonical build and vendor provenance are one executable boundary.
# ---------------------------------------------------------------------------
git checkout -B "$B3" "$NEW_BASE"
apply_changed_paths "$OLD_BUILD_BASE" "$OLD4"
strip_media_from_combined_build
make_provenance_only_dockerfile

# Closed boundary checks before publishing the branch.
test -f scripts/vendor-provenance.js
test -f scripts/validate-vendor-provenance.js
test -f vendor/provenance-policy.json
grep -F '"validate:vendor-provenance"' package.json >/dev/null
! grep -F '"validate:media"' package.json >/dev/null
! grep -F 'VIDEO_EXPORT_INTEGRATION_FIXTURE' Dockerfile >/dev/null
grep -F 'ARG REQUIRE_COMPLETE_VENDOR_PROVENANCE=0' Dockerfile >/dev/null
commit_and_push "$B3" "$OLD3" "build: close canonical site and vendor provenance boundary"
NEW3=$(git rev-parse HEAD)

# ---------------------------------------------------------------------------
# #440: video request/evidence contract plus hermetic Testcontainers execution.
# ---------------------------------------------------------------------------
git checkout -B "$B5" "$NEW3"
apply_changed_paths "$OLD4" "$OLD5"
make_hermetic_video_workflow
add_video_workflow_contract_test

grep -F 'ARG VIDEO_EXPORT_INTEGRATION_FIXTURE=0' Dockerfile >/dev/null
! grep -F 'use_prebuilt' .github/workflows/test.yml >/dev/null
! grep -F 'UNFALLATLAS_IMAGE:' .github/workflows/test.yml >/dev/null
commit_and_push "$B5" "$OLD5" "export: own video contract and hermetic container evidence"
NEW5=$(git rev-parse HEAD)

# ---------------------------------------------------------------------------
# #441: media implementation plus every media-facing command/workflow contract.
# ---------------------------------------------------------------------------
git checkout -B "$B6" "$NEW5"
apply_changed_paths "$OLD5" "$OLD6"
for path in "${MEDIA_OWNER_FILES[@]}"; do
  git checkout "$OLD4" -- "$path"
done

test -f scripts/validate-doc-media.js
test -f scripts/validate-screenshot-evidence.js
grep -F '"validate:media"' package.json >/dev/null
grep -F 'npm run validate:media' .github/workflows/deploy-release.yml >/dev/null
grep -F 'npm run validate:media' .github/workflows/generate-data-deploy-pages.yml >/dev/null
grep -F 'documentation-media-report' .github/workflows/test.yml >/dev/null
commit_and_push "$B6" "$OLD6" "docs: close media tooling and workflow boundary"
NEW6=$(git rev-parse HEAD)

# Up to #441 the only permitted tree drift from the previously reviewed #441
# is the automatic screenshot refresh already present on main. #442 owns those
# paths and replaces them with reviewed assets.
mapfile -t pre_media_diff < <(git diff --name-only "$OLD6" "$NEW6")
for path in "${pre_media_diff[@]}"; do
  [[ "$path" == docs/screenshots/*.png ]] || {
    echo "Unexpected #441 tree drift: $path" >&2
    exit 1
  }
done

# ---------------------------------------------------------------------------
# #442: reviewed media/evidence only; final product tree must be byte-identical.
# ---------------------------------------------------------------------------
git checkout -B "$B7" "$NEW6"
apply_changed_paths "$OLD6" "$OLD7"
commit_and_push "$B7" "$OLD7" "docs: restore reviewed media and durable evidence"
NEW7=$(git rev-parse HEAD)

git diff --quiet "$OLD7" "$NEW7" || {
  echo "Final reconstructed #442 tree is not identical to the verified tree" >&2
  git diff --name-status "$OLD7" "$NEW7" >&2
  exit 1
}

# Retarget the shortened stack only after all tree proofs succeeded.
gh api -X PATCH "repos/$REPO/pulls/439" -f base=main >/dev/null
gh api -X PATCH "repos/$REPO/pulls/440" -f base="$B3" >/dev/null
gh api -X PATCH "repos/$REPO/pulls/441" -f base="$B5" >/dev/null
gh api -X PATCH "repos/$REPO/pulls/442" -f base="$B6" >/dev/null

gh api -X POST "repos/$REPO/issues/434/comments" -f body="Subsumed by #439 after executable-boundary QA showed that the canonical site builder imports and requires the provenance generator and policy. The combined #439 boundary is independently runnable; media-only commands and gates were moved to #441." >/dev/null
gh api -X PATCH "repos/$REPO/pulls/434" -f state=closed >/dev/null

cat > /tmp/rebuild-comment.md <<EOF
Executable stack boundaries repaired and proven lossless:

- #439 now owns canonical site construction **and** the vendor-provenance generator, policy, validator and publication gates required by that build.
- #434 is subsumed and closed.
- #440 owns the video request/evidence contract and the hermetic local Testcontainers workflow.
- #441 owns media validators, media commands and all media QA workflow steps.
- #442 remains reviewed media/evidence only.
- The reconstructed #441 tree differs from the former reviewed #441 only in automatic screenshot-refresh paths inherited from current main.
- The reconstructed #442 tree is byte-identical to verified head \`$OLD7\`.

New heads:
- #439 \`$NEW3\`
- #440 \`$NEW5\`
- #441 \`$NEW6\`
- #442 \`$NEW7\`
EOF
gh api -X POST "repos/$REPO/issues/439/comments" -f body="$(cat /tmp/rebuild-comment.md)" >/dev/null

printf 'REPAIRED_HEADS=%s %s %s %s\n' "$NEW3" "$NEW5" "$NEW6" "$NEW7"
