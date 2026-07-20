#!/usr/bin/env bash
set -euo pipefail

TARGET_BRANCH=split/405-5-video-export-contract
EXPECTED_TARGET_HEAD=fa8ef16a2bf25919401b2868d4c4adb2ea2ca8e9

git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"
git fetch origin "$TARGET_BRANCH" --prune
[[ "$(git rev-parse "origin/$TARGET_BRANCH")" == "$EXPECTED_TARGET_HEAD" ]] || {
  echo "Unexpected #440 head; refusing to overwrite a moved review branch" >&2
  exit 1
}

git checkout -B apply-webp-budget "origin/$TARGET_BRANCH"

python3 <<'PY'
from pathlib import Path

implementation = Path('server/video-export.js')
source = implementation.read_text()
old = "const { ANIMATED_IMAGE_FILTER } = require('./video-export-filters.js');\nconst { inspectRecordedSourceFrames } = require('./video-source-evidence.js');"
new = "const { ANIMATED_IMAGE_FILTER } = require('./video-export-filters.js');\nconst { inspectRecordedSourceFrames } = require('./video-source-evidence.js');\nconst WEBP_ANIMATED_IMAGE_FILTER = ANIMATED_IMAGE_FILTER.replace(/^fps=\\d+/, 'fps=2');"
if source.count(old) != 1:
    raise SystemExit('WebP filter constant insertion point not found exactly once')
source = source.replace(old, new)

start = source.index('function buildWebpEncodingArgs(')
end = source.index('\n}\n', start)
block = source[start:end]
old = "'-vf', ANIMATED_IMAGE_FILTER,"
new = "'-vf', WEBP_ANIMATED_IMAGE_FILTER,"
if block.count(old) != 1:
    raise SystemExit('WebP encoder filter insertion point not found exactly once')
source = source[:start] + block.replace(old, new) + source[end:]
implementation.write_text(source)

contract = Path('tests/unit/videoExportEncodingContract.test.js')
source = contract.read_text()
old = "    expect(args).not.toContain('libwebp');\n    expect(args).not.toContain('-vsync');"
new = "    expect(args).toContain('fps=2,scale=720:-1:flags=lanczos');\n    expect(args).not.toContain('fps=3,scale=720:-1:flags=lanczos');\n    expect(args).not.toContain('libwebp');\n    expect(args).not.toContain('-vsync');"
if source.count(old) != 1:
    raise SystemExit('WebP unit-contract insertion point not found exactly once')
contract.write_text(source.replace(old, new))
PY

git diff --check
npm ci
npx jest --runInBand \
  tests/unit/videoExportEncodingContract.test.js \
  tests/unit/videoSourceEvidence.test.js \
  tests/unit/videoExportCodecWrapper.test.js

RUN_TESTCONTAINERS=1 NODE_OPTIONS=--experimental-vm-modules npx jest \
  --config=tests/integration/jest.testcontainers.config.js \
  --runInBand \
  --testNamePattern='returns valid webp export \((body:webp|query:webp)\)'

git add server/video-export.js tests/unit/videoExportEncodingContract.test.js
git diff --cached --check
git diff --cached --quiet && { echo "No WebP budget patch to commit" >&2; exit 1; }
git commit -m "fix: keep lossless WebP exports within budget"
NEW_HEAD=$(git rev-parse HEAD)

git fetch origin "$TARGET_BRANCH"
[[ "$(git rev-parse "origin/$TARGET_BRANCH")" == "$EXPECTED_TARGET_HEAD" ]] || {
  echo "#440 moved while validation ran; refusing non-fast-forward push" >&2
  exit 1
}
git push origin "$NEW_HEAD:refs/heads/$TARGET_BRANCH"
echo "Updated #440 to $NEW_HEAD"
