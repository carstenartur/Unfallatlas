const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '../../js/ua.analysis_scope.js'), 'utf8');

function bounds(south, west, north, east) {
  return {
    getSouth: () => south,
    getWest: () => west,
    getNorth: () => north,
    getEast: () => east,
    getSouthWest: () => ({ lat: south, lng: west }),
    getNorthEast: () => ({ lat: north, lng: east }),
  };
}

function point(id, lat, lon, mask) {
  return {
    id,
    lat,
    lon,
    props: {
      istrad: mask & 1 ? '1' : '0',
      istfuss: mask & 2 ? '1' : '0',
      istpkw: mask & 4 ? '1' : '0',
      istkrad: mask & 8 ? '1' : '0',
      istgkfz: mask & 16 ? '1' : '0',
      istsonstig: mask & 32 ? '1' : '0',
    },
  };
}

function makeCtx(points) {
  return {
    CITY_RAW: 'Bonn',
    allPts: points,
    filteredAll: points.filter(p => (Number(p.props.istrad) && Number(p.props.istpkw))),
    filteredCapped: points.filter(p => (Number(p.props.istrad) && Number(p.props.istpkw))),
    viewportPts: [],
    selectionBounds: bounds(2, 2, 4, 4),
    map: { getBounds: () => bounds(0, 0, 10, 10) },
    involvementMode: 'and',
    ui: {
      incBikeEl: { checked: true },
      incPedEl: { checked: false },
      incCarEl: { checked: true },
      incMotoEl: { checked: false },
      incGkfzEl: { checked: false },
      incSonEl: { checked: false },
      maxPointsEl: { value: '100000' },
      statEl: { textContent: '', title: '' },
    },
  };
}

function loadModule(setup) {
  const mockWindow = { UA: {} };
  const UA = mockWindow.UA;
  UA.maskFromProps = pr =>
    (pr.istrad === '1' ? 1 : 0)
    | (pr.istfuss === '1' ? 2 : 0)
    | (pr.istpkw === '1' ? 4 : 0)
    | (pr.istkrad === '1' ? 8 : 0)
    | (pr.istgkfz === '1' ? 16 : 0)
    | (pr.istsonstig === '1' ? 32 : 0);
  UA.matchesNonInvolvementFilters = () => true;
  UA.matchesInvolvementFilter = (ctx, mask) => {
    if (ctx.involvementMode === 'and') return (mask & 5) === 5;
    return (mask & 5) !== 0;
  };
  if (setup) setup(UA);
  (function evaluate(window) { eval(source); })(mockWindow);
  return UA;
}

