#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
  createVideoExportContextFixture,
} = require('../tests/fixtures/videoExportContextFixture');

function writeGzipJson(outDir, logicalName, value) {
  const rawPath = path.join(outDir, logicalName);
  fs.rmSync(rawPath, { force: true });
  fs.rmSync(`${rawPath}.gz`, { force: true });
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  fs.writeFileSync(`${rawPath}.gz`, zlib.gzipSync(bytes, { level: 9, mtime: 0 }));
}

function installVideoExportFixture(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, '..'));
  const outDir = path.join(root, 'out');
  const fixture = createVideoExportContextFixture();
  fs.mkdirSync(outDir, { recursive: true });
  writeGzipJson(outDir, 'output_all_years_bonn.geojson', fixture.geojson);
  writeGzipJson(outDir, 'ways_bonn.json', fixture.ways);
  writeGzipJson(outDir, 'output_all_years_bonn.enrichment.meta.json', fixture.meta);
  fs.rmSync(path.join(outDir, 'ctxtiles', 'bonn'), { recursive: true, force: true });
  fs.rmSync(path.join(outDir, 'accidenttiles', 'bonn'), { recursive: true, force: true });
  return {
    city: 'Bonn',
    accidents: fixture.geojson.features.length,
    ways: Object.keys(fixture.ways.ways).length,
  };
}

if (require.main === module) {
  if (process.env.VIDEO_EXPORT_INTEGRATION_FIXTURE !== '1') {
    throw new Error('Refusing to replace accident data outside an explicit integration-fixture build.');
  }
  const result = installVideoExportFixture();
  process.stdout.write(`[video-export-fixture] Installed ${result.accidents} accidents and ${result.ways} ways for ${result.city}.\n`);
}

module.exports = { installVideoExportFixture, writeGzipJson };
