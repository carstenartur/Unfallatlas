#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const scenarios = require('./document-golden-scenarios');
const generatedMatrix = require('./generate-document-golden-matrix');
const libreOffice = require('./libreoffice-rendered-document');

const RENDERED_MATRIX_SCHEMA = 'unfallwerkbank.document-golden-rendered-matrix/v1';

class RenderDocumentGoldenMatrixError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'RenderDocumentGoldenMatrixError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new RenderDocumentGoldenMatrixError(code, message, details);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail('invalid_json', `Cannot read ${label}`, { file, cause: error.message });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_object', `${label} must be an object`, { file });
  }
  return value;
}

function safeChild(root, relative, label) {
  const normalized = generatedMatrix.safeRelativePath(relative, label);
  const candidate = path.resolve(root, normalized);
  const rel = path.relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    fail('unsafe_path', `${label} escapes the matrix directory`, { relative });
  }
  return Object.freeze({ normalized, candidate });
}

function assertRegularFile(root, relative, label) {
  const resolved = safeChild(root, relative, label);
  if (!fs.existsSync(resolved.candidate) || !fs.statSync(resolved.candidate).isFile()) {
    fail('missing_file', `${label} is missing or not a regular file`, {
      file: resolved.candidate,
    });
  }
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(resolved.candidate);
  const rel = path.relative(realRoot, realFile);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    fail('unsafe_path', `${label} resolves outside the matrix directory`, {
      file: resolved.candidate,
    });
  }
  return Object.freeze({ ...resolved, file: realFile });
}

function parseArgs(argv) {
  const options = {
    root: path.resolve(__dirname, '..'),
    matrixDir: 'out/qa/document-golden-matrix',
    inputManifest: 'matrix.json',
    outputManifest: 'rendered-matrix.json',
    renderedDir: 'rendered',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') options.root = path.resolve(argv[++index] || '');
    else if (argument === '--matrix-dir') options.matrixDir = argv[++index];
    else if (argument === '--input') options.inputManifest = argv[++index];
    else if (argument === '--output') options.outputManifest = argv[++index];
    else if (argument === '--rendered-dir') options.renderedDir = argv[++index];
    else fail('unknown_argument', `Unknown argument: ${argument}`);
  }
  return options;
}

function normalizeInputMatrix(value) {
  if (value.schemaVersion !== generatedMatrix.MATRIX_SCHEMA) {
    fail('unsupported_matrix_schema', `Expected ${generatedMatrix.MATRIX_SCHEMA}`, {
      actual: value.schemaVersion,
    });
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) {
    fail('empty_matrix', 'Input matrix must contain artifacts');
  }
  if (typeof value.scenarioContractSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.scenarioContractSha256)) {
    fail('invalid_matrix', 'scenarioContractSha256 must be SHA-256');
  }
  if (typeof value.matrixFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.matrixFingerprint)) {
    fail('invalid_matrix', 'matrixFingerprint must be SHA-256');
  }
  const ids = new Set();
  const artifacts = value.artifacts.map((artifact, index) => {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      fail('invalid_matrix', `artifact ${index} must be an object`);
    }
    const scenario = scenarios.getScenario(artifact.scenarioId);
    if (ids.has(scenario.id)) fail('duplicate_scenario', `Duplicate ${scenario.id}`);
    ids.add(scenario.id);
    const filename = generatedMatrix.safeRelativePath(
      artifact.artifact && artifact.artifact.filename,
      `artifact ${scenario.id} filename`,
    );
    if (filename.includes('/')) {
      fail('invalid_artifact_path', 'DOCX artifacts must be directly inside the matrix directory', {
        scenarioId: scenario.id,
        filename,
      });
    }
    const expectedBytes = Number(artifact.artifact.bytes);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
      fail('invalid_matrix', `${scenario.id} artifact bytes are invalid`);
    }
    const expectedHash = String(artifact.artifact.sha256 || '');
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
      fail('invalid_matrix', `${scenario.id} artifact sha256 is invalid`);
    }
    return Object.freeze({ artifact, scenario, filename, expectedBytes, expectedHash });
  });
  return Object.freeze({ value, artifacts: Object.freeze(artifacts) });
}

