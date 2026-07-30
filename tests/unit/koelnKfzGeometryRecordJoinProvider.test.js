/** @jest-environment node */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const provider = require('../../scripts/providers/koeln_kfz_geometry_record_join_provider');

function schema() {
  return Object.freeze({
    schemaVersion: 1,
    type: provider.SCHEMA_TYPE,
    archiveSourceId: 'traffic.geometry.koeln-kfz-2016-2019',
    archiveSha256: 'a'.repeat(64),
    pointSet: Object.freeze({ id: 'nodes', nodeIdField: 'NODE' }),
    lineSet: Object.freeze({
      id: 'links',
      segmentIdField: 'SEGMENT',
      fromNodeIdField: 'FROMNODE',
      toNodeIdField: 'TONODE',
    }),
    encoding: 'ascii',
    crs: 'EPSG:25832',
    maxEndpointDistanceMeters: 2,
    path: 'schema.json',
    sha256: 'b'.repeat(64),
  });
}

function pointRecord(nodeId, x, y) {
  return Object.freeze({ row: Object.freeze({ NODE: nodeId }), point: Object.freeze({ x, y }) });
}

function lineRecord(segment, fromNode, toNode, points) {
  return Object.freeze({
    row: Object.freeze({ SEGMENT: segment, FROMNODE: fromNode, TONODE: toNode }),
    parts: Object.freeze([Object.freeze(points)]),
  });
}

function shx(entries) {
  const buffer = Buffer.alloc(100 + entries.length * 8);
  buffer.writeInt32BE(9994, 0);
  buffer.writeInt32BE(buffer.length / 2, 24);
  buffer.writeInt32LE(1000, 28);
  buffer.writeInt32LE(1, 32);
  let offset = 100;
  for (const entry of entries) {
    buffer.writeInt32BE(entry.offset / 2, offset);
    buffer.writeInt32BE(entry.contentBytes / 2, offset + 4);
    offset += 8;
  }
  return buffer;
}

function dbf(fields, rows) {
  const headerBytes = 32 + fields.length * 32 + 1;
  const recordBytes = 1 + fields.reduce((sum, field) => sum + field.length, 0);
  const buffer = Buffer.alloc(headerBytes + rows.length * recordBytes + 1, 0);
  buffer[0] = 0x03;
  buffer.writeUInt32LE(rows.length, 4);
  buffer.writeUInt16LE(headerBytes, 8);
  buffer.writeUInt16LE(recordBytes, 10);
  fields.forEach((field, index) => {
    const offset = 32 + index * 32;
    buffer.write(field.name, offset, Math.min(11, field.name.length), 'ascii');
    buffer[offset + 11] = field.type.charCodeAt(0);
    buffer[offset + 16] = field.length;
  });
  buffer[headerBytes - 1] = 0x0d;
  rows.forEach((row, rowIndex) => {
    const offset = headerBytes + rowIndex * recordBytes;
    buffer[offset] = 0x20;
    let cursor = offset + 1;
    fields.forEach((field) => {
      const value = String(row[field.name] || '').padEnd(field.length, ' ').slice(0, field.length);
      buffer.write(value, cursor, field.length, 'ascii');
      cursor += field.length;
    });
  });
  buffer[buffer.length - 1] = 0x1a;
  return buffer;
}

