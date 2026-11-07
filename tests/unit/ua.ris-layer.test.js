'use strict';

const fs = require('fs');
const path = require('path');
const L = require('leaflet');

const validUrl = 'https://www.bonn.sitzung-online.de/akten/1';
const records = [
  { id: 'A', title: 'Querung am <img src=x onerror=alert(1)>', number: '1', gremium: 'Verkehrsausschuss', url: validUrl, source: 'bonn-oparl' },
  { id: 'B', title: 'Antwort zur Querung', number: '1 F1', relatedTo: 'A', url: 'javascript:alert(1)', source: 'bonn-oparl' },
  { id: 'C', title: 'Weiterer Beschluss', number: '2', relatedTo: 'A', url: `${validUrl}/2`, source: 'bonn-oparl' },
  { id: 'D', title: 'Ergänzung ohne Geometrie', number: '1 F2', relatedTo: 'A', url: `${validUrl}/3`, source: 'bonn-oparl' },
];

function feature(recordId, accuracy, type, coordinates) {
  return { type: 'Feature', properties: { recordId, accuracy, label: '<em>Schulweg</em>' }, geometry: { type, coordinates } };
}

const point = feature('A', 'official', 'Point', [7.1, 50.7]);
const line = feature('B', 'derived', 'LineString', [[7, 50.7], [7.2, 50.7]]);
const polygon = feature('C', 'official', 'Polygon', [
  [[7, 50.6], [7.2, 50.6], [7.2, 50.8], [7, 50.8], [7, 50.6]],
  [[7.08, 50.68], [7.08, 50.72], [7.12, 50.72], [7.12, 50.68], [7.08, 50.68]],
]);

