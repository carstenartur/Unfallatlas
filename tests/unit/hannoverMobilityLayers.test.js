'use strict';

const L = require('leaflet');
const source = 'https://www.hannover.de/schulwegplaene';
const plan = 'https://www.hannover.de/content/download/1/file/schulwegplan.pdf';
const alternatePlan = 'https://www.hannover.de/content/download/2/file/umgebung.pdf';

const schools = {
  source,
  year: 2026,
  schools: [{
    name: 'Beispielschule',
    osmId: 'osm:way:1',
    plans: [
      { name: 'Schulwegplan', url: plan },
      { name: 'Kleinerer Umgebungsausschnitt', url: alternatePlan },
      { name: 'Ungültige URL', url: 'javascript:alert(1)' },
      { name: 'Blob-URL', url: 'blob:https://www.hannover.de/fake-plan' },
    ],
  }],
};

const schoolPoi = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [9.72, 52.37] },
  properties: { id: 'osm:way:1', type: 'school' },
};

const station = {
  type: 'Feature',
  id: 'wheel-counter-123',
  geometry: { type: 'Point', coordinates: [9.71, 52.36] },
  properties: {
    name: '<img src=x onerror=alert(1)>',
    externalId: '123',
    wheelCountingDataDaily: [
      { datetime: '2026-10-25 00:00:00', value: '0' },
      { datetime: '2026-10-23 00:00:00', value: '987' },
    ],
    wheelCountingDataMonthly: [],
  },
};

let ctx;
let UA;

beforeEach(() => {
  jest.resetModules();
  window.L = L;
  window.UA = {
    DataResources: { fetchJson: jest.fn(async () => schools) },
    syncAllToUrl: jest.fn(),
  };
  require('../../js/ua.hannover_layers.js');
  UA = window.UA;
  const host = document.body.appendChild(document.createElement('div'));
  ctx = {
    map: L.map(host).setView([52.37, 9.72], 14),
    CITY_RAW: 'Hannover',
    contextOverlays: { active: {} },
  };
});

afterEach(() => {
  ctx?.map.remove();
  document.body.replaceChildren();
  delete window.UA;
  delete window.L;
});

function markers() {
  const result = [];
  ctx.map.eachLayer((layer) => {
    if (layer instanceof L.Marker) result.push(layer);
  });
  return result;
}

function toggle(control, name) {
  control.querySelector(`input[name="${name}"]`).click();
}

function selectFile(control, file) {
  const input = control.querySelector('input[type=file]');
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new Event('change'));
}

function localFile(control, contents) {
  selectFile(control, new File([JSON.stringify(contents)], 'radzaehler.geojson'));
  return new Promise((resolve, reject) => {
    const status = control.querySelector('.mobility-layer-status');
    const observer = new MutationObserver(() => {
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    });
    observer.observe(status, { subtree: true, childList: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error('The file read did not finish'));
    }, 1000);
  });
}

