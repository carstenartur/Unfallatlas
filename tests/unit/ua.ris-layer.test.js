'use strict';

const fs = require('fs');
const path = require('path');
const { ReadableStream } = require('node:stream/web');
const L = require('leaflet');
const { createCatalogue } = require('../../js/ua.ris-catalogue.js');

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

function searchableLocations() {
  const provenance = { city: 'bonn', sha256: 'a'.repeat(64), mapSha256: 'b'.repeat(64) };
  const entry = { ...records[0], type: 'Antrag', date: null, snapshot: provenance, locations: [{
    label: 'Endenicher Straße', kind: 'street', mapped: true,
    evidence: { source: 'title', text: 'Maßnahmen in der Endenicher Straße' },
  }, {
    label: 'Beueler Straße / Gartenstraße', kind: 'junction', mapped: true,
    evidence: { source: 'document', text: 'Kreuzung Beueler Straße / Gartenstraße' },
  }, {
    label: 'Spielplatz', kind: 'place', mapped: false,
    evidence: { source: 'document', text: 'am Spielplatz' },
  }] };
  const near = feature('A', 'derived', 'Point', [7.1, 50.7]);
  near.properties.locationIndex = 0;
  const far = feature('A', 'derived', 'Point', [7.45, 50.94]);
  far.properties.locationIndex = 1;
  const bundle = snapshot([near, far], [entry]);
  bundle.manifest.city = 'bonn';
  bundle.manifest.records = { sha256: provenance.sha256 };
  bundle.manifest.map = { sha256: provenance.mapSha256 };
  return { entry, bundle };
}

