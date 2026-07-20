#!/usr/bin/env bash
set -euo pipefail

TARGET_BRANCH=split/405-5-video-export-contract
EXPECTED_TARGET_HEAD=79796dfb91fc77497c309d593ca8928000741c23

export PATH="$(pwd)/node_modules/.bin:$PATH"
git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"
git fetch origin "$TARGET_BRANCH" --prune
[[ "$(git rev-parse "origin/$TARGET_BRANCH")" == "$EXPECTED_TARGET_HEAD" ]] || {
  echo "Unexpected #440 head; refusing to overwrite a moved review branch" >&2
  exit 1
}

git checkout -B apply-common-grid-evidence "origin/$TARGET_BRANCH"

python3 <<'PY'
from pathlib import Path

source_file = Path('server/video-source-evidence.js')
source = source_file.read_text()
old = 'const SOURCE_INSPECTION_FPS = 2;'
new = "// Whole-second samples are shared by the 2fps GIF/APNG inspection and the 3fps WebP encoding.\nconst SOURCE_INSPECTION_FPS = 1;"
if source.count(old) != 1:
    raise SystemExit('source fps insertion point not found exactly once')
source_file.write_text(source.replace(old, new))

test_file = Path('tests/unit/videoSourceEvidence.test.js')
source = test_file.read_text()
old = "'-vf', 'fps=2,scale=720:-1:flags=lanczos',"
new = "'-vf', 'fps=1,scale=720:-1:flags=lanczos',"
if source.count(old) != 1:
    raise SystemExit('source fps test insertion point not found exactly once')
test_file.write_text(source.replace(old, new))
PY

git diff --check
npm ci
npx jest --runInBand \
  tests/unit/videoSourceEvidence.test.js \
  tests/unit/videoExportEncodingContract.test.js \
  tests/unit/videoExportCodecWrapper.test.js

RUN_TESTCONTAINERS=1 NODE_OPTIONS=--experimental-vm-modules npx jest \
  --config=tests/integration/jest.testcontainers.config.js \
  --runInBand

git add server/video-source-evidence.js tests/unit/videoSourceEvidence.test.js
git diff --cached --check
git diff --cached --quiet && { echo "No common-grid evidence patch to commit" >&2; exit 1; }
git commit -m "fix: sample video evidence on a shared time grid"
NEW_HEAD=$(git rev-parse HEAD)

git fetch origin "$TARGET_BRANCH"
[[ "$(git rev-parse "origin/$TARGET_BRANCH")" == "$EXPECTED_TARGET_HEAD" ]] || {
  echo "#440 moved while validation ran; refusing non-fast-forward push" >&2
  exit 1
}
git push origin "$NEW_HEAD:refs/heads/$TARGET_BRANCH"
echo "Updated #440 to $NEW_HEAD"
