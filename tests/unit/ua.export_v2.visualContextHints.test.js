describe('UA.computeExportReport – visual orthophoto hints provenance', () => {
  let UA;

  beforeEach(() => {
    const fs = require('fs');
    const path = require('path');
    const mockWindow = { UA: {}, location: { href: 'http://localhost/' } };
    const load = (rel) => {
      const p = path.resolve(__dirname, '../../js/' + rel);
      (function (window) { eval(fs.readFileSync(p, 'utf8')); })(mockWindow);
    };
    load('ua.utils.js');
    load('ua.filters.js');
    load('ua.accident_views.js');
    mockWindow.fetch = async () => ({ ok: false, json: async () => ({}), text: async () => '' });
    mockWindow.L = { latLngBounds: () => {} };
    load('ua.export_v2.js');
    UA = mockWindow.UA;
  });

  function pt(year) {
    return {
      lat: 52.25, lon: 9.8,
      props: {
        year: String(year),
        ukategorie: '3',
        ustunde: '12',
        uwochentag: '3',
        strzustand: '0',
        IstRad: '1', IstFuss: '0', IstPKW: '1', IstKrad: '0', IstGkfz: '0', IstSonstig: '0'
      }
    };
  }

  test('adds visualContextHints with source/provenance and safe wording', async () => {
    const sw = { lat: 52.0, lng: 9.7 };
    const ne = { lat: 52.5, lng: 9.9 };
    const bounds = {
      getSouthWest: () => sw,
      getNorthEast: () => ne,
      getCenter: () => ({ lat: 52.25, lng: 9.8 }),
      contains: () => true
    };
    UA.reverseGeocode = async () => null;
    UA.getActiveMapLayerInfo = () => ({
      mode: 'orthophoto',
      modeLabel: 'Orthofoto',
      orthophoto: {
        id: 'niedersachsen-orthophoto',
        displayName: 'DOP20 Niedersachsen',
        provider: 'LGLN',
        attribution: 'Quelle: LGLN',
        license: 'Datenlizenz Deutschland – Zero – Version 2.0'
      }
    });

    const ui = {
      severityEl: { value: 'all' },
      roadConditionEl: { value: 'all' },
      hFromEl: { value: '0' },
      hToEl: { value: '23' },
      dayTypeEl: { value: 'all' },
      incBikeEl: { checked: true },
      incPedEl: { checked: true },
      incCarEl: { checked: true },
      incMotoEl: { checked: true },
      incGkfzEl: { checked: true },
      incSonEl: { checked: true }
    };

    const ctx = {
      CITY_RAW: 'Hannover',
      mapMode: 'orthophoto',
      allPts: [pt(2021), pt(2022), pt(2023)],
      selectionBounds: bounds,
      ui,
      exportOptions: { includeCosts: false, includeMeasures: false }
    };

    const r = await UA.computeExportReport(ctx);
    expect(r.structured.visualContextHints).toBeTruthy();
    expect(r.structured.visualContextHints.sourceType).toBe('visual_context');
    expect(r.structured.visualContextHints.source.layerName).toBe('DOP20 Niedersachsen');
    expect(r.text).toContain('Visuelle Hinweise (Orthofoto/Luftbild):');
    expect(r.text).toContain('Sichtbarer Hinweis aus Orthofoto/Luftbild');
    expect(r.text).toContain('Detailprüfung empfohlen');
    expect(r.text).not.toContain('verursacht durch');
  });
});
