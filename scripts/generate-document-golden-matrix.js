#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const scenarios = require('./document-golden-scenarios');
const sampleDocx = require('./generate-sample-docx');

const MATRIX_SCHEMA = 'unfallwerkbank.document-golden-matrix/v1';

class DocumentGoldenMatrixError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'DocumentGoldenMatrixError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new DocumentGoldenMatrixError(code, message, details);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function safeRelativePath(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    fail('invalid_path', `${label} must be a non-empty relative path`);
  }
  const normalized = value.trim().replace(/\\/g, '/');
  if (
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(value) ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized.includes('\0')
  ) {
    fail('unsafe_path', `${label} must stay inside the repository`, { value });
  }
  return normalized;
}

function resolveInside(root, relative, label) {
  const normalized = safeRelativePath(relative, label);
  const candidate = path.resolve(root, normalized);
  const rel = path.relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    fail('unsafe_path', `${label} must be a child of the repository root`, { relative });
  }
  return { normalized, candidate };
}

function parseArgs(argv) {
  const options = {
    root: path.resolve(__dirname, '..'),
    outDir: 'out/qa/document-golden-matrix',
    manifest: 'matrix.json',
    scenarioIds: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') options.root = path.resolve(argv[++index] || '');
    else if (argument === '--out-dir') options.outDir = argv[++index];
    else if (argument === '--manifest') options.manifest = argv[++index];
    else if (argument === '--scenario') options.scenarioIds.push(argv[++index]);
    else fail('unknown_argument', `Unknown argument: ${argument}`);
  }
  return options;
}

function selectScenarioIds(requested) {
  if (!requested || requested.length === 0) return scenarios.listScenarioIds();
  const ids = requested.map((id) => scenarios.getScenario(id).id);
  if (new Set(ids).size !== ids.length) {
    fail('duplicate_scenario', 'Each requested scenario may occur only once', { ids });
  }
  return ids.sort();
}

function inspectDocx(file, scenario) {
  const buffer = fs.readFileSync(file);
  if (
    buffer.length < scenario.expectations.minimumDocxBytes ||
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b
  ) {
    fail('invalid_docx', `Scenario ${scenario.id} did not produce a valid DOCX`, {
      file,
      bytes: buffer.length,
      minimumBytes: scenario.expectations.minimumDocxBytes,
    });
  }
  return Object.freeze({ bytes: buffer.length, sha256: sha256(buffer) });
}

function buildScenarioReportData(scenarioValue) {
  const scenario = scenarios.getScenario(scenarioValue && scenarioValue.id
    ? scenarioValue.id
    : scenarioValue);
  const reportData = sampleDocx.createReportData(scenario);
  if (!reportData || !reportData.structured) {
    fail('invalid_report_data', `Scenario ${scenario.id} lacks structured report data`);
  }
  const paragraphs = Array.isArray(scenario.narrativeParagraphs)
    ? scenario.narrativeParagraphs
    : [];
  if (paragraphs.length === 0) return reportData;

  // The DOCX renderer intentionally cuts the unstructured Sachverhalt at the
  // first Methodik heading to avoid raw-text/table duplication. Matrix stress
  // sections must therefore enter through a renderer-owned structured field.
  // `patterns` produces one bold title and one content paragraph per item,
  // creating real pagination/heading boundaries without inventing facts.
  const patterns = paragraphs.map((paragraph, index) => Object.freeze({
    title: `Prüfabschnitt ${index + 1}`,
    content:
      `${String(paragraph).replace(/^Prüfabschnitt\s+\d+\s*:\s*/i, '').trim()} ` +
      'Dieser Abschnitt ist ausschließlich ein deterministischer Layout- und Umbruchfall; ' +
      'er enthält keine zusätzliche fachliche Tatsachenbehauptung.',
  }));
  return {
    ...reportData,
    structured: {
      ...reportData.structured,
      patterns,
    },
  };
}

