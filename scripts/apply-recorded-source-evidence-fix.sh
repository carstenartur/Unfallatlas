#!/usr/bin/env bash
set -euo pipefail

TARGET_BRANCH=split/405-5-video-export-contract
DIAGNOSTIC_BRANCH=diagnostic/440-codec-fix-log
EXPECTED_TARGET_HEAD=6c90f7c7006396e88a240bf6535fe43e01ba697a
EXPECTED_DIAGNOSTIC_HEAD=6465d550d44b22d78f461948319e559d9a0734c4

git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"
git fetch origin "$TARGET_BRANCH" "$DIAGNOSTIC_BRANCH" --prune

[[ "$(git rev-parse "origin/$TARGET_BRANCH")" == "$EXPECTED_TARGET_HEAD" ]] || {
  echo "Unexpected #440 head; refusing to overwrite a moved review branch" >&2
  exit 1
}
[[ "$(git rev-parse "origin/$DIAGNOSTIC_BRANCH")" == "$EXPECTED_DIAGNOSTIC_HEAD" ]] || {
  echo "Unexpected diagnostic head; recorded-frame implementation changed" >&2
  exit 1
}

git checkout -B apply-recorded-source-evidence "origin/$TARGET_BRANCH"
git checkout "origin/$DIAGNOSTIC_BRANCH" -- \
  server/video-source-evidence.js \
  tests/unit/videoSourceEvidence.test.js

python3 <<'PY'
from pathlib import Path

implementation = Path('server/video-export.js')
source = implementation.read_text()
replacements = [
    (
        "const { ANIMATED_IMAGE_FILTER } = require('./video-export-filters.js');",
        "const { ANIMATED_IMAGE_FILTER } = require('./video-export-filters.js');\nconst { inspectRecordedSourceFrames } = require('./video-source-evidence.js');",
        'recorded-frame helper import',
    ),
    (
        "    webmPath = videoPath;\n\n    // ── 16. WebM → Zielformat konvertieren",
        "    webmPath = videoPath;\n    let recordedFrameEvidence;\n    try {\n      recordedFrameEvidence = await inspectRecordedSourceFrames(\n        webmPath, requiredState, semanticFrame\n      );\n    } catch (error) {\n      if (error && error.code && !error.status) error.status = 422;\n      throw error;\n    }\n\n    // ── 16. WebM → Zielformat konvertieren",
        'recorded-frame inspection call',
    ),
    (
        "const expectedColor = parseRgb(witness.expectedColor);",
        "const expectedColor = parseRgb(witness.renderedColor || witness.expectedColor);",
        'rendered context colour selection',
    ),
    (
        "'-lossless', '0',",
        "'-lossless', '1',",
        'lossless WebP encoder',
    ),
    (
        "const encodedFrames = await inspectEncodedFrames(outputPath, requiredState, semanticFrame);",
        "const encodedFrames = await inspectEncodedFrames(outputPath, requiredState, recordedFrameEvidence);",
        'final encoded-frame inspection input',
    ),
    (
        "frameBeforeEncoding: semanticFrame,\n        framesAfterEncoding: encodedFrames,",
        "frameBeforeEncoding: semanticFrame,\n        recordedSourceFrames: recordedFrameEvidence,\n        framesAfterEncoding: encodedFrames,",
        'recorded source evidence payload',
    ),
]
for old, new, label in replacements:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label} insertion point found {count} times')
    source = source.replace(old, new)
implementation.write_text(source)

encoding_test = Path('tests/unit/videoExportEncodingContract.test.js')
source = encoding_test.read_text()
old = "      '-c:v', 'libwebp_anim',\n      '-f', 'webp',"
new = "      '-c:v', 'libwebp_anim',\n      '-lossless', '1',\n      '-f', 'webp',"
if source.count(old) != 1:
    raise SystemExit('lossless WebP unit-contract insertion point not found exactly once')
encoding_test.write_text(source.replace(old, new))
PY

git diff --check
npm ci
npx jest --runInBand \
  tests/unit/videoSourceEvidence.test.js \
  tests/unit/videoExportEncodingContract.test.js \
  tests/unit/videoExportCodecWrapper.test.js

RUN_TESTCONTAINERS=1 NODE_OPTIONS=--experimental-vm-modules npx jest \
  --config=tests/integration/jest.testcontainers.config.js \
  --runInBand \
  --testNamePattern='returns valid webp export \(body:webp\)'

git add \
  server/video-export.js \
  server/video-source-evidence.js \
  tests/unit/videoExportEncodingContract.test.js \
  tests/unit/videoSourceEvidence.test.js
git diff --cached --check
git diff --cached --quiet && { echo "No #440 patch to commit" >&2; exit 1; }
git commit -m "fix: validate encoded context against recorded source frames"
NEW_HEAD=$(git rev-parse HEAD)

git fetch origin "$TARGET_BRANCH"
[[ "$(git rev-parse "origin/$TARGET_BRANCH")" == "$EXPECTED_TARGET_HEAD" ]] || {
  echo "#440 moved while validation ran; refusing non-fast-forward push" >&2
  exit 1
}
git push origin "$NEW_HEAD:refs/heads/$TARGET_BRANCH"
echo "Updated #440 to $NEW_HEAD"
