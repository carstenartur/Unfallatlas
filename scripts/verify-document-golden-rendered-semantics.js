#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const scenarios = require('./document-golden-scenarios');
const generatedMatrix = require('./generate-document-golden-matrix');
const renderedMatrix = require('./render-document-golden-matrix');
const { clusterWordsIntoLines } = require('./rendered-table-hints');

const SEMANTIC_MATRIX_SCHEMA = 'unfallwerkbank.document-golden-semantic-matrix/v1';
const MAP_ROLE_PATTERNS = Object.freeze({
  overview: /\bAbbildung\s+\d+\s*:\s*Übersichtskarte\b/iu,
  selection: /\bAbbildung\s+\d+\s*:\s*Auswahl[- ]?Karte\b/iu,
  detail: /\bAbbildung\s+\d+\s*:\s*Detail(?:karte|ausschnitt)\b/iu,
  cluster: /\bAbbildung\s+\d+\s*:\s*Cluster[- ]?Karte\b/iu,
});
const TABLE_ROLE_PATTERNS = Object.freeze({
  severity: /^\s*Verletzungsschwere\s+im\s+Ausschnitt\s*:?\s*$/iu,
  'year-trend': /^\s*Unfälle\s+pro\s+Jahr\s+im\s+Ausschnitt\s*:?\s*$/iu,
  deviations: /^\s*Top-Abweichungen\s*\(Ausschnitt\s+vs\.\s+Stadt\)\s*:?\s*$/iu,
});

class DocumentGoldenSemanticError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'DocumentGoldenSemanticError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new DocumentGoldenSemanticError(code, message, details);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_object', `${label} must be an object`);
  }
  return value;
}

function requiredHash(value, label) {
  const text = String(value || '');
  if (!/^[a-f0-9]{64}$/.test(text)) fail('invalid_hash', `${label} must be SHA-256`);
  return text;
}

function parseArgs(argv) {
  const options = {
    root: path.resolve(__dirname, '..'),
    matrixDir: 'out/qa/document-golden-matrix',
    renderedDir: 'rendered',
    inputManifest: 'rendered-matrix.json',
    outputManifest: 'semantic-matrix.json',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') options.root = path.resolve(argv[++index] || '');
    else if (argument === '--matrix-dir') options.matrixDir = argv[++index];
    else if (argument === '--rendered-dir') options.renderedDir = argv[++index];
    else if (argument === '--input') options.inputManifest = argv[++index];
    else if (argument === '--output') options.outputManifest = argv[++index];
    else fail('unknown_argument', `Unknown argument: ${argument}`);
  }
  return options;
}

function readJson(file, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail('invalid_json', `Cannot read ${label}`, { file, cause: error.message });
  }
  return plainObject(value, label);
}

function resolveMatrixRoot(options) {
  const root = fs.realpathSync(path.resolve(options.root || path.join(__dirname, '..')));
  const matrix = generatedMatrix.resolveInside(
    root,
    options.matrixDir || 'out/qa/document-golden-matrix',
    'matrix directory',
  );
  const matrixDir = renderedMatrix.resolveMatrixDirectory(root, matrix.candidate);
  const renderedName = generatedMatrix.safeRelativePath(options.renderedDir || 'rendered', 'rendered directory');
  if (renderedName.includes('/')) fail('invalid_path', 'rendered directory must be a direct child');
  const renderedRoot = path.join(matrixDir, renderedName);
  if (!fs.existsSync(renderedRoot) || fs.lstatSync(renderedRoot).isSymbolicLink() ||
      !fs.lstatSync(renderedRoot).isDirectory()) {
    fail('invalid_rendered_root', 'rendered directory must be an existing non-symlink directory', {
      renderedRoot,
    });
  }
  return Object.freeze({ root, matrixDir, renderedRoot: fs.realpathSync(renderedRoot) });
}

function regularChild(root, relative, label) {
  const resolved = renderedMatrix.assertRegularFile(root, relative, label);
  return resolved.file;
}

