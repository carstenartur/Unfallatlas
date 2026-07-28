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

function isStrictChild(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeChild(root, relative, label) {
  const normalized = generatedMatrix.safeRelativePath(relative, label);
  const candidate = path.resolve(root, normalized);
  if (!isStrictChild(root, candidate)) {
    fail('unsafe_path', `${label} escapes the matrix directory`, { relative });
  }
  return Object.freeze({ normalized, candidate });
}

function assertRegularFile(root, relative, label) {
  const resolved = safeChild(root, relative, label);
  if (!fs.existsSync(resolved.candidate)) {
    fail('missing_file', `${label} is missing`, { file: resolved.candidate });
  }
  const lstat = fs.lstatSync(resolved.candidate);
  if (lstat.isSymbolicLink() || !lstat.isFile()) {
    fail('unsafe_file', `${label} must be a non-symlink regular file`, {
      file: resolved.candidate,
    });
  }
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(resolved.candidate);
  if (!isStrictChild(realRoot, realFile)) {
    fail('unsafe_path', `${label} resolves outside the matrix directory`, {
      file: resolved.candidate,
      resolved: realFile,
    });
  }
  return Object.freeze({ ...resolved, file: realFile });
}

function resolveMatrixDirectory(root, candidate) {
  if (!fs.existsSync(candidate)) {
    fail('missing_matrix_directory', 'Matrix directory does not exist', { matrixDir: candidate });
  }
  const realRoot = fs.realpathSync(root);
  let realMatrixDir;
  try {
    realMatrixDir = fs.realpathSync(candidate);
  } catch (error) {
    fail('invalid_matrix_directory', 'Matrix directory cannot be resolved', {
      matrixDir: candidate,
      cause: error.message,
    });
  }
  if (!fs.statSync(realMatrixDir).isDirectory()) {
    fail('invalid_matrix_directory', 'Matrix directory is not a directory', {
      matrixDir: candidate,
    });
  }
  if (!isStrictChild(realRoot, realMatrixDir)) {
    fail('unsafe_matrix_directory', 'Matrix directory resolves outside repository root', {
      repositoryRoot: realRoot,
      requested: candidate,
      resolved: realMatrixDir,
    });
  }
  return realMatrixDir;
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
    const artifactRecord = artifact.artifact;
    if (!artifactRecord || typeof artifactRecord !== 'object' || Array.isArray(artifactRecord)) {
      fail('invalid_matrix', `${scenario.id} artifact record must be an object`);
    }
    const filename = generatedMatrix.safeRelativePath(
      artifactRecord.filename,
      `artifact ${scenario.id} filename`,
    );
    if (filename.includes('/')) {
      fail('invalid_artifact_path', 'DOCX artifacts must be directly inside the matrix directory', {
        scenarioId: scenario.id,
        filename,
      });
    }
    const expectedBytes = Number(artifactRecord.bytes);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
      fail('invalid_matrix', `${scenario.id} artifact bytes are invalid`);
    }
    const expectedHash = String(artifactRecord.sha256 || '');
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
  if (!isStrictChild(scenarioRoot, file)) {
    fail('unsafe_renderer_output', `${label} escapes its scenario directory`, { relative });
  }
  if (!fs.existsSync(file)) {
    fail('missing_renderer_output', `${label} is missing`, { file });
  }
  const lstat = fs.lstatSync(file);
  if (lstat.isSymbolicLink() || !lstat.isFile()) {
    fail('unsafe_renderer_output', `${label} must be a non-symlink regular file`, { file });
  }
  const realRenderRoot = fs.realpathSync(renderRoot);
  const realScenarioRoot = fs.realpathSync(scenarioRoot);
  const realFile = fs.realpathSync(file);
  if (!isStrictChild(realScenarioRoot, realFile) || !isStrictChild(realRenderRoot, realFile)) {
    fail('unsafe_renderer_output', `${label} resolves outside the staged render tree`, {
      file,
      resolved: realFile,
    });
  }
  return Object.freeze({
    path: path.relative(realRenderRoot, realFile).replace(/\\/g, '/'),
    bytes: fs.statSync(realFile).size,
    sha256: sha256File(realFile),
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

function publishRenderedDirectory(stageRoot, finalRenderRoot, outputName, output, options = {}) {
  const writeFileSync = options.writeFileSync || fs.writeFileSync;
  const renameSync = options.renameSync || fs.renameSync;
  const manifestStage = path.join(stageRoot, outputName);
  try {
    writeFileSync(manifestStage, `${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    fail('manifest_write_failed', 'Cannot write staged rendered matrix manifest', {
      file: manifestStage,
      cause: error.message,
    });
  }
  if (!fs.existsSync(manifestStage) || fs.lstatSync(manifestStage).isSymbolicLink() ||
      !fs.lstatSync(manifestStage).isFile()) {
    fail('manifest_write_failed', 'Staged rendered matrix manifest is not a regular file', {
      file: manifestStage,
    });
  }

  const backup = `${finalRenderRoot}.backup-${process.pid}-${Date.now()}`;
  let hadPrevious = false;
  if (fs.existsSync(finalRenderRoot)) {
    if (fs.lstatSync(finalRenderRoot).isSymbolicLink() || !fs.lstatSync(finalRenderRoot).isDirectory()) {
      fail('unsafe_publish_target', 'Existing rendered output must be a non-symlink directory', {
        path: finalRenderRoot,
      });
    }
    renameSync(finalRenderRoot, backup);
    hadPrevious = true;
  }
  try {
    renameSync(stageRoot, finalRenderRoot);
  } catch (error) {
    if (hadPrevious && fs.existsSync(backup) && !fs.existsSync(finalRenderRoot)) {
      renameSync(backup, finalRenderRoot);
    }
    fail('publish_failed', 'Cannot atomically install rendered matrix evidence', {
      stageRoot,
      finalRenderRoot,
      cause: error.message,
    });
  }
  if (hadPrevious) fs.rmSync(backup, { recursive: true, force: true });
  return path.join(finalRenderRoot, outputName);
}

async function renderGoldenMatrix(options = {}) {
  const root = fs.realpathSync(path.resolve(options.root || path.join(__dirname, '..')));
  const matrixDirResolved = generatedMatrix.resolveInside(
    root,
    options.matrixDir || 'out/qa/document-golden-matrix',
    'matrix directory',
  );
  const matrixDir = resolveMatrixDirectory(root, matrixDirResolved.candidate);
  const inputName = generatedMatrix.safeRelativePath(options.inputManifest || 'matrix.json', 'input manifest');
  const outputName = generatedMatrix.safeRelativePath(
    options.outputManifest || 'rendered-matrix.json',
    'output manifest',
  );
  const renderedName = generatedMatrix.safeRelativePath(options.renderedDir || 'rendered', 'rendered directory');
  if (inputName.includes('/') || outputName.includes('/') || renderedName.includes('/')) {
    fail('invalid_path', 'Matrix manifests and rendered directory must be direct children');
  }
  const inputFile = assertRegularFile(matrixDir, inputName, 'input matrix manifest').file;
  const input = normalizeInputMatrix(readJson(inputFile, 'input matrix'));
  const renderer = options.renderer || libreOffice.main;
  if (typeof renderer !== 'function') fail('invalid_renderer', 'renderer must be a function');

  const verifiedArtifacts = input.artifacts.map((entry) => Object.freeze({
    entry,
    docx: verifyDocx(matrixDir, entry),
  }));

  const finalRenderRoot = path.join(matrixDir, renderedName);
  const stageRoot = `${finalRenderRoot}.tmp-${process.pid}-${Date.now()}`;
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.mkdirSync(stageRoot, { recursive: true });
  const renderedArtifacts = [];
  try {
    for (const verified of verifiedArtifacts) {
      const { entry, docx } = verified;
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
    const manifestPath = publishRenderedDirectory(
      stageRoot,
      finalRenderRoot,
      outputName,
      output,
      options.publishOptions,
    );
    return Object.freeze({
      matrixDir,
      renderedDir: finalRenderRoot,
      manifestPath,
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
  isStrictChild,
  safeChild,
  assertRegularFile,
  resolveMatrixDirectory,
  parseArgs,
  normalizeInputMatrix,
  verifyDocx,
  evidenceFile,
  normalizeRenderResult,
  publishRenderedDirectory,
  renderGoldenMatrix,
  main,
});
