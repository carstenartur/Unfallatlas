'use strict';

/**
 * Small, dependency-free ZIP reader for reviewed local evidence archives.
 *
 * This is intentionally not a general-purpose ZIP implementation. It accepts
 * only single-disk, non-ZIP64 archives with stored or raw-deflate entries and
 * validates central/local headers, paths, CRC-32, sizes, expansion limits,
 * duplicate/case-folded names and Unix symlink attributes before exposing any
 * bytes to a caller.
 */

const zlib = require('zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 128 * 1024 * 1024,
  maxEntries: 128,
  maxEntryBytes: 128 * 1024 * 1024,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxExpansionRatio: 200,
  maxCommentBytes: 4096,
});

class StrictZipError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'StrictZipError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new StrictZipError(code, message, details);
}

function assertRange(buffer, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
      offset < 0 || length < 0 || offset + length > buffer.length) {
    fail('truncated_zip', `${label} is outside the archive`, {
      offset,
      length,
      archiveBytes: buffer.length,
    });
  }
}

function readU16(buffer, offset, label) {
  assertRange(buffer, offset, 2, label);
  return buffer.readUInt16LE(offset);
}

function readU32(buffer, offset, label) {
  assertRange(buffer, offset, 4, label);
  return buffer.readUInt32LE(offset);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current & 1) ? (0xedb88320 ^ (current >>> 1)) : (current >>> 1);
    }
    table[value] = current >>> 0;
  }
  return table;
})();

function crc32(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeName(bytes, flags, label) {
  const utf8 = (flags & 0x0800) !== 0;
  if (!utf8 && [...bytes].some((byte) => byte < 0x20 || byte > 0x7e)) {
    fail('unsupported_filename_encoding', `${label} is neither UTF-8 flagged nor ASCII`);
  }
  try {
    return utf8
      ? new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      : bytes.toString('ascii');
  } catch (error) {
    fail('invalid_filename', `${label} is not valid UTF-8`, { cause: error.message });
  }
}

function normalizeEntryPath(value) {
  const raw = String(value || '').replace(/\\/g, '/');
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
    fail('unsafe_entry_path', 'ZIP entry path must be a non-empty relative path', { value });
  }
  const directory = raw.endsWith('/');
  const body = directory ? raw.slice(0, -1) : raw;
  const parts = body.split('/');
  if (!body || parts.some((part) => !part || part === '.' || part === '..')) {
    fail('unsafe_entry_path', 'ZIP entry path contains an unsafe segment', { value });
  }
  if (parts.some((part) => /[\u0000-\u001f\u007f]/.test(part))) {
    fail('unsafe_entry_path', 'ZIP entry path contains control characters', { value });
  }
  return `${parts.join('/')}${directory ? '/' : ''}`;
}

function parseExtraFields(bytes, label) {
  const fields = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) fail('invalid_extra_field', `${label} is truncated`);
    const id = bytes.readUInt16LE(offset);
    const size = bytes.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + size > bytes.length) fail('invalid_extra_field', `${label} field is truncated`, { id, size });
    if (id === 0x0001) fail('zip64_not_supported', `${label} contains a ZIP64 field`);
    fields.push(Object.freeze({ id, size }));
    offset += size;
  }
  return Object.freeze(fields);
}

function findEocd(buffer, limits) {
  const minimum = 22;
  if (buffer.length < minimum) fail('invalid_zip', 'archive is too small to contain EOCD');
  const scanStart = Math.max(0, buffer.length - minimum - limits.maxCommentBytes);
  for (let offset = buffer.length - minimum; offset >= scanStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = readU16(buffer, offset + 20, 'EOCD comment length');
    if (offset + minimum + commentLength !== buffer.length) continue;
    return offset;
  }
  fail('missing_eocd', 'cannot find a terminal ZIP EOCD record');
}

function validateFlags(flags, label) {
  const forbidden = 0x0001 | 0x0020 | 0x0040 | 0x2000;
  if ((flags & forbidden) !== 0) {
    fail('unsupported_zip_flags', `${label} uses encryption or masked metadata`, { flags });
  }
}

