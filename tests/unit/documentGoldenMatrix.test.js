'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const scenarios = require('../../scripts/document-golden-scenarios');
const sampleDocx = require('../../scripts/generate-sample-docx');
const matrix = require('../../scripts/generate-document-golden-matrix');

function fakeDocx(id) {
  const label = Buffer.from(`PK-${id}-`);
  return Buffer.concat([label, Buffer.alloc(2048, id.length)]);
}

describe('document Golden scenario matrix', () => {
  const roots = [];

  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
  });

  test('defines exactly the five required semantic scenarios', () => {
    expect(scenarios.listScenarioIds()).toEqual([
      'bonn-urban-junction',
      'few-cases',
      'hannover-arterial',
      'long-multi-section-report',
      'uncertain-context',
    ]);
    expect(scenarios.getScenario('bonn-urban-junction').city).toBe('Bonn');
    expect(scenarios.getScenario('hannover-arterial').city).toBe('Hannover');
    expect(scenarios.getScenario('few-cases').accidentCount).toBe(3);
    expect(
      scenarios.getScenario('long-multi-section-report').expectations.minimumRenderedPages,
    ).toBeGreaterThanOrEqual(8);
    expect(scenarios.getScenario('uncertain-context').context.status).toBe('uncertain');
  });

  test('keeps context, report totals, filters and map bounds consistent for every scenario', () => {
    for (const id of scenarios.listScenarioIds()) {
      const scenario = scenarios.getScenario(id);
      const context = sampleDocx.createContext(scenario);
      const report = sampleDocx.createReportData(scenario);

      expect(context.CITY_RAW).toBe(scenario.city);
      expect(context.allPts).toHaveLength(scenario.accidentCount);
      expect(context.filteredAll).toBe(context.allPts);
      expect(context.filteredCapped).toBe(context.allPts);
      expect(context.viewportPts).toBe(context.allPts);
      expect(context.allPts.every((point) => context.selectionBounds.contains(point))).toBe(true);
      expect(context.ui.incBikeEl.checked).toBe(scenario.involvement.cyclist);
      expect(context.ui.incPedEl.checked).toBe(scenario.involvement.pedestrian);
      expect(context.ui.incCarEl.checked).toBe(scenario.involvement.car);
      expect(context.ui.incMotoEl.checked).toBe(scenario.involvement.motorcycle);
      expect(context.ui.incGkfzEl.checked).toBe(scenario.involvement.heavyGoods);
      expect(context.ui.incSonEl.checked).toBe(scenario.involvement.other);

      expect(report.structured.meta.city).toBe(scenario.city);
      expect(report.structured.severity.total).toBe(scenario.accidentCount);
      expect(
        Object.values(report.structured.severity.bySev)
          .reduce((sum, value) => sum + value, 0),
      ).toBe(scenario.accidentCount);
      expect(
        report.structured.yearTable.reduce((sum, row) => sum + row.total, 0),
      ).toBe(scenario.accidentCount);
      expect(report.structured.deviations.local.total).toBe(scenario.accidentCount);
      expect(report.text).toContain(`${scenario.accidentCount} Unfälle`);
      expect(report.text).toContain(scenario.context.summary);
    }
  });

  test('keeps large point sets inside their declared selection instead of overflowing rows', () => {
    const scenario = scenarios.getScenario('long-multi-section-report');
    const points = sampleDocx.createAccidentPoints(
      scenario.accidentCount,
      scenario.bounds,
      scenario.involvement,
    );
    expect(points).toHaveLength(64);
    expect(points.every((point) =>
      point.lat > scenario.bounds.south && point.lat < scenario.bounds.north &&
      point.lon > scenario.bounds.west && point.lon < scenario.bounds.east
    )).toBe(true);
  });

  test('makes missing or uncertain context explicit instead of replacing it with invented values', () => {
    const scenario = scenarios.getScenario('uncertain-context');
    const report = sampleDocx.createReportData(scenario);
    expect(report.text).toContain('Kontextstatus: unsicher');
    expect(report.text).toContain('nicht vollständig verfügbar');
    expect(report.text).toContain('nicht durch Schätzwerte ersetzt');
  });

  test('generates a hash-bound matrix while explicitly leaving render and Word evidence open', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-document-matrix-'));
    roots.push(root);
    const generator = async ({ scenario, outPath }) => {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, fakeDocx(scenario.id));
      return { scenarioId: scenario.id, outPath, bytes: fs.statSync(outPath).size };
    };

    const first = await matrix.generateGoldenMatrix({
      root,
      outDir: 'out/matrix-one',
      generator,
    });
    const second = await matrix.generateGoldenMatrix({
      root,
      outDir: 'out/matrix-two',
      generator,
    });

    expect(first.matrix.schemaVersion).toBe(matrix.MATRIX_SCHEMA);
    expect(first.matrix.artifacts).toHaveLength(5);
    expect(first.matrix.matrixFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.matrix.matrixFingerprint).toBe(second.matrix.matrixFingerprint);
    expect(first.matrix.artifacts.every((entry) =>
      entry.automatedEvidence.docxGenerated === true &&
      entry.automatedEvidence.zipSignatureValid === true &&
      entry.automatedEvidence.renderedPageCount === null &&
      entry.automatedEvidence.renderedMapSemantics === null &&
      entry.automatedEvidence.renderedTableSemantics === null &&
      entry.manualWordEvidence.required === true &&
      entry.manualWordEvidence.status === 'not-performed' &&
      entry.manualWordEvidence.receipt === null
    )).toBe(true);
    expect(JSON.parse(fs.readFileSync(first.manifestPath, 'utf8'))).toEqual(first.matrix);
  });

  test('supports deterministic subsets and rejects duplicates or path escape', async () => {
    expect(matrix.selectScenarioIds(['few-cases', 'bonn-urban-junction'])).toEqual([
      'bonn-urban-junction',
      'few-cases',
    ]);
    expect(() => matrix.selectScenarioIds(['few-cases', 'few-cases'])).toThrow(
      /duplicate_scenario/,
    );
    expect(() => matrix.safeRelativePath('../outside', 'out')).toThrow(/unsafe_path/);

    const parsed = matrix.parseArgs([
      '--out-dir',
      'out/custom',
      '--manifest',
      'evidence.json',
      '--scenario',
      'few-cases',
    ]);
    expect(parsed.outDir).toBe('out/custom');
    expect(parsed.manifest).toBe('evidence.json');
    expect(parsed.scenarioIds).toEqual(['few-cases']);
  });
});
