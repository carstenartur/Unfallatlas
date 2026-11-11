'use strict';

const fs = require('fs');
const path = require('path');
const L = require('leaflet');

function loadScripts(win, names) {
  for (const name of names) {
    const source = fs.readFileSync(path.resolve(__dirname, '../../js', name + '.js'), 'utf8');
    (function (window, L) { eval(source); })(win, L);
  }
}

function setup(beforeBind) {
  const win = { UA: {}, L };
  loadScripts(win, ['ua.ui', 'ua.map_v2', 'ua.site_discovery', 'ua.site_discovery_ui']);
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
  beforeBind?.({ win, UA, ctx, points, bounds });
  UA.SiteDiscoveryUI.bind(ctx);
  return { UA, ctx, points, bounds };
}

const networkId = 'friedrichswall-junction';
const networkRevision = 'snapshot-2026-10-15';
const networkQuery = { fromYear: null, toYear: null, severity: 'all', type: 'all', involvement: 'all' };

function registerReviewNetwork({ win, UA, ctx, points, bounds }) {
  loadScripts(win, ['ua.filters', 'ua.spatial-grid', 'ua.site_discovery']);
  const area = { id: 'oster', label: 'Friedrichswall / Osterstraße', bounds, changes: [] };
  UA.SiteDiscovery = { ...UA.SiteDiscovery, loadSites: async () => [area] };
  for (const point of points) Object.assign(point.props, {
    year: point.props.ujahr, utyp1: 3, istrad: '1', istpkw: '1', ustunde: '12',
  });
  // Three cases belong to this junction. Another turning case is in the same
  // rectangle but has an ambiguous assignment, and a fifth is outside it.
  const sites = [
    { id: networkId, label: 'Knoten Friedrichswall', kind: 'junction', bounds, changes: [], coordinates: [52.37025, 9.73025] },
    { id: 'oster-crossing', label: 'Querung Osterstraße', kind: 'crossing', bounds, changes: [], coordinates: [52.37031, 9.73031] },
    { id: 'wall-segment', label: 'Abschnitt Friedrichswall', kind: 'segment', bounds, changes: [], coordinates: [52.3701, 9.7301, 52.3703, 9.7303] },
  ];
  ctx.allPts = [...points, { lat: 52.38, lon: 9.74, props: { year: 2025 } }];
  const network = { city: ctx.CITY_RAW, revision: networkRevision, sites: new Map(sites.map(site => [site.id, site])), source: {
    label: 'Kommunales Netzregister', url: 'https://example.com/netz', date: '2026-10-15',
  } };
  const row = (result, id, query, predicate) => {
    const entry = result.bySite.get(id);
    if (!entry) return null;
    const members = UA.SiteDiscovery.filterPoints(predicate ? entry.points.filter(predicate) : entry.points, query);
    return { ...entry, points: members, count: members.length,
      severeCount: members.filter(point => point.props.ukategorie === 2).length,
      pattern: UA.SiteDiscovery.patternForPoints(members) };
  };
  UA.ReviewNetwork = {
    load: jest.fn(async () => network),
    analyze: (loaded, allPoints) => ({ network: loaded,
      counts: { total: 5, assigned: 3, ambiguous: 1, unmatched: 1 },
      bySite: new Map(sites.map(site => [site.id, { ...site, points: site.id === networkId ? allPoints.slice(0, 3) : [] }])) }),
    row,
    rows: (result, query, { kind, onlyEmpty }) => sites
      .map(site => row(result, site.id, query))
      .filter(item => (kind === 'all' || item.kind === kind) && (onlyEmpty ? item.count === 0 : item.count > 0)),
  };
}

function restoreNetworkFocus(ctx, bounds, options = {}) {
  const { revision = networkRevision, query = networkQuery, key = 'turning:5' } = options;
  ctx.selectionBounds = L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]);
  ctx.discoveryFocus = { bounds, key, query, site: { id: networkId, revision } };
}

