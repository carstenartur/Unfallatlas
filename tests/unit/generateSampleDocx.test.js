'use strict';

const {
  createAccidentPoints,
  createContext,
  createReportData,
} = require('../../scripts/generate-sample-docx');

describe('real DOCX Golden snapshot generator', () => {
  test('uses one internally consistent 24-accident runtime population', () => {
    const ctx = createContext();

    expect(ctx.allPts).toHaveLength(24);
    expect(ctx.filteredAll).toHaveLength(24);
    expect(ctx.filteredCapped).toHaveLength(24);
    expect(ctx.viewportPts).toHaveLength(24);
    expect(ctx.allPts).toBe(ctx.filteredAll);
    expect(ctx.allPts).toBe(ctx.filteredCapped);
    expect(ctx.allPts).toBe(ctx.viewportPts);
    expect(ctx.selectionBounds.contains(ctx.viewportPts[0])).toBe(true);
    expect(ctx.selectionBounds.getSouthWest()).toEqual({ lat: 50.728, lng: 7.087 });
    expect(ctx.selectionBounds.getNorthEast()).toEqual({ lat: 50.739, lng: 7.105 });
  });

  test('models the active Rad-plus-PKW filter in the runtime controls', () => {
    const ctx = createContext();

    expect(ctx.ui.incBikeEl.checked).toBe(true);
    expect(ctx.ui.incCarEl.checked).toBe(true);
    expect(ctx.ui.incPedEl.checked).toBe(false);
    expect(ctx.ui.incMotoEl.checked).toBe(false);
    expect(ctx.ui.incGkfzEl.checked).toBe(false);
    expect(ctx.ui.incSonEl.checked).toBe(false);
    expect(ctx.ui.severityEl.value).toBe('all');
    expect(ctx.ui.hFromEl.value).toBe('0');
    expect(ctx.ui.hToEl.value).toBe('23');
  });

  test('keeps narrative, severity and yearly totals bound to the same 24 cases', () => {
    const report = createReportData();

    expect(report.text).toContain('24 Unfälle');
    expect(report.structured.severity.total).toBe(24);
    expect(Object.values(report.structured.severity.bySev).reduce((sum, value) => sum + value, 0)).toBe(24);
    expect(report.structured.yearTable.reduce((sum, row) => sum + row.total, 0)).toBe(24);
    expect(report.structured.deviations.local.total).toBe(24);
  });

  test('creates deterministic points in the live normalized Unfallatlas shape', () => {
    const points = createAccidentPoints(11, {
      south: 50.73,
      west: 7.091,
      north: 50.736,
      east: 7.101,
    });

    expect(points).toHaveLength(11);
    expect(points.every((point) =>
      point.lat > 50.73 && point.lat < 50.736 &&
      point.lon > 7.091 && point.lon < 7.101
    )).toBe(true);
    expect(points.every((point) => point.IstRad === 1 && point.IstPKW === 1)).toBe(true);
    expect(points.every((point) => point.props.istrad === '1' && point.props.istpkw === '1')).toBe(true);
    expect(points.every((point) => point.props.istfuss === '0' && point.props.istkrad === '0')).toBe(true);
    expect(points.every((point) => Number(point.props.ukategorie) === point.severity)).toBe(true);
    expect(points.every((point) => Number(point.props.ujahr) === point.year)).toBe(true);
  });
});

test('each golden role draws its actual population and publishes a snapshot-bound receipt', () => {
  const { createScenarioMaps } = require('../../scripts/generate-sample-docx');
  const maps=createScenarioMaps(createContext(), resolveScenarioForTest());
  expect(Object.keys(maps)).toEqual(['overview', 'selection', 'cluster']);
  expect(maps.overview.receipt.markerCount).toBe(24);
  expect(maps.selection.receipt.markerCount).toBe(24);
  expect(maps.cluster.receipt.markerCount).toBe(11);
  expect(new Set(Object.values(maps).map(m=>m.receipt.sha256)).size).toBe(3);
  expect(maps.cluster.receipt.accidentIds.every(id=>maps.overview.receipt.accidentIds.includes(id))).toBe(true);
});
function resolveScenarioForTest(){return require('../../scripts/document-golden-scenarios').getScenario('bonn-urban-junction');}

test('baseline map marker severities and years agree with the fixed rendered table totals', () => {
  const ctx=createContext(),report=createReportData();
  const severities={1:0,2:0,3:0,other:0},years={};
  for(const p of ctx.allPts){severities[p.props.ukategorie]++;years[p.year]=(years[p.year]||0)+1;}
  expect(severities).toEqual(report.structured.severity.bySev);
  expect(Object.values(years)).toEqual(report.structured.yearTable.map(r=>r.total));
});
