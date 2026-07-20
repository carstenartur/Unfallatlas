#!/usr/bin/env bash
set -euo pipefail

TARGET_BRANCH=split/405-5-video-export-contract
DIAGNOSTIC_BRANCH=diagnostic/440-codec-format-matrix
EXPECTED_TARGET_HEAD=fa8ef16a2bf25919401b2868d4c4adb2ea2ca8e9
EXPECTED_DIAGNOSTIC_HEAD=b21dfe41dc1fb6f76a9cf323c55edfe39f52e93a

git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"
git fetch origin "$TARGET_BRANCH" "$DIAGNOSTIC_BRANCH" --prune
[[ "$(git rev-parse "origin/$TARGET_BRANCH")" == "$EXPECTED_TARGET_HEAD" ]] || {
  echo "Unexpected #440 head; refusing to overwrite a moved review branch" >&2
  exit 1
}
[[ "$(git rev-parse "origin/$DIAGNOSTIC_BRANCH")" == "$EXPECTED_DIAGNOSTIC_HEAD" ]] || {
  echo "Unexpected same-frame diagnostic head" >&2
  exit 1
}

git checkout -B apply-webp-budget "origin/$TARGET_BRANCH"
git checkout "origin/$DIAGNOSTIC_BRANCH" -- \
  server/video-source-evidence.js \
  tests/unit/videoSourceEvidence.test.js

python3 <<'PY'
from pathlib import Path

implementation = Path('server/video-export.js')
source = implementation.read_text()
old = 'const WEBP_QUALITY = 60;'
new = 'const WEBP_QUALITY = 70;'
if source.count(old) != 1:
    raise SystemExit('WebP quality insertion point not found exactly once')
implementation.write_text(source.replace(old, new))

contract = Path('tests/unit/videoExportEncodingContract.test.js')
source = contract.read_text()
old = "      '-lossless', '1',\n      '-f', 'webp',"
new = "      '-lossless', '1',\n      '-q:v', '70',\n      '-f', 'webp',"
if source.count(old) != 1:
    raise SystemExit('WebP q70 unit-contract insertion point not found exactly once')
contract.write_text(source.replace(old, new))
PY

git diff --check
npm ci
npx jest --runInBand \
  tests/unit/videoExportEncodingContract.test.js \
  tests/unit/videoSourceEvidence.test.js \
  tests/unit/videoExportCodecWrapper.test.js

git add \
  server/video-export.js \
  server/video-source-evidence.js \
  tests/unit/videoExportEncodingContract.test.js \
  tests/unit/videoSourceEvidence.test.js
git diff --cached --check
git diff --cached --quiet && { echo "No WebP evidence patch to commit" >&2; exit 1; }
git commit -m "fix: make lossless WebP evidence deterministic"
NEW_HEAD=$(git rev-parse HEAD)

git fetch origin "$TARGET_BRANCH"
[[ "$(git rev-parse "origin/$TARGET_BRANCH")" == "$EXPECTED_TARGET_HEAD" ]] || {
  echo "#440 moved while validation ran; refusing non-fast-forward push" >&2
  exit 1
}
git push origin "$NEW_HEAD:refs/heads/$TARGET_BRANCH"
echo "Updated #440 to $NEW_HEAD"
