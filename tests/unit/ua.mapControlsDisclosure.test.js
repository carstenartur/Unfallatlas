'use strict';

const fs = require('fs');
const path = require('path');
const L = require('leaflet');

function loadScript(name) {
  (function(window, L) {
    eval(fs.readFileSync(path.resolve(__dirname, '../../js', name), 'utf8'));
  })(window, L);
}

describe('map control disclosure', () => {
  let ctx;
  let UA;
  const originalMatchMedia = window.matchMedia;
  const originalSvg = L.Browser.svg;

  beforeEach(() => {
    document.body.innerHTML = '<div id="map"></div>';
    Object.defineProperties(document.getElementById('map'), {
      clientWidth: { value: 390 }, clientHeight: { value: 844 },
    });
    window.matchMedia = () => ({ matches: true });
    L.Browser.svg = true;
    window.L = L;
    UA = window.UA = {};
    loadScript('ua.context_road_layer.js');
    loadScript('ua.map_v2.js');
    UA.syncAllToUrl = () => {};
    ctx = {
      map: L.map('map', { zoomControl: false, attributionControl: false, fadeAnimation: false })
        .setView([50.7, 7.1], 13),
      contextCapabilities: { hasSlope: true, hasTrafficProxy: true },
      contextOverlays: {
        active: { slope: false, traffic: false },
        layers: { slope: null, traffic: null },
        renderer: L.svg(),
      },
      contextLayerState: {
        ways: { W1: { road_slope_class: 'steep', highway: 'residential' } },
        geometries: { W1: [50.70, 7.10, 50.701, 7.101] },
      },
    };
  });

  afterEach(() => {
    ctx.map.remove();
    window.matchMedia = originalMatchMedia;
    L.Browser.svg = originalSvg;
    delete window.UA;
    delete window.L;
  });

  test('phone layer settings start compact and collapsing keeps the selected road layer', async () => {
    UA.refreshContextOverlays(ctx);
    const container = document.querySelector('.context-overlay-control');
    const toggle = container.querySelector('button[aria-expanded]');
    expect(toggle).not.toBeNull();
    const body = document.getElementById(toggle.getAttribute('aria-controls'));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(body.hidden).toBe(true);

    toggle.click();
    const slope = body.querySelector('[data-context-overlay="slope"]');
    slope.click();
    await UA.ensureContextOverlaysReady(ctx);
    const layer = ctx.contextOverlays.layers.slope;
    expect(layer).not.toBeNull();
    expect(ctx.map.hasLayer(layer)).toBe(true);
    toggle.click();
    expect(body.hidden).toBe(true);
    expect(slope.checked).toBe(true);
    expect(ctx.map.hasLayer(layer)).toBe(true);
  });

  test('geometry refresh keeps the chosen disclosure state and focused layer setting', () => {
    UA.refreshContextOverlays(ctx);
    let container = document.querySelector('.context-overlay-control');
    const toggle = container.querySelector('button[aria-expanded]');
    expect(toggle).not.toBeNull();
    toggle.click();
    container.querySelector('[data-context-overlay="slope"]').focus();

    UA.refreshContextOverlays(ctx);
    container = document.querySelector('.context-overlay-control');
    expect(container.querySelector('button').getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.mapControlBody').hidden).toBe(false);
    expect(document.activeElement).toBe(container.querySelector('[data-context-overlay="slope"]'));

    container.querySelector('button').click();
    UA.refreshContextOverlays(ctx);
    expect(document.querySelector('.context-overlay-control button').getAttribute('aria-expanded')).toBe('false');
  });

  test('live legend updates preserve its disclosure and continue to expose both colour meanings', async () => {
    UA.refreshContextOverlays(ctx);
    UA.setContextOverlayActive(ctx, 'slope', true);
    await UA.ensureContextOverlaysReady(ctx);
    const container = document.querySelector('.context-overlay-legend');
    const toggle = container.querySelector('button[aria-expanded]');
    expect(toggle).not.toBeNull();
    const body = document.getElementById(toggle.getAttribute('aria-controls'));
    expect(body.hidden).toBe(true);
    toggle.click();
    UA.setContextOverlayActive(ctx, 'traffic', true);
    await UA.ensureContextOverlaysReady(ctx);
    expect(container.querySelector('button')).toBe(toggle);
    expect(body.hidden).toBe(false);
    expect(body.querySelector('.context-road-legend--slope')).not.toBeNull();
    expect(body.querySelector('.context-road-legend--traffic')).not.toBeNull();
    expect(body.textContent).toMatch(/Steigung außen.*Verkehr.*innen/);
  });

  test('icon toolbar collapses without changing map layer selections and returns focus to its opener', () => {
    UA.addLayerLegend(ctx, ctx.map);
    const container = document.querySelector('.layer-legend-control');
    const toggle = container.querySelector('button[aria-expanded]');
    expect(toggle).not.toBeNull();
    const body = document.getElementById(toggle.getAttribute('aria-controls'));
    expect(body.hidden).toBe(true);
    toggle.click();
    body.querySelector('[data-layer="cluster"]').focus();
    toggle.click();
    expect(document.activeElement).toBe(toggle);
    expect(body.hidden).toBe(true);
    expect(ctx.showCluster).toBe(true);
    expect(ctx.showHeatmap).toBe(true);
  });

  test('desktop controls remain expanded by default and can be collapsed', () => {
    window.matchMedia = () => ({ matches: false });
    UA.refreshContextOverlays(ctx);
    const container = document.querySelector('.context-overlay-control');
    const toggle = container.querySelector('button[aria-expanded]');
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.click();
    expect(container.querySelector('.mapControlBody').hidden).toBe(true);
  });

  test('switching to a phone layout keeps keyboard focus on the now-collapsed card', () => {
    const media = new EventTarget();
    media.matches = false;
    window.matchMedia = () => media;
    UA.addLayerLegend(ctx, ctx.map);
    UA.refreshContextOverlays(ctx);
    document.getElementById('ctxOverlay_slope').focus();
    media.matches = true;
    media.dispatchEvent(new Event('change'));
    const control = document.querySelector('.context-overlay-control');
    expect(control.querySelector('.mapControlBody').hidden).toBe(true);
    expect(document.activeElement).toBe(control.querySelector('.mapControlToggle'));
    expect(document.querySelector('.layer-legend-control').parentElement.classList.contains('leaflet-top')).toBe(true);
  });

  test('refreshing context data preserves focus on the legend disclosure', async () => {
    UA.refreshContextOverlays(ctx);
    UA.setContextOverlayActive(ctx, 'slope', true);
    await UA.ensureContextOverlaysReady(ctx);
    document.getElementById('context-overlay-legend-title').focus();
    UA.refreshContextOverlays(ctx);
    expect(document.activeElement).toBe(document.getElementById('context-overlay-legend-title'));
  });
});