async function generateScenarioDocx({ scenario, outPath }) {
  return sampleDocx.generateSampleDocx({
    scenario,
    outPath,
    reportData: buildScenarioReportData(scenario),
  });
}

async function generateGoldenMatrix(options = {}) {
  const root = fs.realpathSync(path.resolve(options.root || path.join(__dirname, '..')));
  const out = resolveInside(
    root,
    options.outDir || 'out/qa/document-golden-matrix',
    'matrix output directory',
  );
  const manifestRelative = safeRelativePath(options.manifest || 'matrix.json', 'matrix manifest');
  if (manifestRelative.includes('/')) {
    fail('invalid_manifest_path', 'matrix manifest must be a file directly inside the matrix directory');
  }
  const scenarioIds = selectScenarioIds(options.scenarioIds);
  const generator = options.generator || generateScenarioDocx;
  if (typeof generator !== 'function') fail('invalid_generator', 'DOCX generator must be a function');

  const tempDirectory = `${out.candidate}.tmp-${process.pid}-${Date.now()}`;
  fs.rmSync(tempDirectory, { recursive: true, force: true });
  fs.mkdirSync(tempDirectory, { recursive: true });
  const artifacts = [];
  try {
    for (const id of scenarioIds) {
      const scenario = scenarios.getScenario(id);
      const filename = `${scenario.id}.docx`;
      const outPath = path.join(tempDirectory, filename);
      const generated = await generator({ scenario, outPath });
      if (!generated || path.resolve(generated.outPath || '') !== path.resolve(outPath)) {
        fail('generator_contract', `Generator returned an unexpected path for ${scenario.id}`, {
          expected: outPath,
          actual: generated && generated.outPath,
        });
      }
      const observed = inspectDocx(outPath, scenario);
      artifacts.push(Object.freeze({
        scenarioId: scenario.id,
        description: scenario.description,
        artifact: Object.freeze({
          filename,
          bytes: observed.bytes,
          sha256: observed.sha256,
        }),
        expectations: scenario.expectations,
        automatedEvidence: Object.freeze({
          docxGenerated: true,
          zipSignatureValid: true,
          minimumBytesSatisfied: true,
          renderedPageCount: null,
          renderedMapSemantics: null,
          renderedTableSemantics: null,
        }),
        manualWordEvidence: Object.freeze({
          required: scenario.expectations.manualWordEvidenceRequired,
          status: 'not-performed',
          receipt: null,
        }),
      }));
    }

    const scenarioContract = scenarioIds.map((id) => scenarios.getScenario(id));
    const matrix = {
      schemaVersion: MATRIX_SCHEMA,
      scenarioContractSha256: sha256(Buffer.from(canonicalJson(scenarioContract))),
      artifacts,
    };
    matrix.matrixFingerprint = sha256(Buffer.from(canonicalJson(matrix)));
    fs.writeFileSync(
      path.join(tempDirectory, manifestRelative),
      `${JSON.stringify(matrix, null, 2)}\n`,
    );

    fs.mkdirSync(path.dirname(out.candidate), { recursive: true });
    fs.rmSync(out.candidate, { recursive: true, force: true });
    fs.renameSync(tempDirectory, out.candidate);
    return Object.freeze({
      outDir: out.candidate,
      manifestPath: path.join(out.candidate, manifestRelative),
      matrix: Object.freeze(matrix),
    });
  } catch (error) {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function main(argv) {
  const result = await generateGoldenMatrix(parseArgs(argv));
  process.stdout.write(
    `[document-golden-matrix] generated ${result.matrix.artifacts.length} DOCX scenarios; ` +
      `fingerprint ${result.matrix.matrixFingerprint}; manifest ${result.manifestPath}.\n`,
  );
  return result;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  MATRIX_SCHEMA,
  DocumentGoldenMatrixError,
  sha256,
  canonicalJson,
  safeRelativePath,
  resolveInside,
  parseArgs,
  selectScenarioIds,
  inspectDocx,
  buildScenarioReportData,
  generateScenarioDocx,
  generateGoldenMatrix,
  main,
});
