'use strict';

const fs = require('fs');
const path = require('path');
const contract = require('../../js/ua.video-export-contract.js');
const {
  parseVideoExportState,
  validateVideoExportState,
} = require('../../server/video-export-request.js');

describe('canonical video export request contract', () => {
  test('normalizes canonical and legacy requests to the same nested state', () => {
    const legacy = parseVideoExportState({
      city: 'Bonn', severity: '2', hourFrom: '7', hourTo: '18',
      includeCyclist: '1', includePedestrian: '0', ctxSlope: 'steep',
      ctxOnlyMatched: '1', showCluster: '0', showHeatmap: '1', mapLayer: 'slope',
      centerLat: '50.73', centerLon: '7.1', zoom: '14',
      selSouth: '50.72', selWest: '7.08', selNorth: '50.74', selEast: '7.12',
    });
    const canonical = parseVideoExportState({ state: JSON.parse(JSON.stringify(legacy)) });
    expect(legacy).toEqual(canonical);
  });

  test('returns stable 400 errors for invalid atomic view/selection before the worker', () => {
    const next = jest.fn();
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    validateVideoExportState({ body: { centerLat: '50.7' } }, response, next);
    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'incomplete_view',
      category: 'invalid_request',
      path: 'state.viewport',
    }));

    response.status.mockClear();
    response.json.mockClear();
    const invalidSelection = contract.fromLegacyParams({ city: 'Bonn' });
    invalidSelection.selection = { south: 2, west: 2, north: 1, east: 1 };
    validateVideoExportState({ body: { state: invalidSelection } }, response, next);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'invalid_selection' }));
  });

  test('rejects unknown canonical fields instead of silently dropping mutations', () => {
    const base = contract.fromLegacyParams({ city: 'Bonn' });
    for (const state of [
      { ...base, typo: 1 },
      { ...base, filters: { ...base.filters, typo: 1 } },
      { ...base, context: { ...base.context, typo: 1 } },
      { ...base, layers: { ...base.layers, typo: 1 } },
    ]) {
      expect(() => parseVideoExportState({ format: 'webp', state })).toThrow(/unknown_parameter/);
    }
    expect(() => parseVideoExportState({ state: base, severity: '1' })).toThrow(/unknown_parameter/);
    expect(() => contract.fromLegacyParams({ city: 'Bonn', severty: '2' })).toThrow(/unknown_parameter/);
  });

  test('requires an explicit, supported schema version and a complete canonical shape', () => {
    const base = contract.fromLegacyParams({ city: 'Bonn' });
    const withoutVersion = { ...base };
    delete withoutVersion.schemaVersion;
    expect(() => parseVideoExportState({ state: withoutVersion })).toThrow(/invalid_schema_version/);
    expect(() => parseVideoExportState({ state: { ...base, schemaVersion: 2 } }))
      .toThrow(/invalid_schema_version/);
    const withoutContext = { ...base };
    delete withoutContext.context;
    expect(() => parseVideoExportState({ state: withoutContext })).toThrow(/incomplete_state/);
    expect(() => parseVideoExportState({
      state: { ...base, filters: { ...base.filters, hourFrom: null } },
    })).toThrow(/incomplete_state/);
    expect(() => parseVideoExportState({
      state: { ...base, viewport: { center: { lat: 50.7, lon: 7.1 }, zoom: 13.5 } },
    })).toThrow(/invalid_number/);
  });

  test('rejects non-object bodies and deterministically empty OR involvement', () => {
    expect(() => parseVideoExportState([])).toThrow(/invalid_state/);
    expect(() => parseVideoExportState('city=Bonn')).toThrow(/invalid_state/);
    const state = contract.fromLegacyParams({ city: 'Bonn' });
    state.filters.involvement = {
      cyclist: false, pedestrian: false, car: false,
      motorcycle: false, gkfz: false, sonstig: false,
    };
    expect(() => parseVideoExportState({ state })).toThrow(/invalid_involvement/);
    state.filters.involvementMode = 'and';
    expect(parseVideoExportState({ state }).filters.involvementMode).toBe('and');
  });

  test('Express route orders contract validation before concurrency/browser work', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../server/index.js'), 'utf8');
    expect(source).toMatch(
      /app\.post\('\/api\/export-video',\s*videoExportRateLimit,\s*validateVideoExportFormat,\s*validateVideoExportState,\s*concurrencyGuard/
    );
  });
});

