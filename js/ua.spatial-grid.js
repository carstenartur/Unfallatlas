(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) (root.UA = root.UA || {}).SpatialGrid = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const MAX_LATITUDE = 85.05112878;
  const DEFAULT_MAX_TILES = 65536;

  function side(zoom) {
    if (!Number.isInteger(zoom) || zoom < 0 || zoom > 30) throw new RangeError('Invalid tile zoom');
    return 2 ** zoom;
  }

  function lonToTileX(lon, zoom) {
    const n = side(zoom);
    return Math.max(0, Math.min(n - 1, Math.floor(((lon + 180) / 360) * n)));
  }

  function latToTileY(lat, zoom) {
    const n = side(zoom);
    const radians = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat)) * Math.PI / 180;
    return Math.max(0, Math.min(n - 1,
      Math.floor((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * n)));
  }

  function tileXToLon(x, zoom) { return x / side(zoom) * 360 - 180; }
  function tileYToLat(y, zoom) { return Math.atan(Math.sinh(Math.PI - 2 * Math.PI * y / side(zoom))) * 180 / Math.PI; }

  // The array form preserves the existing accident/context API: S,W,N,E.
  // Geometry bounds and tileBounds use the GeoJSON convention: W,S,E,N.
  function tileRange(bounds, zoom) {
    if (!bounds) return null;
    let south, west, north, east;
    if (typeof bounds.getSouth === 'function') {
      south = bounds.getSouth(); west = bounds.getWest(); north = bounds.getNorth(); east = bounds.getEast();
    } else if (Array.isArray(bounds) && bounds.length === 4) {
      [south, west, north, east] = bounds;
    } else {
      ({ south, west, north, east } = bounds);
    }
    if (![south, west, north, east].every(Number.isFinite)) return null;
    const xMin = lonToTileX(Math.min(west, east), zoom);
    const xMax = lonToTileX(Math.max(west, east), zoom);
    const yMin = latToTileY(Math.max(south, north), zoom);
    const yMax = latToTileY(Math.min(south, north), zoom);
    return { xMin, xMax, yMin, yMax, count: (xMax - xMin + 1) * (yMax - yMin + 1) };
  }

  function tilesForBounds(bounds, zoom, { maxTiles = DEFAULT_MAX_TILES } = {}) {
    const range = tileRange(bounds, zoom);
    if (!range) return [];
    if (!(maxTiles >= 0) || range.count > maxTiles) {
      const error = new RangeError(`Spatial tile request exceeds ${maxTiles} tiles`);
      error.code = 'SPATIAL_TILE_LIMIT';
      throw error;
    }
    const tiles = [];
    for (let x = range.xMin; x <= range.xMax; x++) {
      for (let y = range.yMin; y <= range.yMax; y++) tiles.push([x, y]);
    }
    return tiles;
  }

  function tileBounds(x, y, zoom) {
    return [tileXToLon(x, zoom), tileYToLat(y + 1, zoom), tileXToLon(x + 1, zoom), tileYToLat(y, zoom)];
  }

  function geometryBounds(geometry) {
    const result = [Infinity, Infinity, -Infinity, -Infinity];
    let invalid = false;
    function visit(coordinates) {
      if (!Array.isArray(coordinates) || !coordinates.length) { invalid = true; return; }
      if (typeof coordinates[0] === 'number') {
        const [x, y] = coordinates;
        if (!Number.isFinite(x) || !Number.isFinite(y)) { invalid = true; return; }
        result[0] = Math.min(result[0], x); result[1] = Math.min(result[1], y);
        result[2] = Math.max(result[2], x); result[3] = Math.max(result[3], y);
      } else coordinates.forEach(visit);
    }
    if (geometry?.type === 'GeometryCollection') {
      for (const part of geometry.geometries || []) {
        const box = geometryBounds(part);
        if (!box) { invalid = true; break; }
        visit([[box[0], box[1]], [box[2], box[3]]]);
      }
    } else visit(geometry?.coordinates);
    return !invalid && result.every(Number.isFinite) ? result : null;
  }

  function intersectsBounds(a, b) {
    return !!a && !!b && a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
  }

  return Object.freeze({ lonToTileX, latToTileY, tileXToLon, tileYToLat,
    tileRange, tilesForBounds, tileBounds, geometryBounds, intersectsBounds });
});