describe('Cologne geometry record and observation join', () => {
  test('joins by segment and directed node IDs independently of CSV direction label', () => {
    const points = [
      pointRecord('A', 500000, 5800000),
      pointRecord('B', 500100, 5800000),
    ];
    const lines = [lineRecord('200', 'A', 'B', [
      { x: 500000, y: 5800000 },
      { x: 500100, y: 5800000 },
    ])];
    const index = provider.buildOfficialGeometryIndex(points, lines, schema());
    const observations = [{
      observationId: 'traffic:200:reverse:2019',
      measurementType: 'count',
      mode: 'motor_vehicle',
      year: 2019,
      value: 12000,
      unit: 'Kfz/24 h',
      wayId: 'koeln-segment:200:reverse:A->B',
      qualityNotes: [],
    }];

    const joined = provider.joinObservations(observations, index, schema());
    expect(joined).toHaveLength(1);
    expect(joined[0].officialGeometry.directionCode).toBe('reverse');
    expect(joined[0].officialGeometry.fromNode).toBe('A');
    expect(joined[0].officialGeometry.toNode).toBe('B');
    expect(joined[0].geometry.type).toBe('LineString');
    expect(joined[0].geometry.coordinates[0][0]).toBeCloseTo(9, 5);
    expect(joined[0].qualityNotes.at(-1)).toMatch(/keine OpenStreetMap-Zuordnung/);
  });

  test('reverses source coordinates when SHP endpoints oppose DBF direction', () => {
    const points = [pointRecord('A', 500000, 5800000), pointRecord('B', 500100, 5800000)];
    const lines = [lineRecord('201', 'A', 'B', [
      { x: 500100, y: 5800000 },
      { x: 500000, y: 5800000 },
    ])];
    const index = provider.buildOfficialGeometryIndex(points, lines, schema());
    const direct = index.lines.get('201:A->B');
    expect(direct.sourceOrientationReversed).toBe(true);
    expect(direct.points[0]).toEqual({ x: 500000, y: 5800000 });
    expect(direct.points.at(-1)).toEqual({ x: 500100, y: 5800000 });
  });

  test('rejects an observation without complete official geometry coverage', () => {
    const index = Object.freeze({ nodes: new Map(), lines: new Map() });
    expect(() => provider.joinObservations([{
      observationId: 'missing',
      wayId: 'koeln-segment:999:forward:A->B',
    }], index, schema())).toThrow(/observation_geometry_coverage_mismatch/);
  });

  test('reads SHX-indexed point records and DBF rows positionally', () => {
    const contentBytes = 20;
    const shp = Buffer.alloc(100 + 8 + contentBytes);
    shp.writeInt32BE(9994, 0);
    shp.writeInt32BE(shp.length / 2, 24);
    shp.writeInt32LE(1000, 28);
    shp.writeInt32LE(1, 32);
    shp.writeInt32BE(1, 100);
    shp.writeInt32BE(contentBytes / 2, 104);
    shp.writeInt32LE(1, 108);
    shp.writeDoubleLE(500000, 112);
    shp.writeDoubleLE(5800000, 120);
    const index = shx([{ offset: 100, contentBytes }]);
    index.writeInt32LE(1, 32);
    const rows = dbf([{ name: 'NODE', type: 'C', length: 8 }], [{ NODE: 'A' }]);
    const set = { id: 'nodes', recordCount: 1 };

    const records = provider.readPointRecords(shp, index, rows, schema(), set);
    expect(records).toEqual([{ row: { NODE: 'A' }, point: { x: 500000, y: 5800000 } }]);
  });

  test('loads only a hash-pinned exact schema and rejects extra interpretation fields', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koeln-geometry-schema-'));
    try {
      const value = {
        schemaVersion: 1,
        type: provider.SCHEMA_TYPE,
        archiveSourceId: 'traffic.geometry.koeln-kfz-2016-2019',
        archiveSha256: '5672f1b61777ccbd5a1db6555dddf7c61a009eb161b13d4c7cbe530de9299238',
        pointSet: { id: 'nodes', nodeIdField: 'NODE' },
        lineSet: { id: 'links', segmentIdField: 'SEGMENT', fromNodeIdField: 'FROMNODE', toNodeIdField: 'TONODE' },
        encoding: 'windows-1252',
        crs: 'EPSG:25832',
        maxEndpointDistanceMeters: 5,
      };
      const file = path.join(root, 'schema.json');
      fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
      const loaded = provider.loadPinnedSchema({
        schemaRoot: root,
        schemaPath: 'schema.json',
        expectedSchemaSha256: provider.sha256(fs.readFileSync(file)),
      });
      expect(loaded.pointSet.id).toBe('nodes');
      expect(loaded.sha256).toMatch(/^[a-f0-9]{64}$/);

      value.guessedStreetField = 'NAME';
      fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
      expect(() => provider.loadPinnedSchema({
        schemaRoot: root,
        schemaPath: 'schema.json',
        expectedSchemaSha256: provider.sha256(fs.readFileSync(file)),
      })).toThrow(/unexpected or missing fields/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('transforms a Hannover-area UTM zone 32 coordinate with plausible precision', () => {
    const transformed = provider.utm32ToWgs84({ x: 548000, y: 5802000 }, 'EPSG:25832');
    expect(transformed.lat).toBeCloseTo(52.36617, 4);
    expect(transformed.lon).toBeCloseTo(9.70496, 4);
  });
});
