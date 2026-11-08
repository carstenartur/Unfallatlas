'use strict';

// This is the literal PRJ in the SHA-pinned official 2016–2019 archive,
// not a guessed EPSG definition or a replacement Helmert transformation.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const proj4 = require('proj4');
const CRS_ID = 'KOELN:DHDN_GK2_TOWGS84_2019';
const WKT_SHA256 = 'dbc190580b141d88014eb57cbcb574fc4e38b339e3a97d4fdd28ecfcaad71a84';
const WKT = fs.readFileSync(path.join(__dirname, '../../config/koeln-kfz-2019-source.prj'), 'utf8');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
if (hash(WKT) !== WKT_SHA256) throw new Error('Official Köln projection definition hash mismatch');
const LIBRARY_VERSION = require('proj4/package.json').version;
const transformer = proj4(WKT, 'EPSG:4326');
const TRANSFORM_ID = `proj4-${LIBRARY_VERSION}-koeln-gk2-literal-towgs84-v1`;
function recognizes(wkt) { return hash(wkt) === WKT_SHA256; }
function project(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Invalid native coordinate');
  const [lon, lat] = transformer.forward([point.x, point.y]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 45 || lat > 60 || lon < 4 || lon > 16) {
    throw new Error('Projected Köln coordinate lies outside the supported Germany extent');
  }
  return Object.freeze({ lat, lon });
}
module.exports = Object.freeze({ CRS_ID, WKT_SHA256, TRANSFORM_ID, LIBRARY_VERSION, recognizes, project });
