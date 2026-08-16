'use strict';

const api = require('../../js/ua.evidence_cohort.js');

function point(lat, lon, overrides = {}) {
  return {
    lat,
    lon,
    props: {
      istrad: overrides.istrad ? '1' : '0',
      istfuss: overrides.istfuss ? '1' : '0',
      istpkw: overrides.istpkw ? '1' : '0',
      istkrad: '0', istgkfz: '0', istsonstig: '0',
      ukategorie: String(overrides.severity ?? 3),
      ujahr: String(overrides.year ?? 2024),
      umonat: String(overrides.month ?? 1),
      uwochentag: String(overrides.weekday ?? 2),
      ustunde: String(overrides.hour ?? 8),
      strzustand: String(overrides.road ?? 0),
      utyp1: String(overrides.type ?? 1),
      uart: String(overrides.kind ?? 1),
      objectid: overrides.id,
    },
  };
}

function fixture() {
  const allPts = [
    point(52.3911, 9.7199, { id: 'x1', istrad: true, severity: 2, year: 2022 }),
    point(52.3912, 9.7200, { id: 'x2', istrad: true, istpkw: true, year: 2023 }),
    point(52.3913, 9.7201, { id: 'x3', istfuss: true, istpkw: true, year: 2024 }),
    point(52.3914, 9.7202, { id: 'x4', istpkw: true, year: 2025 }),
    point(52.5000, 9.9000, { id: 'outside', istrad: true }),
  ];
  const discovery = allPts.slice(0, 2);
  const UA = {
    maskFromProps(props) {
      return (props.istrad === '1' ? 1 : 0)
        | (props.istfuss === '1' ? 2 : 0)
        | (props.istpkw === '1' ? 4 : 0);
    },
    AnalysisScope: { getActiveFilteredPoints: () => discovery },
  };
  const ctx = {
    allPts,
    selectionBounds: { south: 52.3910, west: 9.7197, north: 52.3920, east: 9.7210 },
  };
  const report = {
    structured: {
      meta: {
        link: 'https://example.test/werkbank_v2.html?city=Hannover&includeCyclist=1',
        filters: { includeCyclist: true, severity: '2' },
      },
      poi: { withinByType: { school: 1 } },
    },
  };
  return { UA, ctx, report, allPts };
}

describe('discovery filters versus complete application evidence', () => {
  test('keeps the active-filter cohort as a subset while numbering every area accident', () => {
    const { UA, ctx, report, allPts } = fixture();
    const cohorts = api.buildCohorts(UA, ctx, report);

    expect(cohorts).toMatchObject({
      schemaVersion: api.SCHEMA_VERSION,
      status: 'complete',
      discoveryCohort: { count: 2 },
      completeEvidenceCohort: { count: 4 },
      relationship: {
        discoveryIsSubset: true,
        additionallyConsideredCount: 2,
      },
    });
    expect(cohorts.discoveryCohort.accidentIds).toEqual(['A001', 'A002']);
    expect(cohorts.completeEvidenceCohort.accidentIds).toEqual(['A001', 'A002', 'A003', 'A004']);
    expect(cohorts.completeEvidenceCohort.rows.map(row => row.discoveryMatch))
      .toEqual([true, true, false, false]);
    expect(cohorts.numberedMapUrl).toContain('evidenceLabels=1');
    expect(cohorts.completeEvidenceCohort.rows[2].mapDeepLink).toContain('evidenceAccident=A003');
    expect(allPts[0].__uaEvidenceDisplayId).toBe('A001');
    expect(Object.keys(allPts[0])).not.toContain('__uaEvidenceDisplayId');
  });

  test('creates complete untruncated tables and separate deterministic statistics', () => {
    const { UA, ctx, report } = fixture();
    const cohorts = api.buildCohorts(UA, ctx, report);
    const structured = api.buildEvidenceStructured(cohorts, report.structured);
    const appendix = api.buildAppendix(cohorts, { ...report.structured, patternDetection: { findings: [] } });

    expect(structured.severity.total).toBe(4);
    expect(structured.yearTable.reduce((sum, row) => sum + row.total, 0)).toBe(4);
    expect(structured.crossTable.rows.reduce((sum, row) => sum + row.total, 0)).toBe(4);
    expect(structured.accidentDetails).toMatchObject({ total: 4, truncated: false });
    expect(appendix).toMatchObject({ complete: true, truncated: false, total: 4, discoveryCount: 2 });
    expect(appendix.rows).toHaveLength(4);
  });

  test('blocks an AI result that omits area accidents or ignores vulnerable-user priority', () => {
    const { UA, ctx, report } = fixture();
    const cohorts = api.buildCohorts(UA, ctx, report);
    const facts = { structured: { evidenceCohorts: cohorts } };
    const valid = api.validateCoverage({ evidenceCohortCoverage: {
      schemaVersion: api.COVERAGE_SCHEMA,
      completeEvidenceCount: 4,
      consideredAccidentIds: ['A001', 'A002', 'A003', 'A004'],
      discoveryAccidentIds: ['A001', 'A002'],
      omittedAccidentIds: [],
      allAccidentsConsidered: true,
      vulnerableUserPriority: {
        schoolsAndKindergartensConsidered: true,
        explanation: 'Kinder und andere vulnerable Personen werden besonders geschützt.',
      },
    } }, facts);
    expect(valid.passed).toBe(true);

    const invalid = api.validateCoverage({ evidenceCohortCoverage: {
      schemaVersion: api.COVERAGE_SCHEMA,
      completeEvidenceCount: 2,
      consideredAccidentIds: ['A001', 'A002'],
      discoveryAccidentIds: ['A001', 'A002'],
      omittedAccidentIds: ['A003', 'A004'],
      allAccidentsConsidered: false,
      vulnerableUserPriority: { schoolsAndKindergartensConsidered: false },
    } }, facts);
    expect(invalid.passed).toBe(false);
    expect(invalid.errors.join(' ')).toMatch(/A003.*A004/);
    expect(invalid.errors.join(' ')).toMatch(/omittedAccidentIds/);
    expect(invalid.errors.join(' ')).toMatch(/Schulen\/Kindertagesstätten/);
  });

  test('exports identical IDs in CSV and GeoJSON and partitions detail maps without loss', () => {
    const { UA, ctx, report } = fixture();
    const cohorts = api.buildCohorts(UA, ctx, report);
    const csv = api.appendixCsv(cohorts);
    const geoJson = api.appendixGeoJson(cohorts);
    const parts = api.partitionRows(cohorts.completeEvidenceCohort.rows, 2);

    expect(csv).toContain('A001');
    expect(csv).toContain('A004');
    expect(csv.trim().split(/\r?\n/)).toHaveLength(5);
    expect(geoJson.features.map(feature => feature.properties.evidence_id))
      .toEqual(['A001', 'A002', 'A003', 'A004']);
    expect(parts.flat().map(row => row.displayId).sort())
      .toEqual(['A001', 'A002', 'A003', 'A004']);
    expect(parts.every(part => part.length <= 2)).toBe(true);
  });
});
