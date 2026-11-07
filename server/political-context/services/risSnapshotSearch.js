'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { cityKey, searchSnapshot } = require('../../../js/ua.ris-catalogue.js');
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
      entry = { revision, snapshot: readRisSnapshot(directory, city) };
      cache.set(city, entry);
    }
    return searchSnapshot(await entry.snapshot, params);
  };
}

module.exports = { createRisSnapshotSearch };
