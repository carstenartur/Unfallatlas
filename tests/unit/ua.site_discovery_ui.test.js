'use strict';

const fs = require('fs');
const path = require('path');
const L = require('leaflet');

function setup() {
  const win = { UA: {}, L };
  for (const name of ['ua.ui', 'ua.map_v2', 'ua.site_discovery', 'ua.site_discovery_ui']) {
    const source = fs.readFileSync(path.resolve(__dirname, '../../js', name + '.js'), 'utf8');
    (function (window, L) { eval(source); })(win, L);
  }
  const UA = win.UA;
  UA.setQS = jest.fn();
  UA.saveCityState = jest.fn();
  UA.recomputeAndRender = jest.fn();
  const points = [
    { lat: 52.3702, lon: 9.7302, props: { ujahr: 2023, utyp1: 2, ukategorie: 2 } },
    { lat: 52.3703, lon: 9.7303, props: { ujahr: 2024, utyp1: 3, ukategorie: 3 } },
    { lat: 52.3703, lon: 9.7303, props: { ujahr: 2025, utyp1: 3, ukategorie: 3 } },
    { lat: 52.3704, lon: 9.7304, props: { ujahr: 2025, utyp1: 1, ukategorie: 3 } },
  ];
  const bounds = { south: 52.37, west: 9.73, north: 52.371234567, east: 9.731234567 };
  const turning = points.slice(0, 3);
  const pattern = { key: 'turning:5', label: 'Abbiegen / Einbiegen · Rad + Pkw', points: turning, recentYear: 2025, recentPoints: [turning[2]] };
  UA.SiteDiscovery = {
    ...UA.SiteDiscovery,
    boundsForPoints: jest.fn(() => bounds),
    filterPoints: jest.fn((items, { type }) => type === 'turning'
      ? items.filter(p => [2, 3].includes(p.props.utyp1))
      : items),
    patternForPoints: jest.fn(() => pattern),
    candidates: jest.fn(() => [{
      id: 'oster', kind: 'site', label: 'Friedrichswall / Osterstraße', bounds,
      points: turning.slice(0, 2), count: 2, severeCount: 1, pattern,
      changes: [{ label: 'Stadt Hannover', url: 'https://www.hannover.de/', date: '2025-10-16', precision: 'documented-by' }]
    }]),
    loadSites: jest.fn(async () => []),
  };
  const map = {
    getCenter: () => ({ lat: 52.37, lng: 9.73 }),
    getZoom: () => 12,
    fitBounds: jest.fn(),
    getBounds: () => L.latLngBounds([52.3, 9.7], [52.4, 9.8]),
    addLayer: jest.fn(),
    removeLayer: jest.fn(),
    closePopup: jest.fn(),
  };
  const ctx = {
    map, CITY_RAW: 'Hannover',
    drawnItems: { addLayer: jest.fn(), clearLayers: jest.fn() },
    allPts: points,
    accidentDataCoverage: { mode: 'full-city', complete: true }
  };
  document.body.innerHTML = '<div class="taskActions"><button id="btnDiscover">Prüfbereiche finden</button></div>';
  UA.SiteDiscoveryUI.bind(ctx);
  return { UA, ctx, points, bounds };
}

function clickButton(root, name) {
  const button = [...root.querySelectorAll('button')].find(btn => btn.textContent.includes(name));
  expect(button).toBeDefined();
  button.click();
  return button;
}

function openCluster(UA, ctx, markers) {
  let clusterClick;
  UA.bindClusterPopup(ctx, { on: (name, listener) => { if (name === 'clusterclick') clusterClick = listener; } });
  let content;
  clusterClick({
    layer: {
      getAllChildMarkers: () => markers,
      getBounds: () => L.latLngBounds(markers.map(marker => marker.getLatLng())),
      bindPopup: node => { content = node; return { openPopup() {} }; },
    }
  });
  return content;
}