function mergeLimits(overrides) {
  const limits = { ...DEFAULT_LIMITS, ...(overrides || {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail('invalid_limits', `${name} must be a positive safe integer`, { value });
    }
  }
  return Object.freeze(limits);
}

function parseCentralDirectory(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) fail('invalid_zip', 'archive must be a Buffer');
  const limits = mergeLimits(options.limits);
  if (buffer.length > limits.maxArchiveBytes) {
    fail('archive_too_large', 'archive exceeds the configured byte limit', {
      bytes: buffer.length,
      limit: limits.maxArchiveBytes,
    });
  }
  const eocdOffset = findEocd(buffer, limits);
  const disk = readU16(buffer, eocdOffset + 4, 'EOCD disk');
  const centralDisk = readU16(buffer, eocdOffset + 6, 'EOCD central disk');
  const entriesOnDisk = readU16(buffer, eocdOffset + 8, 'EOCD entries on disk');
  const entryCount = readU16(buffer, eocdOffset + 10, 'EOCD entry count');
  const centralSize = readU32(buffer, eocdOffset + 12, 'EOCD central size');
  const centralOffset = readU32(buffer, eocdOffset + 16, 'EOCD central offset');
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    fail('multidisk_not_supported', 'only single-disk ZIP archives are supported');
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    fail('zip64_not_supported', 'ZIP64 EOCD sentinel encountered');
  }
  if (entryCount === 0 || entryCount > limits.maxEntries) {
    fail('invalid_entry_count', 'archive entry count is empty or exceeds the configured limit', {
      entryCount,
      limit: limits.maxEntries,
    });
  }
  assertRange(buffer, centralOffset, centralSize, 'central directory');
  if (centralOffset + centralSize !== eocdOffset) {
    fail('invalid_central_directory', 'central directory is not immediately followed by EOCD', {
      centralOffset,
      centralSize,
      eocdOffset,
    });
  }

  const names = new Set();
  const foldedNames = new Set();
  const entries = [];
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (readU32(buffer, offset, `central entry ${index} signature`) !== CENTRAL_SIGNATURE) {
      fail('invalid_central_directory', `central entry ${index} has an invalid signature`);
    }
    assertRange(buffer, offset, 46, `central entry ${index} header`);
    const versionMadeBy = readU16(buffer, offset + 4, `central entry ${index} versionMadeBy`);
    const flags = readU16(buffer, offset + 8, `central entry ${index} flags`);
    const method = readU16(buffer, offset + 10, `central entry ${index} method`);
    const expectedCrc32 = readU32(buffer, offset + 16, `central entry ${index} crc32`);
    const compressedSize = readU32(buffer, offset + 20, `central entry ${index} compressed size`);
    const uncompressedSize = readU32(buffer, offset + 24, `central entry ${index} uncompressed size`);
    const nameLength = readU16(buffer, offset + 28, `central entry ${index} name length`);
    const extraLength = readU16(buffer, offset + 30, `central entry ${index} extra length`);
    const commentLength = readU16(buffer, offset + 32, `central entry ${index} comment length`);
    const diskStart = readU16(buffer, offset + 34, `central entry ${index} disk start`);
    const externalAttributes = readU32(buffer, offset + 38, `central entry ${index} external attributes`);
    const localHeaderOffset = readU32(buffer, offset + 42, `central entry ${index} local offset`);
    validateFlags(flags, `central entry ${index}`);
    if (![0, 8].includes(method)) {
      fail('unsupported_compression', `central entry ${index} uses unsupported method ${method}`);
    }
    if (diskStart !== 0) fail('multidisk_not_supported', `central entry ${index} starts on another disk`);
    if ([compressedSize, uncompressedSize, localHeaderOffset].includes(0xffffffff)) {
      fail('zip64_not_supported', `central entry ${index} uses ZIP64 sizes or offsets`);
    }
    const variableLength = nameLength + extraLength + commentLength;
    assertRange(buffer, offset + 46, variableLength, `central entry ${index} variable data`);
    const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const extraBytes = buffer.subarray(
      offset + 46 + nameLength,
      offset + 46 + nameLength + extraLength,
    );
    const decodedName = decodeName(nameBytes, flags, `central entry ${index} name`);
    const name = normalizeEntryPath(decodedName);
    parseExtraFields(extraBytes, `central entry ${index} extra`);
    if (names.has(name) || foldedNames.has(name.toLowerCase())) {
      fail('duplicate_entry', 'archive contains duplicate or case-colliding entry names', { name });
    }
    names.add(name);
    foldedNames.add(name.toLowerCase());

    const unixHost = (versionMadeBy >>> 8) === 3;
    const unixMode = unixHost ? ((externalAttributes >>> 16) & 0xffff) : 0;
    const unixType = unixMode & 0xf000;
    if (unixType === 0xa000) fail('symlink_entry', 'archive contains a Unix symbolic-link entry', { name });
    const directory = name.endsWith('/') || unixType === 0x4000;
    if (directory && (compressedSize !== 0 || uncompressedSize !== 0)) {
      fail('invalid_directory_entry', 'directory entry contains data', { name });
    }
    if (!directory) {
      if (uncompressedSize > limits.maxEntryBytes) {
        fail('entry_too_large', 'entry exceeds the configured uncompressed byte limit', {
          name,
          uncompressedSize,
          limit: limits.maxEntryBytes,
        });
      }
      if (method === 0 && compressedSize !== uncompressedSize) {
        fail('invalid_stored_entry', 'stored entry compressed and uncompressed sizes differ', { name });
      }
      const ratio = uncompressedSize / Math.max(compressedSize, 1);
      if (ratio > limits.maxExpansionRatio) {
        fail('expansion_ratio_exceeded', 'entry exceeds the configured expansion ratio', {
          name,
          compressedSize,
          uncompressedSize,
          ratio,
          limit: limits.maxExpansionRatio,
        });
      }
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > limits.maxTotalUncompressedBytes) {
        fail('archive_expansion_too_large', 'archive exceeds the configured total output limit', {
          totalUncompressed,
          limit: limits.maxTotalUncompressedBytes,
        });
      }
    }

    entries.push(Object.freeze({
      index,
      name,
      nameBytes: Buffer.from(nameBytes),
      directory,
      flags,
      method,
      crc32: expectedCrc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      externalAttributes,
      unixMode,
    }));
    offset += 46 + variableLength;
  }
  if (offset !== centralOffset + centralSize) {
    fail('invalid_central_directory', 'central directory contains trailing or missing bytes', {
      parsedEnd: offset,
      expectedEnd: centralOffset + centralSize,
    });
  }
  return Object.freeze({
    limits,
    eocdOffset,
    centralOffset,
    centralSize,
    commentBytes: buffer.length - eocdOffset - 22,
    entries: Object.freeze(entries),
    totalUncompressedBytes: totalUncompressed,
  });
}

