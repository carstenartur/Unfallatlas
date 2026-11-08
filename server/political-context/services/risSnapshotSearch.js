'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { cityKey, searchSnapshot, createCatalogue } = require('../../../js/ua.ris-catalogue.js');
const { readRisSnapshot } = require('./risSnapshot.js');

function createRisSnapshotSearch(directory) {
  const cache = new Map();
  return async params => {
    const city = cityKey(params.city);
    if (!city) return null;
    let stat;
    try {
      stat = await fs.lstat(path.join(directory, `${city}.json`), { bigint: true });
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const revision = `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
    let entry = cache.get(city);
    if (entry?.revision !== revision) {
      if (cache.size >= 4 && !entry) cache.delete(cache.keys().next().value);
      const manifest = JSON.parse(await fs.readFile(path.join(directory, `${city}.json`), 'utf8'));
      if (manifest.schemaVersion === 2) {
        const catalogue = createCatalogue({ base: 'https://ris.local/', fetch: async url => {
          const name = new URL(url).pathname.split('/').pop();
          if (!/^[a-z0-9_.-]+$/.test(name)) throw new Error('Invalid RIS asset name');
          try { return new Response(await require('./risSnapshot').partitionInternals.readBounded(path.join(directory, name), 5 * 1024 * 1024, 'asset')); }
          catch (error) { if (error.code === 'ENOENT') return new Response(null, { status: 404 }); throw error; }
        }});
        entry = { revision, catalogue };
      } else entry = { revision, snapshot: readRisSnapshot(directory, city) };
      cache.set(city, entry);
    }
    return entry.catalogue ? entry.catalogue.search(params) : searchSnapshot(await entry.snapshot, params);
  };
}

module.exports = { createRisSnapshotSearch };
