'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const L = require('leaflet');
const fixtures = path.join(__dirname, '../fixtures/traffic/duesseldorf');
const asset = path.join(__dirname, '../../data/mobility/duesseldorf-mannesmannufer-2024.json.gz');
const snapshot = () => JSON.parse(gunzipSync(fs.readFileSync(asset)));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('the shipped station and every pair of hourly values agree with the pinned sources', () => {
  const data = snapshot();
  const rows = gunzipSync(fs.readFileSync(path.join(fixtures, 'mannesmannufer2024-original.csv.gz')))
    .toString('utf8').trim().split(/\r?\n/);
  const header = rows.shift().split(';');
  expect(data.directions.map(item => item.direction)).toEqual(header.slice(1, 3));
  const expected = Object.fromEntries(rows.map(line => {
    const [hour, south, north] = line.split(';');
    return [hour, [Number(south), Number(north)]];
  }));
  expect(data.hours).toEqual(expected);
  expect(data.station.geometry.coordinates).toEqual([6.76712, 51.22015]);
  expect(data.way.id).toBe('1219366607');
  expect(data.sources.counts.contentHash).toBe(require('../fixtures/traffic/duesseldorf/provenance.json').countDistribution.sha256);
  expect(data.timeZone).toBeNull();
  expect(data.intervalBoundary).toBeNull();
});

describe('Düsseldorf mobility control', () => {
  let ctx, api, fetchJson;
  beforeEach(() => {
    jest.resetModules();
    window.L = L;
    fetchJson = jest.fn(async () => snapshot());
    window.UA = { DataResources: { fetchJson }, syncAllToUrl: jest.fn() };
    require('../../js/ua.duesseldorf_bike_counts.js');
    api = window.UA.DuesseldorfBikeCounts;
    ctx = { CITY_RAW: 'Düsseldorf', map: L.map(document.body.appendChild(document.createElement('div')))
      .setView([51.22, 6.77], 12), contextOverlays: { active: {} } };
  });
  afterEach(() => {
    ctx.map.remove();
    document.body.replaceChildren();
    delete window.UA;
    delete window.L;
  });
  function findMarker() {
    let marker;
    ctx.map.eachLayer(layer => { if (layer instanceof L.Marker) marker = layer; });
    return marker;
  }

  test('the switch opens a station with live hour selection, both directions, true zero and missing hour', async () => {
    const control = document.body.appendChild(api.controlContent(ctx));
    expect(fetchJson).not.toHaveBeenCalled();
    control.querySelector('input[name=bikeCounts]').click();
    await tick();
    expect(fetchJson).toHaveBeenCalledTimes(1);
    const marker = findMarker();
    expect(marker.getLatLng()).toMatchObject({ lat: 51.22015, lng: 6.76712 });
    expect(marker.getAttribution()).toMatch(/Landeshauptstadt Düsseldorf/);
    const popup = marker.getPopup().getContent();
    const date = popup.querySelector('input[type=date]');
    const hour = popup.querySelector('select');
    function select(day, h) {
      date.value = day;
      hour.value = h;
      date.dispatchEvent(new Event('change'));
      return popup.querySelector('output').textContent;
    }
    expect(select('2024-01-01', '00')).toMatch(/Sueden.*1 Fahrrad\/Stunde.*Norden.*0 Fahrräder\/Stunde/s);
    expect(select('2024-03-31', '02')).toMatch(/kein Stundenwert/i);
    expect(select('2024-03-31', '03')).toMatch(/Sueden/);
    expect(popup.textContent).toMatch(/Zeitzone und Intervallgrenzen/);
    for (const license of ['DL-DE-BY-2.0', 'DL-DE-Zero-2.0', 'ODbL-1.0'])
      expect([...popup.querySelectorAll('a')].map(a => a.textContent)).toContain(license);
    control.querySelector('input').click();
    expect(findMarker()).toBeUndefined();
    expect(window.UA.syncAllToUrl).toHaveBeenCalledWith(ctx);
  });

  test('failed requests can retry and a late result cannot attach to a different city', async () => {
    ctx.CITY_RAW = 'Duesseldorf';
    ctx.contextOverlays.active.bikeCounts = true;
    fetchJson.mockRejectedValueOnce(new Error('offline'));
    const control = document.body.appendChild(api.controlContent(ctx));
    await tick();
    expect(control.textContent).toMatch(/nicht geladen/);
    const input = control.querySelector('input');
    input.click();
    let resolve;
    fetchJson.mockImplementationOnce(() => new Promise(ok => { resolve = ok; }));
    input.click();
    await tick();
    ctx.CITY_RAW = 'Hannover';
    expect(api.controlContent(ctx)).toBeNull();
    resolve(snapshot());
    await tick();
    expect(findMarker()).toBeUndefined();
  });
});
