'use strict';

describe('UA.buildAccidentContextPopupHtml (backward-compat alias)', () => {
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
    load('ua.popup_context.js');
    load('ua.map_v2.js');
    UA = win.UA;
  });

  test('renders structured Topographie/Straßenkontext/Verkehrsexposition sections', () => {
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
      slope_confidence: 'medium',
      traffic_proxy_class: 'high',
      matched_way_id: '197287584',
      road_slope_percent: 2.4,
      road_context_source: 'osm',
      highway: 'residential',
      maxspeed: 30,
      lanes: 2,
      surface: 'asphalt',
      cycleway: 'lane',
      osm_incline: 'up',
    });

    expect(html).toContain('Kontextdaten');
    expect(html).toContain('Topographie');
    expect(html).toContain('Höhe');
    expect(html).toContain('12 m ü. NN');
    expect(html).toContain('Hangneigung lokal');
    expect(html).toContain('3,2 % (mäßig)');
    expect(html).toContain('Straßenneigung');
    expect(html).toContain('Konfidenz');
    expect(html).toContain('Straßenkontext');
    expect(html).toContain('Verkehrsexposition');
    expect(html).toContain('Verkehrsklasse');
    expect(html).toContain('hoch');
    // Way-ID is demoted into a "Technische Details" disclosure, not
    // rendered prominently next to the section heading.
    expect(html).toContain('Technische Details');
    expect(html).toContain('OSM-Way-ID');
    expect(html).toContain('197287584');
    expect(html).not.toMatch(/Straßenkontext\s*<span[^>]*>Way-ID/);
    // Disclaimer present exactly once.
    const disclaimer = 'Kontextdaten beschreiben die Umgebung, nicht die Unfallursache.';
    expect(html).toContain(disclaimer);
    expect(html.split(disclaimer).length).toBe(2);
    // Source classification badge for the topography section.
    expect(html).toMatch(/data-ua-badge="measured"/);
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

  test('suppresses sections whose fields are missing on this particular feature', () => {
    const ctx = {
      contextCapabilities: {
        hasElevation: true,
        hasSlope: true,
        hasOsmContext: true,
        hasTrafficProxy: true,
      },
    };
    // Only elevation present — even though the dataset advertises all
    // capabilities, this single feature should not render empty
    // Straßenkontext / Verkehrsexposition section headings.
    const html = UA.buildAccidentContextPopupHtml(ctx, { elevation_m: 50 });
    expect(html).toContain('Topographie');
    expect(html).toContain('Höhe');
    expect(html).not.toContain('Straßenkontext');
    expect(html).not.toContain('Verkehrsexposition');
    expect(html).not.toContain('Technische Details');
  });
});
