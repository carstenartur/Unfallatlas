const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.resolve(__dirname, '../../js/ua.filtered_export_provenance.js'),
  'utf8',
);

describe('UA.filteredExportProvenance', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  test('passes a scoped context and corrected manifest to document and data exports', async () => {
    const captured = [];
    const originalCtx = { id: 'original', allPts: [{ id: 1 }, { id: 2 }] };
    const scopedCtx = { id: 'scoped', allPts: [{ id: 1 }] };
    const oldPolicy =
      'Beteiligungsfilter dokumentiert; Datenexport enthält alle Kombinationen im übrigen Filterumfang';

    const mockWindow = {
      console: { warn: jest.fn() },
      UA: {
        AnalysisScope: {
          createScopedContext: jest.fn(() => scopedCtx),
        },
        exportProvenance: {
          createManifest: jest.fn(async ctx => ({
            scenario: { filters: { dataExportInvolvementPolicy: oldPolicy } },
            transformations: [{
              transformationId: 'filter-export-selection',
              description: oldPolicy,
              parameters: { filters: { dataExportInvolvementPolicy: oldPolicy } },
            }],
            pointsSeen: ctx.allPts.length,
          })),
        },
        exportToWord: jest.fn(async ctx => { captured.push(['word', ctx]); return 'word'; }),
        exportToPDF: jest.fn(async ctx => { captured.push(['pdf', ctx]); return 'pdf'; }),
        exportToCSV: jest.fn(async ctx => { captured.push(['csv', ctx]); return 'csv'; }),
        exportToGeoJSON: jest.fn(async ctx => { captured.push(['geojson', ctx]); return 'geojson'; }),
        exportToKML: jest.fn(async ctx => { captured.push(['kml', ctx]); return 'kml'; }),
      },
    };

    (function evaluate(window) { eval(source); })(mockWindow);
    const { UA } = mockWindow;

    await UA.exportToWord(originalCtx);
    await UA.exportToCSV(originalCtx);

    expect(UA.AnalysisScope.createScopedContext).toHaveBeenCalledWith(originalCtx);
    expect(UA.exportProvenance.createManifest).toHaveBeenCalledWith(
      scopedCtx,
      expect.objectContaining({ UA, root: mockWindow }),
    );
    expect(captured.map(([kind]) => kind)).toEqual(['word', 'csv']);

    for (const [, ctx] of captured) {
      expect(ctx).toBe(scopedCtx);
      expect(ctx.exportSourceManifest.pointsSeen).toBe(1);
      expect(ctx.exportSourceManifest.scenario.filters.dataExportInvolvementPolicy)
        .toBe(UA.filteredExportProvenance.POLICY);
      expect(ctx.exportSourceManifest.transformations[0].description)
        .toBe(UA.filteredExportProvenance.DESCRIPTION);
      expect(ctx.exportSourceManifest.transformations[0].parameters.filters.dataExportInvolvementPolicy)
        .toBe(UA.filteredExportProvenance.POLICY);
    }
  });

  test('does not mutate the generated manifest', () => {
    const mockWindow = { UA: {} };
    (function evaluate(window) { eval(source); })(mockWindow);
    const original = {
      scenario: { filters: { dataExportInvolvementPolicy: 'old' } },
      transformations: [{
        transformationId: 'filter-export-selection',
        description: 'old',
        parameters: { filters: { dataExportInvolvementPolicy: 'old' } },
      }],
    };
    const corrected = mockWindow.UA.filteredExportProvenance.correctManifest(original);

    expect(original.scenario.filters.dataExportInvolvementPolicy).toBe('old');
    expect(corrected.scenario.filters.dataExportInvolvementPolicy)
      .toBe(mockWindow.UA.filteredExportProvenance.POLICY);
  });
});
