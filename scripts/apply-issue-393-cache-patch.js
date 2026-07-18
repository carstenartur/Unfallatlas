'use strict';

const fs = require('fs');
const path = require('path');

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`${label}: source block not found`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: source block is ambiguous`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function patchProvider(root) {
  const file = path.join(root, 'js/ua.accident_provider.js');
  let source = fs.readFileSync(file, 'utf8');
  if (!source.includes('function retainForViewport')) {
    source = replaceExactlyOnce(
      source,
      '      trimTileCache(slug, new Set(requestedTileKeys));\n      return Object.freeze({',
      '      return Object.freeze({',
      'remove request-local viewport eviction'
    );
    source = replaceExactlyOnce(
      source,
      '    function getCacheSnapshot(cityRaw) {',
      [
        '    function retainForViewport(cityRaw, tileKeys) {',
        '      const activeKeys = Array.isArray(tileKeys) ? tileKeys : [];',
        '      trimTileCache(slugify(cityRaw), new Set(activeKeys));',
        '    }',
        '',
        '    function getCacheSnapshot(cityRaw) {',
      ].join('\n'),
      'add commit-driven viewport retention'
    );
    source = replaceExactlyOnce(
      source,
      '      getManifest: loadManifest,\n      getCacheSnapshot,',
      '      getManifest: loadManifest,\n      retainForViewport,\n      getCacheSnapshot,',
      'export viewport retention'
    );
    fs.writeFileSync(file, source, 'utf8');
  }
}

function patchController(root) {
  const file = path.join(root, 'js/ua.accident_viewport_controller.js');
  let source = fs.readFileSync(file, 'utf8');
  if (!source.includes('provider.retainForViewport(city')) {
    source = replaceExactlyOnce(
      source,
      [
        '        const nextGeoJson = mergeTileSet(tileSet);',
        '        const requiredTileKeys = Array.from(tileSet.requestedTileKeys || []);',
      ].join('\n'),
      [
        '        const nextGeoJson = mergeTileSet(tileSet);',
        "        if (typeof provider.retainForViewport === 'function') {",
        '          provider.retainForViewport(city, tileSet.requestedTileKeys || []);',
        '        }',
        '        const requiredTileKeys = Array.from(tileSet.requestedTileKeys || []);',
      ].join('\n'),
      'retain cache only after epoch validation and merge'
    );
    fs.writeFileSync(file, source, 'utf8');
  }
}

function main() {
  const root = path.resolve(__dirname, '..');
  patchProvider(root);
  patchController(root);
}

if (require.main === module) main();

module.exports = { replaceExactlyOnce, patchProvider, patchController, main };
