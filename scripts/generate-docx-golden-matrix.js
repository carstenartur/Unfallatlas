#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  GOLDEN_SCENARIOS,
  generateSampleDocx,
} = require('./generate-sample-docx');

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--out-dir') options.outDir = argv[++index];
    else throw new Error(`[docx-golden-matrix] Unknown argument: ${argument}`);
  }
  return options;
}

async function generateDocxGoldenMatrix(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, '..'));
  const outDir = path.resolve(
    root,
    options.outDir || path.join('out', 'qa', 'rendered-document', 'matrix'),
  );
  const sourceDir = path.join(outDir, 'source');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(sourceDir, { recursive: true });

  const cases = [];
  for (const scenarioId of Object.keys(GOLDEN_SCENARIOS)) {
    const outPath = path.join(sourceDir, `${scenarioId}.docx`);
    const result = await (options.generateSampleDocx || generateSampleDocx)({
      scenarioId,
      outPath,
      docx: options.docx,
      pdfMake: options.pdfMake,
      utilsPath: options.utilsPath,
      reportPath: options.reportPath,
    });
    const stat = fs.statSync(outPath);
    const header = fs.readFileSync(outPath).subarray(0, 2);
    if (stat.size < 1024 || header[0] !== 0x50 || header[1] !== 0x4b) {
      throw new Error(`[docx-golden-matrix] Invalid DOCX source for ${scenarioId}`);
    }
    cases.push({
      id: scenarioId,
      city: result.city,
      accidentCount: result.accidentCount,
      contextMode: result.contextMode,
      source: path.relative(root, outPath).replace(/\\/g, '/'),
      bytes: stat.size,
      sha256: sha256File(outPath),
      renderedContractStatus: scenarioId === 'bonn-standard'
        ? 'full-libreoffice-poppler-contract'
        : 'source-fixture-awaiting-dedicated-render-contract',
    });
  }

  const expectedIds = [
    'bonn-standard',
    'hannover-standard',
    'bonn-few-rows',
    'hannover-many-rows',
    'bonn-missing-context',
  ];
  const actualIds = cases.map(item => item.id);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error(`[docx-golden-matrix] Scenario order mismatch: ${actualIds.join(', ')}`);
  }
  if (new Set(cases.map(item => item.sha256)).size !== cases.length) {
    throw new Error('[docx-golden-matrix] Scenario sources are not distinct');
  }
  const missingContext = cases.find(item => item.id === 'bonn-missing-context');
  if (!missingContext || missingContext.contextMode !== 'missing') {
    throw new Error('[docx-golden-matrix] Missing-context case is not explicit');
  }
  const manyRows = cases.find(item => item.id === 'hannover-many-rows');
  const fewRows = cases.find(item => item.id === 'bonn-few-rows');
  if (!manyRows || !fewRows || manyRows.accidentCount <= 50 || fewRows.accidentCount >= 5) {
    throw new Error('[docx-golden-matrix] Few-/many-row cardinality contract is invalid');
  }

  const manifest = {
    schemaVersion: 1,
    matrixId: 'unfallwerkbank-docx-golden-matrix-v1',
    generator: 'scripts/generate-sample-docx.js',
    productionRenderer: 'UA.exportToWord',
    cases,
    limitations: [
      'Only bonn-standard currently has the complete LibreOffice/Poppler final-page contract.',
      'The four additional sources are versioned inputs for dedicated rendered contracts; they are not claimed as publication-ready yet.',
      'Microsoft Word compatibility remains a manual release check.',
    ],
  };
  const manifestPath = path.join(outDir, 'matrix.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `[docx-golden-matrix] wrote ${cases.length} production DOCX source cases to ${outDir}\n`,
  );
  return { root, outDir, manifestPath, manifest };
}

async function main(argv) {
  return generateDocxGoldenMatrix(parseArgs(argv));
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  sha256File,
  parseArgs,
  generateDocxGoldenMatrix,
  main,
};