function changeControl(panel, labelText, value) {
  const label = [...panel.querySelectorAll('label')].find(item => item.firstChild?.textContent === labelText
    || item.textContent.trim() === labelText);
  expect(label).toBeDefined();
  const control = label.querySelector('select, input');
  if (control.type === 'checkbox') control.checked = value;
  else control.value = [...control.options].find(option => option.textContent === value).value;
  control.dispatchEvent(new Event('change'));
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

  test.each(['before', 'after'])('keeps the clicked case when tiles commit %s the marker click', async timing => {
    const { UA, ctx, points } = setup();
    document.querySelector('#btnDiscover').click();
    await Promise.resolve();
    const panel = document.querySelector('#siteDiscoveryPanel');
    clickButton(panel, 'Friedrichswall / Osterstraße');
    clickButton(panel, 'Schließen');
    const marker = ctx.map.addLayer.mock.lastCall[0].getLayers().find(m => m.getLatLng().lat === points[0].lat);

    // extractPoints creates new point wrappers for the same cached tile features.
    const refreshed = [{ ...points[0] }];
    if (timing === 'before') ctx.allPts = refreshed;
    marker.fire('click');
    if (timing === 'after') ctx.allPts = refreshed;
    UA.SiteDiscoveryUI.dataChanged(ctx);

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

describe('optional network register', () => {
  test('loads on open and keeps assigned cases separate from the rectangle search', async () => {
    const { UA, ctx, bounds } = setup(registerReviewNetwork);
    expect(UA.ReviewNetwork.load).not.toHaveBeenCalled();
    document.querySelector('#btnDiscover').click();
    const result = await ctx.reviewNetworkPromise;
    expect(result?.counts).toEqual({ total: 5, assigned: 3, ambiguous: 1, unmatched: 1 });
    expect(result).toBe(ctx.reviewNetworkResult);
    const panel = document.querySelector('#siteDiscoveryPanel');
    expect(panel.querySelector('#siteDiscoveryMode').selectedOptions[0]?.textContent).toBe('Netzregister');
    expect(panel.textContent).toMatch(/5 Fälle insgesamt.*3 zugeordnet.*1 mehrdeutig.*1 ohne Zuordnung/);
    expect(panel.querySelector('a[href="https://example.com/netz"]')?.parentElement.textContent).toMatch(/3 Netzstellen.*15\.10\.2026/);
    clickButton(panel, 'Knoten Friedrichswall');
    expect(ctx.discoveryFocus).toEqual({ bounds, query: networkQuery, key: 'turning:5',
      site: { id: networkId, revision: networkRevision } });
    expect(panel.textContent).toContain('3 zugeordnete Fälle nach Suchkriterien');
    expect(panel.textContent).toContain('4 Fälle insgesamt im Rechteck');
    expect(panel.querySelectorAll('[data-discovery-case]')).toHaveLength(3);
    expect(panel.querySelectorAll('.site-discovery-focus-case')).toHaveLength(3);

    changeControl(panel, 'Suchmodus', 'Prüfbereiche');
    clickButton(panel, 'Friedrichswall / Osterstraße');
    expect(ctx.discoveryFocus.site).toBeUndefined();
    expect(panel.querySelectorAll('[data-discovery-case]')).toHaveLength(4);
  });

  test.each([
    ['Querung', 'Querung Osterstraße', 'oster-crossing', [[52.37031, 9.73031]]],
    ['Straßenabschnitt', 'Abschnitt Friedrichswall', 'wall-segment', [[52.3701, 9.7301], [52.3703, 9.7303]]],
  ])('highlights an inventoried %s without an assigned case', async (kind, label, id, coordinates) => {
    const { ctx } = setup(registerReviewNetwork);
    document.querySelector('#btnDiscover').click();
    await ctx.reviewNetworkPromise;
    const panel = document.querySelector('#siteDiscoveryPanel');
    changeControl(panel, 'Netztyp', kind);
    expect(panel.querySelectorAll('[data-discovery-candidate]')).toHaveLength(0);
    changeControl(panel, 'Ohne zugeordneten Fall nach Suchkriterien', true);
    expect(panel.querySelectorAll('[data-discovery-candidate]')).toHaveLength(1);
    clickButton(panel, label);
    expect(ctx.discoveryFocus.site.id).toBe(id);
    expect(panel.textContent).toContain('0 zugeordnete Fälle nach Suchkriterien');
    expect(panel.textContent).toContain('4 Fälle insgesamt im Rechteck');
    expect(panel.querySelectorAll('[data-discovery-case]')).toHaveLength(0);
    expect(panel.querySelector('.site-discovery-case-list')).toBeNull();
    expect(ctx.map.addLayer).toHaveBeenCalledTimes(1);
    const [geometry] = ctx.map.addLayer.mock.lastCall[0].getLayers();
    expect(geometry.options.interactive).toBe(false);
    expect((geometry.getLatLngs?.() || [geometry.getLatLng()]).map(({ lat, lng }) => [lat, lng])).toEqual(coordinates);
  });

  test.each([true, false])('keeps the original area controls without a usable register (complete data: %s)', async complete => {
    const { UA, ctx } = setup(options => {
      registerReviewNetwork(options);
      options.ctx.accidentDataCoverage.complete = complete;
      if (complete) options.UA.ReviewNetwork.load.mockResolvedValue(null);
    });
    document.querySelector('#btnDiscover').click();
    await ctx.reviewNetworkPromise;
    const panel = document.querySelector('#siteDiscoveryPanel');
    expect([...panel.querySelectorAll('label')].some(label => !label.closest('[hidden]')
      && label.firstChild?.textContent === 'Suchmodus')).toBe(false);
    expect(UA.ReviewNetwork.load).toHaveBeenCalledTimes(complete ? 1 : 0);
    clickButton(panel, 'Friedrichswall / Osterstraße');
    expect(ctx.discoveryFocus.site).toBeUndefined();
  });

  test('loads a report-link focus behind the export panel and reapplies the saved pattern to the filtered assigned cases', async () => {
    const { ctx } = setup(options => {
      registerReviewNetwork(options);
      options.UA.qBool = name => name === 'export';
      options.ctx.ui = {
        severityEl: { value: '3' }, roadConditionEl: { value: 'all' }, dayTypeEl: { value: 'all' },
        hFromEl: { value: '0' }, hToEl: { value: '23' }, incBikeEl: { checked: true },
        incPedEl: { checked: false }, incCarEl: { checked: false }, incMotoEl: { checked: false },
      };
      options.ctx.involvementMode = 'or';
      restoreNetworkFocus(options.ctx, options.bounds, { query: { ...networkQuery, mapFilters: true } });
    });
    expect(ctx.reviewNetworkPromise).toBeInstanceOf(Promise);
    await ctx.reviewNetworkPromise;
    const panel = document.querySelector('#siteDiscoveryPanel');
    expect(panel.hidden).toBe(true);
    expect(panel.textContent).toContain('2 zugeordnete Fälle nach Such- und Kartenfiltern der Musterkarte');
    expect(panel.querySelectorAll('[data-discovery-case]')).toHaveLength(2);
    expect(panel.querySelectorAll('.site-discovery-focus-case')).toHaveLength(2);
    expect(ctx.discoveryFocus.key).toBe('turning:5');
  });

  test.each(['report', 'discovery'])('retries a failed shared network when reopening the %s, once per opening', async target => {
    const { UA, ctx } = setup(options => {
      registerReviewNetwork(options);
      options.UA.qBool = name => name === 'export';
      options.ctx.ui = { btnOpenExport: document.createElement('button') };
      options.UA.ReviewNetwork.load.mockResolvedValueOnce(null);
      restoreNetworkFocus(options.ctx, options.bounds);
    });
    await expect(ctx.reviewNetworkPromise).resolves.toBeNull();
    UA.SiteDiscoveryUI.dataChanged(ctx);
    expect(UA.ReviewNetwork.load).toHaveBeenCalledTimes(1);
    const open = target === 'report' ? ctx.ui.btnOpenExport : document.querySelector('#btnDiscover');
    open.click();
    UA.SiteDiscoveryUI.dataChanged(ctx);
    const result = await ctx.reviewNetworkPromise;
    expect(UA.ReviewNetwork.load).toHaveBeenCalledTimes(2);
    expect(result?.network.revision).toBe(networkRevision);
    expect(document.querySelector('#siteDiscoveryPanel').textContent).toContain('Knoten Friedrichswall');
    open.click();
    await Promise.resolve();
    expect(UA.ReviewNetwork.load).toHaveBeenCalledTimes(2);
  });

  test.each(['revision', 'bounds', 'profile'])('retains the original rectangle when the saved %s is unavailable', async mismatch => {
    const { ctx } = setup(options => {
      registerReviewNetwork(options);
      const bounds = mismatch === 'bounds' ? { ...options.bounds, east: 9.731 } : options.bounds;
      const revision = mismatch === 'revision' ? 'older-snapshot' : networkRevision;
      if (mismatch === 'profile') options.UA.ReviewNetwork.load.mockResolvedValue(null);
      restoreNetworkFocus(options.ctx, bounds, { revision });
    });
    const original = ctx.discoveryFocus;
    await ctx.reviewNetworkPromise;
    const panel = document.querySelector('#siteDiscoveryPanel');
    const detail = panel.querySelector('.site-discovery-detail');
    expect(detail.textContent).toMatch(/gespeicherte Netzstand ist nicht verfügbar/i);
    expect(detail.textContent).toContain('4 Fälle insgesamt im Rechteck');
    expect(detail.querySelectorAll('.site-discovery-focus-case')).toHaveLength(0);
    expect(ctx.discoveryFocus).toEqual(original);
    expect(ctx.selectionBounds.getEast()).toBe(original.bounds.east);
  });
});