function readEntry(buffer, entry, centralOffset) {
  const offset = entry.localHeaderOffset;
  if (readU32(buffer, offset, `${entry.name} local signature`) !== LOCAL_SIGNATURE) {
    fail('invalid_local_header', 'entry has an invalid local-header signature', { name: entry.name });
  }
  assertRange(buffer, offset, 30, `${entry.name} local header`);
  const flags = readU16(buffer, offset + 6, `${entry.name} local flags`);
  const method = readU16(buffer, offset + 8, `${entry.name} local method`);
  const nameLength = readU16(buffer, offset + 26, `${entry.name} local name length`);
  const extraLength = readU16(buffer, offset + 28, `${entry.name} local extra length`);
  validateFlags(flags, `${entry.name} local header`);
  if (flags !== entry.flags || method !== entry.method) {
    fail('local_central_mismatch', 'local and central flags or compression method differ', {
      name: entry.name,
      centralFlags: entry.flags,
      localFlags: flags,
      centralMethod: entry.method,
      localMethod: method,
    });
  }
  assertRange(buffer, offset + 30, nameLength + extraLength, `${entry.name} local variable data`);
  const localName = buffer.subarray(offset + 30, offset + 30 + nameLength);
  if (!localName.equals(entry.nameBytes)) {
    fail('local_central_mismatch', 'local and central filenames differ', { name: entry.name });
  }
  parseExtraFields(
    buffer.subarray(offset + 30 + nameLength, offset + 30 + nameLength + extraLength),
    `${entry.name} local extra`,
  );
  const dataOffset = offset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > centralOffset) {
    fail('entry_overlaps_central_directory', 'entry data overlaps the central directory', {
      name: entry.name,
      dataOffset,
      dataEnd,
      centralOffset,
    });
  }
  assertRange(buffer, dataOffset, entry.compressedSize, `${entry.name} compressed data`);
  const compressed = buffer.subarray(dataOffset, dataEnd);
  let output;
  try {
    output = entry.method === 0
      ? Buffer.from(compressed)
      : zlib.inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize + 1 });
  } catch (error) {
    fail('decompression_failed', 'cannot decompress ZIP entry', {
      name: entry.name,
      cause: error.message,
    });
  }
  if (output.length !== entry.uncompressedSize) {
    fail('uncompressed_size_mismatch', 'decompressed entry has an unexpected size', {
      name: entry.name,
      expected: entry.uncompressedSize,
      actual: output.length,
    });
  }
  const actualCrc32 = crc32(output);
  if (actualCrc32 !== entry.crc32) {
    fail('crc32_mismatch', 'decompressed entry CRC-32 differs from the central directory', {
      name: entry.name,
      expected: entry.crc32,
      actual: actualCrc32,
    });
  }
  return Object.freeze({
    name: entry.name,
    dataOffset,
    dataEnd,
    bytes: output.length,
    data: output,
  });
}

function readStrictZip(buffer, options = {}) {
  const central = parseCentralDirectory(buffer, options);
  const files = [];
  const occupiedRanges = [];
  for (const entry of central.entries) {
    if (entry.directory) continue;
    const value = readEntry(buffer, entry, central.centralOffset);
    occupiedRanges.push({ start: entry.localHeaderOffset, end: value.dataEnd, name: entry.name });
    files.push(Object.freeze({
      name: entry.name,
      method: entry.method,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      crc32: entry.crc32,
      data: value.data,
    }));
  }
  occupiedRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < occupiedRanges.length; index += 1) {
    const previous = occupiedRanges[index - 1];
    const current = occupiedRanges[index];
    if (current.start < previous.end) {
      fail('overlapping_entries', 'ZIP entries overlap in the local-data region', {
        previous: previous.name,
        current: current.name,
      });
    }
  }
  return Object.freeze({
    entryCount: central.entries.length,
    fileCount: files.length,
    totalUncompressedBytes: central.totalUncompressedBytes,
    files: Object.freeze(files),
  });
}

module.exports = Object.freeze({
  EOCD_SIGNATURE,
  CENTRAL_SIGNATURE,
  LOCAL_SIGNATURE,
  DEFAULT_LIMITS,
  StrictZipError,
  crc32,
  decodeName,
  normalizeEntryPath,
  parseExtraFields,
  findEocd,
  mergeLimits,
  parseCentralDirectory,
  readEntry,
  readStrictZip,
});