function normalizeRenderedInput(value) {
  const input = plainObject(value, 'rendered matrix');
  if (input.schemaVersion !== renderedMatrix.RENDERED_MATRIX_SCHEMA) {
    fail('unsupported_schema', `Expected ${renderedMatrix.RENDERED_MATRIX_SCHEMA}`, {
      actual: input.schemaVersion,
    });
  }
  requiredHash(input.matrixFingerprint, 'rendered matrix fingerprint');
  if (!Array.isArray(input.artifacts) || input.artifacts.length === 0) {
    fail('empty_matrix', 'rendered matrix must contain artifacts');
  }
  const seen = new Set();
  const artifacts = input.artifacts.map((artifactValue, index) => {
    const artifact = plainObject(artifactValue, `artifacts[${index}]`);
    const scenario = scenarios.getScenario(artifact.scenarioId);
    if (seen.has(scenario.id)) fail('duplicate_scenario', `Duplicate scenario ${scenario.id}`);
    seen.add(scenario.id);
    const evidence = plainObject(artifact.renderedEvidence, `${scenario.id}.renderedEvidence`);
    const auditModel = plainObject(evidence.auditModel, `${scenario.id}.renderedEvidence.auditModel`);
    requiredHash(auditModel.sha256, `${scenario.id}.auditModel.sha256`);
    return Object.freeze({ artifact, scenario, evidence, auditModel });
  });
  return Object.freeze({ input, artifacts: Object.freeze(artifacts) });
}

function normalizedPageModel(value, scenarioId) {
  const model = plainObject(value, `${scenarioId} Poppler model`);
  if (!Array.isArray(model.pages) || model.pages.length === 0) {
    fail('invalid_model', `${scenarioId} Poppler model has no pages`);
  }
  const pages = model.pages.map((pageValue, index) => {
    const page = plainObject(pageValue, `${scenarioId}.pages[${index}]`);
    if (Number(page.number) !== index + 1) {
      fail('invalid_model', `${scenarioId} page numbering is not contiguous`);
    }
    return Object.freeze({
      number: index + 1,
      width: Number(page.width),
      height: Number(page.height),
      words: Object.freeze(Array.isArray(page.words) ? page.words : []),
      images: Object.freeze(Array.isArray(page.images) ? page.images : []),
      tableRows: Object.freeze(Array.isArray(page.tableRows) ? page.tableRows : []),
    });
  });
  return Object.freeze({ ...model, pages: Object.freeze(pages) });
}

function pageLines(page) {
  return clusterWordsIntoLines(page.words, 3).map((line) => Object.freeze({
    ...line,
    page: page.number,
  }));
}

function allLines(model) {
  return model.pages.flatMap(pageLines);
}

function normalizedText(model) {
  return allLines(model).map(line => line.text).join('\n').replace(/[ \t]+/g, ' ').trim();
}

function findUniqueLine(lines, pattern, label, scenarioId) {
  const matches = lines.filter(line => {
    pattern.lastIndex = 0;
    return pattern.test(line.text);
  });
  if (matches.length !== 1) {
    fail(matches.length ? 'ambiguous_semantic_text' : 'missing_semantic_text',
      `${scenarioId} requires exactly one rendered ${label}`, {
        label,
        matches: matches.map(({ page, text }) => ({ page, text })),
      });
  }
  return matches[0];
}

function contextPattern(scenario) {
  if (scenario.context.status === 'uncertain') return /Kontextstatus\s*:\s*unsicher/iu;
  if (scenario.context.status === 'missing') return /Kontextstatus\s*:\s*nicht verfügbar/iu;
  return /(?:Kontextstatus\s*:\s*verfügbar|Kontextinformationen werden nicht als Kausalnachweis interpretiert)/iu;
}

