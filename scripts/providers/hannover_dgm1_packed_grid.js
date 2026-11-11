'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const sourceCatalog = require('../../config/hannover-dgm1-city-archives.json');

const SIDE = 500;
const BYTES_PER_TILE = SIDE * SIDE * 4;
const MAX_CACHED_TILES = 16;

function validatePackedManifest(manifest) {
  const {grid, distribution} = manifest;
  const expectedArchives = sourceCatalog.archives.map(item => item.sha256);
  const expectedCount = sourceCatalog.archives.reduce((sum, item) => sum + item.xyzEntries, 0);
  if (manifest.sourceId !== 'hannover.dgm1' || typeof manifest.retrievedAt !== 'string' ||
      !Number.isFinite(Date.parse(manifest.retrievedAt)) ||
      JSON.stringify(manifest.archiveSha256) !== JSON.stringify(expectedArchives) ||
      !grid || grid.crs !== 'EPSG:25832' || grid.resolutionMeters !== 1 || grid.tileSide !== SIDE ||
      grid.layout !== 'x-major-float32le' || !Array.isArray(grid.tiles) || grid.tiles.length !== expectedCount ||
      !distribution || distribution.sha256 !== sourceCatalog.packedRasterSha256 ||
      distribution.path !== 'heights-' + distribution.sha256 + '.f32' ||
      distribution.bytes !== expectedCount * BYTES_PER_TILE) throw new Error('Invalid Hannover DGM1 city raster manifest');
  const keys = new Set();
  for (const origin of grid.tiles) {
    if (!Array.isArray(origin) || origin.length !== 2 ||
        !origin.every(value => Number.isSafeInteger(value) && value % SIDE === 0) ||
        keys.has(origin.join(','))) throw new Error('Invalid or duplicate Hannover DGM1 tile origin');
    keys.add(origin.join(','));
  }
  return manifest;
}

function loadPackedGrid(file, manifest) {
  const {grid, distribution} = manifest;
  const offsets = new Map(grid.tiles.map(([east,north], i) => [east + ',' + north, i * BYTES_PER_TILE]));
  const cache = new Map();
  const fd = fs.openSync(file, 'r');
  try {
    if (fs.fstatSync(fd).size !== distribution.bytes || distribution.bytes !== offsets.size * BYTES_PER_TILE) {
      throw new Error('City raster byte size mismatch');
    }
    const hash = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd,chunk,0,chunk.length,null)) > 0) hash.update(chunk.subarray(0,count));
    if (hash.digest('hex') !== distribution.sha256) throw new Error('City raster SHA-256 mismatch');
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
  let closed = false;
  function valueAt(x,y) {
    const east = Math.floor(x / SIDE) * SIDE;
    const north = Math.floor(y / SIDE) * SIDE;
    const offset = offsets.get(east + ',' + north);
    if (offset === undefined) return null;
    let tile = cache.get(offset);
    if (!tile) {
      tile = Buffer.allocUnsafe(BYTES_PER_TILE);
      let read = 0;
      while (read < BYTES_PER_TILE) {
        const n = fs.readSync(fd, tile, read, BYTES_PER_TILE-read, offset+read);
        if (!n) throw new Error('City raster truncated during sampling');
        read += n;
      }
      if (cache.size >= MAX_CACHED_TILES) cache.delete(cache.keys().next().value);
    } else {
      cache.delete(offset);
    }
    cache.set(offset,tile);
    return tile.readFloatLE(((x-east)*SIDE + y-north)*4);
  }
  return {
    pointCount: offsets.size * SIDE * SIDE,
    sha256: distribution.sha256,
    close() {
      if (closed) return;
      cache.clear();
      fs.closeSync(fd);
      closed = true;
    },
    sampleProjected(easting,northing) {
      if (closed) throw new Error('City raster is closed');
      const x = easting-0.5, y = northing-0.5;
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const dx = x-x0, dy = y-y0;
      // At an exact grid node, an absent neighbour with zero weight is irrelevant.
      const x1 = dx ? x0+1 : x0, y1 = dy ? y0+1 : y0;
      const a = valueAt(x0,y0), b = valueAt(x1,y0), c = valueAt(x0,y1), d = valueAt(x1,y1);
      if (![a,b,c,d].every(Number.isFinite)) return null;
      return a*(1-dx)*(1-dy) + b*dx*(1-dy) + c*(1-dx)*dy + d*dx*dy;
    },
  };
}

module.exports = {validatePackedManifest, loadPackedGrid};
