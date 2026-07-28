'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

function loadRoadLayer() {
  const win = {
    UA: {},
    L: {
      canvas: () => ({}),
      layerGroup: () => {
        const layers = [];
        const group = {
          addLayer(layer) { layers.push(layer); return group; },
          getLayers() { return layers.slice(); },
        };
        return group;
      },
      polyline: (latlngs, options) => ({
        _latlngs: latlngs,
        _opts: options,
        feature: null,
      }),
    },
    document: global.document,
  };
  const source = fs.readFileSync(path.join(ROOT, 'js/ua.context_road_layer.js'), 'utf8');
  (function evaluate(window, document) { eval(source); })(win, global.document);
  return win.UA.contextRoadLayer;
}

describe('qualitative traffic proxy runtime contract', () => {
  test('explicit proxy class wins and proxy numbers are never treated as measurements', () => {
    const layer = loadRoadLayer();
    expect(layer.classifyTrafficFromAttrs({
      traffic_measurement_type: 'proxy',
      traffic_proxy_class: 'medium',
      traffic_volume_value: 50000,
    })).toBe('medium');
    expect(layer.classifyTrafficFromAttrs({
      traffic_measurement_type: 'proxy',
      traffic_volume_value: 50000,
    })).toBeNull();
    expect(layer.classifyTrafficFromAttrs({
      traffic_measurement_type: 'measured',
      traffic_volume_value: 50000,
    })).toBe('very_high');
  });

  test('legacy highway-only payloads remain qualitative and unknown classes stay absent', () => {
    const layer = loadRoadLayer();
    expect(layer.classifyTrafficFromAttrs({ highway: 'residential' })).toBe('low');
    expect(layer.classifyTrafficFromAttrs({ highway: 'tertiary' })).toBe('medium');
    expect(layer.classifyTrafficFromAttrs({ highway: 'primary' })).toBe('high');
    expect(layer.classifyTrafficFromAttrs({ highway: 'motorway' })).toBe('very_high');
    expect(layer.classifyTrafficFromAttrs({ highway: 'construction' })).toBeNull();
  });

  test('traffic legend visibly says proxy and never advertises DTV thresholds', () => {
    const layer = loadRoadLayer();
    const legend = layer.buildLegend('traffic');
    expect(legend.querySelector('.context-road-legend__title').textContent)
      .toMatch(/qualitativer Proxy/i);
    const text = legend.textContent;
    expect(text).toMatch(/OSM-Straßenklassenproxy/i);
    expect(text).not.toMatch(/DTV|Fahrzeuge\s*\/\s*Tag|vehicles\s*\/\s*day/i);
  });

  test('rendered traffic features retain the typed proxy marker', () => {
    const layer = loadRoadLayer();
    const rendered = layer.buildTrafficLayer({
      ways: {
        W1: {
          traffic_measurement_type: 'proxy',
          traffic_proxy_class: 'high',
          traffic_proxy_basis: 'highway=primary',
        },
      },
      geometries: { W1: [50, 7, 50.001, 7.001] },
      dicts: {},
    }).getLayers();
    expect(rendered).toHaveLength(1);
    expect(rendered[0].feature.properties).toEqual(expect.objectContaining({
      kind: 'traffic',
      class: 'high',
      traffic_measurement_type: 'proxy',
      traffic_proxy_class: 'high',
    }));
  });

  test('the production context lifecycle applies the adapter before final gates', () => {
    const runner = fs.readFileSync(path.join(ROOT, 'scripts/run-context-enrichment.js'), 'utf8');
    const adapterCall = runner.indexOf("run('scripts/apply-qualitative-traffic-proxy.js'");
    const preflightCall = runner.indexOf("run('scripts/check-enrichment-inputs.js'");
    expect(adapterCall).toBeGreaterThanOrEqual(0);
    expect(preflightCall).toBeGreaterThan(adapterCall);
  });

  test('producer source contains no numeric highway-to-DTV catalogue', () => {
    const producer = fs.readFileSync(path.join(ROOT, 'scripts/producers/traffic_producer.js'), 'utf8');
    expect(producer).toContain("measurementType: 'proxy'");
    expect(producer).toContain('HIGHWAY_PROXY_CLASS');
    expect(producer).not.toContain('HIGHWAY_DTV_PROXY');
    expect(producer).not.toMatch(/motorway:\s*50[_0-9]*000/);
    expect(producer).not.toMatch(/residential:\s*800/);
  });
});