test('loads school metadata only when enabled and renders linked school markers once POIs arrive', async () => {
  const control = document.body.appendChild(UA.HannoverLayers.controlContent(ctx));
  expect(UA.DataResources.fetchJson).not.toHaveBeenCalled();

  toggle(control, 'schoolRoutes');
  UA.HannoverLayers.controlContent(ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(UA.DataResources.fetchJson).toHaveBeenCalledTimes(1);
  expect(UA.DataResources.fetchJson).toHaveBeenCalledWith('schoolPlans', { city: 'Hannover' });
  expect(markers()).toHaveLength(0);

  ctx.poiData = { features: [schoolPoi] };
  UA.HannoverLayers.controlContent(ctx);
  UA.HannoverLayers.controlContent(ctx);

  const [marker] = markers();
  expect(markers()).toHaveLength(1);
  expect(marker.getLatLng()).toMatchObject({ lat: 52.37, lng: 9.72 });
  expect(marker.getElement().getAttribute('aria-label')).toContain('Beispielschule');
  expect(Array.from(marker.getPopup().getContent().querySelectorAll('a'), (a) => a.href))
    .toEqual([plan, alternatePlan]);
  expect(UA.syncAllToUrl).toHaveBeenCalledWith(ctx);
});

test('a late school response respects the current flag and school markers detach on a city change', async () => {
  const control = document.body.appendChild(UA.HannoverLayers.controlContent(ctx));
  ctx.poiData = { features: [schoolPoi] };
  toggle(control, 'schoolRoutes');
  toggle(control, 'schoolRoutes');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(markers()).toHaveLength(0);

  toggle(control, 'schoolRoutes');
  expect(markers()).toHaveLength(1);
  ctx.CITY_RAW = 'Bonn';
  expect(UA.HannoverLayers.controlContent(ctx)).toBeNull();
  expect(markers()).toHaveLength(0);
});

test('an already requested school source still resolves for Hannover if the context changes city', async () => {
  const control = document.body.appendChild(UA.HannoverLayers.controlContent(ctx));
  toggle(control, 'schoolRoutes');
  ctx.CITY_RAW = 'Bonn';
  expect(UA.HannoverLayers.controlContent(ctx)).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(UA.DataResources.fetchJson).not.toHaveBeenCalledWith('schoolPlans', { city: 'Bonn' });
  expect(markers()).toHaveLength(0);
});

test('local VMZ import deduplicates stations and displays the latest reported zero with its date', async () => {
  const control = document.body.appendChild(UA.HannoverLayers.controlContent(ctx));
  toggle(control, 'bikeCounts');
  await localFile(control, { type: 'FeatureCollection', features: [station, station] });

  expect(markers()).toHaveLength(1);
  const popup = markers()[0].getPopup().getContent();
  expect(popup.querySelector('img')).toBeNull();
  expect(popup.textContent).toContain(station.properties.name);
  expect(popup.textContent).toMatch(/25\.10\.2026.*\b0\b/);
  expect(popup.textContent).not.toContain('987');
  expect(popup.textContent).toMatch(/Monat.*kein Messwert/);
  expect(popup.querySelector('a').href)
    .toBe('https://www.vmz-niedersachsen.de/region-hannover/radzaehler/wheel-counter-123/');
  expect(UA.DataResources.fetchJson).not.toHaveBeenCalled();

  const bounds = { south: 52.35, north: 52.37, west: 9.70, east: 9.72 };
  expect(UA.HannoverLayers.stationReadings(ctx, bounds, { fromYear: 2026, toYear: 2026 }))
    .toEqual([expect.objectContaining({ name: station.properties.name, text: expect.stringMatching(/25\.10\.2026.*0/) })]);
  expect(UA.HannoverLayers.stationReadings(ctx, bounds, { toYear: 2025 })).toEqual([]);
  expect(UA.HannoverLayers.stationReadings(ctx, { ...bounds, west: 9.72 }, {})).toEqual([]);

  toggle(control, 'bikeCounts');
  expect(markers()).toHaveLength(0);
  toggle(control, 'bikeCounts');
  expect(markers()).toHaveLength(1);
});

test.each([
  ['coordinates', { ...station, geometry: { type: 'Point', coordinates: [900, 52.36] } }],
  ['date', { ...station, properties: { ...station.properties, wheelCountingDataDaily: [{ datetime: '2026-02-30 00:00:00', value: '1' }] } }],
  ['count', { ...station, properties: { ...station.properties, wheelCountingDataDaily: [{ datetime: '2026-10-25 00:00:00', value: '-1' }] } }],
  ['station ID', { ...station, id: 'https://example.org/' }],
])('a malformed VMZ %s leaves the previously loaded station in place', async (_, invalidStation) => {
  const control = document.body.appendChild(UA.HannoverLayers.controlContent(ctx));
  toggle(control, 'bikeCounts');
  await localFile(control, { type: 'FeatureCollection', features: [station] });
  const [previous] = markers();
  await localFile(control, { type: 'FeatureCollection', features: [invalidStation] });
  expect(markers()).toEqual([previous]);
  expect(control.querySelector('.mobility-layer-status').textContent).toMatch(/ungültig|nicht gelesen/i);
});

test('a file above the import limit is rejected before reading it', () => {
  const control = document.body.appendChild(UA.HannoverLayers.controlContent(ctx));
  toggle(control, 'bikeCounts');
  const read = jest.spyOn(window.FileReader.prototype, 'readAsText');
  try {
    const file = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'radzaehler.geojson');
    selectFile(control, file);
    expect(read).not.toHaveBeenCalled();
    expect(control.querySelector('.mobility-layer-status').textContent).toContain('2 MB');
  } finally {
    read.mockRestore();
  }
});

test('Hannover opens six DGM1 terrain reference profiles including both excluded bridge surfaces', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const control = UA.HannoverLayers.controlContent(ctx);
  const target = [...control.querySelectorAll('a')].find(a => a.textContent.includes('Geländeprofile'));
  const pagePath = path.resolve(__dirname, '../..', target.getAttribute('href'));
  const page = new DOMParser().parseFromString(fs.readFileSync(pagePath, 'utf8'), 'text/html');
  const dataPath = path.join(path.dirname(pagePath), page.querySelector('a[download]').getAttribute('href'));
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  expect(data.surveyYear).toBe(2010);
  expect(data.verticalDatum).toBeNull();
  const rows = [...page.querySelectorAll('tbody tr')];
  expect(rows).toHaveLength(6);
  expect(data.profiles.flatMap(entry => entry.profile)).toHaveLength(292);
  for (const { wayId, profile } of data.profiles) {
    const row = rows.find(entry => entry.querySelector('a').href.endsWith('/way/' + wayId));
    const slopes = [];
    profile.forEach(([distance, height], index) => {
      for (const [end, elevation] of profile.slice(index + 1)) slopes.push(100 * (elevation - height) / (end - distance));
    });
    slopes.sort((a,b) => a - b);
    const slope = (slopes[Math.floor((slopes.length - 1) / 2)] + slopes[Math.floor(slopes.length / 2)]) / 2;
    const shown = Number(row.cells[2].textContent.replace('−', '-').replace(',', '.').replace('≈', '').replace('%', '').trim());
    expect(slope).toBeCloseTo(shown, 2);
    if (['23838108', '24011492'].includes(wayId)) expect(row.textContent).toMatch(/Fahrbahnneigung.*ausgeschlossen/);
  }
  ctx.CITY_RAW = 'Bonn';
  expect(UA.HannoverLayers.controlContent(ctx)).toBeNull();
});
