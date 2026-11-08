'use strict';

const facts = require('../../../js/ua.ris-partitions');
const contextFields = ['level', 'publisher', 'issuer', 'documentKind', 'status', 'publicationDate', 'documentDate', 'meetingDate'];
const statusFields = ['source', 'status', 'url', 'retrievedAt', 'from', 'to', 'recordCount', 'message'];
const project = (value, fields) => Object.fromEntries(fields.map(key => [key, value[key]]));

// Provider input remains defensive: unknown fields are discarded and malformed
// optional facts are omitted. Snapshot/browser checks use the same validators.
function normalizeSourceContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = project(value, contextFields);
  return facts.validSourceContext(result) ? result : null;
}
function httpsUrl(value, official = false) {
  try {
    const url = new URL(value);
    return facts.officialFactUrl(value, official ? undefined : [url.hostname]) ? url.href : null;
  } catch { return null; }
}
function normalizeSourceStatuses(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 16).flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const result = project(value, statusFields);
    return facts.validSourceStatuses([result]) ? [result] : [];
  });
}
module.exports = { normalizeSourceContext, normalizeSourceStatuses, httpsUrl };
