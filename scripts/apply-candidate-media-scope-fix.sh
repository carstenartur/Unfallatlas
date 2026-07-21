#!/usr/bin/env bash
set -euo pipefail

TARGET_BRANCH=split/405-6-media-validation
EXPECTED_TARGET_HEAD=e8e10b2e6f402f922f91ecccfd050078eb08cd51
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
    file = Path(path)
    source = file.read_text()
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one insertion point, found {count}')
    file.write_text(source.replace(old, new))

validator = 'scripts/validate-doc-media.js'
replace_once(
    validator,
    "function validate(options = {}) {\n  const policyOnly = options.policyOnly === true;\n  const repoRoot = path.resolve(options.root || ROOT);",
    "function validate(options = {}) {\n  const policyOnly = options.policyOnly === true;\n  const candidateScreenshots = options.candidateScreenshots === true;\n  const repoRoot = path.resolve(options.root || ROOT);",
    'candidate mode state',
)
replace_once(
    validator,
    "    const allowedFormats = ALLOWED_FORMATS[asset.kind];\n    if (!allowedFormats) violations.push(`${asset.path}: unsupported kind ${asset.kind || '(empty)'}`);",
    "    const allowedFormats = ALLOWED_FORMATS[asset.kind];\n    const extension = path.extname(String(asset.path || '')).toLowerCase();\n    const declaredFormat = extension === '.jpg' ? 'jpeg' : extension.slice(1);\n    if (!allowedFormats) violations.push(`${asset.path}: unsupported kind ${asset.kind || '(empty)'}`);\n    else if (!allowedFormats.has(declaredFormat)) violations.push(`${asset.path}: ${declaredFormat || '(no extension)'} is not allowed for kind ${asset.kind}`);",
    'declared format policy',
)
replace_once(
    validator,
    "    let inspected = null;\n    let targetMatch = false;\n    let bytes = null;\n    if (!policyOnly && assetPathSafe && fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {",
    "    const deferredCandidateAsset = candidateScreenshots && !EVIDENCE_KINDS.has(asset.kind);\n    let inspected = null;\n    let targetMatch = false;\n    let bytes = null;\n    if (!policyOnly && !deferredCandidateAsset && assetPathSafe && fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {",
    'candidate asset inspection scope',
)
replace_once(
    validator,
    "        if (allowedFormats && !allowedFormats.has(inspected.format)) {\n          violations.push(`${asset.path}: ${inspected.format} is not allowed for kind ${asset.kind}`);\n        }\n",
    "",
    'deduplicate inspected format policy',
)
replace_once(
    validator,
    "      target: asset.target || null,\n      status: violations.length ? 'error' : (needsException ? 'policy-exception' : 'valid'),",
    "      target: asset.target || null,\n      deferred: deferredCandidateAsset,\n      validationScope: deferredCandidateAsset ? 'strict-checked-in-media' : (policyOnly ? 'manifest-policy' : (candidateScreenshots ? 'generated-candidate' : 'strict-checked-in-media')),\n      status: violations.length ? 'error' : (deferredCandidateAsset ? 'deferred' : (needsException ? 'policy-exception' : 'valid')),
",
    'candidate row metadata',
)
replace_once(
    validator,
    "    : options.candidateScreenshots\n      ? {\n          report: {\n            mode: 'candidate-screenshots',\n            note: 'accepted screenshot ledger binding is deferred to reviewed promotion',",
    "    : candidateScreenshots\n      ? {\n          report: {\n            mode: 'candidate-screenshots',\n            note: 'accepted screenshot ledger and non-generated media are deferred to the strict checked-in-media gate',",
    'candidate evidence note',
)
replace_once(
    validator,
    "    mode: policyOnly ? 'policy-only' : (options.candidateScreenshots ? 'candidate-screenshots' : 'strict'),\n    mediaValidated: !policyOnly,\n    evidenceValidated: !policyOnly && !options.candidateScreenshots,",
    "    mode: policyOnly ? 'policy-only' : (candidateScreenshots ? 'candidate-screenshots' : 'strict'),\n    mediaValidated: !policyOnly && !candidateScreenshots,\n    candidateMediaValidated: candidateScreenshots,\n    evidenceValidated: !policyOnly && !candidateScreenshots,\n    deferredAssets: rows.filter(row => row.deferred).map(row => row.path),",
    'candidate report metadata',
)
replace_once(
    validator,
    "    const prefix = row.status === 'valid' ? 'OK' : (row.status === 'policy-exception' ? 'EXCEPTION' : 'ERROR');",
    "    const prefix = row.status === 'valid' ? 'OK' : (row.status === 'policy-exception' ? 'EXCEPTION' : (row.status === 'deferred' ? 'DEFERRED' : 'ERROR'));",
    'candidate output prefix',
)
replace_once(
    validator,
    "  process.stdout.write(`[validate-doc-media] mode=${report.mode || 'strict'}, mediaValidated=${report.mediaValidated !== false}, evidenceValidated=${report.evidenceValidated !== false}, ${report.totals.assets} assets, ${report.totals.bytes} bytes\\n`);",
    "  process.stdout.write(`[validate-doc-media] mode=${report.mode || 'strict'}, mediaValidated=${report.mediaValidated === true}, candidateMediaValidated=${report.candidateMediaValidated === true}, evidenceValidated=${report.evidenceValidated === true}, deferred=${(report.deferredAssets || []).length}, ${report.totals.assets} assets, ${report.totals.bytes} bytes\\n`);",
    'candidate output summary',
)

