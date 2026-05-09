'use strict';

/**
 * Tests for js/ua.popup_context.js — the dedicated popup-context
 * renderer extracted from ua.map_v2 in PR #259 follow-up.
 *
 * The renderer is intentionally pure: it does no detection, no I/O,
 * and never mutates its inputs. These tests pin that contract plus
 * the visible UX rules (sections in the right order, German labels,
 * confidence/source badges, no empty sections, way-IDs demoted into
 * the "Technische Details" disclosure, single disclaimer).
 */

const fs = require('fs');
const path = require('path');

function loadModules() {
  const win = { UA: {}, location: { href: 'http://localhost/' }, L: {} };
  const load = (rel) => {
    const p = path.resolve(__dirname, '../../js/' + rel);
    (function (window) { eval(fs.readFileSync(p, 'utf8')); })(win);
  };
  load('ua.core.js');
  load('ua.context_layers.js');
  load('ua.popup_context.js');
  return win.UA;
}

describe('UA.popupContext.render — public contract', () => {
  test('exposes stable public API', () => {
    const UA = loadModules();
    expect(typeof UA.popupContext.render).toBe('function');
    expect(typeof UA.popupContext.formatNumber).toBe('function');
    expect(typeof UA.popupContext.classifySource).toBe('function');
    expect(typeof UA.composeAccidentPopupHtml).toBe('function');
    expect(UA.popupContext.LABELS_DE).toBeTruthy();
  });

  test('renders sections in the documented order: Topographie → Straßenkontext → Verkehrsexposition', () => {
    const UA = loadModules();
    const html = UA.popupContext.render(
      {
        elevation_m: 50,
        slope_percent: 2.1,
        slope_class: 'gentle',
        highway: 'secondary',
        traffic_proxy_class: 'medium',
      },
      { hasElevation: true, hasSlope: true, hasOsmContext: true, hasTrafficProxy: true }
    );
    const iTopo    = html.indexOf('Topographie');
    const iRoad    = html.indexOf('Straßenkontext');
    const iTraffic = html.indexOf('Verkehrsexposition');
    expect(iTopo).toBeGreaterThan(-1);
    expect(iRoad).toBeGreaterThan(iTopo);
    expect(iTraffic).toBeGreaterThan(iRoad);
  });

  test('returns null when capabilities are off, even if props happen to carry fields', () => {
    const UA = loadModules();
    const html = UA.popupContext.render(
      { elevation_m: 100, traffic_proxy_class: 'high' },
      { hasElevation: false, hasSlope: false, hasOsmContext: false, hasTrafficProxy: false }
    );
    expect(html).toBeNull();
  });

  test('does not render empty sections (capability on, but no per-feature data)', () => {
    const UA = loadModules();
    const html = UA.popupContext.render(
      { elevation_m: 12 },
      { hasElevation: true, hasSlope: true, hasOsmContext: true, hasTrafficProxy: true }
    );
    expect(html).toContain('Topographie');
    expect(html).not.toContain('Straßenkontext');
    expect(html).not.toContain('Verkehrsexposition');
    // No "undefined" leaks anywhere.
    expect(html).not.toMatch(/undefined/i);
  });

  test('demotes matched_way_id into a Technische-Details disclosure', () => {
    const UA = loadModules();
    const html = UA.popupContext.render(
      { highway: 'residential', matched_way_id: 'W12345' },
      { hasOsmContext: true }
    );
    expect(html).toContain('Straßenkontext');
    expect(html).toContain('Technische Details');
    expect(html).toContain('W12345');
    // Way-ID must NOT appear right next to the section heading.
    expect(html).not.toMatch(/Straßenkontext\s*<span[^>]*>[^<]*W12345/);
    // It must be inside a <details>/<summary> block.
    expect(html).toMatch(/<details[^>]*data-ua-context-section="technical"[\s\S]*W12345[\s\S]*<\/details>/);
  });

  test('attaches a source/confidence badge classified as measured/derived/proxy/unknown', () => {
    const UA = loadModules();
    const measured = UA.popupContext.render(
      { elevation_m: 10, slope_percent: 1.0, slope_source: 'SRTM Local Tiles' },
      { hasElevation: true, hasSlope: true }
    );
    expect(measured).toMatch(/data-ua-badge="measured"/);

    const derived = UA.popupContext.render(
      { elevation_m: 10, slope_percent: 1.0, slope_source: 'Open-Meteo Elevation' },
      { hasElevation: true, hasSlope: true }
    );
    expect(derived).toMatch(/data-ua-badge="derived"/);

    const proxy = UA.popupContext.render(
      { traffic_proxy_class: 'medium' },
      { hasTrafficProxy: true }
    );
    expect(proxy).toMatch(/data-ua-badge="proxy"/);
  });

  test('uses central German label tables (no inline strings) for slope_class/traffic_proxy_class/confidence', () => {
    const UA = loadModules();
    const html = UA.popupContext.render(
      { slope_percent: 8.5, slope_class: 'steep', slope_confidence: 'low', traffic_proxy_class: 'very_high' },
      { hasSlope: true, hasTrafficProxy: true }
    );
    expect(html).toContain('steil');
    expect(html).toContain('niedrig');   // confidence:low
    expect(html).toContain('sehr hoch'); // traffic_proxy_class:very_high
    // Mapping table itself reflects the producer thresholds.
    expect(UA.popupContext.LABELS_DE.slope_class.very_steep).toBe('sehr steil');
    expect(UA.popupContext.LABELS_DE.traffic_proxy_class.very_high).toBe('sehr hoch');
  });

  test('renders disclaimer exactly once and only when a section is rendered', () => {
    const UA = loadModules();
    const sentence = 'Kontextdaten beschreiben die Umgebung, nicht die Unfallursache.';
    const off = UA.popupContext.render({ elevation_m: 5 }, { hasElevation: false });
    expect(off).toBeNull();
    const on = UA.popupContext.render({ elevation_m: 5 }, { hasElevation: true });
    expect(on).toContain(sentence);
    expect(on.split(sentence).length).toBe(2);
  });

  test('escapes user-controlled / OSM string values to prevent HTML injection', () => {
    const UA = loadModules();
    const html = UA.popupContext.render(
      { highway: '<img src=x onerror=alert(1)>', matched_way_id: '"><script>1</script>' },
      { hasOsmContext: true }
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>1</script>');
    expect(html).toContain('&lt;img src=x');
  });

  test('does not mutate input props', () => {
    const UA = loadModules();
    const props = Object.freeze({
      elevation_m: 1, slope_percent: 0, slope_class: 'flat',
      highway: 'residential', traffic_proxy_class: 'low',
    });
    expect(() => UA.popupContext.render(props, {
      hasElevation: true, hasSlope: true, hasOsmContext: true, hasTrafficProxy: true,
    })).not.toThrow();
  });

  test('renders road_slope_percent in Topographie only (no duplicate row in Straßenkontext)', () => {
    const UA = loadModules();
    const html = UA.popupContext.render(
      {
        elevation_m: 100,
        slope_percent: 1.0,
        road_slope_percent: 2.4,
        highway: 'residential',
      },
      { hasElevation: true, hasSlope: true, hasOsmContext: true }
    );
    // Exactly one Straßenneigung row, in Topographie.
    const matches = html.match(/Straßenneigung/g) || [];
    expect(matches.length).toBe(1);
    const topoIdx = html.indexOf('data-ua-context-section="topography"');
    const roadIdx = html.indexOf('data-ua-context-section="road"');
    const labelIdx = html.indexOf('Straßenneigung');
    expect(topoIdx).toBeGreaterThan(-1);
    expect(roadIdx).toBeGreaterThan(topoIdx);
    expect(labelIdx).toBeGreaterThan(topoIdx);
    expect(labelIdx).toBeLessThan(roadIdx);
  });

  test('formatNumber returns null for non-finite values and uses comma decimal separator', () => {
    const UA = loadModules();
    expect(UA.popupContext.formatNumber(NaN, 1)).toBeNull();
    expect(UA.popupContext.formatNumber('not-a-number', 1)).toBeNull();
    expect(UA.popupContext.formatNumber(3.25, 1)).toBe('3,3');
  });
});

describe('UA.composeAccidentPopupHtml — preserves base content, appends context', () => {
  test('keeps the existing base popup content and appends context below', () => {
    const UA = loadModules();
    const ctx = {
      contextCapabilities: { hasElevation: true },
    };
    const composed = UA.composeAccidentPopupHtml(ctx, { elevation_m: 7 }, {
      baseHtml: '<div class="ua-base">Unfall vom 12.05.2023</div>',
    });
    expect(composed).toContain('Unfall vom 12.05.2023');
    expect(composed).toContain('Topographie');
    // Base must precede context.
    expect(composed.indexOf('Unfall vom')).toBeLessThan(composed.indexOf('Topographie'));
  });

  test('falls back to base-only when no context capability is set', () => {
    const UA = loadModules();
    const ctx = { contextCapabilities: {} };
    const composed = UA.composeAccidentPopupHtml(ctx, { elevation_m: 7 }, {
      baseHtml: '<div>Basis</div>',
    });
    expect(composed).toBe('<div>Basis</div>');
  });

  test('returns null when neither base nor context produces content', () => {
    const UA = loadModules();
    const ctx = { contextCapabilities: {} };
    expect(UA.composeAccidentPopupHtml(ctx, {}, { baseHtml: '' })).toBeNull();
    expect(UA.composeAccidentPopupHtml(ctx, {})).toBeNull();
  });

  test('returns context-only when no baseHtml is supplied', () => {
    const UA = loadModules();
    const ctx = { contextCapabilities: { hasElevation: true } };
    const html = UA.composeAccidentPopupHtml(ctx, { elevation_m: 11 });
    expect(html).toContain('Topographie');
    expect(html).not.toContain('ua-base');
  });
});

describe('UA.contextLayers.capabilitiesFromDetection — single source of truth', () => {
  test('maps detected fields to capability flags + hasAny', () => {
    const UA = loadModules();
    const caps = UA.contextLayers.capabilitiesFromDetection({
      availableFields: ['elevation_m', 'slope_class', 'highway', 'traffic_proxy_class'],
    });
    expect(caps).toEqual(expect.objectContaining({
      hasElevation: true,
      hasSlope: true,
      hasOsmContext: true,
      hasTrafficProxy: true,
      hasAny: true,
    }));
  });

  test('returns all-false flags + hasAny=false for empty/missing detection', () => {
    const UA = loadModules();
    expect(UA.contextLayers.capabilitiesFromDetection(null))
      .toEqual({ hasElevation: false, hasSlope: false, hasOsmContext: false, hasTrafficProxy: false, hasAny: false });
    expect(UA.contextLayers.capabilitiesFromDetection({ availableFields: [] }))
      .toEqual({ hasElevation: false, hasSlope: false, hasOsmContext: false, hasTrafficProxy: false, hasAny: false });
  });

  test('hasOsmContext is true even when only matched_way_id is present (allows future ways_<city>.json hydration)', () => {
    const UA = loadModules();
    const caps = UA.contextLayers.capabilitiesFromDetection({ availableFields: ['matched_way_id'] });
    expect(caps.hasOsmContext).toBe(true);
  });
});
