'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const RUNTIME_CONSUMERS = [
  'js/ua.data.js',
  'js/ua.data_v2.js',
  'js/ua.context_layers.js',
  'js/ua.preview_map_renderer.js',
];

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('central browser static-data access architecture', () => {
  test.each(RUNTIME_CONSUMERS)('%s contains no generated-data path literals', relative => {
    const source = stripComments(read(relative));
    expect(source).not.toMatch(/(?:^|["'`])out\//);
    expect(source).not.toMatch(/output_all_years_|poi_|ways_|ctxtiles\/|accidenttiles\//);
  });

  test.each(RUNTIME_CONSUMERS)('%s does not bypass DataResources transport', relative => {
    const source = stripComments(read(relative));
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/UA\.fetchJson(?:Compressed|Gz)\s*\(/);
  });

  test('DataResources is the sole runtime owner of canonical generated-data paths', () => {
    const registry = read('js/ua.data_paths.js');
    expect(registry).toMatch(/const definitions = Object\.freeze/);
    expect(registry).toMatch(/contextTile:[\s\S]*GZIP_ONLY/);
    expect(registry).toMatch(/fetchJson\(kind, params, options\)/);
  });

  test('HTML loads DataResources before every static-data consumer', () => {
    const html = read('werkbank_v2.html');
    const registry = html.indexOf('js/ua.data_paths.js');
    expect(registry).toBeGreaterThanOrEqual(0);
    for (const script of [
      'js/ua.context_layers.js',
      'js/ua.accident_provider.js',
      'js/ua.data_v2.js',
      'js/ua.preview_map_renderer.js',
    ]) {
      const consumer = html.indexOf(script);
      expect(consumer).toBeGreaterThan(registry);
    }
  });

  test('preview renderer cannot replace context data access functions', () => {
    const source = stripComments(read('js/ua.preview_map_renderer.js'));
    expect(source).not.toMatch(/contextLayers\.loadTilesForBbox\s*=/);
    expect(source).not.toMatch(/contextLayers\.resolveWayAcrossTiles\s*=/);
  });
});