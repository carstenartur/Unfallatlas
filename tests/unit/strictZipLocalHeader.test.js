'use strict';

const strictZip = require('../../scripts/lib/strict-zip');

function oneEntryZip(options = {}) {
  const name = Buffer.from('fixture.txt', 'utf8');
  const data = Buffer.from('strict local header evidence');
  const crc = strictZip.crc32(data);
  const flags = options.flags == null ? 0x0800 : options.flags;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(strictZip.LOCAL_SIGNATURE, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(options.localCrc32 == null ? crc : options.localCrc32 >>> 0, 14);
  local.writeUInt32LE(
    options.localCompressedSize == null ? data.length : options.localCompressedSize,
    18,
  );
  local.writeUInt32LE(
    options.localUncompressedSize == null ? data.length : options.localUncompressedSize,
    22,
  );
  local.writeUInt16LE(name.length, 26);

  const centralOffset = local.length + name.length + data.length;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(strictZip.CENTRAL_SIGNATURE, 0);
  central.writeUInt16LE((3 << 8) | 20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(strictZip.EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, data, central, name, eocd]);
}

describe('strict ZIP local-header evidence', () => {
  test('accepts matching local and central CRC/size claims', () => {
    const result = strictZip.readStrictZip(oneEntryZip());
    expect(result.files).toHaveLength(1);
    expect(result.files[0].data.toString('utf8')).toBe('strict local header evidence');
  });

  test.each([
    ['CRC-32', { localCrc32: 1 }],
    ['compressed size', { localCompressedSize: 3 }],
    ['uncompressed size', { localUncompressedSize: 4 }],
  ])('rejects local/central %s drift before reading entry bytes', (_label, options) => {
    expect(() => strictZip.readStrictZip(oneEntryZip(options)))
      .toThrow(/local_central_mismatch/);
  });

  test('rejects bit-3 data descriptors in the central contract', () => {
    expect(() => strictZip.readStrictZip(oneEntryZip({ flags: 0x0808 })))
      .toThrow(/unsupported_zip_flags/);
  });
});