test_file = 'tests/unit/docMediaPolicy.test.js'
replace_once(
    test_file,
    """  test('candidate mode skips only the accepted-ledger binding', () => {
    const fixture = createIsolatedRepository();
    fs.writeFileSync(path.join(fixture.root, fixture.manifest.evidenceLedger), '{ broken ledger');
    expect(validate({ root: fixture.root, manifest: 'docs/media-manifest.json' }).valid).toBe(false);
    const candidate = validate({
      root: fixture.root,
      manifest: 'docs/media-manifest.json',
      candidateScreenshots: true,
    });
    expect(candidate.valid).toBe(true);
    expect(candidate.evidence.mode).toBe('candidate-screenshots');
  });""",
    """  test('candidate mode validates generated screenshots but defers the accepted ledger', () => {
    const fixture = createIsolatedRepository();
    fs.writeFileSync(path.join(fixture.root, fixture.manifest.evidenceLedger), '{ broken ledger');
    expect(validate({ root: fixture.root, manifest: 'docs/media-manifest.json' }).valid).toBe(false);
    const candidate = validate({
      root: fixture.root,
      manifest: 'docs/media-manifest.json',
      candidateScreenshots: true,
    });
    expect(candidate.valid).toBe(true);
    expect(candidate.mode).toBe('candidate-screenshots');
    expect(candidate.mediaValidated).toBe(false);
    expect(candidate.candidateMediaValidated).toBe(true);
    expect(candidate.evidenceValidated).toBe(false);
    expect(candidate.deferredAssets).toEqual([]);
    expect(candidate.evidence.mode).toBe('candidate-screenshots');
    expect(candidate.assets[0]).toEqual(expect.objectContaining({
      status: 'valid', deferred: false, validationScope: 'generated-candidate',
    }));
  });

  test('candidate mode explicitly defers non-generated animation bytes while strict mode rejects them', () => {
    const fixture = createIsolatedRepository();
    const animationPath = path.join(fixture.root, 'docs', 'deferred.gif');
    fs.writeFileSync(animationPath, tinyFalseGreenGif());
    fs.writeFileSync(
      path.join(fixture.root, 'README.md'),
      '![Kandidat](docs/candidate.png)\\n![Animation](docs/deferred.gif)\\n'
    );
    fixture.manifest.assets.push({
      path: 'docs/deferred.gif',
      kind: 'animation',
      purpose: 'Nicht in diesem Screenshot-Lauf erzeugtes, absichtlich ungültiges Altmedium.',
      target: { width: 720, height: 405 },
      maxBytes: 4096,
      maxDurationMs: 1000,
      exception: 'The animation is deliberately invalid so strict validation must still reject it.',
      references: ['README.md'],
    });
    writeJson(fixture.manifestPath, fixture.manifest);

    const strict = validate({ root: fixture.root, manifest: 'docs/media-manifest.json' });
    expect(strict.valid).toBe(false);
    expect(strict.errors.join('\\n')).toMatch(/visual evidence/i);

    const candidate = validate({
      root: fixture.root,
      manifest: 'docs/media-manifest.json',
      candidateScreenshots: true,
    });
    expect(candidate.valid).toBe(true);
    expect(candidate.deferredAssets).toEqual(['docs/deferred.gif']);
    expect(candidate.assets.find(asset => asset.path === 'docs/deferred.gif')).toEqual(expect.objectContaining({
      status: 'deferred',
      deferred: true,
      validationScope: 'strict-checked-in-media',
      bytes: null,
      dimensions: null,
    }));
    expect(candidate.assets.find(asset => asset.path === 'docs/candidate.png')).toEqual(expect.objectContaining({
      status: 'valid',
      deferred: false,
      validationScope: 'generated-candidate',
    }));
  });""",
    'candidate scope tests',
)

