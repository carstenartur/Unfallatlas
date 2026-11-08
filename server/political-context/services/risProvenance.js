'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { validProvenance } = require('../../../js/ua.ris-partitions');

// Explicit format/mapping revisions, independent of package releases and geocoding.
const PRODUCER_VERSION = 'ris-provenance-v1';
const NORMALIZATION_REVISIONS = { bonn: 'bonn-citation-v1', hannover: 'hannover-sim-citation-v1' };
const SOURCE_FIELDS = ['id', 'title', 'type', 'number', 'date', 'gremium', 'url', 'source', 'relatedTo', 'locationEvidence',
  'locationEvidenceTruncated'];
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function sourceProjectionFingerprint(records) {
  const projection = records.map(record => {
    const value = Object.fromEntries(SOURCE_FIELDS.filter(k => record[k] !== undefined).map(k => [k, record[k]]));
    if (record.locationSource === 'official') for (const field of ['geometry', 'locationSource', 'locationLabel']) {
      if (record[field] !== undefined) value[field] = record[field];
    }
    return canonical(value);
  }).sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
  return { algorithm: 'sha256', kind: 'provider-projection-v1',
    sha256: createHash('sha256').update(JSON.stringify(projection)).digest('hex') };
}
const knownCount = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
function collectionProvenance({ catalogue, city, records, sourceRecords, sourceVerifiedAt, now, sourceOptions = {} }) {
  const facts = catalogue.provenance?.collection || {};
  const history = catalogue.history;
  return {
    schemaVersion: 1, producer: { name: 'unfallwerkbank-ris', version: PRODUCER_VERSION },
    builtAt: new Date(now).toISOString(), sourceVerifiedAt, provider: city === 'bonn' ? 'bonn-oparl' : 'hannover-sim',
    normalizationRevision: NORMALIZATION_REVISIONS[city], sourceFingerprint: sourceProjectionFingerprint(sourceRecords),
    collection: {
      pages: knownCount(facts.pages ?? catalogue.cache?.pages), rawItems: knownCount(facts.rawItems), normalizedItems: records.length,
      requestedFrom: facts.requestedFrom ?? history?.requestedFrom ?? null, requestedTo: facts.requestedTo ?? history?.requestedTo ?? null,
      limits: Object.fromEntries(['maxPages', 'pageSize', 'maxDocuments', 'workBudget', 'maxDurationMs'].map(k => [k,
        knownCount(facts.limits?.[k] ?? sourceOptions[k])])),
      continuation: facts.continuation || { pending: history?.pending ?? null, interrupted: history?.interrupted ?? null,
        pendingYears: history?.pendingYears || [], reason: history?.interrupted
          ? sourceOptions.workBudget === 0 ? 'work-budget' : null : null },
    },
    rights: catalogue.provenance?.rights || { status: 'not-specified', license: null, attribution: [] },
    // Distribution is supplied only after the writer installs actual assets.
  };
}
function distribution(assets) {
  const unique = new Map(assets.map(a => [a.reference.path, a]));
  const value = { compression: 'gzip', assetCount: unique.size, compressedBytes: 0, uncompressedBytes: 0 };
  for (const { bytes, reference, compressedBytes } of unique.values()) { value.compressedBytes += compressedBytes ?? bytes.length; value.uncompressedBytes += reference.bytes; }
  return value;
}
function buildProvenance(value, { generatedAt, recordCount, coverage, now, assets }) {
  if (value === undefined) return undefined;
  // Reject invalid present acquisition data before changing build-specific fields.
  const totals = distribution(assets);
  assertProvenance({ ...value, distribution: value.distribution === undefined ? totals : value.distribution }, generatedAt, recordCount, coverage);
  const prepared = { ...value, producer: { name: 'unfallwerkbank-ris', version: PRODUCER_VERSION },
    builtAt: new Date(typeof now === 'function' ? now() : now).toISOString(), distribution: totals };
  if (!validProvenance(prepared, generatedAt, recordCount, coverage)) throw new Error('Invalid RIS provenance');
  return prepared;
}
function assertProvenance(value, generatedAt, recordCount, coverage) {
  if (!validProvenance(value, generatedAt, recordCount, coverage)) throw new Error('Invalid RIS provenance');
}
async function verifyDistribution(directory, provenance, references) {
  if (!provenance) return;
  const refs = [...new Map(references.map(r => [r.path, r])).values()];
  let compressedBytes = 0, uncompressedBytes = 0;
  for (const ref of refs) { compressedBytes += (await fs.stat(path.join(directory, ref.path))).size; uncompressedBytes += ref.bytes; }
  const d = provenance.distribution;
  if (d.assetCount !== refs.length || d.compressedBytes !== compressedBytes || d.uncompressedBytes !== uncompressedBytes) {
    throw new Error('RIS provenance distribution does not match unique assets');
  }
}
module.exports = { sourceProjectionFingerprint, collectionProvenance, buildProvenance, assertProvenance, verifyDistribution };
