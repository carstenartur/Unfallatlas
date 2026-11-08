'use strict';

// Deliberately synthetic cartography. Accident locations/IDs may come from real
// published records; the background must never be presented as live map tiles.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  drawing: d
} = require('./deterministic-map-fixture');
// Load the production palette without invoking Leaflet or creating a map.
const mapWindow = {
  UA: {}
};
new Function('window', fs.readFileSync(path.join(__dirname, '../js/ua.map_v2.js'), 'utf8'))(mapWindow);
const SEVERITY_COLORS = Object.freeze({
  ...mapWindow.UA.SEVERITY_COLORS
});
const FONT = Object.fromEntries(Object.entries({
  A: '01110 10001 10001 11111 10001 10001 10001',
  B: '11110 10001 10001 11110 10001 10001 11110',
  C: '01111 10000 10000 10000 10000 10000 01111',
  D: '11110 10001 10001 10001 10001 10001 11110',
  E: '11111 10000 10000 11110 10000 10000 11111',
  F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01111 10000 10000 10111 10001 10001 01111',
  H: '10001 10001 10001 11111 10001 10001 10001',
  I: '11111 00100 00100 00100 00100 00100 11111',
  J: '00111 00010 00010 00010 10010 10010 01100',
  K: '10001 10010 10100 11000 10100 10010 10001',
  L: '10000 10000 10000 10000 10000 10000 11111',
  M: '10001 11011 10101 10101 10001 10001 10001',
  N: '10001 11001 11001 10101 10011 10011 10001',
  O: '01110 10001 10001 10001 10001 10001 01110',
  P: '11110 10001 10001 11110 10000 10000 10000',
  Q: '01110 10001 10001 10001 10101 10010 01101',
  R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110',
  T: '11111 00100 00100 00100 00100 00100 00100',
  U: '10001 10001 10001 10001 10001 10001 01110',
  V: '10001 10001 10001 10001 10001 01010 00100',
  W: '10001 10001 10001 10101 10101 10101 01010',
  X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100',
  Z: '11111 00001 00010 00100 01000 10000 11111',
  0: '01110 10001 10011 10101 11001 10001 01110',
  1: '00100 01100 00100 00100 00100 00100 01110',
  2: '01110 10001 00001 00010 00100 01000 11111',
  3: '11110 00001 00001 01110 00001 00001 11110',
  4: '00010 00110 01010 10010 11111 00010 00010',
  5: '11111 10000 10000 11110 00001 00001 11110',
  6: '01110 10000 10000 11110 10001 10001 01110',
  7: '11111 00001 00010 00100 01000 01000 01000',
  8: '01110 10001 10001 01110 10001 10001 01110',
  9: '01110 10001 10001 01111 00001 00001 01110',
  '-': '00000 00000 00000 11111 00000 00000 00000',
  ':': '00000 00100 00100 00000 00100 00100 00000',
  '.': '00000 00000 00000 00000 00000 00100 00100',
  '=': '00000 11111 00000 11111 00000 00000 00000'
}).map(([k, v]) => [k, v.split(' ')]));
const BLACK = [30, 36, 44, 255],
  WHITE = [255, 255, 255, 255];
