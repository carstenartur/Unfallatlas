'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function matchesEntry(entry, key, revision, checkedAt) {
  return entry && entry.schemaVersion === SCHEMA_VERSION && entry.key === key && entry.revision === revision &&
    Number.isFinite(entry.cachedAt) && entry.cachedAt >= 0 && entry.cachedAt <= checkedAt && Object.hasOwn(entry, 'payload');
}

async function readEntry(filename, maxBytes) {
  if (!constants.O_NOFOLLOW && (await fs.lstat(filename)).isSymbolicLink()) return null;
  const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return null;
    const bytes = Buffer.allocUnsafe(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== stat.size) return null;
    return JSON.parse(utf8.decode(bytes.subarray(0, length)));
  } finally {
    await file.close();
  }
}

/**
 * Resume verified public source responses without coupling adapters to their storage.
 * The loader validates its source payload; this cache validates its envelope and age.
 * getOrLoadWithMetadata also returns the original cachedAt for source provenance;
 * getOrLoad retains its payload-only contract for existing consumers.
 * getMetadata reads only provenance, including expired envelopes, without loading
 * or renewing their payloads. It does not count as a payload-cache hit.
 * Stats count actual cache operations, with concurrent identical requests counted once.
 */
function createRisSourceCache({ directory, now = () => Date.now(),
  maxAgeMs = 7 * 86400000, maxEntryBytes = 2 * 1024 * 1024 } = {}) {
  if (typeof directory !== 'string' || !directory || typeof now !== 'function' ||
      !Number.isFinite(maxAgeMs) || maxAgeMs < 0 || !Number.isSafeInteger(maxEntryBytes) || maxEntryBytes <= 0) {
    throw new TypeError('Invalid RIS source cache options');
  }
  const folder = path.resolve(directory);
  const stats = { hits: 0, misses: 0, writes: 0 };
  const pending = new Map();

  function timestamp() {
    const value = now();
    if (!Number.isFinite(value) || value < 0) throw new TypeError('Invalid RIS source cache time');
    return value;
  }

  function shardedFilename(digest) {
    return path.join(folder, digest.slice(0, 2), `${digest}.json`);
  }

  async function readVerifiedEntry(digest, key, revision, checkedAt) {
    const current = shardedFilename(digest);
    // A valid current envelope is authoritative even when expired; age checks
    // must not revive an older flat copy instead of renewing the source.
    for (const filename of [current, path.join(folder, `${digest}.json`)]) {
      try {
        // O_NOFOLLOW protects the envelope itself. The new directory level must
        // also be a real directory before following it to a cached response.
        if (filename === current && !(await fs.lstat(path.dirname(filename))).isDirectory()) continue;
        const entry = await readEntry(filename, maxEntryBytes);
        if (matchesEntry(entry, key, revision, checkedAt)) return entry;
      } catch (_) { /* Missing, unreadable or damaged entries can fall back to the legacy layout. */ }
    }
    return null;
  }

  async function load(digest, key, revision, loader) {
    const checkedAt = timestamp();
    const entry = await readVerifiedEntry(digest, key, revision, checkedAt);
    if (entry && checkedAt - entry.cachedAt < maxAgeMs) {
      stats.hits += 1;
      return { payload: entry.payload, cachedAt: entry.cachedAt };
    }

    stats.misses += 1;
    const payload = await loader();
    const json = JSON.stringify(payload);
    if (json === undefined) throw new TypeError('RIS source cache payload is not JSON serializable');
    const cachedAt = timestamp();
    const header = JSON.stringify({ schemaVersion: SCHEMA_VERSION, key, revision, cachedAt });
    // Public text may contain invisible format controls. Escapes preserve every
    // character without introducing hidden controls into the checked-out tree.
    const encoded = `${header.slice(0, -1)},"payload":${json}}`.replace(/[\u007f-\uffff]/g,
      character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const bytes = Buffer.from(encoded);
    if (bytes.length > maxEntryBytes) throw new RangeError('RIS source cache entry exceeds its size limit');

    // Keep directory fan-out bounded so the Actions cache globber can persist
    // growing histories and multiple parser revisions without argument overflow.
    const filename = shardedFilename(digest);
    const shard = path.dirname(filename);
    await fs.mkdir(shard, { recursive: true });
    if (!(await fs.lstat(shard)).isDirectory()) throw new Error('Invalid RIS source cache directory');
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx' });
      await fs.rename(temporary, filename);
      stats.writes += 1;
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return { payload, cachedAt };
  }

  async function getOrLoadWithMetadata(key, revision, loader) {
    if (typeof key !== 'string' || !key || typeof loader !== 'function' ||
        !(revision === null || typeof revision === 'string' || (typeof revision === 'number' && Number.isFinite(revision)))) {
      throw new TypeError('Invalid RIS source cache key, revision or loader');
    }
    const digest = createHash('sha256').update(JSON.stringify([key, revision])).digest('hex');
    if (!pending.has(digest)) {
      const request = load(digest, key, revision, loader)
        .finally(() => pending.delete(digest));
      pending.set(digest, request);
    }
    return pending.get(digest);
  }

  async function getOrLoad(key, revision, loader) {
    return (await getOrLoadWithMetadata(key, revision, loader)).payload;
  }

  async function getMetadata(key, revision) {
    if (typeof key !== 'string' || !key ||
        !(revision === null || typeof revision === 'string' || (typeof revision === 'number' && Number.isFinite(revision)))) {
      throw new TypeError('Invalid RIS source cache key or revision');
    }
    const checkedAt = timestamp();
    const digest = createHash('sha256').update(JSON.stringify([key, revision])).digest('hex');
    const entry = await readVerifiedEntry(digest, key, revision, checkedAt);
    return entry ? { cachedAt: entry.cachedAt } : null;
  }

  return { getOrLoad, getOrLoadWithMetadata, getMetadata, stats };
}

module.exports = { createRisSourceCache };
