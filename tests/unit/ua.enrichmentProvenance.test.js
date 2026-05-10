'use strict';

/**
 * Unit tests for UA.updateEnrichmentProvenance — the "ⓘ Datenstand"
 * tooltip wiring in the Werkbank V2 city header (item 10 of the
 * post-PR #261 follow-up plan). Loads js/ua.ui.js into the jsdom
 * window and feeds it a synthetic ctx.contextLayerState.meta.
 */

const fs   = require('fs');
const path = require('path');

function loadUI() {
  const win = (typeof window !== 'undefined') ? window : global;
  win.UA = win.UA || {};
  // ua.ui.js depends on UA.setQS/UA.getQS shims for syncAllToUrl —
  // load utils first so a future indirect call doesn't crash.
  const utils = fs.readFileSync(path.resolve(__dirname, '../../js/ua.utils.js'), 'utf8');
  (function (window) { eval(utils); })(win);
  const ui = fs.readFileSync(path.resolve(__dirname, '../../js/ua.ui.js'), 'utf8');
  (function (window) { eval(ui); })(win);
  return win.UA;
}

function setupDom() {
  document.body.innerHTML = `
    <div class="muted" id="metaInfoBox">
      Quelle: <code id="dataSourceCode"></code><br/>
      Build: <code id="buildInfo"></code>
      <span id="enrichmentProvenance" hidden>
        <br/>
        <span id="enrichmentProvenanceTip" tabindex="0"
              aria-label="Datenstand der angereicherten Kontextdaten anzeigen"
              title=""></span>
      </span>
    </div>
  `;
  return {
    wrap: document.getElementById('enrichmentProvenance'),
    tip:  document.getElementById('enrichmentProvenanceTip'),
  };
}

describe('UA.updateEnrichmentProvenance — "ⓘ Datenstand" tooltip', () => {
  test('renders generatedAt + script version + per-source extractDate/producerVersion into the title', () => {
    const UA = loadUI();
    const { wrap, tip } = setupDom();
    const ctx = {
      ui: {},
      contextLayerState: {
        meta: {
          generatedAt: '2026-05-09T06:06:40.970Z',
          enrichmentScriptVersion: '1.0.0',
          sources: {
            osm:     { source: 'OpenStreetMap (Overpass)', producerVersion: '1.1.0', extractDate: '2026-05-09' },
            dem:     { source: 'SRTM Local Tiles',         producerVersion: '1.0.0', resolutionM: 30 },
            traffic: { source: 'OSM-highway-proxy',        producerVersion: '1.0.0', datasetVersion: '1.0.0' },
          },
        },
      },
    };
    UA.updateEnrichmentProvenance(ctx);
    expect(wrap.hidden).toBe(false);
    const title = tip.getAttribute('title') || '';
    expect(title).toMatch(/Erzeugt: 2026-05-09T06:06:40\.970Z/);
    expect(title).toMatch(/Enrichment-Skript: v1\.0\.0/);
    expect(title).toMatch(/OSM: OpenStreetMap \(Overpass\), Producer v1\.1\.0, 2026-05-09/);
    expect(title).toMatch(/DEM: SRTM Local Tiles, Producer v1\.0\.0, 30 m/);
    expect(title).toMatch(/Traffic: OSM-highway-proxy, Producer v1\.0\.0, Dataset 1\.0\.0/);
    // aria-label mirrors the same content (joined with "; ") so SR
    // users hear it without depending on title-on-focus support.
    expect(tip.getAttribute('aria-label')).toMatch(/^Datenstand: /);
    expect(tip.getAttribute('aria-label')).toMatch(/OSM: /);
  });

  test('hides the wrapper when no contextLayerState is present (city without enrichment)', () => {
    const UA = loadUI();
    const { wrap, tip } = setupDom();
    wrap.hidden = false; // simulate "previously visible"
    tip.setAttribute('title', 'stale');
    UA.updateEnrichmentProvenance({ ui: {}, contextLayerState: null });
    expect(wrap.hidden).toBe(true);
    expect(tip.getAttribute('title')).toBe('');
  });

  test('hides the wrapper when meta is present but empty', () => {
    const UA = loadUI();
    const { wrap, tip } = setupDom();
    wrap.hidden = false;
    tip.setAttribute('title', 'stale');
    UA.updateEnrichmentProvenance({ ui: {}, contextLayerState: { meta: {} } });
    expect(wrap.hidden).toBe(true);
    expect(tip.getAttribute('title')).toBe('');
  });

  test('is a no-op when the metaInfoBox / tooltip elements are missing (headless contexts)', () => {
    const UA = loadUI();
    document.body.innerHTML = ''; // no metaInfoBox at all
    expect(() => UA.updateEnrichmentProvenance({ ui: {}, contextLayerState: { meta: { generatedAt: 'x' } } })).not.toThrow();
  });
});