function text(surface, value, x, y, scale = 2) {
  for (const [i, c] of [...String(value).toUpperCase()].entries()) {
    const glyph = FONT[c];
    if (!glyph) continue;
    glyph.forEach((row, dy) => [...row].forEach((on, dx) => {
      if (on === '1') d.fillRect(surface, x + (i * 6 + dx) * scale, y + dy * scale, scale, scale, BLACK);
    }));
  }
}
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function rgba(hex) {
  return [...hex.slice(1).match(/../g).map(x => parseInt(x, 16)), 255];
}
function checkedBounds(b) {
  if (!b || !['south', 'west', 'north', 'east'].every(k => Number.isFinite(b[k])) || b.south >= b.north || b.west >= b.east) throw new Error('Invalid map bounds');
  return Object.fromEntries(['south', 'west', 'north', 'east'].map(k => [k, b[k]]));
}
function boundsForPoints(points, padding = .08) {
  const lats = points.map(p => Number(p.lat)),
    lons = points.map(p => Number(p.lon));
  const south = Math.min(...lats),
    north = Math.max(...lats),
    west = Math.min(...lons),
    east = Math.max(...lons);
  const dy = Math.max(north - south, .0002) * padding,
    dx = Math.max(east - west, .0002) * padding;
  return {
    south: south - dy,
    west: west - dx,
    north: north + dy,
    east: east + dx
  };
}
function createRoleMapFixture(options) {
  const {
    role,
    snapshotHash
  } = options;
  if (!/^[a-f0-9]{64}$/.test(snapshotHash || '')) throw new Error('Map source snapshot hash is required');
  if (!/^[a-z][a-z0-9-]*$/i.test(role || '')) throw new Error('Map role is required');
  const bounds = checkedBounds(options.bounds),
    points = options.points || [];
  if (!points.length || points.length > 280) throw new Error('Map needs 1–280 accident points');
  const ids = points.map(p => String(p.id || ''));
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('Missing or duplicate map accident IDs');
  const width = 1200,
    height = 800,
    surface = d.createSurface(width, height, [229, 236, 225, 255]);
  d.fillRect(surface, width * .82, 90, 110, height - 150, [179, 215, 234, 255]);
  for (let row = 0; row < 6; row++) for (let col = 0; col < 9; col++) d.fillRect(surface, 25 + col * 125, 120 + row * 98, 72, 48, [214, 209, 198, 255]);
  d.drawRoad(surface, [[0, 510], [430, 410], [760, 450], [1200, 270]], 18);
  d.drawRoad(surface, [[350, 90], [540, 370], [620, 700]], 14);
  d.drawRoad(surface, [[0, 220], [650, 300], [1200, 600]], 8);
  d.drawDashedRect(surface, 25, 100, width - 50, height - 175, [32, 87, 171, 255], 3, 12);
  d.fillRect(surface, 0, 0, width, 90, WHITE);
  text(surface, 'DETERMINISTIC TEST BASEMAP - NO LIVE TILES', 18, 12, 2);
  text(surface, `${role} N=${ids.length}`, 18, 44, 3);
  text(surface, 'N', width - 45, 12, 3);
  d.drawLine(surface, width - 36, 70, width - 36, 40, BLACK, 3);
  const labels = [];
  const columns = 14,
    stepX = 82,
    stepY = 29;
  const slots = Array.from({
    length: columns * 20
  }, (_, i) => ({
    x: 25 + i % columns * stepX,
    y: 110 + Math.floor(i / columns) * stepY
  }));
  const projected = points.map(p => {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || p.lat < bounds.south || p.lat > bounds.north || p.lon < bounds.west || p.lon > bounds.east) throw new Error(`Map point ${p.id} outside bounds`);
    return {
      ...p,
      x: 35 + (p.lon - bounds.west) / (bounds.east - bounds.west) * (width - 70),
      y: 110 + (bounds.north - p.lat) / (bounds.north - bounds.south) * (height - 200)
    };
  });
  for (const p of projected) {
    const labelWidth = String(p.id).length * 18 + 8;
    const available = slots.filter(s => projected.every(marker => marker.x + 8 < s.x - 2 || marker.x - 8 > s.x + labelWidth || marker.y + 8 < s.y - 2 || marker.y - 8 > s.y + 25));
    if (!available.length) throw new Error('No collision-free map label position');
    available.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
    const label = available[0];
    slots.splice(slots.indexOf(label), 1);
    labels.push({
      id: String(p.id),
      xMin: label.x - 2,
      yMin: label.y - 2,
      xMax: label.x + labelWidth,
      yMax: label.y + 25,
      markerX: p.x,
      markerY: p.y
    });
  }
  for (const label of labels) d.drawLine(surface, label.markerX, label.markerY, label.xMin + 22, label.yMin + 10, [80, 80, 80, 255], 1);
  for (const p of projected) d.drawCircle(surface, p.x, p.y, 5, rgba(SEVERITY_COLORS[String(p.severity)] || '#777777'), BLACK, 1);
  for (const label of labels) {
    d.fillRect(surface, label.xMin, label.yMin, label.xMax - label.xMin, label.yMax - label.yMin, WHITE);
    text(surface, label.id, label.xMin + 2, label.yMin + 2, 3);
  }
  d.fillRect(surface, 0, height - 65, width, 65, WHITE);
  let lx = 20;
  for (const [severity, label] of [['1', 'FATAL'], ['2', 'SERIOUS'], ['3', 'SLIGHT']]) {
    d.drawCircle(surface, lx + 8, height - 40, 7, rgba(SEVERITY_COLORS[severity]), BLACK, 1);
    text(surface, label, lx + 25, height - 48, 2);
    lx += 205;
  }
  text(surface, 'SOURCE: UNFALLATLAS / TEST CARTOGRAPHY', 20, height - 20, 1);
  const receipt = {
    schemaVersion: 1,
    role,
    snapshotHash,
    bounds,
    accidentIds: ids,
    markerCount: ids.length,
    labels,
    severityColors: SEVERITY_COLORS,
    width,
    height,
    basemap: 'Deterministic test basemap; no live tiles',
    labelEncoding: '5x7 bitmap, displaced labels with leader lines'
  };
  const png = d.encodePng(surface, {
    Title: `${role} – deterministic test basemap`,
    Source: receipt.basemap,
    Snapshot: snapshotHash,
    AccidentIds: ids.join(','),
    Bounds: JSON.stringify(bounds),
    MarkerCount: ids.length
  });
  return {
    png,
    receipt: {
      ...receipt,
      sha256: sha256(png),
      pixelSha256: sha256(surface.pixels)
    }
  };
}
function verifyRoleMapFixtures(maps, snapshotHash) {
  if (!maps.length) throw new Error('No map receipts');
  const seen = new Set(),
    overview = maps.find(m => m.receipt.role === 'overview'),
    population = new Set(overview?.receipt.accidentIds || []);
  for (const {
    png,
    receipt: r
  } of maps) {
    if (r.snapshotHash !== snapshotHash) throw new Error('Map source snapshot mismatch');
    if (r.sha256 !== sha256(png) || seen.has(r.sha256)) throw new Error('Map bytes reused or receipt hash mismatch');
    const embedded = new (require('png-js'))(png).text;
    if (embedded.Snapshot !== snapshotHash || embedded.AccidentIds !== r.accidentIds.join(',') ||
        embedded.MarkerCount !== String(r.markerCount) || embedded.Bounds !== JSON.stringify(r.bounds) ||
        JSON.stringify(r.labels.map(label => label.id)) !== JSON.stringify(r.accidentIds)) {
      throw new Error('Map receipt IDs, bounds or source differ from the PNG');
    }
    seen.add(r.sha256);
    if (r.markerCount !== r.accidentIds.length || new Set(r.accidentIds).size !== r.accidentIds.length || r.labels.length !== r.markerCount) throw new Error('Map ID receipt mismatch');
    if (overview && r.accidentIds.some(id => !population.has(id))) throw new Error('Map IDs outside overview subset');
  }
  return true;
}
module.exports = {
  createRoleMapFixture,
  verifyRoleMapFixtures,
  boundsForPoints,
  SEVERITY_COLORS,
  sha256
};
