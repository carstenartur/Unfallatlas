'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const strictZip = require('../../scripts/lib/strict-zip');
const provider = require('../../scripts/providers/koeln_kfz_geometry_archive_provider');

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const localName = Buffer.from(entry.localName || entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    const method = entry.method == null ? 0 : entry.method;
    const compressed = method === 8 ? zlib.deflateRawSync(data) : Buffer.from(data);
    const crc = entry.crc32 == null ? strictZip.crc32(data) : entry.crc32 >>> 0;
    const flags = entry.flags == null ? 0x0800 : entry.flags;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(strictZip.LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, localName, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(strictZip.CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(entry.externalAttributes == null ? 0 : entry.externalAttributes >>> 0, 38);
    central.writeUInt32LE(entry.localOffset == null ? localOffset : entry.localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + localName.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(strictZip.EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function shapefile(shapeType, bbox = [350000, 5640000, 351000, 5641000]) {
  const buffer = Buffer.alloc(100);
  buffer.writeInt32BE(9994, 0);
  buffer.writeInt32BE(50, 24);
  buffer.writeInt32LE(1000, 28);
  buffer.writeInt32LE(shapeType, 32);
  bbox.forEach((value, index) => buffer.writeDoubleLE(value, 36 + index * 8));
  return buffer;
}

function dbf(fields = [{ name: 'NO', type: 'C', length: 10 }], records = []) {
  const recordBytes = 1 + fields.reduce((sum, field) => sum + field.length, 0);
  const headerBytes = 32 + fields.length * 32 + 1;
  const buffer = Buffer.alloc(headerBytes + recordBytes * records.length + 1, 0);
  buffer[0] = 0x03;
  buffer.writeUInt32LE(records.length, 4);
  buffer.writeUInt16LE(headerBytes, 8);
  buffer.writeUInt16LE(recordBytes, 10);
  fields.forEach((field, index) => {
    const offset = 32 + index * 32;
    Buffer.from(field.name, 'ascii').copy(buffer, offset, 0, 11);
    buffer[offset + 11] = String(field.type || 'C').charCodeAt(0);
    buffer[offset + 16] = field.length;
    buffer[offset + 17] = field.decimals || 0;
  });
  buffer[headerBytes - 1] = 0x0d;
  records.forEach((record, row) => {
    let offset = headerBytes + row * recordBytes;
    buffer[offset] = 0x20;
    offset += 1;
    fields.forEach((field) => {
      Buffer.from(String(record[field.name] || '').padEnd(field.length).slice(0, field.length), 'ascii')
        .copy(buffer, offset);
      offset += field.length;
    });
  });
  buffer[buffer.length - 1] = 0x1a;
  return buffer;
}

const ETRS_UTM_32 =
  'PROJCS["ETRS_1989_UTM_Zone_32N",GEOGCS["GCS_ETRS_1989"],AUTHORITY["EPSG","25832"]]';
const WGS_UTM_32 =
  'PROJCS["WGS_1984_UTM_Zone_32N",GEOGCS["GCS_WGS_1984"],AUTHORITY["EPSG","32632"]]';

function geometryArchive(options = {}) {
  const pointType = options.pointType || 1;
  const lineType = options.lineType || 3;
  const pointBbox = [350000, 5640000, 351000, 5641000];
  const lineBbox = [349500, 5639500, 351500, 5641500];
  const entries = [
    { name: 'geometry/nodes.shp', data: shapefile(pointType, pointBbox), method: 8 },
    { name: 'geometry/nodes.shx', data: shapefile(pointType, pointBbox) },
    { name: 'geometry/nodes.dbf', data: dbf([{ name: 'NODENO', type: 'N', length: 12 }]) },
    { name: 'geometry/nodes.prj', data: options.pointPrj || ETRS_UTM_32 },
    { name: 'geometry/links.shp', data: shapefile(lineType, lineBbox), method: 8 },
    { name: 'geometry/links.shx', data: shapefile(lineType, options.mismatchedLineBbox || lineBbox) },
    { name: 'geometry/links.dbf', data: dbf([
      { name: 'NO', type: 'N', length: 10 },
      { name: 'FROMNODENO', type: 'N', length: 12 },
      { name: 'TONODENO', type: 'N', length: 12 },
    ]) },
    { name: 'geometry/links.prj', data: options.linePrj || WGS_UTM_32 },
    { name: 'geometry/links.cpg', data: 'UTF-8\n' },
  ];
  if (options.remove) return zip(entries.filter((entry) => entry.name !== options.remove));
  if (options.extra) entries.push(options.extra);
  return zip(entries);
}

describe('strict ZIP evidence reader', () => {
  test('reads stored and deflated entries with exact bytes and CRC-32', () => {
    const archive = zip([
      { name: 'a.txt', data: 'alpha', method: 0 },
      { name: 'nested/b.txt', data: 'beta'.repeat(20), method: 8 },
    ]);
    const result = strictZip.readStrictZip(archive);
    expect(result.entryCount).toBe(2);
    expect(result.files.map((file) => [file.name, file.data.toString('utf8')])).toEqual([
      ['a.txt', 'alpha'],
      ['nested/b.txt', 'beta'.repeat(20)],
    ]);
  });

  test.each([
    ['path traversal', [{ name: '../escape.txt', data: 'x' }], /unsafe_entry_path/],
    ['absolute path', [{ name: '/escape.txt', data: 'x' }], /unsafe_entry_path/],
    ['case collision', [{ name: 'A.txt', data: 'a' }, { name: 'a.TXT', data: 'b' }], /duplicate_entry/],
    ['local/central mismatch', [{ name: 'a.txt', localName: 'b.txt', data: 'x' }], /local_central_mismatch/],
    ['encrypted flag', [{ name: 'a.txt', data: 'x', flags: 0x0801 }], /unsupported_zip_flags/],
    ['unsupported compression', [{ name: 'a.txt', data: 'x', method: 12 }], /unsupported_compression/],
    ['Unix symlink', [{ name: 'a.txt', data: 'target', externalAttributes: (0xa1ff << 16) >>> 0 }], /symlink_entry/],
    ['bad CRC', [{ name: 'a.txt', data: 'x', crc32: 1 }], /crc32_mismatch/],
  ])('rejects %s', (_label, entries, expected) => {
    expect(() => strictZip.readStrictZip(zip(entries))).toThrow(expected);
  });

  test('rejects excessive expansion before exposing decompressed bytes', () => {
    const archive = zip([{ name: 'bomb.txt', data: Buffer.alloc(128 * 1024, 0x41), method: 8 }]);
    expect(() => strictZip.readStrictZip(archive, {
      limits: { maxExpansionRatio: 2 },
    })).toThrow(/expansion_ratio_exceeded/);
  });
});

describe('Cologne Kfz geometry archive provider', () => {
  const roots = [];

  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
  });

  test('inventories complete point and polyline shape sets without interpreting rows', () => {
    const archive = geometryArchive();
    const inspected = provider.inspectGeometryArchiveBuffer(archive);
    expect(inspected.roles).toEqual({
      pointShapeSetIds: ['geometry/nodes'],
      polylineShapeSetIds: ['geometry/links'],
    });
    expect(inspected.shapeSets).toHaveLength(2);
    const nodes = inspected.shapeSets.find((set) => set.id === 'geometry/nodes');
    const links = inspected.shapeSets.find((set) => set.id === 'geometry/links');
    expect(nodes).toEqual(expect.objectContaining({
      shapeType: 1,
      shapeTypeName: 'point',
      recordCount: 0,
      crs: expect.objectContaining({ zone: 32, hemisphere: 'N', epsg: 'EPSG:25832' }),
      dbfFields: [{ name: 'NODENO', type: 'N', length: 12, decimals: 0 }],
    }));
    expect(links).toEqual(expect.objectContaining({
      shapeType: 3,
      shapeTypeName: 'polyline',
      crs: expect.objectContaining({ zone: 32, hemisphere: 'N', epsg: 'EPSG:32632' }),
      dbfFields: [
        { name: 'NO', type: 'N', length: 10, decimals: 0 },
        { name: 'FROMNODENO', type: 'N', length: 12, decimals: 0 },
        { name: 'TONODENO', type: 'N', length: 12, decimals: 0 },
      ],
    }));
    expect(inspected.inventory.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
  });

  test('verifies arbitrary pinned bytes at the lower trust layer', () => {
    const archive = geometryArchive();
    const result = provider.verifyArchiveBytes(
      archive,
      provider.sha256(archive),
      archive.length,
    );
    expect(result.sha256).toBe(provider.sha256(archive));
    expect(result.inspected.shapeSets).toHaveLength(2);
    expect(() => provider.verifyArchiveBytes(archive, 'a'.repeat(64), archive.length))
      .toThrow(/archive_hash_mismatch/);
    expect(() => provider.verifyArchiveBytes(archive, provider.sha256(archive), archive.length + 1))
      .toThrow(/archive_size_mismatch/);
  });

  test('keeps the production loader pinned to the portal-published ZIP hash', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-koeln-geometry-pin-'));
    roots.push(root);
    const archive = geometryArchive();
    fs.writeFileSync(path.join(root, 'fixture.zip'), archive);
    expect(() => provider.loadVerifiedGeometryArchive({
      allowedRoot: root,
      archivePath: 'fixture.zip',
      expectedDistributionSha256: provider.sha256(archive),
      expectedBytes: archive.length,
      retrievedAt: '2026-07-30T17:00:00Z',
    })).toThrow(/unreviewed_distribution/);
    expect(provider.REVIEWED_DISTRIBUTION_SHA256).toBe(
      '5672f1b61777ccbd5a1db6555dddf7c61a009eb161b13d4c7cbe530de9299238',
    );
    expect(provider.DISTRIBUTION_URL).toMatch(/KFZ%20Zaehldaten%202016-2019_0\.zip$/);
  });

  test.each([
    ['missing DBF', { remove: 'geometry/links.dbf' }, /incomplete_shape_set/],
    ['SHP/SHX mismatch', { mismatchedLineBbox: [1, 2, 3, 4] }, /shape_index_mismatch/],
    ['wrong CRS', { linePrj: 'GEOGCS["WGS 84",AUTHORITY["EPSG","4326"]]' }, /unsupported_crs/],
    ['no point geometry', { pointType: 5 }, /missing_geometry_roles/],
    ['unreviewed executable', { extra: { name: 'geometry/install.exe', data: 'MZ' } }, /unexpected_archive_entry/],
  ])('rejects %s', (_label, options, expected) => {
    expect(() => provider.inspectGeometryArchiveBuffer(geometryArchive(options))).toThrow(expected);
  });

  test('rejects malformed Shapefile and DBF headers', () => {
    const invalidShp = shapefile(1);
    invalidShp.writeInt32BE(9995, 0);
    expect(() => provider.parseShapefileHeader(invalidShp, 'fixture.shp'))
      .toThrow(/invalid file code/);

    const invalidDbf = dbf();
    // Preserve the real terminator at byte 64 but claim a 66-byte header. This
    // targets the header-length/terminator contract without creating a second,
    // accidentally truncated field descriptor.
    invalidDbf.writeUInt16LE(66, 8);
    expect(() => provider.parseDbfHeader(invalidDbf, 'fixture.dbf'))
      .toThrow(/terminator/);
  });

  test('builds a deterministic manifest with an explicit truth boundary', () => {
    const archive = geometryArchive();
    const verified = provider.verifyArchiveBytes(archive, provider.sha256(archive), archive.length);
    const loaded = {
      sourceId: provider.SOURCE_ID,
      datasetUrl: provider.DATASET_URL,
      distributionUrl: provider.DISTRIBUTION_URL,
      licenseId: 'DL-DE-Zero-2.0',
      licenseName: 'Datenlizenz Deutschland – Zero – Version 2.0',
      retrievedAt: '2026-07-30T17:00:00.000Z',
      relativePath: 'fixture.zip',
      sha256: verified.sha256,
      bytes: verified.bytes,
      inspected: verified.inspected,
    };
    const first = provider.buildManifest(loaded);
    const second = provider.buildManifest(loaded);
    expect(second).toEqual(first);
    expect(first.schemaVersion).toBe(provider.MANIFEST_SCHEMA);
    expect(first.truthBoundary).toEqual({
      archiveBytesVerified: true,
      zipEntriesVerified: true,
      shapefileContainersVerified: true,
      dbfRowsInterpreted: false,
      coordinatesTransformed: false,
      linkValuesJoined: false,
      osmMatched: false,
    });
  });

  test('confines the production archive path and manifest output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-koeln-geometry-path-'));
    roots.push(root);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-koeln-geometry-outside-'));
    roots.push(outside);
    fs.writeFileSync(path.join(outside, 'outside.zip'), geometryArchive());
    fs.symlinkSync(path.join(outside, 'outside.zip'), path.join(root, 'link.zip'));
    expect(() => provider.resolveConfinedRegularFile(root, 'link.zip'))
      .toThrow(/symbolic link/);
    expect(() => provider.resolveConfinedRegularFile(root, '../outside.zip'))
      .toThrow(/normalized relative path/);

    const manifestPath = path.join(root, 'manifest.json');
    const manifest = { schemaVersion: provider.MANIFEST_SCHEMA };
    expect(provider.writeManifestAtomic(manifestPath, manifest)).toBe(manifestPath);
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))).toEqual(manifest);
    expect(fs.readdirSync(root).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });
});