function verifyDocx(matrixDir, entry) {
  const resolved = assertRegularFile(matrixDir, entry.filename, `${entry.scenario.id} DOCX`);
  const bytes = fs.statSync(resolved.file).size;
  const hash = sha256File(resolved.file);
  if (bytes !== entry.expectedBytes || hash !== entry.expectedHash) {
    fail('docx_drift', `${entry.scenario.id} DOCX differs from matrix manifest`, {
      expectedBytes: entry.expectedBytes,
      actualBytes: bytes,
      expectedSha256: entry.expectedHash,
      actualSha256: hash,
    });
  }
  return Object.freeze({ file: resolved.file, bytes, sha256: hash });
}

function evidenceFile(renderRoot, scenarioRoot, relative, label) {
  const normalized = generatedMatrix.safeRelativePath(relative, label);
  const file = path.resolve(scenarioRoot, normalized);
  const rel = path.relative(scenarioRoot, file);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    fail('unsafe_renderer_output', `${label} escapes its scenario directory`, { relative });
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    fail('missing_renderer_output', `${label} is missing`, { file });
  }
  return Object.freeze({
    path: path.relative(renderRoot, file).replace(/\\/g, '/'),
    bytes: fs.statSync(file).size,
    sha256: sha256File(file),
  });
}

function normalizeRenderResult(result, scenario, renderRoot, scenarioRoot) {
  const pages = Number(result && result.metadata && result.metadata.convertedPdf &&
    result.metadata.convertedPdf.pages);
  if (!Number.isInteger(pages) || pages <= 0) {
    fail('invalid_renderer_result', `${scenario.id} renderer did not report a page count`);
  }
  if (pages < scenario.expectations.minimumRenderedPages) {
    fail('minimum_page_count_not_met', `${scenario.id} rendered only ${pages} pages`, {
      expectedMinimum: scenario.expectations.minimumRenderedPages,
      actual: pages,
    });
  }
  const auditPassed = result?.metadata?.audit?.passed === true;
  const auditIssues = Number(result?.metadata?.audit?.issues);
  if (!auditPassed || auditIssues !== 0) {
    fail('rendered_audit_failed', `${scenario.id} did not pass the final-page audit`, {
      passed: auditPassed,
      issues: auditIssues,
    });
  }
  if (!Array.isArray(result.pages) || result.pages.length !== pages) {
    fail('invalid_renderer_result', `${scenario.id} page evidence is inconsistent`, {
      expected: pages,
      actual: Array.isArray(result.pages) ? result.pages.length : null,
    });
  }
  const pdf = evidenceFile(renderRoot, scenarioRoot, 'converted.pdf', `${scenario.id} PDF`);
  const metadata = evidenceFile(
    renderRoot,
    scenarioRoot,
    'conversion-metadata.json',
    `${scenario.id} conversion metadata`,
  );
  const auditModel = evidenceFile(
    renderRoot,
    scenarioRoot,
    result.metadata.audit.model,
    `${scenario.id} Poppler model`,
  );
  const auditReport = evidenceFile(
    renderRoot,
    scenarioRoot,
    result.metadata.audit.report,
    `${scenario.id} audit report`,
  );
  const pageImages = result.pages.map((page, index) => {
    if (Number(page.page) !== index + 1) {
      fail('invalid_renderer_result', `${scenario.id} page ordering is not contiguous`);
    }
    return Object.freeze({
      page: index + 1,
      ...evidenceFile(renderRoot, scenarioRoot, page.file, `${scenario.id} page ${index + 1}`),
      width: Number(page.width),
      height: Number(page.height),
    });
  });
  return Object.freeze({
    renderedPageCount: pages,
    minimumRenderedPages: scenario.expectations.minimumRenderedPages,
    libreOfficeVersion: String(result.metadata.libreOffice?.version || 'unknown'),
    pdf,
    metadata,
    auditModel,
    auditReport,
    pageImages: Object.freeze(pageImages),
  });
}

