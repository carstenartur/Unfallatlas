'use strict';

describe('UA.buildAccidentContextPopupHtml', () => {
  let UA;

  beforeEach(() => {
    const fs = require('fs');
    const path = require('path');
    const win = { UA: {}, location: { href: 'http://localhost/' }, L: {} };
    const load = (rel) => {
      const p = path.resolve(__dirname, '../../js/' + rel);
      (function (window) { eval(fs.readFileSync(p, 'utf8')); })(win);
    };
    load('ua.core.js');
    load('ua.map_v2.js');
    UA = win.UA;
  });

  test('renders structured context sections for enriched properties', () => {
    const ctx = {
      contextCapabilities: {
        hasElevation: true,
        hasSlope: true,
        hasOsmContext: true,
        hasTrafficProxy: true,
      },
    };
    const html = UA.buildAccidentContextPopupHtml(ctx, {
      elevation_m: 12,
      slope_percent: 3.2,
      slope_class: 'moderate',
      slope_source: 'SRTM Local Tiles',
      traffic_proxy_class: 'high',
      matched_way_id: '197287584',
      road_slope_percent: 2.4,
      highway: 'residential',
      maxspeed: 30,
      lanes: 2,
      surface: 'asphalt',
      cycleway: 'lane',
      osm_incline: 'up',
    });

    expect(html).toContain('Kontextdaten');
    expect(html).toContain('Geometrie');
    expect(html).toContain('Höhe');
    expect(html).toContain('12 m ü. NN');
    expect(html).toContain('Hangneigung');
    expect(html).toContain('3,2 % (mäßig)');
    expect(html).toContain('Straßenkontext');
    expect(html).toContain('Way-ID: 197287584');
    expect(html).toContain('Verkehrslast');
    expect(html).toContain('Verkehrsklasse');
    expect(html).toContain('hoch');
    expect(html).toContain('Kontextdaten beschreiben die Umgebung, nicht die Unfallursache.');
  });

  test('returns null when no enriched fields are present (graceful degradation)', () => {
    const ctx = {
      contextCapabilities: {
        hasElevation: false,
        hasSlope: false,
        hasOsmContext: false,
        hasTrafficProxy: false,
      },
    };
    const html = UA.buildAccidentContextPopupHtml(ctx, { year: 2023, ukategorie: '2' });
    expect(html).toBeNull();
  });
});
