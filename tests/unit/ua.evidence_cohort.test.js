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

  test.each([['available', [true, false, false, false]], ['unavailable', [false, false, false, false]]])
  ('marks only the site cohort in the complete area annex when the network is %s', (status, expectedMatches) => {
    const { UA, ctx, report, allPts } = fixture();
    const site = { id: 'j:22', revision: '398a1a71f25db801' };
    report.structured.siteNetwork = { status, site, mappedPoints: status === 'available' ? [allPts[0]] : [] };
    const cohorts = api.buildCohorts(UA, ctx, report);
    expect(cohorts.completeEvidenceCohort.count).toBe(4);
    expect(cohorts.completeEvidenceCohort.rows.map(row => row.discoveryMatch)).toEqual(expectedMatches);
    expect(cohorts.discoveryCohort.label).toBe('Netzzuordnung');
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

describe('printed point maps for a council motion', () => {
  const row = (displayId, lat, lon) => ({ displayId, lat, lon });
  test('uses every located case once, separating the actual focus and keeping coincident IDs together', () => {
    const rows = [row('A001', 52.37570, 9.72678), row('A002', 52.375700000000026, 9.726780000000021),
      row('A003', 52.37575, 9.72681), row('A004', 52.37581, 9.72677), row('A005', null, 9.72677)];
    const sheets = api.documentPointSheets(rows, new Set(['A001', 'A002', 'A003']));
    expect(sheets.map(s => [s.ref, s.kind, s.locations.length])).toEqual([['K1', 'focus', 2], ['K2', 'other', 1]]);
    expect(sheets[0].locations.find(p => p.ids.includes('A001')).ids).toEqual(['A001', 'A002']);
    expect(sheets.flatMap(s => s.locations.flatMap(p => p.ids)).sort()).toEqual(['A001', 'A002', 'A003', 'A004']);
  });

  test('groups a large cohort spatially without splitting identical locations or losing cases', () => {
    const rows = Array.from({length: 60}, (_, i) => row('A' + i, 52.37 + i / 10000, 9.72));
    rows.push(row('duplicate', rows[0].lat, rows[0].lon));
    const sheets = api.documentPointSheets(rows, new Set());
    expect(sheets.map(s => s.locations.length)).toEqual([30, 30]);
    expect(sheets.every(s => s.kind === 'area')).toBe(true);
    expect(sheets.flatMap(s => s.locations.flatMap(p => p.ids)).sort()).toEqual(rows.map(r => r.displayId).sort());
    expect(sheets.flatMap(s => s.locations).find(p => p.ids.includes('duplicate')).ids).toContain('A0');
  });
  test('places true coordinate anchors across the printed frame and registers them to the aerial', () => {
    const pen = Object.fromEntries(['arc', 'beginPath', 'drawImage', 'fill', 'fillRect', 'fillText',
      'lineTo', 'moveTo', 'stroke', 'strokeRect'].map(key => [key, jest.fn()]));
    pen.measureText = text => ({ width: 16 * text.length });
    const root = { document: { createElement: () => ({ getContext: () => pen, toDataURL: () => 'png' }) } };
    const rows = [row('A001', 52.37570, 9.726780), row('A002', 52.37572, 9.726800), row('A003', 52.37572, 9.726800)];
    const [sheet] = api.documentPointSheets(rows, new Set());
    const photo = { bitmap: {}, bounds: { west: 9.7267, east: 9.7269, south: 52.37565, north: 52.37577 } };
    expect(api.drawDocumentPointMap(root, sheet, photo)).toBe('png');
    expect(pen.arc).toHaveBeenCalledTimes(2);
    const [[x1, y1], [x2, y2]] = pen.arc.mock.calls;
    expect(x1).toBeLessThan(x2);
    expect(y1 - y2).toBeGreaterThan(250);
    const [[bitmap, left, , imageWidth]] = pen.drawImage.mock.calls;
    expect(bitmap).toBe(photo.bitmap);
    expect(x1).toBeCloseTo(left + imageWidth * 0.4);
    expect(x2).toBeCloseTo(left + imageWidth * 0.5);
    expect(pen.fillText.mock.calls.map(([t]) => t)).toContain('A002 ×2');
  });

});

test('links to the overview and individual rows open the map without inheriting another selected ID', () => {
  const { UA, ctx, report } = fixture();
  report.structured.meta.link += '&export=1&evidenceAccident=A099';
  const cohorts = api.buildCohorts(UA, ctx, report);
  const overview = new URL(cohorts.numberedMapUrl);
  const individual = new URL(cohorts.completeEvidenceCohort.rows[1].mapDeepLink);
  expect(overview.searchParams.get('evidenceScope')).toBe('complete');
  expect(overview.searchParams.has('evidenceAccident')).toBe(false);
  expect(overview.searchParams.has('export')).toBe(false);
  expect(individual.searchParams.get('evidenceAccident')).toBe('A002');
  expect(individual.searchParams.has('export')).toBe(false);
});

test('DOM updates during a report and after Leaflet inserts its markers reuse the numbered evidence map', async () => {
  const { UA, ctx, report } = fixture();
  ctx.map = {};
  UA.getRuntimeContext = () => ctx;
  let finish;
  const compute = jest.fn(() => new Promise(resolve => { finish = resolve; }));
  UA.computeExportReport = compute;
  let mutation;
  const groups = [];
  const marker = jest.fn(() => ({ bindPopup() {}, addTo() {} }));
  const scope = {
    document: { documentElement: {}, getElementById: () => null },
    location: new URL('https://example.test/?evidenceLabels=1&evidenceScope=complete&evidenceAccident=A002'),
    MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} },
    L: { marker, divIcon: options => options, layerGroup: () => {
      const layer = { addTo: jest.fn(), remove: jest.fn() };
      groups.push(layer);
      return layer;
    } },
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  api.install(UA, scope);
  mutation();
  mutation();
  await settle();
  expect(compute).toHaveBeenCalledTimes(1);
  finish(report);
  await settle();
  mutation();
  await settle();
  expect(compute).toHaveBeenCalledTimes(1);
  expect(groups).toHaveLength(1);
  expect(groups[0].addTo).toHaveBeenCalledWith(ctx.map);
  expect(marker).toHaveBeenCalledTimes(4);
  const selected = marker.mock.calls.filter(([, options]) => options.icon.className.includes('ua-evidence-id-selected'));
  expect(selected).toHaveLength(1);
  expect(selected[0][1]).toMatchObject({ title: 'A002', zIndexOffset: 1000 });

  scope.location.search = '?city=Hannover';
  mutation();
  expect(groups[0].remove).toHaveBeenCalledTimes(1);
  expect(ctx.__uaEvidenceLabelLayer).toBeUndefined();
});
