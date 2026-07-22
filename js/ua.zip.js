/**
 * Small deterministic ZIP writer for browser-side export packages.
 *
 * It deliberately supports the ZIP "stored" method only. CSV packages are
 * small enough that compression is not required, while avoiding a second
 * browser bundle keeps the export path reproducible and auditable.
 */
(function initZip(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    const UA = (root.UA = root.UA || {});
    UA.zip = api;
  }
})(typeof window !== "undefined" ? window : null, function createZipApi() {
  "use strict";

  class ZipError extends Error {
    constructor(code, message) {
      super(`${code}: ${message}`);
      this.name = "ZipError";
      this.code = code;
    }
  }

  function fail(code, message) {
    throw new ZipError(code, message);
  }

  function encodeUtf8(value) {
    if (value instanceof Uint8Array) return value;
    if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(value)) {
      return new Uint8Array(value);
    }
    if (typeof value !== "string") {
      fail("invalid_content", "ZIP entry content must be a string or Uint8Array");
    }
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value);
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "utf8"));
    fail("utf8_unavailable", "No UTF-8 encoder is available");
  }

  function safeEntryName(value) {
    if (typeof value !== "string" || !value.trim()) {
      fail("invalid_name", "ZIP entry name must be a non-empty string");
    }
    const name = value.normalize("NFKC");
    if (
      name.startsWith("/") ||
      name.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(name) ||
      name.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      fail("unsafe_name", `Unsafe ZIP entry name: ${value}`);
    }
    return name;
  }

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let value = n;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[n] = value >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const value of bytes) crc = CRC_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function writeUint16(target, offset, value) {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >>> 8) & 0xff;
  }

  function writeUint32(target, offset, value) {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >>> 8) & 0xff;
    target[offset + 2] = (value >>> 16) & 0xff;
    target[offset + 3] = (value >>> 24) & 0xff;
  }

  function concat(parts) {
    const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.byteLength;
    }
    return result;
  }

  function createStoredZip(entriesValue) {
    if (!Array.isArray(entriesValue) || entriesValue.length === 0) {
      fail("missing_entries", "ZIP requires at least one entry");
    }
    if (entriesValue.length > 0xffff) {
      fail("too_many_entries", "ZIP64 is intentionally unsupported");
    }

    const seen = new Set();
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;

    for (const entry of entriesValue) {
      const name = safeEntryName(entry?.name);
      if (seen.has(name)) fail("duplicate_entry", `Duplicate ZIP entry: ${name}`);
      seen.add(name);

      const nameBytes = encodeUtf8(name);
      const contentBytes = encodeUtf8(entry?.content ?? "");
      if (nameBytes.byteLength > 0xffff || contentBytes.byteLength > 0xffffffff) {
        fail("entry_too_large", "ZIP64 is intentionally unsupported");
      }
      const checksum = crc32(contentBytes);
      const flags = 0x0800;
      const method = 0;
      const dosTime = 0;
      const dosDate = 33;

      const localHeader = new Uint8Array(30 + nameBytes.byteLength);
      writeUint32(localHeader, 0, 0x04034b50);
      writeUint16(localHeader, 4, 20);
      writeUint16(localHeader, 6, flags);
      writeUint16(localHeader, 8, method);
      writeUint16(localHeader, 10, dosTime);
      writeUint16(localHeader, 12, dosDate);
      writeUint32(localHeader, 14, checksum);
      writeUint32(localHeader, 18, contentBytes.byteLength);
      writeUint32(localHeader, 22, contentBytes.byteLength);
      writeUint16(localHeader, 26, nameBytes.byteLength);
      writeUint16(localHeader, 28, 0);
      localHeader.set(nameBytes, 30);
      localParts.push(localHeader, contentBytes);

      const centralHeader = new Uint8Array(46 + nameBytes.byteLength);
      writeUint32(centralHeader, 0, 0x02014b50);
      writeUint16(centralHeader, 4, 20);
      writeUint16(centralHeader, 6, 20);
      writeUint16(centralHeader, 8, flags);
      writeUint16(centralHeader, 10, method);
      writeUint16(centralHeader, 12, dosTime);
      writeUint16(centralHeader, 14, dosDate);
      writeUint32(centralHeader, 16, checksum);
      writeUint32(centralHeader, 20, contentBytes.byteLength);
      writeUint32(centralHeader, 24, contentBytes.byteLength);
      writeUint16(centralHeader, 28, nameBytes.byteLength);
      writeUint16(centralHeader, 30, 0);
      writeUint16(centralHeader, 32, 0);
      writeUint16(centralHeader, 34, 0);
      writeUint16(centralHeader, 36, 0);
      writeUint32(centralHeader, 38, 0);
      writeUint32(centralHeader, 42, localOffset);
      centralHeader.set(nameBytes, 46);
      centralParts.push(centralHeader);

      localOffset += localHeader.byteLength + contentBytes.byteLength;
      if (localOffset > 0xffffffff) fail("archive_too_large", "ZIP64 is unsupported");
    }

    const centralDirectory = concat(centralParts);
    const end = new Uint8Array(22);
    writeUint32(end, 0, 0x06054b50);
    writeUint16(end, 4, 0);
    writeUint16(end, 6, 0);
    writeUint16(end, 8, entriesValue.length);
    writeUint16(end, 10, entriesValue.length);
    writeUint32(end, 12, centralDirectory.byteLength);
    writeUint32(end, 16, localOffset);
    writeUint16(end, 20, 0);

    return concat([...localParts, centralDirectory, end]);
  }

  return Object.freeze({ ZipError, crc32, createStoredZip });
});