describe('UA.AnalysisScope', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  test('separates buffered, exactly visible and selected counts', () => {
    const points = [
      point('visible', 5, 5, 5),
      point('buffer-only', 5, 11, 5),
      point('selected', 3, 3, 5),
      point('wrong-involvement', 3, 3, 1),
    ];
    const UA = loadModule(api => {
      api.applyViewportFilter = ctx => {
        // Legacy behaviour: this represents the visible map plus load padding.
        ctx.viewportPts = ctx.filteredCapped.filter(p => p.lon <= 12);
      };
      api.updateStats = ctx => { ctx.ui.statEl.textContent = 'legacy'; };
    });
    const ctx = makeCtx(points);

    UA.applyViewportFilter(ctx);
    UA.updateStats(ctx);

    expect(ctx.bufferedViewportPts.map(p => p.id)).toEqual([
      'visible', 'buffer-only', 'selected',
    ]);
    expect(ctx.visibleViewportPts.map(p => p.id)).toEqual([
      'visible', 'selected',
    ]);
    expect(ctx.selectionPts.map(p => p.id)).toEqual(['selected']);
    expect(ctx.ui.statEl.textContent).toContain('sichtbar: 2');
    expect(ctx.ui.statEl.textContent).toContain('markierter Bereich: 1');
    expect(ctx.ui.statEl.textContent).not.toContain('im Viewport: 3');
    expect(ctx.ui.statEl.title).toContain('Technischer Ladepuffer: 3 Unfälle');
  });

  test('report and data exports receive the active involvement population', async () => {
    const points = [
      point('selected-active', 3, 3, 5),
      point('selected-bike-only', 3, 3.5, 1),
      point('outside-active', 8, 8, 5),
      point('outside-bike-only', 8, 8.5, 1),
    ];
    let reportCtx = null;
    let csvCtx = null;
    const UA = loadModule(api => {
      api.computeExportReport = async ctx => {
        reportCtx = ctx;
        return {
          text: 'Antrag\n\nMethodik unter denselben Nicht-Beteiligungsfiltern (Schwere/Zeit/Zustand/Wochentag)',
          html: '<div style="font-weight:950; font-size:16px;">Report</div>',
          structured: {
            totalAccidents: 99,
            severity: { total: 99, bySev: {} },
            meta: { filters: { involvementMode: 'and' }, baselineScope: {} },
            methodikScope: { title: 'alt', lines: ['alt'] },
          },
        };
      };
      api.exportToCSV = ctx => { csvCtx = ctx; return ctx.allPts.length; };
    });
    const ctx = makeCtx(points);

    const report = await UA.computeExportReport(ctx);
    const csvCount = UA.exportToCSV(ctx);

    expect(reportCtx.allPts.map(p => p.id)).toEqual([
      'selected-active', 'outside-active',
    ]);
    expect(reportCtx.baselineCounts.total).toBe(2);
    expect(csvCtx.allPts.map(p => p.id)).toEqual([
      'selected-active', 'outside-active',
    ]);
    expect(csvCount).toBe(2);

    expect(report.structured.totalAccidents).toBe(1);
    expect(report.structured.scopeCounts).toEqual(expect.objectContaining({
      activeInArea: 1,
      areaBeforeInvolvementFilter: 2,
      selectedActive: 1,
    }));
    expect(report.structured.meta.countScope.includesInvolvementFilter).toBe(true);
    expect(report.structured.methodikScope.lines.join(' ')).toContain('technischer Ladepuffer');
    expect(report.text).toContain('Aktive Auswahl im markierten Bereich: 1 Unfall');
    expect(report.text).toContain('Gebietsbestand vor Beteiligungsfilter: 2 Unfälle');
    expect(report.text).not.toContain('Nicht-Beteiligungsfiltern');
    expect(report.html).toContain('data-ua-count-scope="active"');
  });

  test('composes with the partial-coverage export guard without duplicate scope decoration', async () => {
    let originalCalls = 0;
    const UA = loadModule(api => {
      api.computeExportReport = async () => {
        originalCalls += 1;
        return {
          text: 'Antrag',
          html: '<div style="font-weight:950; font-size:16px;">Report</div>',
          structured: { severity: { total: 0 }, meta: {} },
        };
      };
      api.installAccidentCoverageExportGuards = () => {
        const original = api.computeExportReport;
        if (original && original._accidentCoverageGuarded) return;
        const guarded = async function guardedReport(ctx, ...args) {
          if (ctx.accidentDataCoverage && ctx.accidentDataCoverage.complete === false) {
            throw new Error('Berichtsexport ist bei unvollständiger Abdeckung gesperrt');
          }
          return original.call(this, ctx, ...args);
        };
        guarded._accidentCoverageGuarded = true;
        guarded._original = original;
        api.computeExportReport = guarded;
      };
    });
    const points = [point('selected-active', 3, 3, 5)];
    const incomplete = makeCtx(points);
    incomplete.accidentDataCoverage = { complete: false };

    await expect(UA.computeExportReport(incomplete)).rejects.toThrow(/unvollständiger Abdeckung/);
    expect(originalCalls).toBe(0);

    const complete = makeCtx(points);
    complete.accidentDataCoverage = { complete: true };
    const report = await UA.computeExportReport(complete);
    expect(originalCalls).toBe(1);
    expect((report.html.match(/data-ua-count-scope="active"/g) || [])).toHaveLength(1);
  });
});
