'use strict';

/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');

describe('context tile access ownership', () => {
  function loadModule(relPath) {
    const code = fs.readFileSync(path.resolve(__dirname, relPath), 'utf8');
    // eslint-disable-next-line no-new-func
    (new Function('window', 'document', code))(window, document);
  }

  beforeEach(() => {
    delete window.UA;
    delete window.L;
    window.UA = { normKey: (s) => String(s || '').toLowerCase() };
    loadModule('../../js/ua.data_paths.js');
    loadModule('../../js/ua.context_layers.js');
  });

  test('preview renderer never replaces context-layer loaders', () => {
    const loadTilesForBbox = window.UA.contextLayers.loadTilesForBbox;
    const resolveWayAcrossTiles = window.UA.contextLayers.resolveWayAcrossTiles;

    loadModule('../../js/ua.preview_map_renderer.js');

    expect(window.UA.contextLayers.loadTilesForBbox).toBe(loadTilesForBbox);
    expect(window.UA.contextLayers.resolveWayAcrossTiles).toBe(resolveWayAcrossTiles);
    expect(window.UA.contextLayers._contextTilePerformanceGuards).toBeUndefined();
  });

  test('preview renderer contains no static context path or network implementation', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../js/ua.preview_map_renderer.js'),
      'utf8'
    );

    expect(source).not.toMatch(/out\/ctxtiles/i);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\.loadTilesForBbox\s*=/);
    expect(source).not.toMatch(/\.resolveWayAcrossTiles\s*=/);
  });

  test('context tile URL and compression policy come from DataResources', () => {
    const descriptor = window.UA.DataResources.resolve('contextTile', {
      city: 'Hannover', x: 4300, y: 2680,
    });

    expect(descriptor.logicalUrl).toBe('out/ctxtiles/hannover/4300/2680.json');
    expect(descriptor.gzipUrl).toBe('out/ctxtiles/hannover/4300/2680.json.gz');
    expect(descriptor.compression)
      .toBe(window.UA.DataResources.COMPRESSION.GZIP_ONLY);
  });
});