function verifyScenarioText(model, scenario) {
  const text = normalizedText(model);
  const requirements = [
    ['city', new RegExp(`\\b${escapeRegex(scenario.city)}\\b`, 'iu')],
    ['area', new RegExp(escapeRegex(scenario.areaName), 'iu')],
    ['accidentCount', new RegExp(`\\b${scenario.accidentCount}\\s+Unfälle\\b`, 'iu')],
    ['contextStatus', contextPattern(scenario)],
  ];
  const matched = {};
  for (const [name, pattern] of requirements) {
    pattern.lastIndex = 0;
    if (!pattern.test(text)) {
      fail('missing_scenario_semantics', `${scenario.id} rendered text lacks ${name}`, {
        pattern: pattern.source,
      });
    }
    matched[name] = pattern.source;
  }
  let longReport = null;
  if (scenario.narrativeParagraphs.length > 1) {
    const lines = allLines(model);
    const first = findUniqueLine(lines, /Prüfabschnitt\s+1\b/iu, 'first long-report section', scenario.id);
    const lastPattern = new RegExp(`Prüfabschnitt\\s+${scenario.narrativeParagraphs.length}\\b`, 'iu');
    const last = findUniqueLine(lines, lastPattern, 'last long-report section', scenario.id);
    if (last.page <= first.page) {
      fail('long_report_not_paginated', `${scenario.id} long report does not span multiple final pages`, {
        firstPage: first.page,
        lastPage: last.page,
      });
    }
    longReport = Object.freeze({ firstPage: first.page, lastPage: last.page });
  }
  return Object.freeze({ matched: Object.freeze(matched), longReport });
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function imageIdentity(image, page, index) {
  const id = typeof image.imageId === 'string' && image.imageId.trim()
    ? image.imageId.trim()
    : `page-${page.number}-image-${index}`;
  return Object.freeze({
    id,
    page: page.number,
    xMin: Number(image.xMin),
    yMin: Number(image.yMin),
    xMax: Number(image.xMax),
    yMax: Number(image.yMax),
  });
}

function bindCaptionToImage(model, line, usedImages, scenarioId, role) {
  const page = model.pages[line.page - 1];
  const candidates = page.images.map((image, index) => imageIdentity(image, page, index))
    .filter(image => Number.isFinite(image.yMax) && image.yMax <= line.yMin + 6)
    .map(image => ({ image, gap: line.yMin - image.yMax }))
    .filter(candidate => candidate.gap >= -6 && candidate.gap <= 120)
    .sort((left, right) => left.gap - right.gap || left.image.xMin - right.image.xMin);
  const candidate = candidates.find(entry => !usedImages.has(entry.image.id));
  if (!candidate) {
    fail('map_caption_without_image', `${scenarioId} ${role} caption is not bound to a unique preceding image`, {
      page: line.page,
      caption: line.text,
      candidates,
    });
  }
  usedImages.add(candidate.image.id);
  return Object.freeze({
    role,
    page: line.page,
    caption: line.text,
    imageId: candidate.image.id,
    gap: candidate.gap,
  });
}

function verifyMapSemantics(model, scenario) {
  const lines = allLines(model);
  const usedImages = new Set();
  const bindings = scenario.expectations.requiredMapKinds.map((role) => {
    const pattern = MAP_ROLE_PATTERNS[role];
    if (!pattern) fail('unknown_map_role', `${scenario.id} declares unsupported map role ${role}`);
    const line = findUniqueLine(lines, pattern, `${role} map caption`, scenario.id);
    return bindCaptionToImage(model, line, usedImages, scenario.id, role);
  });
  return Object.freeze({
    verified: true,
    expectedRoles: Object.freeze([...scenario.expectations.requiredMapKinds]),
    bindings: Object.freeze(bindings),
  });
}

function verifyTableSemantics(model, scenario) {
  const lines = allLines(model);
  const bindings = scenario.expectations.requiredTables.map((role) => {
    const pattern = TABLE_ROLE_PATTERNS[role];
    if (!pattern) fail('unknown_table_role', `${scenario.id} declares unsupported table role ${role}`);
    const line = findUniqueLine(lines, pattern, `${role} table heading`, scenario.id);
    return Object.freeze({ role, page: line.page, heading: line.text });
  });
  const tableRows = model.pages.reduce((sum, page) => sum + page.tableRows.length, 0);
  return Object.freeze({
    verified: true,
    expectedRoles: Object.freeze([...scenario.expectations.requiredTables]),
    bindings: Object.freeze(bindings),
    reconstructedRowCount: tableRows,
    evidenceMode: tableRows > 0 ? 'rendered-rows-and-headings' : 'rendered-headings',
  });
}

function verifyArtifact(entry, renderedRoot) {
  const modelFile = regularChild(
    renderedRoot,
    entry.auditModel.path,
    `${entry.scenario.id} Poppler audit model`,
  );
  if (sha256(fs.readFileSync(modelFile)) !== entry.auditModel.sha256) {
    fail('audit_model_drift', `${entry.scenario.id} Poppler model differs from rendered matrix`);
  }
  const model = normalizedPageModel(readJson(modelFile, `${entry.scenario.id} Poppler model`), entry.scenario.id);
  if (model.pages.length < entry.scenario.expectations.minimumRenderedPages) {
    fail('minimum_pages_not_met', `${entry.scenario.id} has too few rendered pages`, {
      expected: entry.scenario.expectations.minimumRenderedPages,
      actual: model.pages.length,
    });
  }
  return Object.freeze({
    scenarioTextSemantics: verifyScenarioText(model, entry.scenario),
    renderedMapSemantics: verifyMapSemantics(model, entry.scenario),
    renderedTableSemantics: verifyTableSemantics(model, entry.scenario),
    model: Object.freeze({
      path: entry.auditModel.path,
      sha256: entry.auditModel.sha256,
      pages: model.pages.length,
    }),
  });
}

function writeAtomic(file, value) {
  const target = path.resolve(file);
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return target;
}

function verifyRenderedSemantics(options = {}) {
  const roots = resolveMatrixRoot(options);
  const inputName = generatedMatrix.safeRelativePath(
    options.inputManifest || 'rendered-matrix.json',
    'rendered semantic input manifest',
  );
  const outputName = generatedMatrix.safeRelativePath(
    options.outputManifest || 'semantic-matrix.json',
    'rendered semantic output manifest',
  );
  if (inputName.includes('/') || outputName.includes('/') || inputName === outputName) {
    fail('invalid_manifest_path', 'semantic input/output manifests must be distinct direct children');
  }
  const inputFile = regularChild(roots.renderedRoot, inputName, 'rendered matrix manifest');
  const normalized = normalizeRenderedInput(readJson(inputFile, 'rendered matrix manifest'));
  const sourceHash = sha256(fs.readFileSync(inputFile));
  const artifacts = normalized.artifacts.map((entry) => {
    const semanticEvidence = verifyArtifact(entry, roots.renderedRoot);
    return Object.freeze({
      ...entry.artifact,
      automatedEvidence: Object.freeze({
        ...entry.artifact.automatedEvidence,
        scenarioTextSemantics: semanticEvidence.scenarioTextSemantics,
        renderedMapSemantics: semanticEvidence.renderedMapSemantics,
        renderedTableSemantics: semanticEvidence.renderedTableSemantics,
      }),
      semanticEvidence,
    });
  });
  const output = {
    schemaVersion: SEMANTIC_MATRIX_SCHEMA,
    sourceRenderedMatrix: Object.freeze({
      filename: inputName,
      sha256: sourceHash,
      matrixFingerprint: normalized.input.matrixFingerprint,
    }),
    artifacts,
    truthBoundary: Object.freeze({
      renderedPageCountsVerified: true,
      genericFinalPageAuditVerified: true,
      scenarioTextSemanticsVerified: true,
      renderedMapSemanticsVerified: true,
      renderedTableSemanticsVerified: true,
      microsoftWordEvidenceVerified: false,
    }),
  };
  output.matrixFingerprint = generatedMatrix.sha256(
    Buffer.from(generatedMatrix.canonicalJson(output)),
  );
  const manifestPath = writeAtomic(path.join(roots.renderedRoot, outputName), output);
  return Object.freeze({
    renderedRoot: roots.renderedRoot,
    manifestPath,
    matrix: Object.freeze(output),
  });
}

function main(argv) {
  const result = verifyRenderedSemantics(parseArgs(argv));
  process.stdout.write(
    `[document-golden-semantics] verified ${result.matrix.artifacts.length} rendered scenarios; ` +
    `fingerprint ${result.matrix.matrixFingerprint}; manifest ${result.manifestPath}.\n`,
  );
  return result;
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    if (error && error.details) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  SEMANTIC_MATRIX_SCHEMA,
  MAP_ROLE_PATTERNS,
  TABLE_ROLE_PATTERNS,
  DocumentGoldenSemanticError,
  sha256,
  plainObject,
  requiredHash,
  parseArgs,
  readJson,
  resolveMatrixRoot,
  regularChild,
  normalizeRenderedInput,
  normalizedPageModel,
  pageLines,
  allLines,
  normalizedText,
  findUniqueLine,
  contextPattern,
  verifyScenarioText,
  escapeRegex,
  imageIdentity,
  bindCaptionToImage,
  verifyMapSemantics,
  verifyTableSemantics,
  verifyArtifact,
  writeAtomic,
  verifyRenderedSemantics,
  main,
});
