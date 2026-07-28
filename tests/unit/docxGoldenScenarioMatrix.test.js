'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  GOLDEN_SCENARIOS,
  SampleDocxError,
  createGoldenScenario,
  resolveScenario,
} = require('../../scripts/generate-sample-docx');
const {
  generateDocxGoldenMatrix,
} = require('../../scripts/generate-docx-golden-matrix');
const renderedQa = require('../../scripts/qa-sample-docx-rendered');

function fakeDocxBytes(id) {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.alloc(1200, id.length),
    Buffer.from(id),
  ]);
}

describe('DOCX Golden scenario matrix', () => {
  test('declares exactly the required five cases in stable order', () => {
    expect(Object.keys(GOLDEN_SCENARIOS)).toEqual([
      'bonn-standard',
      'hannover-standard',
      'bonn-few-rows',
      'hannover-many-rows',
      'bonn-missing-context',
    ]);
  });

  test('keeps the existing Bonn contract unchanged at its public boundary', () => {
    const scenario = createGoldenScenario('bonn-standard');
    expect(scenario.descriptor).toMatchObject({
      city: 'Bonn',
      count: 24,
      clusterCount: 11,
      contextMode: 'available',
    });
    expect(scenario.context.CITY_RAW).toBe('Bonn');
    expect(scenario.context.allPts).toHaveLength(24);
    expect(scenario.reportData.structured.severity).toEqual({
      total: 24,
      bySev: { '1': 1, '2': 6, '3': 17, other: 0 },
    });
    expect(scenario.reportData.structured.yearTable.map(row => row.total)).toEqual([7, 8, 9]);
  });

  test('few, many, second-city and missing-context cases are semantically distinct', () => {
    const hannover = createGoldenScenario('hannover-standard');
    const few = createGoldenScenario('bonn-few-rows');
    const many = createGoldenScenario('hannover-many-rows');
    const missing = createGoldenScenario('bonn-missing-context');

    expect(hannover.context.CITY_RAW).toBe('Hannover');
    expect(hannover.reportData.structured.meta.city).toBe('Hannover');
    expect(few.context.allPts).toHaveLength(3);
    expect(many.context.allPts).toHaveLength(72);
    expect(many.reportData.structured.severity.total).toBe(72);
    expect(missing.context.contextDataState).toEqual({
      status: 'missing',
      slope: false,
      traffic: false,
      roads: false,
    });
    expect(missing.reportData.text).toMatch(/keine Straßen-, Steigungs- oder Verkehrskontextdaten/);
    expect(missing.reportData.structured.meta.contextAvailability).toBe('missing');
  });

  test('unknown scenario fails closed and lists valid identifiers', () => {
    expect(() => resolveScenario('unknown-case')).toThrow(SampleDocxError);
    try {
      resolveScenario('unknown-case');
    } catch (error) {
      expect(error.code).toBe('unknown_scenario');
      expect(error.details.available).toEqual(Object.keys(GOLDEN_SCENARIOS));
    }
  });

  test('matrix manifest contains distinct hash-bound production sources', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-docx-matrix-'));
    try {
      const generateSampleDocx = jest.fn(async ({ scenarioId, outPath }) => {
        const descriptor = GOLDEN_SCENARIOS[scenarioId];
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, fakeDocxBytes(scenarioId));
        return {
          scenarioId,
          city: descriptor.city,
          accidentCount: descriptor.count,
          contextMode: descriptor.contextMode,
          outPath,
          bytes: fs.statSync(outPath).size,
          downloadName: `${scenarioId}.docx`,
          mapBytes: 100,
        };
      });

      const result = await generateDocxGoldenMatrix({ root, generateSampleDocx });
      expect(generateSampleDocx).toHaveBeenCalledTimes(5);
      expect(result.manifest.schemaVersion).toBe(1);
      expect(result.manifest.productionRenderer).toBe('UA.exportToWord');
      expect(result.manifest.cases).toHaveLength(5);
      expect(new Set(result.manifest.cases.map(item => item.sha256))).toHaveSize(5);
      expect(result.manifest.cases.find(item => item.id === 'bonn-standard').renderedContractStatus)
        .toBe('full-libreoffice-poppler-contract');
      expect(result.manifest.cases.filter(item => item.id !== 'bonn-standard'))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            renderedContractStatus: 'source-fixture-awaiting-dedicated-render-contract',
          }),
        ]));
      expect(JSON.parse(fs.readFileSync(result.manifestPath, 'utf8')))
        .toEqual(result.manifest);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rendered QA generates the matrix before the existing Bonn final-page audit', async () => {
    const calls = [];
    const result = await renderedQa.main({
      root: '/tmp/unfallatlas-fixture',
      matrixMain: async () => {
        calls.push('matrix');
        return { manifest: { cases: Array(5).fill({}) } };
      },
      libreOfficeMain: () => {
        calls.push('libreoffice');
        return { pages: [{ number: 1 }] };
      },
      tableMain: () => {
        calls.push('tables');
        return { report: { summary: { mapCount: 4, tableRowCount: 10 } } };
      },
    });
    expect(calls).toEqual(['matrix', 'libreoffice', 'tables']);
    expect(result.matrixEvidence.manifest.cases).toHaveLength(5);
  });
});