readme = 'docs/screenshots/README.md'
replace_once(
    readme,
    """`validate:screenshot-evidence` und danach `validate:media
-- --candidate-screenshots` auf. Dieser explizite Kandidatenmodus überspringt
nur die Bindung an die bereits akzeptierte Evidence; Maße, Formate, Budgets,
Referenzen und die vorgelagerte aktuelle Lifecycle-Evidence bleiben zwingend.
Der normale `validate:media`-Lauf bindet dagegen stets die eingecheckten Bilder
an die dauerhaft archivierte Evidence.""",
    """`validate:screenshot-evidence` und danach `validate:media
-- --candidate-screenshots` auf. Dieser explizite Kandidatenmodus prüft die in
diesem Lauf erzeugten Screenshot- und Dokumentvorschau-Dateien vollständig
auf Maße, Format, Budget, Referenzen und aktuelle Lifecycle-Evidence. Nicht
neu erzeugte Medien – insbesondere die separat regenerierte Demo-Animation –
werden im Report ausdrücklich als `deferred` ausgewiesen und erst im normalen
`validate:media`-Lauf zusammen mit der dauerhaft archivierten Evidence streng
gebunden. Format-, Pfad-, Referenz- und Budgetregeln des Manifests gelten auch
für zurückgestellte Einträge unverändert.""",
    'candidate mode documentation',
)
PY

git diff --check
npm ci
npx jest --runInBand \
  tests/unit/docMediaPolicy.test.js \
  tests/unit/screenshotWorkflowSafety.test.js

node - <<'NODE'
const { validate } = require('./scripts/validate-doc-media');
const report = validate({ root: process.cwd(), manifest: 'docs/media-manifest.json', candidateScreenshots: true });
if (!report.valid || report.mode !== 'candidate-screenshots' || report.mediaValidated !== false ||
    report.candidateMediaValidated !== true || report.evidenceValidated !== false ||
    !Array.isArray(report.deferredAssets) || !report.deferredAssets.includes('docs/demo.gif')) {
  throw new Error(`Invalid candidate media scope: ${JSON.stringify(report)}`);
}
NODE

git add scripts/validate-doc-media.js tests/unit/docMediaPolicy.test.js docs/screenshots/README.md
git diff --cached --check
git diff --cached --quiet && { echo "No candidate-media scope patch to commit" >&2; exit 1; }
git commit -m "qa: scope candidate media validation to generated assets"
NEW_HEAD=$(git rev-parse HEAD)

git fetch origin "$TARGET_BRANCH"
[[ "$(git rev-parse "origin/$TARGET_BRANCH")" == "$EXPECTED_TARGET_HEAD" ]] || {
  echo "#441 moved while validation ran; refusing non-fast-forward push" >&2
  exit 1
}
git push origin "$NEW_HEAD:refs/heads/$TARGET_BRANCH"
echo "VALIDATED_HEAD=$NEW_HEAD"
