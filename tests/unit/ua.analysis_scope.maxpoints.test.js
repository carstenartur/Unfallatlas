const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '../../js/ua.analysis_scope.js'), 'utf8');

function bounds(south, west, north, east) {
  return {
    getSouth: () => south,
    getWest: () => west,
    getNorth: () => north,
    getEast: () => east,
  };
}

function point(id, lat, lon) {
  return {
    id, lat, lon,
    props: {
      istrad: '1', istpkw: '1', istfuss: '0', istkrad: '0',
      istgkfz: '0', istsonstig: '0',
    },
  };
}

test('maxPoints does not make a contained selection larger than the visible count', () => {
  jest.useFakeTimers();
  const mockWindow = { UA: {} };
  const UA = mockWindow.UA;
  UA.maskFromProps = () => 5;
  UA.matchesNonInvolvementFilters = () => true;
  UA.matchesInvolvementFilter = () => true;
  UA.updateStats = ctx => { ctx.ui.statEl.textContent = 'legacy'; };
  (function evaluate(window) { eval(source); })(mockWindow);

  const visible = point('visible', 5, 5);
  const selected = point('selected-but-not-rendered', 3, 3);
  const ctx = {
    CITY_RAW: 'Bonn',
    allPts: [visible, selected],
    filteredAll: [visible, selected],
    // Simulate an aggressive render cap that retained only the first point.
    filteredCapped: [visible],
    viewportPts: [visible],
    selectionBounds: bounds(2, 2, 4, 4),
    map: { getBounds: () => bounds(0, 0, 10, 10) },
    involvementMode: 'and',
    ui: {
      incBikeEl: { checked: true }, incPedEl: { checked: false },
      incCarEl: { checked: true }, incMotoEl: { checked: false },
      incGkfzEl: { checked: false }, incSonEl: { checked: false },
      maxPointsEl: { value: '500' },
      statEl: { textContent: '', title: '' },
    },
  };

  const scope = UA.AnalysisScope.refreshScopePoints(ctx);
  UA.updateStats(ctx);

  expect(scope.visible.map(p => p.id)).toEqual(['visible', 'selected-but-not-rendered']);
  expect(scope.selected.map(p => p.id)).toEqual(['selected-but-not-rendered']);
  expect(scope.selected.length).toBeLessThanOrEqual(scope.visible.length);
  expect(ctx.ui.statEl.textContent).toContain('Darstellung begrenzt auf 1');
  expect(ctx.ui.statEl.textContent).toContain('sichtbar: 2');

  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});