describe('video export browser request contract', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = `
      <div id="videoExportContainer" style="display:none">
        <button id="btnExportVideo">Video</button>
        <div id="videoExportProgress"></div>
        <input type="radio" name="videoExportFormat" value="webp" checked>
      </div>
      <select id="citySel"><option value="Bonn" selected>Bonn</option></select>
      <select id="severity"><option value="2" selected>2</option></select>
      <input id="incBike" type="checkbox" checked><input id="incPed" type="checkbox">
      <input id="incCar" type="checkbox" checked><input id="incMoto" type="checkbox">
      <input id="incGkfz" type="checkbox"><input id="incSon" type="checkbox">
      <input id="hFrom" value="7"><input id="hTo" value="18">
      <select id="dayType"><option value="weekday" selected>weekday</option></select>
      <select id="roadCondition"><option value="all" selected>all</option></select>
      <input id="maxPoints" value="100000"><input id="viewportPaddingPct" value="20">
      <input id="heatRadius" value="25"><input id="ctxOnlyMatched" type="checkbox" checked>
      <input data-ctx-slope="steep" type="checkbox" checked>
      <input data-ctx-traffic="high" type="checkbox" checked>
      <button id="modeOr" aria-pressed="false"></button>
      <button id="modeAnd" class="active" aria-pressed="true"></button>
      <button id="modeSolo" aria-pressed="false"></button>
      <button id="toggleCluster" aria-pressed="false"></button>
      <button id="toggleHeat" class="active" aria-pressed="true"></button>
      <button id="toggleOnlyHot" aria-pressed="false"></button>
      <input id="ctxOverlay_slope" data-context-overlay="slope" type="checkbox" checked>
      <input id="ctxOverlay_traffic" data-context-overlay="traffic" type="checkbox">`;
    window.UA = {
      videoExportContract: contract,
      ctx: {
        CITY_RAW: 'Hannover', involvementMode: 'or', showCluster: true,
        showHeatmap: false, showOnlyAboveAverage: true,
        contextFilters: {
          slopeClasses: new Set(['flat']), trafficClasses: new Set(['low']), onlyMatchedWays: false,
        },
        contextOverlays: { active: { slope: false, traffic: true } },
        map: { getCenter: () => ({ lat: 50.73, lng: 7.1 }), getZoom: () => 14 },
        selectionBounds: {
          getSouth: () => 50.72, getWest: () => 7.08,
          getNorth: () => 50.74, getEast: () => 7.12,
        },
      },
    };
    Object.defineProperty(window.URL, 'createObjectURL', { configurable: true, value: jest.fn(() => 'blob:test') });
    Object.defineProperty(window.URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
    jest.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete window.fetch;
  });

  test('intercepts the client POST and sends the complete canonical state', async () => {
    window.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ available: true }) })
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['animation']) });
    const source = fs.readFileSync(path.resolve(__dirname, '../../js/ua.video-export.js'), 'utf8');
    window.eval(source);
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await Promise.resolve();
    await Promise.resolve();

    document.getElementById('btnExportVideo').click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(window.fetch).toHaveBeenCalledTimes(2);
    const [url, init] = window.fetch.mock.calls[1];
    expect(url).toBe('/api/export-video');
    expect(init.method).toBe('POST');
    const payload = JSON.parse(init.body);
    expect(payload).toEqual({
      format: 'webp',
      state: expect.objectContaining({
        schemaVersion: 1,
        city: 'Bonn',
        filters: expect.objectContaining({
          severity: '2', involvementMode: 'and', hourFrom: 7, hourTo: 18,
          involvement: expect.objectContaining({ cyclist: true, pedestrian: false, car: true }),
        }),
        context: { slopeClasses: ['steep'], trafficClasses: ['high'], onlyMatchedWays: true },
        layers: { cluster: false, heatmap: true, onlyAboveAverage: false, slope: true, traffic: false },
        viewport: { center: { lat: 50.73, lon: 7.1 }, zoom: 14 },
        selection: { south: 50.72, west: 7.08, north: 50.74, east: 7.12 },
      }),
    });
  });
});
