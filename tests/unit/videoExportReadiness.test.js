'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('@playwright/test', () => ({ chromium: { launch: jest.fn() } }));

const {
  assertFreshExportContent,
  assertRuntimeContextAvailable,
  assertVideoAnalysisState,
  buildVideoWorkbenchUrl,
  clickAndWaitForDownload,
  countPalettePixels,
  expectedVideoState,
  selectRequiredCity,
  waitForFreshExportPreview,
  waitForRequestedContextState,
  waitForTiles,
} = require('../../server/video-export');

describe('video export semantic readiness', () => {
  afterEach(() => {
    delete window.UA;
    delete window._uaMap;
    document.body.innerHTML = '';
  });

  test('fails closed when the application map helper returns false', async () => {
    const page = {
      evaluate: jest.fn().mockResolvedValue({
        supported: true,
        ok: false,
        lifecycle: { status: 'rendering' },
      }),
      waitForFunction: jest.fn(),
      waitForTimeout: jest.fn(),
    };
    await expect(waitForTiles(page)).rejects.toThrow('Video map readiness returned false');
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  test('propagates a strict DOM fallback timeout when the helper is unavailable', async () => {
    const page = {
      evaluate: jest.fn().mockResolvedValue({ supported: false, ok: false }),
      waitForFunction: jest.fn().mockRejectedValue(new Error('no decoded tiles')),
      waitForTimeout: jest.fn(),
    };
    await expect(waitForTiles(page)).rejects.toThrow('no decoded tiles');
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  test('rejects an unknown requested city instead of selecting another city', async () => {
    const cityLocator = {
      evaluate: jest.fn().mockResolvedValue(null),
      selectOption: jest.fn(),
    };
    const page = { locator: jest.fn().mockReturnValue(cityLocator) };
    await expect(selectRequiredCity(page, 'Atlantis')).rejects.toThrow(/unknown_city.*Atlantis/);
    expect(cityLocator.selectOption).not.toHaveBeenCalled();
  });

  test('hydrates the canonical context state through the public workbench URL', () => {
    const state = expectedVideoState({
      ctxSlope: 'steep,very_steep',
      ctxTraffic: 'high,very_high',
      ctxOnlyMatched: '1',
      mapLayer: 'slope,traffic',
    }, 'Bonn');
    const url = new URL(buildVideoWorkbenchUrl(state));

    expect(url.pathname).toBe('/werkbank_v2.html');
    expect(url.searchParams.get('city')).toBe('Bonn');
    expect(url.searchParams.get('ctxSlope')).toBe('steep,very_steep');
    expect(url.searchParams.get('ctxTraffic')).toBe('high,very_high');
    expect(url.searchParams.get('ctxOnlyMatched')).toBe('1');
    expect(url.searchParams.get('mapLayer')).toBe('slope,traffic');
  });

  test('accepts only an exact, attached and non-empty URL-hydrated context state', async () => {
    const state = expectedVideoState({
      ctxSlope: 'steep', ctxTraffic: 'high', ctxOnlyMatched: '1',
      mapLayer: 'slope,traffic',
    }, 'Bonn');
    document.body.innerHTML = `
      <input data-context-overlay="slope" type="checkbox" checked>
      <input data-context-overlay="traffic" type="checkbox" checked>`;
    const map = { hasLayer: jest.fn().mockReturnValue(true) };
    window._uaMap = map;
    const runtimeContext = {
        map,
        contextFilters: {
          slopeClasses: new Set(['steep']),
          trafficClasses: new Set(['high']),
          onlyMatchedWays: true,
        },
        contextOverlays: {
          active: { slope: true, traffic: true },
          layers: {
            slope: { getLayers: () => [{}] },
            traffic: { getLayers: () => [{}, {}] },
          },
        },
      };
    window.UA = {
      getRuntimeContext: () => runtimeContext,
    };
    const page = {
      waitForFunction: jest.fn(async (callback, argument) => {
        if (!callback(argument)) throw new Error('not ready');
      }),
      evaluate: jest.fn(async callback => callback()),
    };

    await expect(waitForRequestedContextState(page, state)).resolves.toBeUndefined();
    expect(page.waitForFunction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        context: state.context,
        layers: { slope: true, traffic: true },
      }),
      { timeout: 60000 }
    );
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  test('fails immediately when the canonical runtime-context port is missing', async () => {
    window.UA = {};
    window._uaMap = {};
    const page = { evaluate: jest.fn(async callback => callback()) };

    await expect(assertRuntimeContextAvailable(page)).rejects.toThrow(
      /runtime_context_unavailable.*integration contract is unavailable/
    );
  });

  test('validates requested hours and the complete expected filter state', () => {
    const state = expectedVideoState({
      hourFrom: '8', hourTo: '17', involvementMode: 'and',
      selSouth: '50.73', selWest: '7.09', selNorth: '50.74', selEast: '7.10',
    }, 'Bonn');
    expect(state).toEqual(expect.objectContaining({
      schemaVersion: 1,
      city: 'Bonn',
      selection: { south: 50.73, west: 7.09, north: 50.74, east: 7.10 },
      viewport: null,
    }));
    expect(state.filters).toEqual(expect.objectContaining({
      hourFrom: 8, hourTo: 17, involvementMode: 'and',
    }));
    expect(() => expectedVideoState({ hourFrom: '18', hourTo: '7' }, 'Bonn'))
      .toThrow('invalid_hour_range');
    expect(() => expectedVideoState({ involvementMode: 'xor' }, 'Bonn'))
      .toThrow(/unsupported value xor/);
    expect(() => expectedVideoState({ selSouth: '50.73' }, 'Bonn'))
      .toThrow('incomplete_selection');
    expect(() => expectedVideoState({
      selSouth: '50.74', selWest: '7.09', selNorth: '50.73', selEast: '7.10',
    }, 'Bonn')).toThrow('invalid_selection');
    for (const partialView of [
      { centerLat: '50.73' },
      { centerLon: '7.09' },
      { zoom: '13' },
      { centerLat: '50.73', centerLon: '7.09' },
      { centerLat: '50.73', zoom: '13' },
      { centerLon: '7.09', zoom: '13' },
    ]) {
      expect(() => expectedVideoState(partialView, 'Bonn')).toThrow('incomplete_view');
    }
    expect(expectedVideoState({
      centerLat: '50.730000', centerLon: '7.090000', zoom: '13',
    }, 'Bonn').viewport).toEqual({ center: { lat: 50.73, lon: 7.09 }, zoom: 13 });
    expect(() => expectedVideoState({ severty: '2' }, 'Bonn')).toThrow(/unknown_parameter/);
  });

  test('rejects unknown fields at every canonical nesting level', () => {
    const base = expectedVideoState({}, 'Bonn');
    const mutations = [
      { ...base, typo: true },
      { ...base, filters: { ...base.filters, typo: true } },
      { ...base, filters: { ...base.filters, involvement: { ...base.filters.involvement, typo: true } } },
      { ...base, context: { ...base.context, typo: true } },
      { ...base, layers: { ...base.layers, typo: true } },
      { ...base, viewport: { center: { lat: 50.73, lon: 7.09 }, zoom: 13, typo: true } },
      { ...base, viewport: { center: { lat: 50.73, lon: 7.09, typo: true }, zoom: 13 } },
      { ...base, selection: { south: 50.7, west: 7.0, north: 50.8, east: 7.1, typo: true } },
    ];
    for (const mutated of mutations) {
      expect(() => expectedVideoState(mutated, 'Bonn')).toThrow(/unknown fields/);
    }
  });

  test('rejects a lifecycle/UI snapshot for the wrong city or filters', async () => {
    const expected = expectedVideoState({ hourFrom: '8', showHeatmap: '1' }, 'Bonn');
    const page = {
      evaluate: jest.fn().mockResolvedValue({
        state: {
          ...expected,
          city: 'Hannover',
          filters: { ...expected.filters, hourFrom: 9 },
          selection: null,
          viewport: null,
        },
        lifecycleCity: 'Hannover',
        selectedCity: 'Hannover',
        selection: null,
        lifecycle: { status: 'ready' },
        frameSemantics: { visibleLegendText: [], paletteCounts: {} },
      }),
    };
    await expect(assertVideoAnalysisState(page, expected)).rejects.toThrow(/city: expected Bonn, got Hannover/);
    await expect(assertVideoAnalysisState(page, expected)).rejects.toThrow(/filters:/);
  });

  test('rejects a different spatial selection than the requested bounds', async () => {
    const expected = expectedVideoState({
      selSouth: '50.730000', selWest: '7.090000', selNorth: '50.736000', selEast: '7.100000',
    }, 'Bonn');
    const page = {
      evaluate: jest.fn().mockResolvedValue({
        state: {
          ...expected,
          selection: { ...expected.selection, north: 50.740000 },
          viewport: null,
        },
        selectedCity: 'Bonn',
        lifecycleCity: 'Bonn',
        selection: { ...expected.selection, north: 50.740000 },
        lifecycle: { status: 'ready' },
        frameSemantics: { visibleLegendText: [], paletteCounts: {} },
      }),
    };
    await expect(assertVideoAnalysisState(page, expected)).rejects.toThrow(
      'selection.north: expected 50.736, got 50.74'
    );
  });

  test('fails closed on viewport, context-filter and layer mismatches', async () => {
    const expected = expectedVideoState({
      centerLat: '50.730000', centerLon: '7.090000', zoom: '13',
      ctxSlope: 'steep', mapLayer: 'slope', showHeatmap: '1',
    }, 'Bonn');
    const actualState = JSON.parse(JSON.stringify(expected));
    actualState.viewport.center.lat = 50.74;
    actualState.context.slopeClasses = ['flat'];
    actualState.layers.slope = false;
    const page = {
      evaluate: jest.fn().mockResolvedValue({
        state: actualState,
        selectedCity: 'Bonn',
        lifecycleCity: 'Bonn',
        lifecycle: { status: 'ready' },
        frameSemantics: {
          visibleLegendText: ['Straßensteigung'],
          paletteCounts: { slopePixels: 25, trafficPixels: 0 },
        },
      }),
    };
    await expect(assertVideoAnalysisState(page, expected)).rejects.toThrow(/viewport\.center\.lat/);
    await expect(assertVideoAnalysisState(page, expected)).rejects.toThrow(/context:/);
    await expect(assertVideoAnalysisState(page, expected)).rejects.toThrow(/layers:/);
  });

  test('requires attached, non-empty registry ownership for every context layer', async () => {
    const expected = expectedVideoState({ mapLayer: 'slope,traffic' }, 'Bonn');
    const page = {
      evaluate: jest.fn().mockResolvedValue({
        state: expected,
        selectedCity: 'Bonn',
        lifecycleCity: 'Bonn',
        lifecycle: { status: 'ready' },
        frameSemantics: {
          visibleLegendText: ['Straßensteigung', 'Verkehrsbelastung'],
          contextOwnership: {
            slope: {
              active: true, present: true, attached: true,
              childCount: 3, geometryCount: 3, matchingGeometryCount: 3,
            },
            traffic: {
              active: true, present: true, attached: true,
              childCount: 4, geometryCount: 4, matchingGeometryCount: 0,
            },
            layersDistinct: true,
          },
        },
      }),
    };
    await expect(assertVideoAnalysisState(page, expected)).rejects.toThrow(
      /layers\.traffic: registry ownership is not active, attached and non-empty/
    );
  });

  test('checks distinct owned witnesses instead of global context colors', () => {
    const state = expectedVideoState({ mapLayer: 'slope,traffic' }, 'Bonn');
    const width = 48;
    const height = 28;
    const frameEvidence = {
      sourceWidth: width,
      sourceHeight: height,
      accidentWitnesses: {
        cluster: {
          kind: 'cluster', clusterSize: 'small', x: 9, y: 13,
          radius: 2, ringRadius: 2, witnessColor: [255, 0, 255],
        },
      },
      contextWitnesses: {
        slope: {
          kind: 'slope', x: 32, y: 19, radius: 4, ringRadius: 4,
          roadRadius: 2, witnessColor: [0, 96, 255], expectedColor: '#f03b20',
          wayId: 'W1', lineWeight: 8, dashArray: '', sharedCompositeWay: true,
          counterpartWayPresent: true, counterpartExpectedColor: '#3a5a98',
          counterpartLineWeight: 3,
        },
        traffic: {
          kind: 'traffic', x: 32, y: 19, radius: 7, ringRadius: 7,
          roadRadius: 2, witnessColor: [255, 0, 128], expectedColor: '#3a5a98',
          wayId: 'W1', lineWeight: 3, dashArray: '10 6', sharedCompositeWay: true,
          counterpartWayPresent: true, counterpartExpectedColor: '#f03b20',
          counterpartLineWeight: 8,
        },
      },
    };
    const frame = Buffer.alloc(width * height * 4, 255);
    const setPixel = (target, x, y, [r, g, b]) => {
      const offset = (y * width + x) * 4;
      target[offset] = r; target[offset + 1] = g; target[offset + 2] = b; target[offset + 3] = 255;
    };
    for (let pixel = 0; pixel < 24; pixel++) {
      const offset = pixel * 4;
      frame[offset] = 0; frame[offset + 1] = 191; frame[offset + 2] = 165;
    }
    for (const point of [[8, 12], [9, 12]]) setPixel(frame, ...point, [255, 0, 255]);
    for (const point of [[7, 14], [8, 14]]) setPixel(frame, ...point, [181, 226, 140]);
    for (const point of [[10, 14], [11, 14]]) setPixel(frame, ...point, [110, 204, 57]);
    for (const point of [[29, 16], [30, 16]]) setPixel(frame, ...point, [0, 96, 255]);
    for (const point of [[35, 16], [36, 16]]) setPixel(frame, ...point, [255, 0, 128]);
    for (const point of [[30, 19], [34, 19]]) setPixel(frame, ...point, [240, 59, 32]);
    for (const point of [[32, 18], [32, 20]]) setPixel(frame, ...point, [58, 90, 152]);
    const decoded = Buffer.concat([frame, frame]);
    expect(countPalettePixels(decoded, width, height, state, frameEvidence)).toEqual(expect.objectContaining({
      frameCount: 2,
      maxMarkerPixels: expect.any(Number),
      maxSlopePixels: 2,
      maxTrafficPixels: 2,
      maxCompositeContextPairPixels: 2,
      maxSlopeWitnessPixels: 2,
      maxTrafficWitnessPixels: 2,
    }));

    // Mutation: both real context colours exist in the animation, but never
    // in the same decoded frame. Per-layer maxima therefore pass while the
    // composite road view is absent throughout the animation.
    const slopeFrame = Buffer.from(frame);
    const trafficFrame = Buffer.from(frame);
    for (const point of [[32, 18], [32, 20]]) setPixel(slopeFrame, ...point, [255, 255, 255]);
    for (const point of [[30, 19], [34, 19]]) setPixel(trafficFrame, ...point, [255, 255, 255]);
    expect(() => countPalettePixels(
      Buffer.concat([slopeFrame, trafficFrame]), width, height, state, frameEvidence
    )).toThrow('both real context-layer colours in the same frame and road corridor');
    const badgeOnlyFrame = Buffer.alloc(width * height * 4, 255);
    for (let pixel = 0; pixel < 24; pixel++) {
      const offset = pixel * 4;
      badgeOnlyFrame[offset] = 0;
      badgeOnlyFrame[offset + 1] = 191;
      badgeOnlyFrame[offset + 2] = 165;
    }
    expect(() => countPalettePixels(
      Buffer.concat([badgeOnlyFrame, badgeOnlyFrame]), width, height, state, frameEvidence
    )).toThrow(/cluster accident-layer witness/);

    const ringsOnlyFrame = Buffer.from(badgeOnlyFrame);
    for (const point of [[8, 12], [9, 12]]) setPixel(ringsOnlyFrame, ...point, [255, 0, 255]);
    for (const point of [[7, 14], [8, 14]]) setPixel(ringsOnlyFrame, ...point, [181, 226, 140]);
    for (const point of [[10, 14], [11, 14]]) setPixel(ringsOnlyFrame, ...point, [110, 204, 57]);
    for (const point of [[29, 16], [30, 16]]) setPixel(ringsOnlyFrame, ...point, [0, 96, 255]);
    for (const point of [[35, 16], [36, 16]]) setPixel(ringsOnlyFrame, ...point, [255, 0, 128]);
    expect(() => countPalettePixels(
      Buffer.concat([ringsOnlyFrame, ringsOnlyFrame]), width, height, state, frameEvidence
    )).toThrow('real slope road pixels from the owned geometry layer');

    // Mutation: the old tolerance treated slope [255,255,178] as traffic
    // [255,255,204].  Keep valid accident + slope witnesses, paint that slope
    // color inside the traffic region. Both helper rings remain present, but
    // the exact traffic-layer road color is absent.
    const slopeOnlyFrame = Buffer.from(badgeOnlyFrame);
    for (const point of [[8, 12], [9, 12]]) setPixel(slopeOnlyFrame, ...point, [255, 0, 255]);
    for (const point of [[7, 14], [8, 14]]) setPixel(slopeOnlyFrame, ...point, [181, 226, 140]);
    for (const point of [[10, 14], [11, 14]]) setPixel(slopeOnlyFrame, ...point, [110, 204, 57]);
    for (const point of [[29, 16], [30, 16]]) setPixel(slopeOnlyFrame, ...point, [0, 96, 255]);
    for (const point of [[35, 16], [36, 16]]) setPixel(slopeOnlyFrame, ...point, [255, 0, 128]);
    for (const point of [[30, 18], [31, 18], [32, 18], [33, 18], [34, 18]]) {
      setPixel(slopeOnlyFrame, ...point, [240, 59, 32]);
    }
    expect(() => countPalettePixels(
      Buffer.concat([slopeOnlyFrame, slopeOnlyFrame]), width, height, state, frameEvidence
    )).toThrow('real traffic road pixels from the owned geometry layer');

    const collidingEvidence = {
      ...frameEvidence,
      contextWitnesses: {
        ...frameEvidence.contextWitnesses,
        traffic: {
          ...frameEvidence.contextWitnesses.traffic,
          expectedColor: '#ffffcc',
          counterpartExpectedColor: '#ffffb2',
        },
      },
    };
    expect(() => countPalettePixels(decoded, width, height, state, collidingEvidence))
      .toThrow('Traffic road color overlaps the underlying slope-layer color tolerance');

    const noDashEvidence = {
      ...frameEvidence,
      contextWitnesses: {
        ...frameEvidence.contextWitnesses,
        traffic: { ...frameEvidence.contextWitnesses.traffic, dashArray: '' },
      },
    };
    expect(() => countPalettePixels(decoded, width, height, state, noDashEvidence))
      .toThrow('Traffic centreline must use a dash pattern');

    const narrowCasingEvidence = {
      ...frameEvidence,
      contextWitnesses: {
        ...frameEvidence.contextWitnesses,
        slope: { ...frameEvidence.contextWitnesses.slope, lineWeight: 5 },
      },
    };
    expect(() => countPalettePixels(decoded, width, height, state, narrowCasingEvidence))
      .toThrow('Slope casing must be at least three pixels wider');
  });

  test('requires a separate encoded heatmap witness when cluster and heatmap are requested', () => {
    const state = expectedVideoState({ showCluster: '1', showHeatmap: '1' }, 'Bonn');
    const width = 48;
    const height = 28;
    const frameEvidence = {
      sourceWidth: width,
      sourceHeight: height,
      accidentWitnesses: {
        cluster: {
          kind: 'cluster', clusterSize: 'small', x: 9, y: 13,
          radius: 2, ringRadius: 2, witnessColor: [255, 0, 255],
        },
        heatmap: {
          kind: 'heatmap', x: 34, y: 13,
          radius: 2, ringRadius: 2, witnessColor: [128, 0, 128],
          expectedColor: [255, 0, 0],
        },
      },
      contextWitnesses: {},
    };
    const frame = Buffer.alloc(width * height * 4, 255);
    const setPixel = (x, y, [r, g, b]) => {
      const offset = (y * width + x) * 4;
      frame[offset] = r; frame[offset + 1] = g; frame[offset + 2] = b; frame[offset + 3] = 255;
    };
    for (let pixel = 0; pixel < 24; pixel++) setPixel(pixel, 0, [0, 191, 165]);
    for (const point of [[8, 12], [9, 12]]) setPixel(...point, [255, 0, 255]);
    for (const point of [[7, 14], [8, 14]]) setPixel(...point, [181, 226, 140]);
    for (const point of [[10, 14], [11, 14]]) setPixel(...point, [110, 204, 57]);
    for (const point of [[33, 12], [34, 12]]) setPixel(...point, [128, 0, 128]);
    for (const point of [[33, 14], [34, 14]]) setPixel(...point, [255, 0, 0]);
    const decoded = Buffer.concat([frame, frame]);
    expect(countPalettePixels(decoded, width, height, state, frameEvidence)).toEqual(
      expect.objectContaining({ maxHeatmapWitnessPixels: expect.any(Number), maxHeatmapPixels: 2 })
    );

    const clusterOnlyEvidence = {
      ...frameEvidence,
      accidentWitnesses: { cluster: frameEvidence.accidentWitnesses.cluster },
    };
    expect(() => countPalettePixels(decoded, width, height, state, clusterOnlyEvidence))
      .toThrow(/separate accident heatmap-layer witness/);

    const noHeatPixelsFrame = Buffer.from(frame);
    for (const point of [[33, 14], [34, 14]]) {
      const offset = (point[1] * width + point[0]) * 4;
      noHeatPixelsFrame[offset] = 255;
      noHeatPixelsFrame[offset + 1] = 255;
      noHeatPixelsFrame[offset + 2] = 255;
    }
    expect(() => countPalettePixels(
      Buffer.concat([noHeatPixelsFrame, noHeatPixelsFrame]),
      width,
      height,
      state,
      frameEvidence
    )).toThrow('witnessed heatmap pixels');
  });

  test('reports an invalid decoded-frame size with the correct semantic error fields', () => {
    const state = expectedVideoState({}, 'Bonn');
    try {
      countPalettePixels(Buffer.alloc(3), 1, 1, state, {});
      throw new Error('expected countPalettePixels to reject malformed decoded bytes');
    } catch (error) {
      expect(error).toEqual(expect.objectContaining({
        code: 'encoded_frame_decode_invalid',
        details: null,
      }));
      expect(error.message).toContain('Decoded frame buffer has invalid size 3');
    }
  });

  test('observes a late download rejection when the PDF click fails', async () => {
    let rejectDownload;
    const order = [];
    const downloadPromise = new Promise((resolve, reject) => { rejectDownload = reject; });
    const clickError = new Error('PDF button detached');
    const page = {
      waitForEvent: jest.fn(() => {
        order.push('wait');
        return downloadPromise;
      }),
      locator: jest.fn(() => ({
        click: jest.fn(async () => {
          order.push('click');
          throw clickError;
        }),
      })),
    };

    await expect(clickAndWaitForDownload(page, '#btnExportPDF', 1234)).rejects.toBe(clickError);
    expect(order).toEqual(['wait', 'click']);
    expect(page.waitForEvent).toHaveBeenCalledWith('download', { timeout: 1234 });

    // This rejection occurs after the public operation already rejected. It
    // must still be observed and therefore must not fail Jest as unhandled.
    rejectDownload(new Error('page closed while waiting for download'));
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  test('requires city and a positive local accident count in the fresh preview', async () => {
    const page = { locator: jest.fn().mockReturnValue({ innerText: jest.fn() }) };
    page.locator().innerText.mockResolvedValue('Auswertung: lokal 19,248 Unfälle – Hannover');
    await expect(assertFreshExportContent(page, 'Hannover')).resolves.toEqual({ localAccidents: 19248 });
    page.locator().innerText.mockResolvedValue('Auswertung: lokal 7.387 Unfälle – Bonn');
    await expect(assertFreshExportContent(page, 'Bonn')).resolves.toEqual({ localAccidents: 7387 });
    page.locator().innerText.mockResolvedValue('Auswertung: lokal 0 Unfälle – Hannover');
    await expect(assertFreshExportContent(page, 'Hannover')).rejects.toThrow('non-empty local accident data');
  });

  test('accepts a fresh semantic HTML preview without requiring embedded images', async () => {
    document.body.innerHTML = `
      <div id="exportProgress">Fertig.</div>
      <div id="exportHtml"><h2>Report</h2><p>Auswertung: lokal 19,248 Unfälle – Hannover</p></div>`;
    const page = {
      waitForFunction: jest.fn(async (predicate, previousFingerprint) => {
        expect(predicate(previousFingerprint)).toBe(true);
      }),
    };
    await expect(waitForFreshExportPreview(page, {
      previousFingerprint: '34:stale', timeoutMs: 1000,
    })).resolves.toBeUndefined();
    expect(page.waitForFunction).toHaveBeenCalledWith(
      expect.any(Function), '34:stale', { timeout: 1000 }
    );
  });

  test('fails immediately when report generation exposes an error state', async () => {
    document.body.innerHTML = `
      <div id="exportProgress">Fehler.</div>
      <div id="exportHtml">Export fehlgeschlagen: map capture unavailable</div>`;
    const page = {
      waitForFunction: jest.fn(async (predicate, previousFingerprint) => {
        predicate(previousFingerprint);
      }),
    };
    await expect(waitForFreshExportPreview(page, { timeoutMs: 1000 }))
      .rejects.toThrow('Export preview failed');
  });

  test('uses the real range/hotspot controls and never swallows preview readiness', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../server/video-export.js'), 'utf8');
    expect(source).toContain("page.locator('#hFrom')");
    expect(source).toContain("page.locator('#hTo')");
    expect(source).toContain("page.locator('#toggleOnlyHot')");
    expect(source).not.toContain("page.locator('#hourFrom')");
    expect(source).not.toContain("page.locator('#hourTo')");
    expect(source).not.toContain("page.locator('#toggleHot')");
    expect(source).toContain('map.fire(window.L.Draw.Event.CREATED');
    expect(source).not.toContain('cx - 90');
    expect(source).not.toMatch(/waitForFreshExportPreview\([\s\S]{0,220}\.catch/);
    const fingerprintBlock = source.slice(
      source.indexOf('const beforeExportFingerprint'),
      source.indexOf("await page.locator('#btnOpenExport').click()")
    );
    expect(fingerprintBlock).not.toContain('.catch');
  });
});
