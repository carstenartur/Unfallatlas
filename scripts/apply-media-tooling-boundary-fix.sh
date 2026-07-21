#!/usr/bin/env bash
set -euo pipefail

TARGET_BRANCH=split/405-6-media-validation
EXPECTED_TARGET_HEAD=505326c49b6d7170823d949032dde067517527ff
CONTROL_ROOT=$(pwd)
WORKTREE_ROOT=$(mktemp -d)

cleanup() {
  cd "$CONTROL_ROOT"
  git worktree remove --force "$WORKTREE_ROOT" >/dev/null 2>&1 || rm -rf "$WORKTREE_ROOT"
}
trap cleanup EXIT

git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"
git fetch origin "$TARGET_BRANCH" --prune
[[ "$(git rev-parse "origin/$TARGET_BRANCH")" == "$EXPECTED_TARGET_HEAD" ]] || {
  echo "Unexpected #441 head; refusing to overwrite a moved review branch" >&2
  exit 1
}

git worktree add --detach "$WORKTREE_ROOT" "origin/$TARGET_BRANCH"
cd "$WORKTREE_ROOT"
git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"

python3 <<'PY'
from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    source = p.read_text()
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one insertion point, found {count}')
    p.write_text(source.replace(old, new))

validator = 'scripts/validate-doc-media.js'
replace_once(
    validator,
    "const args = { manifest: 'docs/media-manifest.json', report: null, candidateScreenshots: false };",
    "const args = { manifest: 'docs/media-manifest.json', report: null, candidateScreenshots: false, policyOnly: false };",
    'validator argument defaults',
)
replace_once(
    validator,
    "    else if (argv[i] === '--candidate-screenshots') args.candidateScreenshots = true;\n    else throw new Error(`[validate-doc-media] Unknown argument: ${argv[i]}`);",
    "    else if (argv[i] === '--candidate-screenshots') args.candidateScreenshots = true;\n    else if (argv[i] === '--policy-only') args.policyOnly = true;\n    else throw new Error(`[validate-doc-media] Unknown argument: ${argv[i]}`);",
    'validator policy-only argument',
)
replace_once(
    validator,
    "function validate(options = {}) {\n  const repoRoot = path.resolve(options.root || ROOT);",
    "function validate(options = {}) {\n  const policyOnly = options.policyOnly === true;\n  const repoRoot = path.resolve(options.root || ROOT);",
    'validator policy-only state',
)
replace_once(
    validator,
    "    if (assetPathSafe && fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {",
    "    if (!policyOnly && assetPathSafe && fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {",
    'validator byte inspection guard',
)
replace_once(
    validator,
    "  const evidenceResult = options.candidateScreenshots\n    ? {\n        report: {\n          mode: 'candidate-screenshots',\n          note: 'accepted screenshot ledger binding is deferred to reviewed promotion',\n        },\n        errors: [],\n      }\n    : validateScreenshotEvidenceLedger(\n        repoRoot,\n        manifest,\n        Array.isArray(manifest.assets) ? manifest.assets : []\n      );",
    "  const evidenceResult = policyOnly\n    ? {\n        report: {\n          mode: 'policy-only',\n          validated: false,\n          note: 'checked-in bytes and durable evidence are intentionally deferred to the successor evidence boundary',\n        },\n        errors: [],\n      }\n    : options.candidateScreenshots\n      ? {\n          report: {\n            mode: 'candidate-screenshots',\n            note: 'accepted screenshot ledger binding is deferred to reviewed promotion',\n          },\n          errors: [],\n        }\n      : validateScreenshotEvidenceLedger(\n          repoRoot,\n          manifest,\n          Array.isArray(manifest.assets) ? manifest.assets : []\n        );",
    'validator evidence mode',
)
replace_once(
    validator,
    "  const committedMedia = listFiles(path.join(repoRoot, 'docs'), file => MEDIA_EXTENSIONS.has(path.extname(file).toLowerCase()), { ignoreDirectories: new Set() })\n    .map(file => path.relative(repoRoot, file).replace(/\\\\/g, '/'));",
    "  const committedMedia = policyOnly\n    ? []\n    : listFiles(path.join(repoRoot, 'docs'), file => MEDIA_EXTENSIONS.has(path.extname(file).toLowerCase()), { ignoreDirectories: new Set() })\n      .map(file => path.relative(repoRoot, file).replace(/\\\\/g, '/'));",
    'validator committed-media guard',
)
replace_once(
    validator,
    "  return {\n    schemaVersion: 2,\n    valid: errors.length === 0,",
    "  return {\n    schemaVersion: 2,\n    mode: policyOnly ? 'policy-only' : (options.candidateScreenshots ? 'candidate-screenshots' : 'strict'),\n    mediaValidated: !policyOnly,\n    evidenceValidated: !policyOnly && !options.candidateScreenshots,\n    valid: errors.length === 0,",
    'validator report mode',
)
replace_once(
    validator,
    "  process.stdout.write(`[validate-doc-media] ${report.totals.assets} assets, ${report.totals.bytes} bytes\\n`);",
    "  process.stdout.write(`[validate-doc-media] mode=${report.mode || 'strict'}, mediaValidated=${report.mediaValidated !== false}, evidenceValidated=${report.evidenceValidated !== false}, ${report.totals.assets} assets, ${report.totals.bytes} bytes\\n`);",
    'validator mode summary',
)

