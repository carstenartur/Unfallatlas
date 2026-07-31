/** @jest-environment node */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const scenarios = require('../../scripts/document-golden-scenarios');
const renderedMatrix = require('../../scripts/render-document-golden-matrix');
const semantics = require('../../scripts/verify-document-golden-rendered-semantics');

function word(text, yMin, xMin = 40) {
  return { text, xMin, yMin, xMax: xMin + Math.max(30, text.length * 4), yMax: yMin + 10 };
}

function page(number, words = [], images = []) {
  return { number, width: 595, height: 842, words, images, tableRows: [] };
}

function baselineModel() {
  return {
    documentId: 'golden-bonn-urban-junction',
    renderer: 'docx-libreoffice-poppler',
    pages: [
      page(1, [
        word('Bonn', 60),
        word('Innerstädtischer Knoten Bonn-Zentrum', 80),
        word('24 Unfälle', 100),
        word('Kontextinformationen werden nicht als Kausalnachweis interpretiert', 120),
        word('Verletzungsschwere im Ausschnitt', 180),
        word('Mehrjahres-Trend', 260),
      ]),
      page(2, [word('Abbildung 1: Übersichtskarte aller Beteiligungs-Kombinationen', 330)], [
        { imageId: 'overview', xMin: 40, yMin: 80, xMax: 520, yMax: 300 },
      ]),
      page(3, [word('Abbildung 2: Auswahl-Karte mit 24 Unfällen', 330)], [
        { imageId: 'selection', xMin: 40, yMin: 80, xMax: 520, yMax: 300 },
      ]),
      page(4, [word('Abbildung 3: Detailausschnitt des markierten Auswertungsbereichs', 330)], [
        { imageId: 'detail', xMin: 40, yMin: 80, xMax: 520, yMax: 300 },
      ]),
      page(5, [word('Abbildung 4: Cluster-Karte Bonn-Zentrum mit 11 Unfällen', 330)], [
        { imageId: 'cluster', xMin: 40, yMin: 80, xMax: 520, yMax: 300 },
      ]),
      page(6, [word('Datenquelle Unfallatlas', 60)]),
    ],
  };
}

describe('document Golden rendered semantics', () => {
  test('binds every declared map and table role to final-page evidence', () => {
    const scenario = scenarios.getScenario('bonn-urban-junction');
    const model = semantics.normalizedPageModel(baselineModel(), scenario.id);
    const text = semantics.verifyScenarioText(model, scenario);
    const maps = semantics.verifyMapSemantics(model, scenario);
    const tables = semantics.verifyTableSemantics(model, scenario);

    expect(text.matched.accidentCount).toContain('24');
    expect(maps.bindings.map(binding => binding.role))
      .toEqual(['cluster', 'detail', 'overview', 'selection']);
    expect(new Set(maps.bindings.map(binding => binding.imageId)).size).toBe(4);
    expect(tables.bindings.map(binding => binding.role)).toEqual(['severity', 'year-trend']);
    expect(tables.evidenceMode).toBe('rendered-headings');
  });

  test('rejects a visible map caption without a unique preceding image', () => {
    const scenario = scenarios.getScenario('bonn-urban-junction');
    const source = baselineModel();
    source.pages[3].images = [];
    const model = semantics.normalizedPageModel(source, scenario.id);
    expect(() => semantics.verifyMapSemantics(model, scenario))
      .toThrow(/map_caption_without_image/);
  });

  test('writes a source-hash-bound semantic matrix without replacing rendered evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'document-golden-semantics-'));
    try {
      const matrixDir = path.join(root, 'out', 'qa', 'document-golden-matrix');
      const renderedRoot = path.join(matrixDir, 'rendered');
      const scenarioRoot = path.join(renderedRoot, 'bonn-urban-junction', 'poppler');
      fs.mkdirSync(scenarioRoot, { recursive: true });
      const modelFile = path.join(scenarioRoot, 'rendered-document-model.json');
      fs.writeFileSync(modelFile, `${JSON.stringify(baselineModel())}\n`);
      const modelRelative = path.relative(renderedRoot, modelFile).replace(/\\/g, '/');
      const input = {
        schemaVersion: renderedMatrix.RENDERED_MATRIX_SCHEMA,
        sourceMatrix: {
          filename: 'matrix.json',
          sha256: '1'.repeat(64),
          matrixFingerprint: '2'.repeat(64),
          scenarioContractSha256: '3'.repeat(64),
        },
        artifacts: [{
          scenarioId: 'bonn-urban-junction',
          artifact: { filename: 'bonn-urban-junction.docx', bytes: 2048, sha256: '4'.repeat(64) },
          expectations: scenarios.getScenario('bonn-urban-junction').expectations,
          automatedEvidence: {
            docxGenerated: true,
            zipSignatureValid: true,
            minimumBytesSatisfied: true,
            renderedPageCount: 6,
            renderedMapSemantics: null,
            renderedTableSemantics: null,
          },
          manualWordEvidence: { required: true, status: 'not-performed', receipt: null },
          renderedEvidence: {
            renderedPageCount: 6,
            minimumRenderedPages: 6,
            auditModel: {
              path: modelRelative,
              bytes: fs.statSync(modelFile).size,
              sha256: semantics.sha256(fs.readFileSync(modelFile)),
            },
          },
        }],
        truthBoundary: {
          renderedPageCountsVerified: true,
          genericFinalPageAuditVerified: true,
          renderedMapSemanticsVerified: false,
          renderedTableSemanticsVerified: false,
          microsoftWordEvidenceVerified: false,
        },
        matrixFingerprint: '5'.repeat(64),
      };
      const inputFile = path.join(renderedRoot, 'rendered-matrix.json');
      fs.writeFileSync(inputFile, `${JSON.stringify(input, null, 2)}\n`);
      const original = fs.readFileSync(inputFile);

      const result = semantics.verifyRenderedSemantics({ root });
      expect(fs.readFileSync(inputFile)).toEqual(original);
      expect(result.matrix.truthBoundary.renderedMapSemanticsVerified).toBe(true);
      expect(result.matrix.truthBoundary.renderedTableSemanticsVerified).toBe(true);
      expect(result.matrix.truthBoundary.microsoftWordEvidenceVerified).toBe(false);
      expect(result.matrix.sourceRenderedMatrix.sha256).toBe(semantics.sha256(original));
      expect(fs.existsSync(result.manifestPath)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
