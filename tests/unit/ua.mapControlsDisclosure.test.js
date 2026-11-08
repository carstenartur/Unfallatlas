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
    ctx.map?.remove();
    window.matchMedia = originalMatchMedia;
    L.Browser.svg = originalSvg;
    delete window.UA;
    delete window.L;
  });

  // Break caught: default top-left zoom sits underneath the main panel; adding a second control leaves duplicate actions.
  test('initialization places the native zoom before Draw and Karte in one right column', () => {
    require('leaflet-draw');
    ctx.map.remove();
    ctx = {};
    UA.initLeaflet(ctx);
    const column = document.querySelector('#map .leaflet-top.leaflet-right');
    const zoom = ctx.map.zoomControl.getContainer();
    const draw = ctx.drawControl.getContainer();
    const card = document.querySelector('.carte-control');
    expect(zoom.parentElement).toBe(column);
    expect([...column.children].indexOf(zoom)).toBeLessThan([...column.children].indexOf(draw));
    expect([...column.children].indexOf(draw)).toBeLessThan([...column.children].indexOf(card));
    expect(document.querySelectorAll('.leaflet-control-zoom')).toHaveLength(1);
    const before = ctx.map.getZoom();
    zoom.querySelector('.leaflet-control-zoom-in').click();
    expect(ctx.map.getZoom()).toBe(before + 1);
    UA.refreshContextOverlays(ctx);
    expect(ctx.map.zoomControl.getContainer()).toBe(zoom);
    expect(document.querySelectorAll('.leaflet-control-zoom')).toHaveLength(1);
  });

  test('one labelled Karte groups background and independently selectable accident layers', () => {
    document.body.insertAdjacentHTML('beforeend', '<section id="mapBackgroundControls"><button id="mapModeStandard">Standardkarte</button></section><div id="mapAccidentControls"><button id="toggleCluster">Cluster</button><button id="toggleHeat">Heatmap</button></div>');
    const background = document.getElementById('mapBackgroundControls');
    UA.renderLayers = jest.fn();
    ctx.showCluster = ctx.showHeatmap = true;
    UA.addLayerLegend(ctx, ctx.map);
    UA.refreshContextOverlays(ctx);
    expect([...document.querySelectorAll('.mapControlToggle')].filter(button => button.textContent === 'Karte')).toHaveLength(1);
    expect([...document.querySelectorAll('.mapControlToggle')].some(button => /^(Ebenen|Karten-Layer)$/.test(button.textContent))).toBe(false);
    const card = document.querySelector('.carte-control');
    expect(card.contains(background)).toBe(true);
    expect(card.querySelector('.mapControlToggle').getAttribute('aria-label')).toBe('Karte');
    expect([...card.querySelectorAll('legend')].map(node => node.textContent)).toEqual(['Hintergrund', 'Unfalldarstellung', 'Umgebung', 'Straßeninformationen', 'Ratsvorgänge']);
    expect(document.querySelectorAll('#toggleCluster')).toHaveLength(1);
    expect(card.querySelector('[data-layer="cluster"]')).toBe(document.getElementById('toggleCluster'));
    expect(card.querySelector('[data-layer="heatmap"]')).toBe(document.getElementById('toggleHeat'));
    expect(card.querySelector('[data-layer="cluster"]').getAttribute('aria-pressed')).toBe('true');
  });

  test('cluster and heatmap remain independent and report pressed state', () => {
    UA.renderLayers = jest.fn();
    UA.addLayerLegend(ctx, ctx.map);
    const cluster = document.querySelector('[data-layer="cluster"]');
    const heat = document.querySelector('[data-layer="heatmap"]');
    cluster.click();
    expect(ctx.showCluster).toBe(false);
    expect(ctx.showHeatmap).toBe(true);
    expect(cluster.getAttribute('aria-pressed')).toBe('false');
    heat.click();
    expect(ctx.showCluster).toBe(false);
    expect(ctx.showHeatmap).toBe(false);
    cluster.click();
    heat.click();
    expect(ctx.showCluster && ctx.showHeatmap).toBe(true);
  });

  test('Escape folds Karte and returns focus without changing layer state', () => {
    UA.refreshContextOverlays(ctx);
    const card = document.querySelector('.context-overlay-control');
    card.querySelector('.mapControlToggle').click();
    const slope = card.querySelector('[data-context-overlay="slope"]');
    slope.focus();
    slope.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(card.querySelector('.mapControlBody').hidden).toBe(true);
    expect(document.activeElement).toBe(card.querySelector('.mapControlToggle'));
  });

  test('capabilities remove unavailable road controls and retain one Karte entry', () => {
    UA.addLayerLegend(ctx, ctx.map);
    UA.refreshContextOverlays(ctx);
    ctx.contextCapabilities = {};
    UA.refreshContextOverlays(ctx);
    expect(document.querySelector('[data-context-overlay="slope"]')).toBeNull();
    expect(document.querySelector('[data-context-overlay="traffic"]')).toBeNull();
    expect(document.querySelector('.carte-control')).not.toBeNull();
    expect(document.querySelectorAll('.carte-control')).toHaveLength(1);
  });

  test('refreshing road and RIS controls never enables unrelated accident layers', () => {
    UA.refreshContextOverlays(ctx);
    expect(ctx.showCluster).toBeUndefined();
    expect(ctx.showHeatmap).toBeUndefined();
    expect(ctx.showSchools).toBeUndefined();
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

  test('legacy media listeners adapt controls and are released with the map', () => {
    const listeners = new Set();
    const media = {
      matches: false,
      addListener: listener => listeners.add(listener),
      removeListener: listener => listeners.delete(listener),
    };
    window.matchMedia = () => media;
    UA.addLayerLegend(ctx, ctx.map);
    UA.refreshContextOverlays(ctx);
    media.matches = true;
    for (const listener of listeners) listener();
    const control = document.querySelector('.context-overlay-control');
    expect(control.querySelector('.mapControlBody').hidden).toBe(true);
    expect(document.querySelector('.layer-legend-control').parentElement.classList.contains('leaflet-top')).toBe(true);

    media.matches = false;
    for (const listener of listeners) listener();
    expect(control.querySelector('.mapControlBody').hidden).toBe(false);
    ctx.map.remove();
    ctx.map = null;
    expect(listeners.size).toBe(0);
  });
});
