const hannoverGremien = require('../../templates/gremien_hannover.json');

describe('Hannover committee attribution in the export report', () => {
  const savedFetch = global.fetch;

  afterEach(() => {
    global.fetch = savedFetch;
    delete window.UA;
  });

  async function computeReport(address, officialDistricts, corners) {
    jest.resetModules();
    global.fetch = jest.fn(async (url) => {
      if (url.startsWith('https://nominatim.openstreetmap.org/reverse?')) {
        return { ok: Boolean(address), json: async () => ({ address: { city: 'Hannover', ...address } }) };
      }
      if (url === 'templates/gremien_hannover.json') {
        return { ok: true, json: async () => hannoverGremien };
      }
      if (url === 'data/mobility/hannover-stadtbezirke.geojson' && officialDistricts) {
        return { ok: true, json: async () => officialDistricts };
      }
      return { ok: false };
    });

    require('../../js/ua.utils.js');
    require('../../js/ua.accident_views.js');
    require('../../js/ua.export_template_defaults.js');
    require('../../js/ua.export_v2.js');
    return window.UA.computeExportReport({
      CITY_RAW: 'Hannover',
      allPts: [],
      selectionBounds: {
        getSouthWest: () => corners?.sw || ({ lat: 52.391108, lng: 9.719819 }),
        getNorthEast: () => corners?.ne || ({ lat: 52.391889, lng: 9.721093 }),
        getCenter: () => ({ lat: 52.3914985, lng: 9.720456 }),
        contains: () => false
      },
      exportOptions: { includeCosts: false, includeMeasures: false }
    });
  }

  test('attributes Engelbosteler Damm/Bodestraße to Stadtbezirksrat Nord', async () => {
    const report = await computeReport({ road: 'Engelbosteler Damm', city_district: 'Nord', suburb: 'Nordstadt' });

    expect(report.structured.meta.gremium).toMatchObject({
      gremium: 'Stadtbezirksrat Nord',
      typ: 'Bezirksrat',
      kontakt: '18.62.13.brb@hannover-stadt.de',
      confidence: 'hoch'
    });
    expect(report.text).toContain('Stadtbezirksrat Nord');
  });

  test('uses a recognized city district with an unmapped neighborhood label', async () => {
    const report = await computeReport({ city_district: 'Buchholz-Kleefeld', suburb: 'Nicht zugeordnetes Quartier' });

    expect(report.structured.meta.gremium.gremium).toBe('Stadtbezirksrat Buchholz-Kleefeld');
  });

  test.each([
    ['Ahlem', 'Ahlem-Badenstedt-Davenstedt'],
    ['Heideviertel', 'Buchholz-Kleefeld'],
    ['Kronsberg-Süd', 'Kirchrode-Bemerode-Wülferode'],
    ['Südstadt', 'Südstadt-Bult'],
    ['Vahrenheide', 'Bothfeld-Vahrenheide'],
    ['Vinnhorst', 'Nord'],
    ['Waldheim', 'Döhren-Wülfel'],
    ['Zoo', 'Mitte']
  ])('resolves %s without a city district label', async (suburb, district) => {
    const report = await computeReport({ suburb });

    expect(report.structured.meta.gremium.gremium).toBe(`Stadtbezirksrat ${district}`);
  });

  test.each([
    { city_district: 'Mitte', suburb: 'Nordstadt' },
    { city: 'Langenhagen', city_district: 'Mitte', suburb: 'Mitte' },
    { city_district: 'Unbekannt', suburb: 'Unbekannt' }
  ])('keeps the recipient unresolved for %j', async (address) => {
    const report = await computeReport(address);

    expect(report.structured.meta.gremium).toMatchObject({
      gremium: null,
      kontakt: null,
      confidence: 'unbekannt',
      hinweis: hannoverGremien.fallback
    });
  });

  function officialBoundaries(east) {
    return {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { district: 'Nord' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[9.71, 52.39], [east, 52.39], [east, 52.40], [9.71, 52.40], [9.71, 52.39]]],
        },
      }],
    };
  }

  test('uses the official district containing the marked area when reverse geocoding fails', async () => {
    const report = await computeReport(null, officialBoundaries(9.73));
    expect(report.structured.meta.gremium.gremium).toBe('Stadtbezirksrat Nord');
  });

  test('leaves the recipient open when the selection crosses an official boundary', async () => {
    const report = await computeReport({ city_district: 'Nord', suburb: 'Nordstadt' }, officialBoundaries(9.72));
    expect(report.structured.meta.gremium.gremium).toBeNull();
  });

  test('assigns Nord when a diagonal official boundary envelope overlaps but misses the selection', async () => {
    const districts = JSON.parse(require('fs').readFileSync(
      require('path').join(__dirname, '../../data/mobility/hannover-stadtbezirke.geojson'), 'utf8'
    ));
    const report = await computeReport(null, districts, {
      sw: { lat: 52.4046776, lng: 9.7207568 },
      ne: { lat: 52.4048776, lng: 9.7210568 }
    });
    expect(report.structured.meta.gremium.gremium).toBe('Stadtbezirksrat Nord');
  });

  test('keeps the recipient open when the selection touches a district edge', async () => {
    const report = await computeReport(null, officialBoundaries(9.721093));
    expect(report.structured.meta.gremium.gremium).toBeNull();
  });

  test('keeps the recipient open when only a selection vertex touches a diagonal boundary', async () => {
    const districts = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature', properties: { district: 'Nord' },
        geometry: { type: 'Polygon', coordinates: [[[-2, -2], [4, -2], [-2, 4], [-2, -2]]] }
      }]
    };
    const report = await computeReport(null, districts, {
      sw: { lat: 0, lng: 0 }, ne: { lat: 1, lng: 1 }
    });
    expect(report.structured.meta.gremium.gremium).toBeNull();
  });
});