replace_once(
    'package.json',
    '    "validate:media": "node scripts/validate-doc-media.js",\n    "validate:screenshot-evidence": "node scripts/validate-screenshot-evidence.js",',
    '    "validate:media": "node scripts/validate-doc-media.js",\n    "validate:media:policy": "node scripts/validate-doc-media.js --policy-only",\n    "validate:screenshot-evidence": "node scripts/validate-screenshot-evidence.js",',
    'package policy command',
)

replace_once(
    '.github/workflows/test.yml',
    "      - name: Validate documentation media\n        id: validate_checked_media\n        run: npm run validate:media -- --report out/qa/documentation-media.json",
    "      - name: Validate documentation media policy boundary\n        id: validate_checked_media\n        run: npm run validate:media:policy -- --report out/qa/documentation-media.json",
    'workflow policy boundary step',
)

first_test = """  test('all committed media, Markdown references, dimensions and budgets validate', () => {
    const report = validate({ root: ROOT, manifest: 'docs/media-manifest.json' });
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
    expect(report.totals.assets).toBe(manifest.assets.length);
  });"""
first_replacement = """  test('tooling boundary validates manifest policy without claiming final media evidence', () => {
    const policy = validate({ root: ROOT, manifest: 'docs/media-manifest.json', policyOnly: true });
    expect(policy.errors).toEqual([]);
    expect(policy.valid).toBe(true);
    expect(policy.mode).toBe('policy-only');
    expect(policy.mediaValidated).toBe(false);
    expect(policy.evidenceValidated).toBe(false);
    expect(policy.evidence).toEqual(expect.objectContaining({ mode: 'policy-only', validated: false }));
    expect(policy.totals.assets).toBe(manifest.assets.length);
    expect(policy.assets.every(asset => asset.bytes === null && asset.dimensions === null)).toBe(true);

    const strict = validate({ root: ROOT, manifest: 'docs/media-manifest.json' });
    const evidenceLedger = path.join(ROOT, manifest.evidenceLedger);
    if (fs.existsSync(evidenceLedger)) {
      expect(strict.errors).toEqual([]);
      expect(strict.valid).toBe(true);
      expect(strict.mode).toBe('strict');
      expect(strict.mediaValidated).toBe(true);
      expect(strict.evidenceValidated).toBe(true);
    } else {
      expect(strict.valid).toBe(false);
      expect(strict.errors).toContain(`${manifest.evidenceLedger}: screenshot evidence ledger is missing`);
    }
  });"""
replace_once('tests/unit/docMediaPolicy.test.js', first_test, first_replacement, 'tooling boundary unit test')

animation_test = """  test('the canonical animation stays inside its byte and duration exception', () => {
    const animation = manifest.assets.find(asset => asset.kind === 'animation');
    const inspected = inspectMedia(path.join(ROOT, animation.path));
    expect(inspected.animated).toBe(true);
    expect(inspected.frames).toBeGreaterThan(1);
    expect(inspected.durationMs).toBeLessThanOrEqual(animation.maxDurationMs);
    expect(inspected.visualEvidence).toEqual(expect.objectContaining({
      valid: true,
      paintedCanvasRatio: 1,
      uniqueCompositedFrames: expect.any(Number),
    }));
    expect(inspected.visualEvidence.uniqueCompositedFrames).toBeGreaterThan(1);
    expect(inspected.visualEvidence.maxChangedPixels).toBeGreaterThanOrEqual(
      inspected.visualEvidence.requiredChangedPixels
    );
    expect(fs.statSync(path.join(ROOT, animation.path)).size).toBeLessThanOrEqual(animation.maxBytes);
  });"""
animation_replacement = """  test('the canonical animation policy is explicit and the promoted asset satisfies it', () => {
    const animation = manifest.assets.find(asset => asset.kind === 'animation');
    expect(animation).toEqual(expect.objectContaining({
      maxBytes: expect.any(Number),
      maxDurationMs: expect.any(Number),
      exception: expect.any(String),
    }));
    expect(animation.exception.trim().length).toBeGreaterThan(20);

    if (!fs.existsSync(path.join(ROOT, manifest.evidenceLedger))) {
      const policy = validate({ root: ROOT, manifest: 'docs/media-manifest.json', policyOnly: true });
      expect(policy.valid).toBe(true);
      expect(policy.mediaValidated).toBe(false);
      return;
    }

    const inspected = inspectMedia(path.join(ROOT, animation.path));
    expect(inspected.animated).toBe(true);
    expect(inspected.frames).toBeGreaterThan(1);
    expect(inspected.durationMs).toBeLessThanOrEqual(animation.maxDurationMs);
    expect(inspected.visualEvidence).toEqual(expect.objectContaining({
      valid: true,
      paintedCanvasRatio: 1,
      uniqueCompositedFrames: expect.any(Number),
    }));
    expect(inspected.visualEvidence.uniqueCompositedFrames).toBeGreaterThan(1);
    expect(inspected.visualEvidence.maxChangedPixels).toBeGreaterThanOrEqual(
      inspected.visualEvidence.requiredChangedPixels
    );
    expect(fs.statSync(path.join(ROOT, animation.path)).size).toBeLessThanOrEqual(animation.maxBytes);
  });"""