async function renderGoldenMatrix(options = {}) {
  const root = fs.realpathSync(path.resolve(options.root || path.join(__dirname, '..')));
  const matrixDirResolved = generatedMatrix.resolveInside(
    root,
    options.matrixDir || 'out/qa/document-golden-matrix',
    'matrix directory',
  );
  const matrixDir = matrixDirResolved.candidate;
  if (!fs.existsSync(matrixDir) || !fs.statSync(matrixDir).isDirectory()) {
    fail('missing_matrix_directory', 'Matrix directory does not exist', { matrixDir });
  }
  const inputName = generatedMatrix.safeRelativePath(options.inputManifest || 'matrix.json', 'input manifest');
  const outputName = generatedMatrix.safeRelativePath(
    options.outputManifest || 'rendered-matrix.json',
    'output manifest',
  );
  const renderedName = generatedMatrix.safeRelativePath(options.renderedDir || 'rendered', 'rendered directory');
  if (inputName.includes('/') || outputName.includes('/') || renderedName.includes('/')) {
    fail('invalid_path', 'Matrix manifests and rendered directory must be direct children');
  }
  if (inputName === outputName) fail('invalid_path', 'Input and output manifests must differ');
  const inputFile = assertRegularFile(matrixDir, inputName, 'input matrix manifest').file;
  const input = normalizeInputMatrix(readJson(inputFile, 'input matrix'));
  const renderer = options.renderer || libreOffice.main;
  if (typeof renderer !== 'function') fail('invalid_renderer', 'renderer must be a function');

  const finalRenderRoot = path.join(matrixDir, renderedName);
  const stageRoot = `${finalRenderRoot}.tmp-${process.pid}-${Date.now()}`;
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.mkdirSync(stageRoot, { recursive: true });
  const renderedArtifacts = [];
  try {
    for (const entry of input.artifacts) {
      const docx = verifyDocx(matrixDir, entry);
      const scenarioRoot = path.join(stageRoot, entry.scenario.id);
      fs.mkdirSync(scenarioRoot, { recursive: true });
      const result = await renderer([
        '--docx', docx.file,
        '--out-dir', scenarioRoot,
        '--document-id', `golden-${entry.scenario.id}`,
      ]);
      const evidence = normalizeRenderResult(result, entry.scenario, stageRoot, scenarioRoot);
      renderedArtifacts.push(Object.freeze({
        ...entry.artifact,
        automatedEvidence: Object.freeze({
          ...entry.artifact.automatedEvidence,
          renderedPageCount: evidence.renderedPageCount,
          renderedMapSemantics: null,
          renderedTableSemantics: null,
        }),
        renderedEvidence: evidence,
      }));
    }

    fs.rmSync(finalRenderRoot, { recursive: true, force: true });
    fs.renameSync(stageRoot, finalRenderRoot);
    const output = {
      schemaVersion: RENDERED_MATRIX_SCHEMA,
      sourceMatrix: Object.freeze({
        filename: inputName,
        sha256: sha256File(inputFile),
        matrixFingerprint: input.value.matrixFingerprint,
        scenarioContractSha256: input.value.scenarioContractSha256,
      }),
      artifacts: renderedArtifacts,
      truthBoundary: Object.freeze({
        renderedPageCountsVerified: true,
        genericFinalPageAuditVerified: true,
        renderedMapSemanticsVerified: false,
        renderedTableSemanticsVerified: false,
        microsoftWordEvidenceVerified: false,
      }),
    };
    output.matrixFingerprint = generatedMatrix.sha256(
      Buffer.from(generatedMatrix.canonicalJson(output)),
    );
    const outputFile = path.join(matrixDir, outputName);
    fs.writeFileSync(outputFile, `${JSON.stringify(output, null, 2)}\n`);
    return Object.freeze({
      matrixDir,
      renderedDir: finalRenderRoot,
      manifestPath: outputFile,
      matrix: Object.freeze(output),
    });
  } catch (error) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

async function main(argv) {
  const result = await renderGoldenMatrix(parseArgs(argv));
  process.stdout.write(
    `[render-document-golden-matrix] rendered ${result.matrix.artifacts.length} scenarios; ` +
      `fingerprint ${result.matrix.matrixFingerprint}; manifest ${result.manifestPath}.\n`,
  );
  return result;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    if (error && error.details) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  RENDERED_MATRIX_SCHEMA,
  RenderDocumentGoldenMatrixError,
  sha256File,
  readJson,
  safeChild,
  assertRegularFile,
  parseArgs,
  normalizeInputMatrix,
  verifyDocx,
  evidenceFile,
  normalizeRenderResult,
  renderGoldenMatrix,
  main,
});
