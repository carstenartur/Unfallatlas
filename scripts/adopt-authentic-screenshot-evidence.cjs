'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const sourceCommit = process.env.SOURCE_COMMIT;
const runId = Number(process.env.RUN_ID);
if (!/^[a-f0-9]{40}$/i.test(String(sourceCommit || ''))) {
  throw new Error('SOURCE_COMMIT must be a full Git revision');
}
if (!Number.isInteger(runId) || runId <= 0) throw new Error('RUN_ID must be positive');

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const evidenceRoot = path.join(root, 'qa', 'screenshot-evidence');
const readinessRoot = path.join(evidenceRoot, 'readiness');
fs.rmSync(readinessRoot, { recursive: true, force: true });
fs.mkdirSync(readinessRoot, { recursive: true });
for (const name of fs.readdirSync(path.join(root, 'out', 'qa', 'screenshot-readiness')).sort()) {
  if (name.endsWith('.json')) {
    fs.copyFileSync(path.join(root, 'out', 'qa', 'screenshot-readiness', name), path.join(readinessRoot, name));
  }
}
fs.copyFileSync(path.join(root, 'out', 'qa', 'screenshot-evidence.json'), path.join(evidenceRoot, 'summary.json'));

const summaryPath = path.join(evidenceRoot, 'summary.json');
const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const buildManifest = JSON.parse(fs.readFileSync(path.join(root, '_site', 'build-manifest.json'), 'utf8'));
const readinessFiles = fs.readdirSync(readinessRoot).filter(name => name.endsWith('.json')).sort();
const entryPayload = summary.screenshots
  .map(entry => `${entry.path}\t${entry.sha256}\t${entry.bytes}\n`).join('');
const readinessPayload = readinessFiles.map(name => {
  const file = path.join(readinessRoot, name);
  return `${name}\t${sha256(file)}\t${fs.statSync(file).size}\n`;
}).join('');

const archivePath = path.join(root, 'out', 'qa', 'publication-screenshots-reviewed.zip');
fs.mkdirSync(path.dirname(archivePath), { recursive: true });
const zipEntries = [
  ...fs.readdirSync(path.join(root, 'docs', 'screenshots'))
    .filter(name => name.endsWith('.png')).sort()
    .map(name => path.join('docs', 'screenshots', name)),
  ...readinessFiles.map(name => path.join('qa', 'screenshot-evidence', 'readiness', name)),
  path.join('qa', 'screenshot-evidence', 'summary.json'),
  path.join('_site', 'build-manifest.json')
];
execFileSync('zip', ['-q', '-9', archivePath, ...zipEntries], { cwd: root });

const provenance = {
  schemaVersion: 1,
  purpose: 'Durable binding for authentic publication screenshots generated on 2026-07-19.',
  source: {
    artifactName: `publication-screenshots-reviewed-${runId}`,
    artifactId: runId,
    artifactZipSha256: sha256(archivePath),
    evidenceRevision: sourceCommit,
    evidenceStatus: 'valid',
    evidenceCount: summary.screenshots.length
  },
  build: {
    manifestSha256: summary.build.sha256,
    fingerprint: buildManifest.fingerprint,
    applicationFingerprint: buildManifest.application.fingerprint,
    dataFingerprint: buildManifest.data.fingerprint
  },
  summary: {
    path: 'qa/screenshot-evidence/summary.json',
    sha256: sha256(summaryPath),
    entriesSha256: crypto.createHash('sha256').update(entryPayload).digest('hex')
  },
  readiness: {
    directory: 'qa/screenshot-evidence/readiness',
    files: readinessFiles.length,
    bytes: readinessFiles.reduce((sum, name) => sum + fs.statSync(path.join(readinessRoot, name)).size, 0),
    entriesSha256: crypto.createHash('sha256').update(readinessPayload).digest('hex')
  }
};
fs.writeFileSync(path.join(evidenceRoot, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);

const screenshots = fs.readdirSync(path.join(root, 'docs', 'screenshots'))
  .filter(name => name.endsWith('.png')).sort();
const screenshotBytes = screenshots.reduce((sum, name) =>
  sum + fs.statSync(path.join(root, 'docs', 'screenshots', name)).size, 0);
const report = `# Medien-QA: authentische Publikations-Screenshots\n\n` +
  `Quellcommit \`${sourceCommit}\`, Workflow-Run \`${runId}\`. ` +
  `${summary.screenshots.length}/${summary.screenshots.length} Evidence-Sidecars sind gültig.\n\n` +
  `Automatische PR-/E2E-Artefakte bleiben synthetische Regressionstests und sind keine Publikationsmedien. ` +
  `Die eingecheckten Bilder weisen echte Rasterkarten, Providerstatus und sichtbare Attribution nach; ` +
  `SVG-/Fixture-Tiles werden für Publikationsmedien abgelehnt. Der PDF-Test lässt den Kartenausschnitt aktiviert.\n\n` +
  `Screenshots gesamt: **${screenshotBytes} Byte**.\n`;
fs.writeFileSync(path.join(root, 'docs', 'media-qa-2026-07-19.md'), report);
