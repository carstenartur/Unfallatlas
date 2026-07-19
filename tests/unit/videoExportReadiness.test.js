'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('@playwright/test', () => ({ chromium: { launch: jest.fn() } }));

const {
  assertFreshExportContent,
  assertVideoAnalysisState,
  expectedVideoState,
  selectRequiredCity,
  waitForFreshExportPreview,
  waitForTiles,
} = require('../../server/video-export');

describe('video export semantic readiness', () => {
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
    await expect(selectRequiredCity(page, 'Atlantis')).rejects.toThrow('unknown_city:Atlantis');
    expect(cityLocator.selectOption).not.toHaveBeenCalled();
  });

  test('validates requested hours and the complete expected filter state', () => {
    expect(expectedVideoState({
      hourFrom: '8', hourTo: '17', involvementMode: 'and',
      selSouth: '50.73', selWest: '7.09', selNorth: '50.74', selEast: '7.10',
    }, 'Bonn')).toEqual(expect.objectContaining({
      city: 'Bonn', hourFrom: 8, hourTo: 17, involvementMode: 'and',
      selection: { south: 50.73, west: 7.09, north: 50.74, east: 7.10 },
      view: null,
    }));
    expect(() => expectedVideoState({ hourFrom: '18', hourTo: '7' }, 'Bonn'))
      .toThrow('invalid_hour_range');
    expect(() => expectedVideoState({ involvementMode: 'xor' }, 'Bonn'))
      .toThrow('invalid_involvementMode');
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
    }, 'Bonn').view).toEqual({ lat: 50.73, lon: 7.09, zoom: 13 });
  });

  test('rejects a lifecycle/UI snapshot for the wrong city or filters', async () => {
    const expected = expectedVideoState({ hourFrom: '8', showHeatmap: '1' }, 'Bonn');
    const page = {
      evaluate: jest.fn().mockResolvedValue({
        ...expected,
        city: 'Hannover',
        selectedCity: 'Hannover',
        hourFrom: 9,
        selection: null,
        view: null,
        lifecycle: { status: 'ready' },
      }),
    };
    await expect(assertVideoAnalysisState(page, expected)).rejects.toThrow(/city: expected Bonn, got Hannover/);
    await expect(assertVideoAnalysisState(page, expected)).rejects.toThrow(/hourFrom: expected 8, got 9/);
  });

  test('rejects a different spatial selection than the requested bounds', async () => {
    const expected = expectedVideoState({
      selSouth: '50.730000', selWest: '7.090000', selNorth: '50.736000', selEast: '7.100000',
    }, 'Bonn');
    const page = {
      evaluate: jest.fn().mockResolvedValue({
        ...expected,
        selectedCity: 'Bonn',
        selection: { ...expected.selection, north: 50.740000 },
        view: null,
        lifecycle: { status: 'ready' },
      }),
    };
    await expect(assertVideoAnalysisState(page, expected)).rejects.toThrow(
      'selection.north: expected 50.736, got 50.74'
    );
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
  });
});
