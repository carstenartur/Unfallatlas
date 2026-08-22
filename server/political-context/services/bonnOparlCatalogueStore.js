'use strict';

/**
 * Provider-level snapshot cache for Bonn's official OParl paper catalogue.
 *
 * The outer portalSearchCache deliberately keys exact search requests. This
 * store sits one level lower: one bounded, immutable catalogue snapshot can be
 * searched repeatedly for different street/topic terms without crawling the
 * municipal portal again.
 */

const crypto = require('crypto');

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_STALE_IF_ERROR_MS = 60 * 60 * 1000;
const DEFAULT_MAX_SNAPSHOTS = 4;
const DEFAULT_MAX_ITEMS = 50_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_SCHEMA_VERSION = 1;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveDuration(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch (_) {
    return '';
  }
}

function compactError(error) {
  return {
    code: String(error && error.code || 'OPARL_CATALOGUE_REFRESH_FAILED').slice(0, 100),
    message: String(error && error.message || error || 'OParl catalogue refresh failed').slice(0, 500),
  };
}

class BonnOparlCatalogueStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BonnOparlCatalogueStoreError';
    this.code = code;
    this.details = details;
  }
}

function compactLocation(value) {
  if (!value || typeof value !== 'object') return null;
  const location = {
    description: value.description || null,
    streetAddress: value.streetAddress || null,
    locality: value.locality || null,
  };
  return Object.freeze(location);
}

function compactFile(value) {
  if (!value || typeof value !== 'object') return null;
  const file = {
    name: value.name || null,
    fileName: value.fileName || null,
    web: normalizeUrl(value.web),
    accessUrl: normalizeUrl(value.accessUrl),
    downloadUrl: normalizeUrl(value.downloadUrl),
  };
  return Object.freeze(file);
}

function compactPaper(value) {
  if (!value || typeof value !== 'object') return null;
  const keyword = Array.isArray(value.keyword)
    ? Object.freeze(value.keyword.map(item => String(item || '')).filter(Boolean).slice(0, 100))
    : Object.freeze([]);
  const location = Array.isArray(value.location)
    ? Object.freeze(value.location.map(compactLocation).filter(Boolean).slice(0, 100))
    : Object.freeze([]);
  const auxiliaryFile = Array.isArray(value.auxiliaryFile)
    ? Object.freeze(value.auxiliaryFile.map(compactFile).filter(Boolean).slice(0, 100))
    : Object.freeze([]);
  return Object.freeze({
    id: normalizeUrl(value.id),
    web: normalizeUrl(value.web),
    name: value.name || '',
    reference: value.reference || null,
    paperType: value.paperType || null,
    date: value.date || null,
    modified: value.modified || null,
    deleted: value.deleted === true,
    gremium: value.gremium || null,
    organizationName: value.organizationName || null,
    keyword,
    location,
    mainFile: compactFile(value.mainFile),
    auxiliaryFile,
  });
}

function compactPage(value) {
  if (!value || typeof value !== 'object') return null;
  return Object.freeze({
    url: normalizeUrl(value.url),
    count: Number.isFinite(Number(value.count)) ? Number(value.count) : 0,
    pagination: value.pagination && typeof value.pagination === 'object'
      ? Object.freeze({ ...value.pagination })
      : null,
  });
}

function estimateBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function normalizeSnapshot(rawValue, limits) {
  const raw = rawValue && typeof rawValue === 'object' ? rawValue : null;
  if (!raw || !Array.isArray(raw.items)) {
    throw new BonnOparlCatalogueStoreError(
      'OPARL_CATALOGUE_INVALID_SNAPSHOT',
      'The Bonn OParl catalogue loader returned no item array.'
    );
  }
  if (raw.items.length > limits.maxItems) {
    throw new BonnOparlCatalogueStoreError(
      'OPARL_CATALOGUE_ITEM_LIMIT',
      `The Bonn OParl catalogue contains ${raw.items.length} items; maximum is ${limits.maxItems}.`,
      { itemCount: raw.items.length, maxItems: limits.maxItems }
    );
  }

  const items = Object.freeze(raw.items.map(compactPaper).filter(Boolean));
  const pages = Object.freeze(
    (Array.isArray(raw.pages) ? raw.pages : []).map(compactPage).filter(Boolean)
  );
  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    sourceUrl: normalizeUrl(raw.sourceUrl || raw.paperListUrl || raw.firstUrl),
    items,
    pages,
    pagesFetched: Number(raw.pagesFetched || 0),
    scanPagesFetched: Number(raw.scanPagesFetched || raw.pagesFetched || 0),
    discoveryPagesFetched: Number(raw.discoveryPagesFetched || 0),
    traversalDirection: String(raw.traversalDirection || 'newest-first'),
    truncated: raw.truncated === true,
    nextUrl: normalizeUrl(raw.nextUrl),
  };
  const estimatedBytes = estimateBytes(snapshot);
  if (estimatedBytes > limits.maxBytes) {
    throw new BonnOparlCatalogueStoreError(
      'OPARL_CATALOGUE_BYTE_LIMIT',
      `The normalized Bonn OParl catalogue requires ${estimatedBytes} bytes; maximum is ${limits.maxBytes}.`,
      { estimatedBytes, maxBytes: limits.maxBytes }
    );
  }
  return Object.freeze({ ...snapshot, estimatedBytes });
}

