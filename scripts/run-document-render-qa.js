'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MODE = String(process.env.DOCUMENT_RENDER_MODE || 'all').trim().toLowerCase();
const ALLOWED = new Set(['all', 'native-pdf', 'docx']);
if (!ALLOWED.has(MODE)) {
  throw new Error(`Unsupported DOCUMENT_RENDER_MODE ${JSON.stringify(MODE)}; expected all, native-pdf or docx`);
}

function runNode(relativeScript, args = [], options = {}) {
  const result = spawnSync(process.execPath, [path.join(ROOT, relativeScript), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...(options.env || {}) },
    stdio: options.stdio || 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${relativeScript} exited with status ${result.status}`);
  }
}

function runNativePdf() {
  runNode('scripts/generate-sample-pdf.js', ['--out', 'out/ci-render-gate.pdf']);
  runNode('scripts/poppler-rendered-document.js', [
    '--pdf', 'out/ci-render-gate.pdf',
    '--out-dir', 'out/qa/rendered-document/poppler',
    '--document-id', 'ci-native-sample-pdf',
    '--renderer', 'native-pdf-poppler',
  ]);
}

function runFocusedDocxTests() {
  const jest = path.join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js');
  if (!fs.existsSync(jest)) throw new Error(`Locked Jest CLI is missing: ${jest}`);
  const tests = [
    'tests/unit/deterministicMapFixture.test.js',
    'tests/unit/docxPagination.test.js',
    'tests/unit/docxSourceLinks.test.js',
    'tests/unit/enrichRenderedDocumentTables.test.js',
    'tests/unit/generateSampleDocx.test.js',
    'tests/unit/libreOfficeRenderedDocument.test.js',
    'tests/unit/libreOfficeRenderedMapSemantics.test.js',
    'tests/unit/qaSampleDocxRendered.test.js',
    'tests/unit/renderedTableHints.test.js',
    'tests/unit/runtimeExportProvenanceLoader.test.js',
  ];
  const result = spawnSync(process.execPath, [jest, '--runInBand', ...tests], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Focused DOCX Jest suite exited with status ${result.status}`);
}

function runDocx() {
  runFocusedDocxTests();
  runNode('scripts/generate-sample-docx.js', ['--out', 'out/ci-render-gate.docx']);

  const evidenceRoot = path.join(ROOT, 'out', 'qa', 'rendered-document', 'docx');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const auditLog = path.join(evidenceRoot, 'audit-command.log');
  const audit = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'qa-sample-docx-rendered.js')], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
  });
  const combined = `${audit.stdout || ''}${audit.stderr || ''}`;
  fs.writeFileSync(auditLog, combined);
  process.stdout.write(combined);
  if (audit.error) throw audit.error;
  if (audit.status !== 0) throw new Error(`Rendered DOCX audit exited with status ${audit.status}`);

  runNode('scripts/verify-rendered-document-evidence.js');
}

if (MODE === 'all' || MODE === 'native-pdf') runNativePdf();
if (MODE === 'all' || MODE === 'docx') runDocx();

console.log(`[document-render] PASS (${MODE})`);