describe('site discovery controls', () => {
  test('canonical selection uses the original rectangle and exact share coordinates, and clear resets focus', () => {
    const { UA, ctx, bounds } = setup();
    const manual = L.rectangle([[bounds.south, bounds.west], [bounds.north, bounds.east]]);
    UA.setSelectionArea(ctx, manual.getBounds(), { layer: manual });
    expect(ctx.drawnItems.addLayer).toHaveBeenCalledWith(manual);
    expect(ctx.selectionBounds.getNorth()).toBe(bounds.north);
    expect(UA.setQS).toHaveBeenLastCalledWith(expect.objectContaining({
      selNorth: '52.371234567', selEast: '9.731234567'
    }));
    expect(UA.recomputeAndRender).toHaveBeenCalledWith(ctx, 'selectionChanged');
    ctx.discoveryFocus = { bounds, key: 'turning:5', query: {} };
    UA.setSelectionArea(ctx, null);
    expect(ctx.selectionBounds).toBeNull();
    expect(ctx.discoveryFocus).toBeUndefined();
    expect(UA.setQS).toHaveBeenLastCalledWith(expect.objectContaining({ selNorth: null, selEast: null }));
  });

  test('coincident child locations can be marked with no zoom and a distinct whole-area count', () => {
    const { UA, ctx, points, bounds } = setup();
    const markers = [L.marker([points[0].lat, points[0].lon]), L.marker([points[0].lat, points[0].lon])];
    markers[0]._preSpiderfyLatlng = L.latLng(points[0].lat, points[0].lon);
    markers[0].setLatLng([52.3999, 9.7999]);
    const popup = openCluster(UA, ctx, markers);
    expect(popup.querySelector('[onclick]')).toBeNull();
    expect(ctx.selectionBounds).toBeUndefined();
    clickButton(popup, 'Bereich markieren');
    expect(UA.SiteDiscovery.boundsForPoints.mock.calls[0][0]).toEqual([
      { lat: points[0].lat, lon: points[0].lon },
      { lat: points[0].lat, lon: points[0].lon }
    ]);
    expect(ctx.selectionBounds.getEast()).toBe(bounds.east);
    expect(ctx.map.fitBounds).not.toHaveBeenCalled();
    const detail = document.querySelector('#siteDiscoveryPanel');
    expect(detail.textContent).toContain('2 sichtbare Clusterfälle');
    expect(detail.textContent).toContain('4 Fälle insgesamt im Rechteck');
  });

  test('a cluster spanning too much ground leaves selection intact and retains a separate zoom button', () => {
    const { UA, ctx } = setup();
    UA.SiteDiscovery.boundsForPoints.mockReturnValue(null);
    const popup = openCluster(UA, ctx, [L.marker([52.37, 9.73]), L.marker([52.47, 9.83])]);
    clickButton(popup, 'Bereich markieren');
    expect(ctx.selectionBounds).toBeUndefined();
    expect(popup.querySelector('[role=status]').textContent).toMatch(/näher heranzoomen/);
    clickButton(popup, 'Zoom auf Cluster');
    expect(ctx.map.fitBounds).toHaveBeenCalledTimes(1);
  });

  test('the detailed cluster popup keeps both actions when it renders involvement classes', () => {
    const { UA, ctx } = setup();
    ctx.map.getZoom = () => 18;
    UA.COMBO_LABEL = { 5: 'Rad & Pkw <Gruppe>' };
    const marker = L.marker([52.37, 9.73]);
    marker._uaProps = { istrad: '1', istpkw: '1' };
    const popup = openCluster(UA, ctx, [marker]);
    expect(popup.textContent).toContain('Rad & Pkw <Gruppe>');
    expect(popup.querySelector('[data-action="select-cluster"]')).not.toBeNull();
    expect(popup.querySelector('[data-action="zoom-cluster"]')).not.toBeNull();
  });

  test('candidate applies discovery criteria across the exact rectangle, keeps global filters, and labels partial data', async () => {
    const { UA, ctx, points, bounds } = setup();
    ctx.accidentDataCoverage = { mode: 'viewport-partial', complete: false, viewportComplete: true };
    ctx.filteredCapped = [points[0]];
    ctx.ui = { severityEl: { value: '1' } };
    document.querySelector('#btnDiscover').click();
    await Promise.resolve();
    const panel = document.querySelector('#siteDiscoveryPanel');
    const type = panel.querySelector('#siteDiscoveryType');
    type.value = 'turning';
    type.dispatchEvent(new Event('change'));
    expect(panel.textContent).toMatch(/unvollständig/i);
    expect(UA.SiteDiscovery.candidates).toHaveBeenLastCalledWith(points, expect.objectContaining({ type: 'turning' }), []);
    clickButton(panel, 'Friedrichswall / Osterstraße');
    expect(ctx.ui.severityEl.value).toBe('1');
    expect(ctx.discoveryFocus).toEqual({
      bounds, query: { fromYear: null, toYear: null, severity: 'all', type: 'turning', involvement: 'all' }, key: 'turning:5'
    });
    expect(panel.textContent).toContain('3 Fälle nach Suchkriterien');
    expect(panel.textContent).toContain('4 geladene Fälle im Rechteck');
    expect(panel.textContent).toContain('1 Fall im jüngsten Jahr dieses Musters (2025)');
    expect(panel.querySelector('a[href="https://www.hannover.de/"]')).not.toBeNull();
    expect(panel.querySelectorAll('[data-discovery-case]')).toHaveLength(3);
    const markerLayer = ctx.map.addLayer.mock.lastCall[0];
    const markers = markerLayer.getLayers();
    expect(markers).toHaveLength(2);
    expect(markers.every(marker => marker.options.color === '#861878')).toBe(true);
    markers[0].fire('click');
    expect(document.activeElement).toBe(panel.querySelector('[data-discovery-case="1"]'));
    expect(panel.querySelector('[aria-current="true"]').textContent).toContain('2025');
    ctx.CITY_RAW = 'Bonn';
    UA.SiteDiscoveryUI.selectionChanged(ctx);
    expect(ctx.discoveryFocus).toBeUndefined();
    expect(ctx.map.removeLayer).toHaveBeenCalledWith(markerLayer);
    expect(panel.querySelectorAll('[data-discovery-case]')).toHaveLength(0);
  });

  test.each(['open', 'closed'])('updates the case list when the loaded tiles are replaced with the panel %s', async visibility => {
    const { UA, ctx, points } = setup();
    ctx.accidentDataCoverage = { complete: false };
    document.querySelector('#btnDiscover').click();
    await Promise.resolve();
    const panel = document.querySelector('#siteDiscoveryPanel');
    clickButton(panel, 'Friedrichswall / Osterstraße');
    const oldLayer = ctx.map.addLayer.mock.lastCall[0];
    if (visibility === 'closed') clickButton(panel, 'Schließen');
    ctx.allPts = [points[0]];
    UA.SiteDiscoveryUI.dataChanged(ctx);
    expect(panel.querySelectorAll('[data-discovery-case]')).toHaveLength(1);
    expect(panel.textContent).toContain('1 geladener Fall im Rechteck');
    expect(ctx.map.removeLayer).toHaveBeenCalledWith(oldLayer);
    const [marker] = ctx.map.addLayer.mock.lastCall[0].getLayers();
    marker.fire('click');
    expect(panel.hidden).toBe(false);
    const selected = panel.querySelector('[data-discovery-case][aria-current="true"]');
    expect(selected?.textContent).toContain('2023');
    expect(document.activeElement).toBe(selected);
  });

  test('offers newly loaded years in both filters while preserving the chosen range', () => {
    const { UA, ctx, points } = setup();
    const trigger = document.querySelector('#btnDiscover');
    trigger.click();
    const panel = document.querySelector('#siteDiscoveryPanel');
    const from = panel.querySelector('#siteDiscoveryFromYear');
    const to = panel.querySelector('#siteDiscoveryToYear');
    from.value = '2023';
    to.value = '2025';
    to.dispatchEvent(new Event('change'));
    clickButton(panel, 'Schließen');

    ctx.allPts = [{ ...points[0], props: { UJAHR: '2026' } }];
    UA.SiteDiscoveryUI.dataChanged(ctx);
    trigger.click();

    for (const control of [from, to]) {
      expect([...control.options].map(option => option.value)).toEqual(['', '2023', '2025', '2026']);
    }
    expect(from.value).toBe('2023');
    expect(to.value).toBe('2025');
    to.value = '2026';
    to.dispatchEvent(new Event('change'));
    expect(UA.SiteDiscovery.candidates).toHaveBeenLastCalledWith(ctx.allPts,
      expect.objectContaining({ fromYear: 2023, toYear: 2026 }), []);
  });
});