function buildCatalogueKey(config = {}) {
  const canonical = JSON.stringify({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    collectionUrl: normalizeUrl(config.collectionUrl),
    pageSize: positiveInteger(config.pageSize, 100),
    maxScanPages: positiveInteger(config.maxScanPages, 300),
    businessDateCutoff: String(config.businessDateCutoff || ''),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function materialize(record, store, status, now, extras = {}) {
  const ageMs = Math.max(0, now - record.generatedAtMs);
  const metadata = Object.freeze({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    cacheStatus: status,
    snapshotKey: record.key,
    generatedAt: new Date(record.generatedAtMs).toISOString(),
    ageMs,
    ttlMs: store.ttlMs,
    staleIfErrorMs: store.staleIfErrorMs,
    stale: status === 'stale-if-error',
    refreshFailed: status === 'stale-if-error',
    refreshError: extras.refreshError || null,
    sourceUrl: record.snapshot.sourceUrl,
    pagesFetched: record.snapshot.pagesFetched,
    scanPagesFetched: record.snapshot.scanPagesFetched,
    itemCount: record.snapshot.items.length,
    estimatedBytes: record.snapshot.estimatedBytes,
    truncated: record.snapshot.truncated,
  });
  return Object.freeze({ snapshot: record.snapshot, metadata });
}

class BonnOparlCatalogueStore {
  constructor(options = {}) {
    this.ttlMs = positiveDuration(
      options.ttlMs,
      positiveDuration(process.env.BONN_OPARL_CATALOGUE_TTL_MS, DEFAULT_TTL_MS)
    );
    this.staleIfErrorMs = positiveDuration(
      options.staleIfErrorMs,
      positiveDuration(
        process.env.BONN_OPARL_CATALOGUE_STALE_IF_ERROR_MS,
        DEFAULT_STALE_IF_ERROR_MS
      )
    );
    this.maxSnapshots = positiveInteger(
      options.maxSnapshots,
      positiveInteger(process.env.BONN_OPARL_CATALOGUE_MAX_SNAPSHOTS, DEFAULT_MAX_SNAPSHOTS)
    );
    this.maxItems = positiveInteger(
      options.maxItems,
      positiveInteger(process.env.BONN_OPARL_CATALOGUE_MAX_ITEMS, DEFAULT_MAX_ITEMS)
    );
    this.maxBytes = positiveInteger(
      options.maxBytes,
      positiveInteger(process.env.BONN_OPARL_CATALOGUE_MAX_BYTES, DEFAULT_MAX_BYTES)
    );
    this.clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
    this.entries = new Map();
    this.inFlight = new Map();
  }

  size() {
    return this.entries.size;
  }

  clear() {
    this.entries.clear();
    this.inFlight.clear();
  }

  _touch(key, record) {
    this.entries.delete(key);
    this.entries.set(key, record);
  }

  _store(key, snapshot, now) {
    const record = Object.freeze({
      key,
      snapshot,
      generatedAtMs: now,
      expiresAtMs: now + this.ttlMs,
    });
    this._touch(key, record);
    while (this.entries.size > this.maxSnapshots) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return record;
  }

  async getOrRefresh(config, loader) {
    if (typeof loader !== 'function') {
      throw new TypeError('BonnOparlCatalogueStore.getOrRefresh requires a loader function.');
    }
    const key = buildCatalogueKey(config);
    const now = Number(this.clock());
    const existing = this.entries.get(key);
    if (existing && now < existing.expiresAtMs) {
      this._touch(key, existing);
      return materialize(existing, this, 'hit', now);
    }

    const currentRefresh = this.inFlight.get(key);
    if (currentRefresh) {
      const outcome = await currentRefresh;
      const currentNow = Number(this.clock());
      return materialize(
        outcome.record,
        this,
        outcome.stale ? 'stale-if-error' : 'coalesced',
        currentNow,
        { refreshError: outcome.refreshError }
      );
    }

    const refresh = (async () => {
      try {
        const raw = await loader();
        const snapshot = normalizeSnapshot(raw, {
          maxItems: this.maxItems,
          maxBytes: this.maxBytes,
        });
        return {
          record: this._store(key, snapshot, Number(this.clock())),
          stale: false,
          refreshError: null,
        };
      } catch (error) {
        const failedAt = Number(this.clock());
        const staleAge = existing ? failedAt - existing.expiresAtMs : Number.POSITIVE_INFINITY;
        if (existing && staleAge <= this.staleIfErrorMs) {
          this._touch(key, existing);
          return {
            record: existing,
            stale: true,
            refreshError: compactError(error),
          };
        }
        throw error;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, refresh);

    const outcome = await refresh;
    const completedAt = Number(this.clock());
    const status = outcome.stale
      ? 'stale-if-error'
      : (existing ? 'refresh' : 'miss');
    return materialize(outcome.record, this, status, completedAt, {
      refreshError: outcome.refreshError,
    });
  }
}

const sharedBonnOparlCatalogueStore = new BonnOparlCatalogueStore();

module.exports = {
  SNAPSHOT_SCHEMA_VERSION,
  DEFAULT_TTL_MS,
  DEFAULT_STALE_IF_ERROR_MS,
  DEFAULT_MAX_SNAPSHOTS,
  DEFAULT_MAX_ITEMS,
  DEFAULT_MAX_BYTES,
  BonnOparlCatalogueStoreError,
  BonnOparlCatalogueStore,
  sharedBonnOparlCatalogueStore,
  buildCatalogueKey,
  normalizeSnapshot,
  compactPaper,
  compactError,
};