async function openSearch(ctx, reference, meta = {}) {
  loadScript('ua.utils.js');
  document.body.insertAdjacentHTML('beforeend', '<button id="btnPolCtxOpen">Recherche</button>'
    + '<div id="polCtxPanel" aria-hidden="true" style="display:none">'
    + '<button id="polCtxBtnClose">Schließen</button><input id="polCtxSearchInput" value="Endenicher Straße">'
    + '<div id="polCtxStatus" role="status"></div><div id="polCtxResults"></div></div>');
  window.UA.PoliticalContext.search = async () => ({
    references: [reference], meta: { supported: true, searchStatus: 'results-found', ...meta }
  });
  await window.UA.PoliticalContext.openPanel(ctx);
  await window.UA.PoliticalContext._runSearch(ctx);
  return document.getElementById('polCtxPanel');
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
    UA = window.UA = {};
    loadScript('ua.political-context.js');
    UA.PoliticalContext.addReferences = jest.fn().mockResolvedValue(1);
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
    UA._activeModalController?.close({ restoreFocus: false });
    ctx.map.remove();
    jest.useRealTimers();
    L.Browser.svg = svg;
    delete window.UA;
    delete window.L;
  });

  function mountPanelFooter() {
    const html = fs.readFileSync(path.resolve(__dirname, '../../werkbank_v2.html'), 'utf8');
    const page = new DOMParser().parseFromString(html, 'text/html');
    document.body.append(page.getElementById('panel'));
    loadScript('ua.ui.js');
    UA.bindDom(ctx);
    ctx.ui.statEl.textContent = 'Sichtbar: 34 Unfälle';
  }

  test('the panel footer shows published and mapped record counts with the map layer off', async () => {
    mountPanelFooter();
    const manifest = deferred();
    UA.RisCatalogue.loadManifest = jest.fn().mockReturnValue(manifest.promise);
    UA.refreshContextOverlays(ctx);
    const footer = document.querySelector('#panelBody #risCatalogueCount');
    expect(footer).not.toBeNull();
    expect(footer.hidden).toBe(false);
    expect(footer.textContent).toMatch(/wird geladen/i);
    expect(footer.previousElementSibling).toBe(ctx.ui.statEl);

    manifest.resolve({ schemaVersion: 2, generatedAt: new Date().toISOString(),
      recordCount: 1234, mappedRecordCount: 0, geometryCount: 0, coverage: { complete: false, warnings: [] } });
    await flush();

    expect(footer.textContent).toMatch(/Katalog.*1\.234.*0 verortet.*Teilbestand/);
    expect(ctx.ui.statEl.textContent).toBe('Sichtbar: 34 Unfälle');
    expect(checkbox('Ratsvorgänge').checked).toBe(false);
    expect(UA.RisCatalogue.loadMap).not.toHaveBeenCalled();
  });

  test('the footer drops a late result from the previous city and distinguishes unavailable counts from zero', async () => {
    mountPanelFooter();
    const bonn = deferred();
    UA.RisCatalogue.loadManifest = jest.fn()
      .mockReturnValueOnce(bonn.promise)
      .mockRejectedValueOnce({ code: 'RIS_SNAPSHOT_UNAVAILABLE' });
    UA.refreshContextOverlays(ctx);
    ctx.CITY_RAW = 'Hannover';
    UA.RisLayer.refresh(ctx);
    const footer = document.getElementById('risCatalogueCount');
    expect(footer?.textContent).toMatch(/wird geladen/i);
    await flush();
    expect(footer.textContent).toMatch(/kein veröffentlichter Ratsdatenbestand/i);

    bonn.resolve({ schemaVersion: 2, generatedAt: new Date().toISOString(),
      recordCount: 99, mappedRecordCount: 12, coverage: { complete: true, warnings: [] } });
    await flush();

    expect(footer.textContent).toMatch(/kein veröffentlichter Ratsdatenbestand/i);
    expect(footer.textContent).not.toMatch(/99|\b0\b/);
  });

  test('a retained legacy count is marked stale and disappears when its snapshot expires', async () => {
    jest.useFakeTimers();
    mountPanelFooter();
    const day = 24 * 60 * 60 * 1000;
    const generatedAt = new Date(Date.now() - 13 * day).toISOString();
    UA.RisCatalogue.loadManifest = jest.fn().mockResolvedValue({
      schemaVersion: 1, generatedAt, records: { count: 42 }, map: { count: 53 },
      coverage: { complete: true, warnings: [] },
    });
    UA.refreshContextOverlays(ctx);
    await jest.advanceTimersByTimeAsync(0);
    const footer = document.getElementById('risCatalogueCount');
    expect(footer?.textContent).toMatch(/42.*veralteter Datenstand/i);
    expect(footer.textContent).not.toMatch(/53|verortet/i);

    await jest.advanceTimersByTimeAsync(day);
    expect(footer.textContent).toMatch(/abgelaufen/i);
    expect(footer.textContent).not.toContain('42');
  });

  test('panning rechecks an unavailable footer count after the manifest cache expires', async () => {
    mountPanelFooter();
    let now = Date.now();
    const sha256 = 'a'.repeat(64);
    const manifest = { schemaVersion: 1, city: 'bonn', generatedAt: new Date(now).toISOString(), sources: [validUrl],
      coverage: { from: null, to: null, bodies: [], complete: true, warnings: [] },
      records: { path: `bonn.${sha256}.records.json.gz`, sha256, bytes: 42, count: 42 },
      map: { path: `bonn.${sha256}.map.json.gz`, sha256, bytes: 53, count: 0 } };
    const fetchManifest = jest.fn()
      .mockResolvedValueOnce({ status: 404, ok: false })
      .mockImplementation(async () => ({ status: 200, ok: true, body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(manifest)));
          controller.close();
        },
      }) }));
    UA.RisCatalogue = createCatalogue({ base: document.baseURI, fetch: fetchManifest, now: () => new Date(now) });
    UA.refreshContextOverlays(ctx);
    const footer = document.getElementById('risCatalogueCount');
    await flush();
    expect(footer.textContent).toMatch(/kein veröffentlichter Ratsdatenbestand/i);

    ctx.map.fire('moveend');
    await flush();
    expect(fetchManifest).toHaveBeenCalledTimes(1);
    now += 5 * 60 * 1000;
    ctx.map.fire('moveend');
    await flush();

    expect(footer.textContent).toMatch(/Katalog.*42/);
    expect(fetchManifest.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/data/ris/bonn.json', '/data/ris/bonn.json']);
  });

  test('the RIS checkbox and selection restriction project canonical share state', async () => {
    UA.syncAllToUrl = jest.fn();
    ctx.contextOverlays = { active: { slope: true, traffic: false, ris: true } };
    ctx.risView = { selectionOnly: true };
    ctx.selectionBounds = L.latLngBounds([50.69, 7.09], [50.71, 7.11]);
    UA.RisCatalogue.loadMap.mockResolvedValue(snapshot([point]));
    UA.refreshContextOverlays(ctx);
    await flush();
    expect(checkbox('Ratsvorgänge').checked).toBe(true);
    expect(checkbox('Nur in markierter Fläche').checked).toBe(true);
    expect(risRecordIds(ctx.map)).toEqual(['A']);
    ctx.contextOverlays.active.slope = true;
    checkbox('Ratsvorgänge').click();
    expect(ctx.contextOverlays.active.ris).toBe(false);
    expect(ctx.contextOverlays.active.slope).toBe(true);
    expect(UA.syncAllToUrl).toHaveBeenCalledWith(ctx);
    expect(risRecordIds(ctx.map)).toEqual([]);
  });

  test('selecting a map location enables RIS in shared state', async () => {
    UA.syncAllToUrl = jest.fn();
    const { entry, bundle } = searchableLocations();
    UA.RisCatalogue.loadMap.mockResolvedValue(bundle);
    UA.refreshContextOverlays(ctx);
    await UA.RisLayer.showLocation(ctx, entry, 0, () => true);
    expect(ctx.contextOverlays.active.ris).toBe(true);
    expect(UA.syncAllToUrl).toHaveBeenCalledWith(ctx);
  });

  // Break caught: the shared renderer supplies geometry identity, while v1 navigation accepts only a numeric location index.
  test.each([['legacy:record', undefined], ['legacy:location:0', 0]])('opens legacy geometry identity %s from independent details', async (geometryId, locationIndex) => {
    const { entry, bundle } = searchableLocations();
    if (locationIndex === undefined) bundle.features.features.unshift({ ...point, geometry: { type: 'Point', coordinates: [7.3, 50.8] },
      properties: { recordId: entry.id, accuracy: 'official' } });
    UA.RisCatalogue.loadMap.mockResolvedValue(bundle);
    UA.refreshContextOverlays(ctx);
    const target = await UA.RisLayer.showLocation(ctx, entry, { geometryId }, () => true);
    expect(target).toBeInstanceOf(Element);
    expect(ctx.contextOverlays.active.ris).toBe(true);
    expect(risFeatures(ctx.map).some(layer => layer.isPopupOpen() && layer.feature.properties.locations.some(location =>
      location.recordId === entry.id && location.locationIndex === locationIndex))).toBe(true);
  });

  test('desktop popups retain a usable central strip beside the unified tall Karte card', async () => {
    ctx.map.getContainer().getBoundingClientRect = () => ({ left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 });
    ctx.ui.panelEl = document.createElement('div');
    ctx.ui.panelEl.getBoundingClientRect = () => ({ left: 8, top: 8, right: 328, bottom: 792, width: 320, height: 784 });
    UA.RisCatalogue.loadMap.mockResolvedValue(snapshot([point]));
    UA.refreshContextOverlays(ctx);
    const card = document.querySelector('.context-overlay-control');
    expect(card.classList.contains('layer-legend-control')).toBe(true);
    card.getBoundingClientRect = () => ({ left: 972, top: 10, right: 1270, bottom: 674, width: 298, height: 664 });
    checkbox('Ratsvorgänge').click();
    await flush();
    const layer = risFeatures(ctx.map)[0];
    layer.openPopup();
    const layout = layer.getPopup().options;
    expect(layout.autoPanPaddingTopLeft).toEqual([336, 8]);
    expect(layout.autoPanPaddingBottomRight).toEqual([316, 8]);
    expect(layout.maxHeight).toBe(280);
    expect(layout.maxWidth).toBe(340);
    expect(layer.isPopupOpen()).toBe(true);
  });

  test('phone record popups use the map width while the surrounding cards are hidden', async () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = () => ({ matches: true });
    try {
      ctx.map.getContainer().getBoundingClientRect = () => ({
        left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844,
      });
      ctx.ui.panelEl = document.createElement('div');
      ctx.ui.panelEl.getBoundingClientRect = () => ({
        left: 8, top: 766, right: 288, bottom: 836, width: 280, height: 70,
      });
      UA.RisCatalogue.loadMap.mockResolvedValue(snapshot([point]));
      UA.refreshContextOverlays(ctx);
      checkbox('Ratsvorgänge').click();
      await flush();
      const layer = risFeatures(ctx.map)[0];
      layer.openPopup();
      expect(layer.getPopup().options.maxWidth).toBeGreaterThanOrEqual(300);
      expect(layer.getPopup().options.maxHeight).toBe(280);
      expect(layer.getPopup().options.autoPanPaddingTopLeft).toEqual([8, 8]);
      expect(checkbox('Ratsvorgänge').checked).toBe(true);
      expect(risRecordIds(ctx.map)).toEqual(['A']);
    } finally {
      window.matchMedia = matchMedia;
    }
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

    expect(UA.RisCatalogue.loadMap).toHaveBeenCalledWith('Bonn', expect.objectContaining({ bounds: expect.any(Array), zoom: 13, maxFeatures: 1000 }));
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

  test('a popup shows evidence for the location indexed by the clicked geometry', async () => {
    const entry = { ...records[0], locations: [{
      label: 'Endenicher Straße', kind: 'street', mapped: true,
      evidence: { source: 'title', text: 'Maßnahmen in der Endenicher Straße' },
    }, {
      label: 'Endenicher Straße / <em>Römerstraße</em>', kind: 'junction', mapped: true,
      evidence: { source: 'document', text: 'an der Kreuzung mit <em>Römerstraße</em>' },
    }] };
    const junction = feature('A', 'derived', 'Point', [7.1, 50.7]);
    junction.properties.locationIndex = 1;
    junction.properties.label = 'Endenicher Straße / <em>Römerstraße</em> — © OpenStreetMap-Mitwirkende';
    UA.RisCatalogue.loadMap.mockResolvedValue(snapshot([junction], [entry]));
    UA.refreshContextOverlays(ctx);
    checkbox('Ratsvorgänge').click();
    await flush();

    risFeatures(ctx.map)[0].openPopup();
    const popup = document.querySelector('.leaflet-popup');
    expect(popup.textContent).toContain('Kreuzung');
    expect(popup.textContent).toContain('Endenicher Straße / <em>Römerstraße</em>');
    expect(popup.textContent).toContain('Dokument: „an der Kreuzung mit <em>Römerstraße</em>“');
    expect(popup.textContent).toContain('© OpenStreetMap-Mitwirkende');
    expect(popup.textContent).not.toContain('Maßnahmen in der Endenicher Straße');
    expect(popup.querySelector('em')).toBeNull();
  });

  test('opens the exact mapped place selected in the search and focuses its map feature', async () => {
    const { entry, bundle } = searchableLocations();
    UA.RisCatalogue.loadMap.mockResolvedValue(bundle);
    UA.refreshContextOverlays(ctx);
    const panel = await openSearch(ctx, entry);
    const buttons = panel.querySelectorAll('#polCtxResults button[aria-label^="Auf Karte zeigen:"]');
    expect(buttons).toHaveLength(2); // The third place is named but not mapped.
    expect(buttons[1].getAttribute('aria-label')).toContain('Beueler Straße / Gartenstraße');
    expect(UA.RisCatalogue.loadMap).not.toHaveBeenCalled();
    buttons[1].click();
    await flush();

    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(checkbox('Ratsvorgänge').checked).toBe(true);
    const [layer] = risFeatures(ctx.map);
    expect(layer.getLatLng()).toEqual(L.latLng(50.94, 7.45));
    expect(document.activeElement).toBe(layer.getElement());
    expect(document.querySelector('.leaflet-popup').textContent).toContain('Beueler Straße / Gartenstraße');
  });

  test('refreshes pinned geometry when only its hash changed', async () => {
    const { entry, bundle } = searchableLocations();
    const old = searchableLocations().bundle;
    old.manifest.map.sha256 = 'c'.repeat(64);
    old.records[0].snapshot.mapSha256 = old.manifest.map.sha256;
    old.features.features[1].geometry.coordinates = [7.11, 50.7];
    UA.RisCatalogue.loadMap.mockResolvedValueOnce(old).mockResolvedValueOnce(bundle);
    UA.refreshContextOverlays(ctx);
    checkbox('Ratsvorgänge').click();
    await flush();
    expect(risFeatures(ctx.map).map(layer => layer.getLatLng())).toContainEqual(L.latLng(50.7, 7.11));

    const panel = await openSearch(ctx, entry);
    panel.querySelectorAll('#polCtxResults button[aria-label^="Auf Karte zeigen:"]')[1].click();
    await flush();

    expect(UA.RisCatalogue.loadMap.mock.calls).toEqual([['Bonn', expect.objectContaining({ bounds: expect.any(Array), zoom: 13, maxFeatures: 1000 })], ['Bonn', expect.objectContaining({ revalidate: true, bounds: expect.any(Array), zoom: 13, maxFeatures: 1000 })]]);
    const [layer] = risFeatures(ctx.map);
    expect(layer.getLatLng()).toEqual(L.latLng(50.94, 7.45));
    expect(layer.isPopupOpen()).toBe(true);
  });

  test('revalidates a stale manifest even when both hashes match', async () => {
    const { entry, bundle } = searchableLocations();
    const old = { ...bundle, manifest: { ...bundle.manifest, generatedAt: new Date(Date.now() - 9 * 86400000).toISOString() } };
    UA.RisCatalogue.loadMap.mockResolvedValueOnce(old).mockResolvedValueOnce(bundle);
    UA.refreshContextOverlays(ctx);
    checkbox('Ratsvorgänge').click();
    await flush();
    const status = document.querySelector('.context-overlay-control [role="status"]');
    expect(status.textContent).toContain('Veralteter Datenstand');

    const panel = await openSearch(ctx, entry);
    panel.querySelectorAll('#polCtxResults button[aria-label^="Auf Karte zeigen:"]')[1].click();
    await flush();

    expect(UA.RisCatalogue.loadMap.mock.calls).toEqual([['Bonn', expect.objectContaining({ bounds: expect.any(Array), zoom: 13, maxFeatures: 1000 })], ['Bonn', expect.objectContaining({ revalidate: true, bounds: expect.any(Array), zoom: 13, maxFeatures: 1000 })]]);
    expect(status.textContent).not.toContain('Veralteter Datenstand');
    expect(risFeatures(ctx.map)[0].isPopupOpen()).toBe(true);
  });

  test('keeps the marked area filter when a searched location is outside it', async () => {
    const { entry, bundle } = searchableLocations();
    UA.RisCatalogue.loadMap.mockResolvedValue(bundle);
    ctx.selectionBounds = L.latLngBounds([50.69, 7.09], [50.71, 7.11]);
    UA.refreshContextOverlays(ctx);
    checkbox('Ratsvorgänge').click();
    await flush();
    checkbox('Nur in markierter Fläche').click();
    const panel = await openSearch(ctx, entry);
    const buttons = panel.querySelectorAll('#polCtxResults button[aria-label^="Auf Karte zeigen:"]');
    expect(buttons).toHaveLength(2);
    buttons[1].click();
    await flush();

    expect(panel.getAttribute('aria-hidden')).toBeNull();
    expect(panel.querySelector('[role="status"]').textContent).toContain('außerhalb der markierten Fläche');
    expect(checkbox('Nur in markierter Fläche').checked).toBe(true);
    expect(ctx.map.getCenter()).toEqual(L.latLng(50.7, 7.1));
    expect(document.querySelector('.leaflet-popup')).toBeNull();
  });

  test('does not jump when a search result belongs to a different snapshot', async () => {
    const { entry, bundle } = searchableLocations();
    bundle.manifest.records.sha256 = 'b'.repeat(64);
    UA.RisCatalogue.loadMap.mockResolvedValue(bundle);
    UA.refreshContextOverlays(ctx);
    const panel = await openSearch(ctx, entry);
    const buttons = panel.querySelectorAll('#polCtxResults button[aria-label^="Auf Karte zeigen:"]');
    expect(buttons).toHaveLength(2);
    buttons[1].click();
    await flush();

    expect(UA.RisCatalogue.loadMap.mock.calls).toEqual([['Bonn', expect.objectContaining({ bounds: expect.any(Array), zoom: 13, maxFeatures: 1000 })], ['Bonn', expect.objectContaining({ revalidate: true, bounds: expect.any(Array), zoom: 13, maxFeatures: 1000 })]]);
    expect(panel.querySelector('[role="status"]').textContent).toMatch(/Datenst.nd/);
    expect(checkbox('Ratsvorgänge').checked).toBe(false);
    expect(ctx.map.getCenter()).toEqual(L.latLng(50.7, 7.1));
    expect(document.querySelector('.leaflet-popup')).toBeNull();
  });

  test('a late map lookup cannot jump after the user leaves and returns to the city', async () => {
    const { entry, bundle } = searchableLocations();
    const pending = deferred();
    UA.RisCatalogue.loadMap.mockReturnValue(pending.promise);
    UA.refreshContextOverlays(ctx);
    const panel = await openSearch(ctx, entry);
    const buttons = panel.querySelectorAll('#polCtxResults button[aria-label^="Auf Karte zeigen:"]');
    expect(buttons).toHaveLength(2);
    buttons[1].click();
    await flush();

    for (const city of ['Hannover', 'Bonn']) {
      ctx.CITY_RAW = city;
      UA.PoliticalContext.resetCity(ctx);
      UA.RisLayer.refresh(ctx);
    }
    pending.resolve(bundle);
    await flush();

    expect(checkbox('Ratsvorgänge').checked).toBe(false);
    expect(ctx.map.getCenter()).toEqual(L.latLng(50.7, 7.1));
    expect(document.querySelector('.leaflet-popup')).toBeNull();
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

  test('rapid toggles share a fetch and city changes preserve the requested layer while rejecting old results', async () => {
    const bonn = deferred();
    const hannover = deferred();
    UA.RisCatalogue.loadMap.mockImplementation(city => city === 'Bonn' ? bonn.promise : hannover.promise);
    UA.refreshContextOverlays(ctx);
    checkbox('Ratsvorgänge').click();
    checkbox('Ratsvorgänge').click();
    checkbox('Ratsvorgänge').click();
    await flush();
    expect(UA.RisCatalogue.loadMap.mock.calls).toEqual([['Bonn', expect.objectContaining({ bounds: expect.any(Array), zoom: 13, maxFeatures: 1000 })]]);

    ctx.CITY_RAW = 'Hannover';
    UA.renderLayers(ctx);
    expect(checkbox('Ratsvorgänge').checked).toBe(true);
    hannover.resolve(snapshot([line]));
    await flush();
    expect(UA.RisCatalogue.loadMap).toHaveBeenCalledTimes(2);
    bonn.resolve(snapshot([point, polygon]));
    await flush();
    expect(risRecordIds(ctx.map)).toEqual(['B']);

    ctx.CITY_RAW = 'Bonn';
    UA.renderLayers(ctx);
    expect(risFeatures(ctx.map)).toHaveLength(0);
    expect(checkbox('Ratsvorgänge').checked).toBe(true);
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
  function partitionSnapshot(features = []) {
    return { manifest: { schemaVersion: 2, city: 'bonn', generation: 'c'.repeat(64),
      generatedAt: new Date().toISOString(), coverage: { complete: true, bodies: [], warnings: [] }, mappedRecordCount: 72 },
    partitioned: true, features: { type: 'FeatureCollection', features },
    coverage: { complete: true, missing: [], truncated: false }, overview: false, recordCount: 72 };
  }
  function partitionFeature(id = 'shape') {
    return { ...point, bounds: [7.1, 50.7, 7.1, 50.7], properties: { geometryId: id, accuracy: 'official', label: 'Ort', recordCount: 72 } };
  }

  test.each([['legacy', false], ['partitioned', true]])('labels mapped and unlocated Hannover sources in %s popups', async (_name, partitioned) => {
    const city = { ...records[0], id: 'hannover-sim:2003037', source: 'hannover-sim',
      url: 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/ds_suchformular/2003037' };
    const region = { ...records[3], id: 'region-hannover-ris:2003037', relatedTo: city.id, source: 'region-hannover-ris',
      url: 'https://ris.hannit.de/public/vo020?VOLFDNR=2003037' };
    const noLink = { ...region, id: 'region-hannover-ris:2003038', url: 'javascript:alert(1)' };
    const unknown = { ...records[3], id: 'other:1', relatedTo: city.id, source: '<img src=x onerror=alert(1)>' };
    const relatives = [region, noLink, unknown];
    const mapped = feature(city.id, 'official', 'Point', [9.73, 52.37]);
    const bundle = partitioned ? partitionSnapshot([{ ...mapped, bounds: [9.73, 52.37, 9.73, 52.37],
      properties: { geometryId: 'shape', accuracy: 'official', label: 'Ort', recordCount: 1 } }]) : snapshot([mapped], [city, ...relatives]);
    bundle.manifest.city = 'hannover';
    if (partitioned) {
      bundle.manifest.mappedRecordCount = bundle.recordCount = 1;
      UA.RisCatalogue.loadFeatureRecords = jest.fn().mockResolvedValue({ records: [city],
        links: [{ recordId: city.id, accuracy: 'official', label: 'Ort' }], total: 1, nextPage: null, complete: true });
      UA.RisCatalogue.loadRelatedRecords = jest.fn().mockResolvedValue({ records: relatives, total: 3, nextPage: null, complete: true });
    }
    ctx.CITY_RAW = 'Hannover';
    ctx.map.setView([52.37, 9.73], 13);
    UA.RisCatalogue.loadMap.mockResolvedValue(bundle);
    UA.refreshContextOverlays(ctx);
    checkbox('Ratsvorgänge').click();
    await flush();
    risFeatures(ctx.map)[0].openPopup();
    await flush();
    const popup = document.querySelector('.leaflet-popup');
    if (partitioned) {
      [...popup.querySelectorAll('button')].find(button => button.textContent === 'Verknüpfte Vorgänge anzeigen').click();
      await flush();
    }

    expect(popup.textContent).toContain('Quelle: Landeshauptstadt Hannover · SIM');
    expect(popup.textContent.match(/Quelle: Region Hannover · ALLRIS/g)).toHaveLength(2);
    expect(popup.textContent).toContain('Quelle: <img src=x onerror=alert(1)>');
    expect(popup.querySelector('img')).toBeNull();
    expect([...popup.querySelectorAll('a[target="_blank"]')].map(link => link.href)).toEqual([city.url, region.url, unknown.url]);
  });

  test('partitioned maps request bounded viewports and load records and relations only on demand', async () => {
    const bundle = partitionSnapshot([partitionFeature()]);
    UA.RisCatalogue.loadMap.mockResolvedValue(bundle);
    UA.RisCatalogue.loadFeatureRecords = jest.fn().mockResolvedValue({ records: [records[0]],
      links: [{ recordId: 'A', locationId: 'A/place', accuracy: 'official', label: 'Ort' }], total: 72, nextPage: 1, complete: true });
    UA.RisCatalogue.loadRelatedRecords = jest.fn().mockResolvedValue({ records: [records[3]], total: 1, nextPage: null, complete: true });
    UA.refreshContextOverlays(ctx);
    checkbox('Ratsvorgänge').click();
    await flush();
    expect(UA.RisCatalogue.loadMap).toHaveBeenCalledWith('Bonn', expect.objectContaining({ bounds: expect.any(Array), zoom: 13, maxFeatures: 1000 }));
    expect(UA.RisCatalogue.loadFeatureRecords).not.toHaveBeenCalled();
    const layer = risFeatures(ctx.map)[0];
    expect(layer).toBeDefined();
    layer.openPopup();
    await flush();
    expect(UA.RisCatalogue.loadFeatureRecords).toHaveBeenCalledWith('Bonn', 'shape', 0, { snapshot: bundle.manifest });
    expect(UA.RisCatalogue.loadRelatedRecords).not.toHaveBeenCalled();
    [...document.querySelectorAll('.leaflet-popup button')].find(b => b.textContent === 'Verknüpfte Vorgänge anzeigen').click();
    await flush();
    expect(document.querySelector('.leaflet-popup').textContent).toContain(records[3].title);
    [...document.querySelectorAll('.leaflet-popup button')].find(b => b.textContent === 'Weitere Vorgänge laden').click();
    await flush();
    expect(UA.RisCatalogue.loadFeatureRecords).toHaveBeenLastCalledWith('Bonn', 'shape', 1, { snapshot: bundle.manifest });
    ctx.map.panBy([10, 0], { animate: false });
    await flush();
    expect(risFeatures(ctx.map)[0]).toBe(layer);
    expect(layer.isPopupOpen()).toBe(true);
  });

  test('partitioned overview renders aggregate rectangles and explains missing coverage', async () => {
    const overview = { ...polygon, bounds: [7, 50.6, 7.2, 50.8], properties: { overview: true, geometryId: 'overview:8/1/2', count: 90, recordCount: 72, geometryCount: 40, label: 'Zelle' } };
    const bundle = { ...partitionSnapshot([overview]), overview: true, coverage: { complete: false, missing: ['asset'], truncated: true } };
    UA.RisCatalogue.loadMap.mockResolvedValue(bundle);
    UA.RisCatalogue.loadFeatureRecords = jest.fn();
    UA.refreshContextOverlays(ctx);
    checkbox('Ratsvorgänge').click();
    await flush();
    expect(risFeatures(ctx.map)).toHaveLength(1);
    expect(risFeatures(ctx.map)[0].feature.geometry.type).toBe('Polygon');
    risFeatures(ctx.map)[0].openPopup();
    expect(document.querySelector('.leaflet-popup').textContent).toMatch(/Übersicht|zusammengefasst/);
    expect(document.querySelector('.context-overlay-control [role="status"]').textContent).toMatch(/unvollständig|fehlen/);
    expect(UA.RisCatalogue.loadFeatureRecords).not.toHaveBeenCalled();
  });

  test.each([true, false])('budget overview distinguishes aggregation from missing data with source completeness %s', async sourceComplete => {
    const overview = { ...polygon, bounds: [7, 50.6, 7.2, 50.8],
      properties: { overview: true, geometryId: 'overview:8/1/2', recordCount: 72, geometryCount: 40 } };
    const bundle = { ...partitionSnapshot([overview]), overview: true,
      coverage: { complete: false, missing: [], truncated: true } };
    bundle.manifest.coverage.complete = sourceComplete;
    UA.RisCatalogue.loadMap.mockResolvedValue(bundle);
    UA.refreshContextOverlays(ctx);
    checkbox('Ratsvorgänge').click();
    await flush();
    const status = document.querySelector('.context-overlay-control [role="status"]').textContent;
    expect(status).toContain('Übersicht: zusammengefasste Zellen');
    expect(status).toContain('Detailbudget erreicht');
    expect(status).not.toMatch(/Kartenabdeckung unvollständig|Daten fehlen/);
    if (sourceComplete) expect(status).not.toContain('Teilbestand');
    else expect(status).toContain('Teilbestand');
  });

  async function openOverviewAt(zoom, maxZoom, bounds = [7, 50.6, 7.2, 50.8]) {
    const [w, s, e, n] = bounds;
    const overview = { type: 'Feature', bounds,
      geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
      properties: { overview: true, geometryId: 'overview:8/1/2', recordCount: 72, geometryCount: 40 } };
    ctx.map.setMaxZoom(maxZoom).setView([50.74, 7.18], zoom, { animate: false });
    UA.RisCatalogue.loadMap.mockResolvedValue({ ...partitionSnapshot([overview]), overview: true });
    UA.RisCatalogue.loadFeatureRecords = jest.fn();
    UA.refreshContextOverlays(ctx);
    checkbox('Ratsvorgänge').click();
    await flush();
    risFeatures(ctx.map)[0].openPopup();
    return document.querySelector('.ua-ris-popup');
  }

  test('a coarse overview fallback at high zoom drills into the visible part without zooming out', async () => {
    const popup = await openOverviewAt(18, 19);
    const visibleCenter = ctx.map.getCenter();
    const visibleBounds = ctx.map.getBounds();
    const button = [...popup.querySelectorAll('button')].find(node => node.textContent === 'Für Details vergrößern');
    button.focus();
    button.click();
    await flush();
    expect(ctx.map.getZoom()).toBe(19);
    expect(visibleBounds.contains(ctx.map.getCenter())).toBe(true);
    expect(ctx.map.getCenter().distanceTo(visibleCenter)).toBeLessThan(1);
    expect(document.activeElement).toBe(ctx.map.getContainer());
    expect(UA.RisCatalogue.loadFeatureRecords).not.toHaveBeenCalled();
  });

  test('low zoom overview drilldown still fits a smaller selected cell', async () => {
    const bounds = [7.16, 50.72, 7.20, 50.76];
    const popup = await openOverviewAt(8, 19, bounds);
    [...popup.querySelectorAll('button')].find(node => node.textContent === 'Für Details vergrößern').click();
    await flush();
    expect(ctx.map.getZoom()).toBeGreaterThan(8);
    expect(ctx.map.getZoom()).toBeLessThanOrEqual(19);
    expect(L.latLngBounds([bounds[1], bounds[0]], [bounds[3], bounds[2]]).contains(ctx.map.getCenter())).toBe(true);
  });

  test('an overview at the map maximum explains that further zoom is unavailable', async () => {
    const popup = await openOverviewAt(18, 18);
    const before = ctx.map.getCenter();
    const button = [...popup.querySelectorAll('button')].find(node => /Maximale Vergrößerung/.test(node.textContent));
    expect(button).toBeDefined();
    expect(button.disabled).toBe(true);
    expect(popup.querySelector('[role="status"]').textContent).toMatch(/nicht weiter vergrößert/);
    button.click();
    await flush();
    expect(ctx.map.getZoom()).toBe(18);
    expect(ctx.map.getCenter()).toEqual(before);
    expect(UA.RisCatalogue.loadFeatureRecords).not.toHaveBeenCalled();
  });

  test('partitioned viewport ignores out-of-order and disabled responses', async () => {
    const first = deferred(), second = deferred();
    UA.RisCatalogue.loadMap.mockResolvedValueOnce(partitionSnapshot([partitionFeature()]))
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    UA.refreshContextOverlays(ctx); checkbox('Ratsvorgänge').click(); await flush();
    ctx.map.panBy([10, 0], { animate: false }); await flush();
    ctx.map.panBy([10, 0], { animate: false }); await flush();
    second.resolve(partitionSnapshot([partitionFeature('latest')])); await flush();
    first.resolve(partitionSnapshot([partitionFeature('obsolete')])); await flush();
    expect(risFeatures(ctx.map).map(l => l.feature.properties.geometryId)).toEqual(['latest']);
    const late = deferred(); UA.RisCatalogue.loadMap.mockReturnValueOnce(late.promise);
    ctx.map.panBy([10, 0], { animate: false }); await flush();
    checkbox('Ratsvorgänge').click();
    late.resolve(partitionSnapshot([partitionFeature('disabled')])); await flush();
    expect(risFeatures(ctx.map)).toHaveLength(0);
  });

  test('research pages beyond 64 locations and navigates by stable location identity', async () => {
    const entry = { ...records[0], snapshot: { city: 'bonn', sha256: 'c'.repeat(64), mapSha256: 'c'.repeat(64) },
      locations: Array.from({ length: 64 }, (_, i) => ({ id: `place-${i}`, label: `Ort ${i}`, mapped: true })), locationsNextPage: 1, locationCount: 65 };
    UA.RisCatalogue.loadRecordLocations = jest.fn().mockResolvedValue({ locations: [{ id: 'place-64', geometryId: 'shape', label: 'Ort 64', mapped: true }], nextPage: null, complete: true });
    UA.RisLayer.showLocation = jest.fn().mockResolvedValue(null);
    UA.refreshContextOverlays(ctx);
    const panel = await openSearch(ctx, entry);
    const more = [...panel.querySelectorAll('button')].find(b => b.textContent === 'Weitere Orte laden');
    expect(more).toBeDefined(); more.click(); await flush();
    panel.querySelector('button[aria-label="Auf Karte zeigen: Ort 64"]').click(); await flush();
    expect(UA.RisLayer.showLocation).toHaveBeenCalledWith(ctx, expect.objectContaining({ id: 'A' }), 'place-64', expect.any(Function));
  });

  test('official geometry without locations can be opened from research', async () => {
    const bundle = partitionSnapshot([]), shape = partitionFeature();
    const entry = { ...records[0], snapshot: { city: 'bonn', sha256: bundle.manifest.generation, mapSha256: bundle.manifest.generation }, geometryIds: ['shape'] };
    UA.RisCatalogue.loadMap.mockResolvedValue(bundle);
    UA.RisCatalogue.loadGeometry = jest.fn().mockResolvedValue(shape);
    UA.RisCatalogue.loadFeatureRecords = jest.fn().mockResolvedValue({ records: [], links: [], complete: true, nextPage: null });
    UA.refreshContextOverlays(ctx);
    const panel = await openSearch(ctx, entry);
    const button = panel.querySelector('button[aria-label="Auf Karte zeigen: Amtliche Kartenlage 1"]');
    expect(button).not.toBeNull(); button.click(); await flush(); await flush();
    expect(UA.RisCatalogue.loadGeometry).toHaveBeenCalledWith('Bonn', 'shape', { snapshot: bundle.manifest });
    expect(risFeatures(ctx.map)).toHaveLength(1);
    expect(document.querySelector('.leaflet-popup')).not.toBeNull();
  });

  test('a closed partition popup discards delayed details and retries a failed page when reopened', async () => {
    const pending = deferred();
    UA.RisCatalogue.loadMap.mockResolvedValue(partitionSnapshot([partitionFeature()]));
    UA.RisCatalogue.loadFeatureRecords = jest.fn().mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new Error('Partition fehlt'))
      .mockResolvedValueOnce({ records: [records[0]], links: [{ recordId: 'A', accuracy: 'official' }], total: 1, nextPage: null, complete: true });
    UA.refreshContextOverlays(ctx); checkbox('Ratsvorgänge').click(); await flush();
    const layer = risFeatures(ctx.map)[0]; layer.openPopup(); await flush();
    const old = document.querySelector('.leaflet-popup-content'); layer.closePopup();
    pending.resolve({ records: [records[0]], links: [{ recordId: 'A' }], total: 1, nextPage: null, complete: true }); await flush();
    expect(old.textContent).not.toContain(records[0].title);
    layer.openPopup(); await flush();
    expect(document.querySelector('.leaflet-popup').textContent).toContain('Partition fehlt');
    [...document.querySelectorAll('.leaflet-popup button')].find(b => b.textContent === 'Erneut versuchen').click(); await flush();
    expect(document.querySelector('.leaflet-popup').textContent).toContain(records[0].title);
  });

  test('a feature beyond the first location page displays only its matching evidence', async () => {
    const entry = { ...records[0], locations: [{ id: 'wrong', label: 'Anderer Ort', evidence: { source: 'title', text: 'Falscher Beleg' } }], locationsNextPage: 1 };
    UA.RisCatalogue.loadMap.mockResolvedValue(partitionSnapshot([partitionFeature()]));
    UA.RisCatalogue.loadFeatureRecords = jest.fn().mockResolvedValue({ records: [entry], links: [{ recordId: 'A', locationId: 'right', accuracy: 'official' }], total: 1, nextPage: null, complete: true });
    UA.RisCatalogue.loadRecordLocations = jest.fn().mockResolvedValue({ locations: [{ id: 'right', label: 'Richtiger Ort', evidence: { source: 'document', text: 'Passender Beleg aus Seite 2' } }], nextPage: null, complete: true });
    UA.refreshContextOverlays(ctx); checkbox('Ratsvorgänge').click(); await flush();
    risFeatures(ctx.map)[0].openPopup(); await flush();
    expect(UA.RisCatalogue.loadRecordLocations).not.toHaveBeenCalled();
    const popup = document.querySelector('.leaflet-popup');
    expect(popup.textContent).not.toContain('Falscher Beleg');
    [...popup.querySelectorAll('button')].find(b => b.textContent === 'Ortsbeleg laden').click(); await flush();
    expect(UA.RisCatalogue.loadRecordLocations).toHaveBeenCalledWith('Bonn', 'A', 1, expect.objectContaining({ snapshot: expect.any(Object) }));
    expect(popup.textContent).toContain('Passender Beleg aus Seite 2');
    expect(popup.textContent).not.toContain('Falscher Beleg');
  });

  test('partition research rejects a different generation before fetching geometry', async () => {
    const bundle = partitionSnapshot([]);
    const entry = { ...records[0], snapshot: { city: 'bonn', sha256: 'old', mapSha256: 'old' }, geometryIds: ['shape'] };
    UA.RisCatalogue.loadMap.mockResolvedValue(bundle);
    UA.RisCatalogue.loadGeometry = jest.fn();
    UA.refreshContextOverlays(ctx);
    const panel = await openSearch(ctx, entry);
    panel.querySelector('button[aria-label="Auf Karte zeigen: Amtliche Kartenlage 1"]').click(); await flush();
    expect(UA.RisCatalogue.loadGeometry).not.toHaveBeenCalled();
    expect(panel.querySelector('[role="status"]').textContent).toMatch(/Datenst.nd/);
    expect(checkbox('Ratsvorgänge').checked).toBe(false);
  });

  test('partition research respects selected area and discards geometry after a city change', async () => {
    const bundle = partitionSnapshot([]);
    const entry = { ...records[0], snapshot: { city: 'bonn', sha256: bundle.manifest.generation, mapSha256: bundle.manifest.generation }, geometryIds: ['shape'] };
    UA.RisCatalogue.loadMap.mockResolvedValue(bundle);
    UA.RisCatalogue.loadGeometry = jest.fn().mockResolvedValue(partitionFeature());
    ctx.selectionBounds = L.latLngBounds([50.8, 7.3], [50.9, 7.4]);
    UA.refreshContextOverlays(ctx); checkbox('Ratsvorgänge').click(); await flush();
    checkbox('Nur in markierter Fläche').click();
    const panel = await openSearch(ctx, entry);
    const button = panel.querySelector('button[aria-label="Auf Karte zeigen: Amtliche Kartenlage 1"]');
    button.click(); await flush();
    expect(panel.querySelector('[role="status"]').textContent).toContain('außerhalb');
    expect(risFeatures(ctx.map)).toHaveLength(0);
    const pending = deferred(); UA.RisCatalogue.loadGeometry.mockReturnValue(pending.promise);
    checkbox('Nur in markierter Fläche').click(); button.click(); await flush();
    ctx.CITY_RAW = 'Hannover'; UA.PoliticalContext.resetCity(ctx); UA.RisLayer.refresh(ctx);
    pending.resolve(partitionFeature()); await flush();
    expect(risFeatures(ctx.map)).toHaveLength(0);
    expect(document.querySelector('.leaflet-popup')).toBeNull();
  });

  test('official geometry links beyond their first page remain navigable', async () => {
    const entry = { ...records[0], snapshot: { city: 'bonn', sha256: 'c'.repeat(64), mapSha256: 'c'.repeat(64) }, geometryIds: ['first'], geometryNextPage: 1 };
    UA.RisCatalogue.loadRecordGeometries = jest.fn().mockResolvedValue({ geometryIds: ['second'], nextPage: null, complete: true });
    UA.RisLayer.showLocation = jest.fn().mockResolvedValue(null);
    UA.refreshContextOverlays(ctx);
    const panel = await openSearch(ctx, entry);
    [...panel.querySelectorAll('button')].find(b => b.textContent === 'Weitere Kartenlagen laden').click(); await flush();
    panel.querySelector('button[aria-label="Auf Karte zeigen: Amtliche Kartenlage 2"]').click(); await flush();
    expect(UA.RisLayer.showLocation).toHaveBeenCalledWith(ctx, expect.objectContaining({ id: 'A' }), { geometryId: 'second' }, expect.any(Function));
  });

  test('research delegates relatives and their paging to the shared document view', async () => {
    const entry = { ...records[0], snapshot: { city: 'bonn', sha256: 'c'.repeat(64), mapSha256: 'c'.repeat(64) } };
    UA.RisCatalogue.loadRelatedRecords = jest.fn();
    UA.RisDetails = { open: jest.fn() };
    UA.refreshContextOverlays(ctx);
    const panel = await openSearch(ctx, entry);
    const open = panel.querySelector('[data-ris-open-record]');
    expect(open).not.toBeNull();
    open.click();
    expect(UA.RisDetails.open).toHaveBeenCalledWith(ctx, entry.id, { trigger: open });
    expect(UA.RisCatalogue.loadRelatedRecords).not.toHaveBeenCalled();
    expect(panel.style.display).toBe('flex');
  });

  test('research search pages preserve checked results, query and snapshot, and ignore a superseded query', async () => {
    const snapshot = { city: 'bonn', sha256: 'c'.repeat(64), mapSha256: 'c'.repeat(64) };
    const entry = { ...records[0], snapshot };
    UA.refreshContextOverlays(ctx);
    const panel = await openSearch(ctx, entry, { nextPage: 1, snapshot });
    panel.querySelector('.polCtxCheck').checked = true;
    const button = [...panel.querySelectorAll('button')].find(b => b.textContent === 'Weitere Suchtreffer laden');
    expect(button).toBeDefined();
    UA.PoliticalContext.search = jest.fn().mockResolvedValueOnce({ references: [entry, { ...records[2], snapshot }], meta: { supported: true, nextPage: 2, snapshot, searchStatus: 'results-found' } });
    button.click(); await flush();
    expect(UA.PoliticalContext.search).toHaveBeenCalledWith(expect.objectContaining({ city: 'Bonn', searchTerms: ['Endenicher Straße'], page: 1, snapshot }));
    expect(panel.querySelectorAll('.polCtxCheck')).toHaveLength(2);
    expect(panel.querySelector('.polCtxCheck').checked).toBe(true);
    const pending = deferred(); UA.PoliticalContext.search.mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ references: [records[1]], meta: { supported: true, searchStatus: 'results-found' } });
    [...panel.querySelectorAll('button')].find(b => b.textContent === 'Weitere Suchtreffer laden').click(); await flush();
    document.getElementById('polCtxSearchInput').value = 'Neue Suche';
    await UA.PoliticalContext._runSearch(ctx);
    pending.resolve({ references: [records[3]], meta: { nextPage: null, snapshot } }); await flush();
    expect(panel.textContent).toContain(records[1].title);
    expect(panel.textContent).not.toContain(records[3].title);
  });

  test('a focused far-away exact feature survives the following bounded viewport refresh', async () => {
    const bundle = partitionSnapshot([]), shape = partitionFeature();
    shape.geometry = { type: 'Point', coordinates: [7.45, 50.94] };
    shape.bounds = [7.45, 50.94, 7.45, 50.94];
    const entry = { ...records[0], snapshot: { city: 'bonn', sha256: bundle.manifest.generation, mapSha256: bundle.manifest.generation }, geometryIds: ['shape'] };
    const viewport = deferred();
    UA.RisCatalogue.loadMap.mockResolvedValueOnce(bundle).mockReturnValueOnce(viewport.promise);
    UA.RisCatalogue.loadGeometry = jest.fn().mockResolvedValue(shape);
    UA.RisCatalogue.loadFeatureRecords = jest.fn().mockResolvedValue({ records: [], links: [], nextPage: null, complete: true });
    UA.refreshContextOverlays(ctx);
    const panel = await openSearch(ctx, entry);
    panel.querySelector('button[aria-label="Auf Karte zeigen: Amtliche Kartenlage 1"]').click(); await flush();
    const focused = risFeatures(ctx.map)[0];
    expect(focused.getLatLng()).toEqual(L.latLng(50.94, 7.45));
    expect(focused.isPopupOpen()).toBe(true);
    viewport.resolve(partitionSnapshot([])); await flush();
    expect(risFeatures(ctx.map)[0]).toBe(focused);
    expect(focused.isPopupOpen()).toBe(true);
  });

  test('research refuses a later search page from a different snapshot without losing selections', async () => {
    const snapshot = { city: 'bonn', sha256: 'c'.repeat(64), mapSha256: 'c'.repeat(64) };
    UA.refreshContextOverlays(ctx);
    const panel = await openSearch(ctx, { ...records[0], snapshot }, { nextPage: 1, snapshot });
    panel.querySelector('.polCtxCheck').checked = true;
    UA.PoliticalContext.search = jest.fn().mockResolvedValue({ references: [{ ...records[3], snapshot: { ...snapshot, sha256: 'new' } }], meta: { nextPage: null } });
    [...panel.querySelectorAll('button')].find(b => b.textContent === 'Weitere Suchtreffer laden').click(); await flush();
    expect(panel.querySelector('#polCtxStatus').textContent).toMatch(/Datenst.nd/);
    expect(panel.textContent).not.toContain(records[3].title);
    expect(panel.querySelector('.polCtxCheck').checked).toBe(true);
  });

  test('research forwards opaque search continuations on empty and later pages until null', async () => {
    const snapshot = { city: 'bonn', sha256: 'c'.repeat(64), mapSha256: 'c'.repeat(64) };
    const first = `ris2.first_page.${'a'.repeat(64)}`, second = `ris2.next_page.${'b'.repeat(64)}`;
    UA.refreshContextOverlays(ctx);
    const panel = await openSearch(ctx, { ...records[0], snapshot }, { nextPage: first, snapshot });
    const button = [...panel.querySelectorAll('button')].find(b => b.textContent === 'Weitere Suchtreffer laden');
    expect(button).toBeDefined();
    UA.PoliticalContext.search = jest.fn().mockResolvedValueOnce({ references: [], meta: { supported: true, nextPage: second, snapshot, complete: false } })
      .mockResolvedValueOnce({ references: [{ ...records[2], snapshot }], meta: { supported: true, nextPage: null, snapshot } });
    button.click(); await flush();
    expect(UA.PoliticalContext.search).toHaveBeenLastCalledWith(expect.objectContaining({ page: first, snapshot }));
    const nextButton = [...panel.querySelectorAll('button')].find(b => b.textContent === 'Weitere Suchtreffer laden');
    expect(nextButton).toBeDefined(); nextButton.click(); await flush();
    expect(UA.PoliticalContext.search).toHaveBeenLastCalledWith(expect.objectContaining({ page: second, snapshot }));
    expect([...panel.querySelectorAll('button')].some(b => b.textContent === 'Weitere Suchtreffer laden')).toBe(false);
    expect(panel.textContent).toContain(records[2].title);
  });

  test('dense asynchronous popup pages reflow and scroll without rebuilding or fetching details again', async () => {
    const pending = deferred();
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() {
      return this.classList.contains('leaflet-popup-content') ? (this.textContent.includes(records[0].title) ? 600 : 60) : 0;
    } });
    try {
      UA.RisCatalogue.loadMap.mockResolvedValue(partitionSnapshot([partitionFeature()]));
      UA.RisCatalogue.loadFeatureRecords = jest.fn().mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce({ records: [records[2]], links: [{ recordId: 'C', accuracy: 'official' }], total: 2, nextPage: null, complete: true });
      UA.RisCatalogue.loadRelatedRecords = jest.fn().mockResolvedValue({ records: [records[3]], nextPage: null, complete: true });
      UA.refreshContextOverlays(ctx); checkbox('Ratsvorgänge').click(); await flush();
      const layer = risFeatures(ctx.map)[0]; layer.openPopup(); await flush();
      const root = document.querySelector('.leaflet-popup-content section');
      pending.resolve({ records: [records[0]], links: [{ recordId: 'A', accuracy: 'official' }], total: 2, nextPage: 1, complete: true }); await flush();
      const content = document.querySelector('.leaflet-popup-content');
      expect(content.style.height).toBe('280px');
      expect(content.classList.contains('leaflet-popup-scrolled')).toBe(true);
      expect(content.querySelector('section')).toBe(root);
      expect(UA.RisCatalogue.loadFeatureRecords).toHaveBeenCalledTimes(1);
      [...root.querySelectorAll('button')].find(b => b.textContent === 'Verknüpfte Vorgänge anzeigen').click(); await flush();
      expect(content.querySelector('section')).toBe(root);
      expect(UA.RisCatalogue.loadFeatureRecords).toHaveBeenCalledTimes(1);
      [...root.querySelectorAll('button')].find(b => b.textContent === 'Weitere Vorgänge laden').click(); await flush();
      expect(UA.RisCatalogue.loadFeatureRecords).toHaveBeenLastCalledWith('Bonn', 'shape', 1, expect.any(Object));
      expect(root.textContent).toContain(records[0].title);
      expect(root.textContent).toContain(records[2].title);
      expect(root.textContent).toContain(records[3].title);
      expect([...root.querySelectorAll('button')].every(b => b.classList.contains('smallBtn'))).toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', descriptor);
      else delete HTMLElement.prototype.offsetHeight;
    }
  });

  test('lazy popup evidence and overview controls use the 44px action style', async () => {
    UA.RisCatalogue.loadMap.mockResolvedValue(partitionSnapshot([partitionFeature()]));
    UA.RisCatalogue.loadFeatureRecords = jest.fn().mockResolvedValue({ records: [{ ...records[0], locationCount: 65 }], links: [{ recordId: 'A', locationId: 'beyond-first-page', accuracy: 'official' }], nextPage: 1, complete: true });
    UA.refreshContextOverlays(ctx); checkbox('Ratsvorgänge').click(); await flush();
    risFeatures(ctx.map)[0].openPopup(); await flush();
    expect([...document.querySelectorAll('.ua-ris-popup button')].every(b => b.classList.contains('smallBtn'))).toBe(true);
    checkbox('Ratsvorgänge').click();
    const overview = { ...polygon, bounds: [7, 50.6, 7.2, 50.8], properties: { overview: true, geometryId: 'overview:8/1/2', recordCount: 72, geometryCount: 40 } };
    UA.RisCatalogue.loadMap.mockResolvedValue({ ...partitionSnapshot([overview]), overview: true });
    checkbox('Ratsvorgänge').click(); await flush();
    risFeatures(ctx.map)[0].openPopup();
    expect([...document.querySelectorAll('.ua-ris-popup button')].every(b => b.classList.contains('smallBtn'))).toBe(true);
    const css = fs.readFileSync(path.resolve(__dirname, '../../css/ua.css'), 'utf8');
    expect(css).toMatch(/\.ua-ris-popup \.smallBtn\s*\{[^}]*min-height:\s*44px/s);
  });

  test('explicit layer disable cancels pending exact navigation without undoing the user toggle', async () => {
    const bundle = partitionSnapshot([]), pending = deferred();
    const entry = { ...records[0], snapshot: { city: 'bonn', sha256: bundle.manifest.generation, mapSha256: bundle.manifest.generation }, geometryIds: ['shape'] };
    UA.RisCatalogue.loadMap.mockResolvedValue(bundle);
    UA.RisCatalogue.loadGeometry = jest.fn().mockReturnValue(pending.promise);
    UA.RisCatalogue.loadFeatureRecords = jest.fn();
    UA.refreshContextOverlays(ctx); checkbox('Ratsvorgänge').click(); await flush();
    const navigation = UA.RisLayer.showLocation(ctx, entry, { geometryId: 'shape' }, () => true);
    await flush();
    checkbox('Ratsvorgänge').click();
    pending.resolve(partitionFeature());
    await navigation; await flush();
    expect(checkbox('Ratsvorgänge').checked).toBe(false);
    expect(risFeatures(ctx.map)).toHaveLength(0);
    expect(document.querySelector('.leaflet-popup')).toBeNull();
    expect(UA.RisCatalogue.loadFeatureRecords).not.toHaveBeenCalled();
  });

  test('official geometry without record locations offers no unreachable evidence lookup', async () => {
    UA.RisCatalogue.loadMap.mockResolvedValue(partitionSnapshot([partitionFeature()]));
    UA.RisCatalogue.loadFeatureRecords = jest.fn().mockResolvedValue({ records: [{ ...records[0], locationCount: 0 }], links: [{ recordId: 'A', locationId: 'official:shape', accuracy: 'official' }], nextPage: null, complete: true });
    UA.refreshContextOverlays(ctx); checkbox('Ratsvorgänge').click(); await flush();
    risFeatures(ctx.map)[0].openPopup(); await flush();
    const popup = document.querySelector('.ua-ris-popup');
    expect(popup.textContent).toContain('Amtlich verortet');
    expect(popup.textContent).not.toContain('Ortsbeleg laden');
    expect(popup.querySelector('a').href).toBe(validUrl);
  });

  test('popup reflow preserves a surviving focused link and scroll, and never steals outside focus', async () => {
    const related = deferred();
    UA.RisCatalogue.loadMap.mockResolvedValue(partitionSnapshot([partitionFeature()]));
    UA.RisCatalogue.loadFeatureRecords = jest.fn().mockResolvedValue({ records: [records[0]], links: [{ recordId: 'A', accuracy: 'official' }], nextPage: null, complete: true });
    UA.RisCatalogue.loadRelatedRecords = jest.fn().mockReturnValue(related.promise);
    UA.refreshContextOverlays(ctx); checkbox('Ratsvorgänge').click(); await flush();
    const layer = risFeatures(ctx.map)[0]; layer.openPopup(); await flush();
    const content = document.querySelector('.leaflet-popup-content');
    [...content.querySelectorAll('button')].find(b => b.textContent === 'Verknüpfte Vorgänge anzeigen').click();
    const link = content.querySelector('a'); link.focus(); content.scrollTop = 123; content.scrollLeft = 9;
    const popup = layer.getPopup(), update = popup.update.bind(popup);
    jest.spyOn(popup, 'update').mockImplementation(() => { update(); content.scrollTop = content.scrollLeft = 0; return popup; });
    related.resolve({ records: [records[3]], nextPage: 1, complete: true }); await flush();
    expect(document.activeElement).toBe(link);
    expect(content.scrollTop).toBe(123); expect(content.scrollLeft).toBe(9);
    const outside = document.createElement('button'); document.body.append(outside);
    const next = deferred(); UA.RisCatalogue.loadRelatedRecords.mockReturnValue(next.promise);
    [...content.querySelectorAll('button')].find(b => b.textContent === 'Weitere verknüpfte Vorgänge laden').click();
    outside.focus();
    next.resolve({ records: [records[2]], nextPage: null, complete: true }); await flush();
    expect(document.activeElement).toBe(outside);
  });

  test('last-page action disappearing during reflow moves its focus to the popup status', async () => {
    const next = deferred();
    UA.RisCatalogue.loadMap.mockResolvedValue(partitionSnapshot([partitionFeature()]));
    UA.RisCatalogue.loadFeatureRecords = jest.fn().mockResolvedValueOnce({ records: [records[0]], links: [{ recordId: 'A', accuracy: 'official' }], total: 2, nextPage: 1, complete: true }).mockReturnValueOnce(next.promise);
    UA.refreshContextOverlays(ctx); checkbox('Ratsvorgänge').click(); await flush();
    risFeatures(ctx.map)[0].openPopup(); await flush();
    const content = document.querySelector('.leaflet-popup-content');
    const button = [...content.querySelectorAll('button')].find(b => b.textContent === 'Weitere Vorgänge laden');
    button.focus(); button.click(); content.scrollTop = 87;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.disabled).toBe(false);
    button.click();
    expect(UA.RisCatalogue.loadFeatureRecords).toHaveBeenCalledTimes(2);
    next.resolve({ records: [records[2]], links: [{ recordId: 'C', accuracy: 'official' }], total: 2, nextPage: null, complete: true }); await flush();
    expect(button.hidden).toBe(true);
    expect(document.activeElement).toBe(content.querySelector('[role="status"]'));
    expect(document.activeElement.textContent).toContain('2 von 2');
    expect(content.scrollTop).toBe(87);
  });

  test.each(['legacy', 'partitioned'])('%s popups open the shared record view without loading hidden history', async kind => {
    UA.RisDetails = { open: jest.fn() };
    const sourceContext = { level: 'region', publisher: 'Region Hannover', documentKind: 'Drucksache',
      status: 'proposal', documentDate: '2026-06-01' };
    const entry = { ...records[0], eventCount: 65, relationshipCount: 1, sourceContext };
    if (kind === 'legacy') UA.RisCatalogue.loadMap.mockResolvedValue(snapshot([point], [entry]));
    else {
      UA.RisCatalogue.loadMap.mockResolvedValue(partitionSnapshot([partitionFeature()]));
      UA.RisCatalogue.loadFeatureRecords = jest.fn().mockResolvedValue({ records: [entry],
        links: [{ recordId: 'A', accuracy: 'official' }], nextPage: null, complete: true });
    }
    UA.RisCatalogue.loadRecordEvents = jest.fn();
    UA.RisCatalogue.loadRecordRelationships = jest.fn();
    UA.refreshContextOverlays(ctx); checkbox('Ratsvorgänge').click(); await flush();
    risFeatures(ctx.map)[0].openPopup(); await flush();
    const content = document.querySelector('.leaflet-popup-content');
    expect(content.textContent).toContain('Region Hannover');
    expect(content.textContent).toContain('Dokumentdatum: 2026-06-01');
    const open = [...content.querySelectorAll('button')].find(b => b.textContent === 'Verlauf und Zusammenhänge');
    expect(open).toBeDefined(); open.click();
    expect(UA.RisDetails.open).toHaveBeenCalledWith(ctx, 'A', { trigger: ctx.map.getContainer() });
    expect(UA.RisCatalogue.loadRecordEvents).not.toHaveBeenCalled();
    expect(UA.RisCatalogue.loadRecordRelationships).not.toHaveBeenCalled();
  });

});