replace_once('tests/unit/docMediaPolicy.test.js', animation_test, animation_replacement, 'animation promotion unit test')

replace_once(
    'tests/unit/docMediaPolicy.test.js',
    "    const report = validate({ root: fixture.root, manifest: 'docs/media-manifest.json' });\n\n    expect(report.valid).toBe(false);\n    expect(report.errors).toEqual(expect.arrayContaining([\n      'manifest.schemaVersion must equal 1',",
    "    const report = validate({ root: fixture.root, manifest: 'docs/media-manifest.json', policyOnly: true });\n\n    expect(report.valid).toBe(false);\n    expect(report.mode).toBe('policy-only');\n    expect(report.mediaValidated).toBe(false);\n    expect(report.errors).toEqual(expect.arrayContaining([\n      'manifest.schemaVersion must equal 1',",
    'policy-only fail-closed metadata test',
)

legacy_viewport_test = """  test('new full-screen screenshot candidates target 1280x640', () => {
    const panelAssets = new Set([
      'docs/screenshots/02-stadtauswahl.png',
      'docs/screenshots/03-filter.png',
      'docs/screenshots/08-stundenfilter.png',
    ]);
    const documentPreview = 'docs/screenshots/15-export-pdf-rendered.png';
    for (const asset of manifest.assets.filter(entry => entry.kind === 'screenshot')) {
      if (panelAssets.has(asset.path)) expect(asset.target).toEqual({ width: 440, height: 620 });
      else if (asset.path !== documentPreview) expect(asset.target).toEqual({ width: 1280, height: 640 });
    }
    const screenshotSpec = fs.readFileSync(path.join(ROOT, 'tests/e2e/screenshots.spec.js'), 'utf8');
    expect(screenshotSpec).toMatch(/viewport:\\s*\\{\\s*width:\\s*1280,\\s*height:\\s*640\\s*\\}/);
  });"""
full_viewport_test = """  test('new full-screen screenshot candidates target 1280x640', () => {
    const documentPreview = 'docs/screenshots/15-export-pdf-rendered.png';
    for (const asset of manifest.assets.filter(entry => entry.kind === 'screenshot')) {
      if (asset.path !== documentPreview) expect(asset.target).toEqual({ width: 1280, height: 640 });
    }
    const screenshotSpec = fs.readFileSync(path.join(ROOT, 'tests/e2e/screenshots.spec.js'), 'utf8');
    expect(screenshotSpec).toMatch(/viewport:\\s*\\{\\s*width:\\s*1280,\\s*height:\\s*640\\s*\\}/);
  });"""
replace_once(
    'tests/unit/docMediaPolicy.test.js',
    legacy_viewport_test,
    full_viewport_test,
    'full-frame screenshot dimensions test',
)
PY

git diff --check
npm ci
npm run build:site
npm run validate:media:policy -- --report out/qa/documentation-media.json
node - <<'NODE'
const report = require('./out/qa/documentation-media.json');
if (report.valid !== true || report.mode !== 'policy-only' ||
    report.mediaValidated !== false || report.evidenceValidated !== false ||
    !report.evidence || report.evidence.validated !== false) {
  throw new Error(`Invalid policy-boundary report: ${JSON.stringify(report)}`);
}
NODE
npx jest --runInBand \
  tests/unit/docMediaPolicy.test.js \
  tests/unit/screenshotWorkflowSafety.test.js \
  tests/unit/siteBuildContract.test.js

git add \
  scripts/validate-doc-media.js \
  package.json \
  .github/workflows/test.yml \
  tests/unit/docMediaPolicy.test.js
git diff --cached --check
git diff --cached --quiet && { echo "No media-tooling boundary patch to commit" >&2; exit 1; }
git commit -m "qa: make media tooling boundary independently executable"
NEW_HEAD=$(git rev-parse HEAD)

git fetch origin "$TARGET_BRANCH"
[[ "$(git rev-parse "origin/$TARGET_BRANCH")" == "$EXPECTED_TARGET_HEAD" ]] || {
  echo "#441 moved while validation ran; refusing non-fast-forward push" >&2
  exit 1
}
git push origin "$NEW_HEAD:refs/heads/$TARGET_BRANCH"
echo "Updated #441 to $NEW_HEAD"