function snapshot(features, entries = records) {
  return {
    manifest: { generatedAt: new Date().toISOString(), coverage: { complete: true, bodies: ['Rat'], warnings: [] } },
    records: entries,
    features: { type: 'FeatureCollection', features },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function flush() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function checkbox(label) {
  return [...document.querySelectorAll('.context-overlay-control label')]
    .find(element => element.textContent.trim() === label).querySelector('input');
}

function risFeatures(map) {
  const features = [];
  map.eachLayer(layer => { if (layer.feature) features.push(layer); });
  return features;
}

function risRecordIds(map) {
  return risFeatures(map).flatMap(layer => layer.feature.properties.locations.map(location => location.recordId));
}

function loadScript(name) {
  (function (window, L) {
    eval(fs.readFileSync(path.resolve(__dirname, `../../js/${name}`), 'utf8'));
  })(window, L);
}

describe('Ratsvorgänge in the V2 map', () => {
  let ctx;
  let UA;
  const svg = L.Browser.svg;

  beforeEach(() => {
    document.body.innerHTML = '<div id="map"></div>';
    Object.defineProperties(document.getElementById('map'), {
      clientWidth: { value: 800 }, clientHeight: { value: 600 },
    });
    L.Browser.svg = true; // jsdom provides SVG elements but not the Leaflet capability probe.
    window.L = L;
    UA = window.UA = { PoliticalContext: { addReferences: jest.fn().mockResolvedValue(1) } };
    loadScript('ua.ris-catalogue.js');
    UA.RisCatalogue.loadMap = jest.fn();
    loadScript('ua.ris-layer.js');
    loadScript('ua.map_v2.js');
    ctx = {
      map: L.map('map', { zoomControl: false, attributionControl: false, fadeAnimation: false }).setView([50.7, 7.1], 13),
      CITY_RAW: 'Bonn', selectionBounds: null, ui: { statEl: document.createElement('div') },
    };
  });

  afterEach(() => {
    ctx.map.remove();
    jest.useRealTimers();
    L.Browser.svg = svg;
    delete window.UA;
    delete window.L;
  });

  test('opt-in renders separately, opens safe linked popups, and adopts a single selected document', async () => {
    const accidents = L.layerGroup([L.circleMarker([50.72, 7.09])]).addTo(ctx.map);
    UA.RisCatalogue.loadMap.mockResolvedValue(snapshot([point, line, polygon]));
    UA.refreshContextOverlays(ctx);

    expect(document.querySelector('.context-overlay-control')).not.toBeNull();
    expect(checkbox('Ratsvorgänge').checked).toBe(false);
    expect(UA.RisCatalogue.loadMap).not.toHaveBeenCalled();
    checkbox('Ratsvorgänge').click();
    expect(document.querySelector('[role="status"]').textContent).toMatch(/geladen/);
    await flush();

    expect(UA.RisCatalogue.loadMap).toHaveBeenCalledWith('Bonn');
    const [marker, path, area] = risFeatures(ctx.map);
    expect([marker, path, area].map(layer => layer.feature.geometry.type)).toEqual(['Point', 'LineString', 'Polygon']);
    expect(path.options.pane).toBe(marker.options.pane);
    expect(path.options.pane).not.toBe('overlayPane');
    expect(path.options.dashArray).toBeTruthy();
    expect(area.options.dashArray).toBeFalsy();
    expect(path.getElement().getAttribute('tabindex')).toBe('0');

    path.getElement().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const popup = document.querySelector('.leaflet-popup');
    expect(popup.textContent).toContain('Antwort zur Querung');
    expect(popup.textContent).toContain('Verknüpfte Vorgänge');
    expect(popup.textContent).toContain('Weiterer Beschluss');
    expect(popup.textContent).toContain('Ergänzung ohne Geometrie');
    expect(popup.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(popup.textContent).toContain('<em>Schulweg</em>');
    expect(popup.textContent).toContain('Abgeleitete Lage');
    expect(popup.querySelector('img, em')).toBeNull();
    expect([...popup.querySelectorAll('a[target="_blank"]')].map(a => a.href)).toEqual([validUrl, `${validUrl}/2`, `${validUrl}/3`]);
    expect(popup.querySelector('a[target="_blank"]').rel).toContain('noopener');
    popup.querySelector('button').click();
    expect(UA.PoliticalContext.addReferences).toHaveBeenCalledWith(ctx, [records[0]]);
    await flush();
    expect(popup.querySelector('[role="status"]').textContent).toMatch(/übernommen/i);
    marker.getElement().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.leaflet-popup').textContent).toContain('Amtlich verortet');

    checkbox('Ratsvorgänge').focus();
    UA.refreshContextOverlays(ctx);
    expect(document.querySelectorAll('.context-overlay-control')).toHaveLength(1);
    expect(document.activeElement).toBe(checkbox('Ratsvorgänge'));
    expect(checkbox('Ratsvorgänge').checked).toBe(true);
    checkbox('Ratsvorgänge').click();
    expect(risFeatures(ctx.map)).toHaveLength(0);
    expect(ctx.map.hasLayer(accidents)).toBe(true);
    checkbox('Ratsvorgänge').click();
    await flush();
    expect(UA.RisCatalogue.loadMap).toHaveBeenCalledTimes(1);
    expect(risFeatures(ctx.map)).toHaveLength(3);
  });

  test('reports rejected adoption and reloads the map when reopened after a catalogue change', async () => {
    const rejection = Promise.reject(Object.assign(new Error('Bitte die Recherche erneut öffnen.'), {
      code: 'RIS_SNAPSHOT_REFERENCE_MISMATCH',
    }));
    rejection.catch(() => {});
    UA.PoliticalContext.addReferences.mockReturnValue(rejection);
    UA.RisCatalogue.loadMap.mockResolvedValue(snapshot([point]));
    UA.refreshContextOverlays(ctx);
    checkbox('Ratsvorgänge').click();
    await flush();

    risFeatures(ctx.map)[0].openPopup();
    const popup = document.querySelector('.leaflet-popup');
    popup.querySelector('button').click();
    await flush();

    const status = document.querySelector('.context-overlay-control [role="status"]');
    expect(status.textContent).toContain('Kartenlayer aus- und wieder einschalten');
    expect(risFeatures(ctx.map)).toHaveLength(0);

    checkbox('Ratsvorgänge').click();
    checkbox('Ratsvorgänge').click();
    await flush();
    expect(UA.RisCatalogue.loadMap).toHaveBeenCalledTimes(2);
  });

  test('does not confirm adoption after the city changes while it is pending', async () => {
    const pending = deferred();
    UA.PoliticalContext.addReferences.mockReturnValue(pending.promise);
    UA.RisCatalogue.loadMap.mockResolvedValue(snapshot([point]));
    UA.refreshContextOverlays(ctx);
    checkbox('Ratsvorgänge').click();
    await flush();

    risFeatures(ctx.map)[0].openPopup();
    const popup = document.querySelector('.leaflet-popup');
    const status = popup.querySelector('[role="status"]');
    popup.querySelector('button').click();
    expect(status.textContent).not.toMatch(/übernommen/i);

    ctx.CITY_RAW = 'Hannover';
    UA.renderLayers(ctx);
    pending.resolve(1);
    await flush();

    expect(status.textContent).not.toMatch(/übernommen/i);
  });

  test.each(['derived', 'official'])('one street path exposes unrelated proceedings on identical geometry (%s)', async accuracy => {
    const second = { id: 'E', title: 'Beleuchtung der Straße', url: `${validUrl}/4`, source: 'bonn-oparl' };
    const relative = { id: 'F', title: 'Antwort zur Beleuchtung', relatedTo: 'E', url: `${validUrl}/5`, source: 'bonn-oparl' };
    const coincident = feature('E', accuracy, 'LineString', [[7, 50.7], [7.2, 50.7]]);
    UA.RisCatalogue.loadMap.mockResolvedValue(snapshot([line, coincident], [...records, second, relative]));
    ctx.selectionBounds = L.latLngBounds([50.69, 7.09], [50.71, 7.11]);
    UA.refreshContextOverlays(ctx);
    checkbox('Ratsvorgänge').click();
    await flush();
    checkbox('Nur in markierter Fläche').click();

    const status = document.querySelector('.context-overlay-control [role="status"]');
    expect(status.textContent).toBe('2 verortete Ratsvorgänge in der Markierung · 2 im Kartenausschnitt');
    expect(risFeatures(ctx.map)).toHaveLength(1);
    const [street] = risFeatures(ctx.map);
    street.getElement().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const popup = document.querySelector('.leaflet-popup');
    expect([...popup.querySelectorAll('strong')].map(el => el.textContent)).toEqual([
      'Antwort zur Querung', 'Beleuchtung der Straße', records[0].title, 'Antwort zur Beleuchtung',
      'Weiterer Beschluss', 'Ergänzung ohne Geometrie',
    ]);
    expect(popup.textContent).toContain('Abgeleitete Lage');
    const mixedLegend = [...document.querySelectorAll('.context-overlay-control div')]
      .find(el => el.textContent.trim() === 'Amtliche und abgeleitete Lage');
    expect(mixedLegend.hidden).toBe(accuracy !== 'official');
    if (accuracy === 'official') expect(popup.textContent).toContain('Amtlich verortet');
    popup.querySelector('button[aria-label="Beleuchtung der Straße für Bericht übernehmen"]').click();
    expect(UA.PoliticalContext.addReferences).toHaveBeenCalledTimes(1);
    expect(UA.PoliticalContext.addReferences).toHaveBeenCalledWith(ctx, [second]);

    ctx.selectionBounds = L.latLngBounds([50.73, 7.09], [50.74, 7.11]);
    UA.renderLayers(ctx);
    expect(risFeatures(ctx.map)).toHaveLength(0);
    expect(status.textContent).toBe('Keine Ratsvorgänge in der Markierung.');
  });

  test('pans load only intersecting geometry without closing a popup that stays in view', async () => {
    const remote = feature('C', 'official', 'Point', [7.45, 50.94]);
    UA.RisCatalogue.loadMap.mockResolvedValue(snapshot([point, remote]));
    UA.refreshContextOverlays(ctx);
    checkbox('Ratsvorgänge').click();
    await flush();

    const status = document.querySelector('.context-overlay-control [role="status"]');
    expect(risRecordIds(ctx.map)).toEqual(['A']);
    expect(status.textContent).toBe('2 verortete Ratsvorgänge · 1 im Kartenausschnitt');
    const [nearby] = risFeatures(ctx.map);
    nearby.getElement().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(nearby.isPopupOpen()).toBe(true);

    ctx.map.panBy([30, 10], { animate: false });
    expect(risFeatures(ctx.map)[0]).toBe(nearby);
    expect(nearby.isPopupOpen()).toBe(true);

    ctx.map.setView([50.82, 7.28], 13, { animate: false });
    expect(risFeatures(ctx.map)).toHaveLength(0);
    expect(status.textContent).toBe('2 verortete Ratsvorgänge · 0 im Kartenausschnitt');
    expect(nearby.isPopupOpen()).toBe(false);

    ctx.map.setView([50.94, 7.45], 13, { animate: false });
    expect(risRecordIds(ctx.map)).toEqual(['C']);
    expect(UA.RisCatalogue.loadMap).toHaveBeenCalledTimes(1);

    checkbox('Ratsvorgänge').click();
    ctx.map.setView([50.7, 7.1], 13, { animate: false });
    expect(risFeatures(ctx.map)).toHaveLength(0);
  });

  test('an optional area filter includes crossing lines but excludes a polygon whose hole contains the marked area', async () => {
    UA.RisCatalogue.loadMap.mockResolvedValue(snapshot([point, line, polygon]));
    UA.refreshContextOverlays(ctx);
    ctx.selectionBounds = L.latLngBounds([50.69, 7.09], [50.71, 7.11]);
    UA.renderLayers(ctx);
    checkbox('Ratsvorgänge').click();
    await flush();

    expect(risFeatures(ctx.map)).toHaveLength(3);
    checkbox('Nur in markierter Fläche').click();
    expect(risRecordIds(ctx.map)).toEqual(['A', 'B']);

    ctx.selectionBounds = L.latLngBounds([50.73, 7.09], [50.74, 7.11]);
    UA.renderLayers(ctx);
    expect(risRecordIds(ctx.map)).toEqual(['C']);

    ctx.selectionBounds = null;
    UA.renderLayers(ctx);
    expect(checkbox('Nur in markierter Fläche').checked).toBe(false);
    expect(checkbox('Nur in markierter Fläche').disabled).toBe(true);
    expect(window.getComputedStyle(checkbox('Nur in markierter Fläche').parentElement).display).toBe('none');
    expect(risFeatures(ctx.map)).toHaveLength(3);
  });

  test('rapid toggles share a pending fetch and a late result from the old city cannot update the new city', async () => {
    const bonn = deferred();
    const hannover = deferred();
    UA.RisCatalogue.loadMap.mockImplementation(city => city === 'Bonn' ? bonn.promise : hannover.promise);
    UA.refreshContextOverlays(ctx);
    checkbox('Ratsvorgänge').click();
    checkbox('Ratsvorgänge').click();
    checkbox('Ratsvorgänge').click();
    await flush();
    expect(UA.RisCatalogue.loadMap.mock.calls).toEqual([['Bonn']]);

    ctx.CITY_RAW = 'Hannover';
    UA.renderLayers(ctx);
    expect(checkbox('Ratsvorgänge').checked).toBe(false);
    expect(UA.RisCatalogue.loadMap).toHaveBeenCalledTimes(1);
    checkbox('Ratsvorgänge').click();
    hannover.resolve(snapshot([line]));
    await flush();
    bonn.resolve(snapshot([point, polygon]));
    await flush();
    expect(risRecordIds(ctx.map)).toEqual(['B']);

    ctx.CITY_RAW = 'Bonn';
    UA.renderLayers(ctx);
    expect(risFeatures(ctx.map)).toHaveLength(0);
    expect(checkbox('Ratsvorgänge').checked).toBe(false);
    checkbox('Ratsvorgänge').click();
    checkbox('Ratsvorgänge').click();
    await flush();
    expect(risFeatures(ctx.map)).toHaveLength(0);
  });

  test('marks a formerly current catalogue as stale without a viewport change', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-11-01T10:00:00Z') });
    UA.RisCatalogue.loadMap.mockResolvedValue(snapshot([point]));
    UA.refreshContextOverlays(ctx);
    checkbox('Ratsvorgänge').click();
    await jest.advanceTimersByTimeAsync(0);
    const status = document.querySelector('.context-overlay-control [role="status"]');
    const details = document.querySelector('.context-overlay-control details');
    expect(status.textContent).not.toMatch(/veraltet|teilbestand/i);

    jest.setSystemTime(new Date('2026-11-09T10:00:01Z'));
    UA.RisLayer.refresh(ctx);

    expect(status.textContent).toMatch(/veraltet/i);
    expect(details.querySelector('summary').textContent).toMatch(/teilbestand/i);
    expect(details.textContent).toMatch(/älter als acht Tage/i);
    expect(risRecordIds(ctx.map)).toEqual(['A']);
  });

  test('removes a retained fallback at expiry even while the map sits idle', async () => {
    const expiresAt = '2026-09-08T10:00:00Z';
    const warning = 'Die letzte Aktualisierung des Ratsdatenstands ist fehlgeschlagen.';
    jest.useFakeTimers({ now: Date.parse('2026-09-01T10:00:00Z') });
    const bundle = snapshot([point]);
    bundle.manifest.generatedAt = '2026-08-25T10:00:00Z';
    bundle.manifest.refreshFailure = { attemptedAt: '2026-09-01T09:00:00Z', reason: warning, expiresAt };
    UA.RisCatalogue.loadMap.mockResolvedValue(bundle);
    UA.refreshContextOverlays(ctx);
    checkbox('Ratsvorgänge').click();
    await jest.advanceTimersByTimeAsync(0);

    const status = document.querySelector('.context-overlay-control [role="status"]');
    const details = document.querySelector('.context-overlay-control details');
    expect(risRecordIds(ctx.map)).toEqual(['A']);
    expect(status.textContent).toMatch(/aktualisierung fehlgeschlagen/i);
    expect(status.textContent).toMatch(/teilbestand/i);
    expect(status.textContent).not.toMatch(/veraltet/i);
    expect(details.textContent).toContain(warning);

    await jest.advanceTimersByTimeAsync(Date.parse(expiresAt) - Date.now());

    expect(risRecordIds(ctx.map)).toEqual([]);
    expect(status.textContent).toMatch(/abgelaufen/i);
  });

  test('expires an idle map even when the last update never published a warning', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-11-14T09:59:59Z') });
    const bundle = snapshot([point]);
    bundle.manifest.generatedAt = '2026-10-31T10:00:00Z';
    UA.RisCatalogue.loadMap.mockResolvedValue(bundle);
    UA.refreshContextOverlays(ctx);
    checkbox('Ratsvorgänge').click();
    await jest.advanceTimersByTimeAsync(0);
    expect(risRecordIds(ctx.map)).toEqual(['A']);
    await jest.advanceTimersByTimeAsync(1000);
    expect(risRecordIds(ctx.map)).toEqual([]);
  });

  test('distinguishes an absent catalogue, an invalid snapshot, and a catalogue without located records', async () => {
    UA.RisCatalogue.loadMap
      .mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'RIS_SNAPSHOT_UNAVAILABLE' }))
      .mockRejectedValueOnce(Object.assign(new Error('bad digest'), { code: 'RIS_SNAPSHOT_INVALID' }))
      .mockRejectedValueOnce(Object.assign(new Error('Der letzte geprüfte Ratsdatenstand ist abgelaufen.'), { code: 'RIS_SNAPSHOT_EXPIRED' }))
      .mockResolvedValueOnce(snapshot([]));
    UA.refreshContextOverlays(ctx);
    const button = checkbox('Ratsvorgänge');
    const status = document.querySelector('[role="status"]');

    button.click();
    await flush();
    expect(status.textContent).toMatch(/kein Kartenbestand/i);
    button.click();
    button.click();
    await flush();
    expect(status.textContent).toMatch(/konnte nicht geladen werden/i);
    button.click();
    button.click();
    await flush();
    expect(status.textContent).toMatch(/abgelaufen/i);
    button.click();
    button.click();
    await flush();
    expect(status.textContent).toMatch(/keine verorteten Ratsvorgänge/i);
  });
});
