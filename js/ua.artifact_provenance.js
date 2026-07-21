/**
 * Format adapters for the shared SourceManifest contract.
 *
 * This module does not invent or maintain format-specific source strings.
 * Every adapter normalizes the same manifest, hashes its canonical JSON and
 * embeds or packages that exact representation.
 */
(function initArtifactProvenance(root, factory) {
  const dependency = typeof module !== 'undefined' && module.exports
    ? require('./ua.source_manifest')
    : root && root.UA && root.UA.sourceManifest;
  const api = factory(dependency);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    const UA = root.UA = root.UA || {};
    UA.artifactProvenance = api;
  }
})(typeof window !== 'undefined' ? window : null, function createArtifactProvenanceApi(sourceManifest) {
  'use strict';

  if (!sourceManifest || typeof sourceManifest.normalizeManifest !== 'function') {
    throw new Error('ua.source_manifest.js must be loaded before ua.artifact_provenance.js');
  }

  const SIDECAR_SCHEMA_VERSION = 1;
  const SOURCE_IDS_PROPERTY = 'unfallatlas:sourceIds';
  const MANIFEST_HASH_PROPERTY = 'unfallatlas:sourceManifestSha256';

  class ArtifactProvenanceError extends Error {
    constructor(code, message, details) {
      super(message ? `${code}: ${message}` : code);
      this.name = 'ArtifactProvenanceError';
      this.code = code;
      this.details = details || null;
    }
  }

  function fail(code, message, details) {
    throw new ArtifactProvenanceError(code, message, details);
  }

  function requiredString(value, path) {
    if (typeof value !== 'string' || !value.trim()) {
      fail('invalid_value', `${path} must be a non-empty string`);
    }
    return value.trim();
  }

  function safeBaseName(value) {
    const name = requiredString(value, 'baseName')
      .normalize('NFKC')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!name || name === '.' || name === '..') fail('invalid_filename', 'baseName is unsafe');
    return name.slice(0, 120);
  }

  function bytes(value) {
    if (value instanceof Uint8Array) return value;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(value)) {
      return new Uint8Array(value);
    }
    if (typeof value === 'string') {
      if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value);
      if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'utf8'));
    }
    fail('invalid_bytes', 'artifact content must be UTF-8 text, Buffer or Uint8Array');
  }

  function hex(array) {
    return Array.from(array).map(value => value.toString(16).padStart(2, '0')).join('');
  }

  async function sha256(value) {
    const content = bytes(value);
    if (typeof require === 'function' && typeof module !== 'undefined' && module.exports) {
      const crypto = require('crypto');
      return crypto.createHash('sha256').update(Buffer.from(content)).digest('hex');
    }
    const subtle = rootCrypto();
    if (!subtle) fail('sha256_unavailable', 'Web Crypto SHA-256 is unavailable');
    return hex(new Uint8Array(await subtle.digest('SHA-256', content)));
  }

  function rootCrypto() {
    if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
      return globalThis.crypto.subtle;
    }
    return null;
  }

  async function normalizeAndHash(manifestValue) {
    const manifest = sourceManifest.normalizeManifest(manifestValue);
    const canonicalJson = sourceManifest.stableStringify(manifest);
    return Object.freeze({
      manifest,
      canonicalJson,
      prettyJson: `${JSON.stringify(manifest, null, 2)}\n`,
      sha256: await sha256(canonicalJson),
    });
  }

  function sourceIdSet(manifest) {
    return new Set(manifest.sources.map(source => source.sourceId));
  }

  function normalizeSourceIds(value, manifest, path, options = {}) {
    const supplied = value == null ? [] : value;
    if (!Array.isArray(supplied)) fail('invalid_source_ids', `${path} must be an array`);
    const ids = [...new Set(supplied.map((item, index) =>
      requiredString(item, `${path}[${index}]`)
    ))].sort((left, right) => left.localeCompare(right));
    if (!ids.length && options.defaultAll) return manifest.sources.map(source => source.sourceId);
    if (!ids.length && !options.allowEmpty) fail('missing_source_ids', `${path} must not be empty`);
    const known = sourceIdSet(manifest);
    const unknown = ids.filter(id => !known.has(id));
    if (unknown.length) fail('unknown_source_id', `${path} contains unknown IDs`, { unknown });
    return ids;
  }

  function visibleSourceLines(manifestValue, options = {}) {
    const summaries = sourceManifest.visibleSourceSummary(manifestValue);
    const maxSources = Math.max(1, Number(options.maxSources) || summaries.length);
    const selected = summaries.slice(0, maxSources);
    const lines = selected.map(source => {
      const change = source.changedOrDerived && source.changeNotice
        ? ` Änderungen: ${source.changeNotice}` : '';
      const attribution = source.attribution ? ` ${source.attribution}.` : '';
      return `${source.label}. Datensatz: ${source.datasetUrl}. ` +
        `Lizenz: ${source.licenseLabel} – ${source.licenseUrl}.${attribution}${change}`;
    });
    if (selected.length < summaries.length) {
      lines.push(`Weitere ${summaries.length - selected.length} Quelle(n) im vollständigen SourceManifest.`);
    }
    return Object.freeze(lines);
  }

  function compactSourceNotice(manifestValue, options = {}) {
    const maxCharacters = Math.max(80, Number(options.maxCharacters) || 500);
    const prefix = requiredString(options.prefix || 'Quellen', 'prefix');
    const summaries = sourceManifest.visibleSourceSummary(manifestValue);
    const labels = summaries.map(source => `${source.label} (${source.licenseId})`);
    let text = `${prefix}: ${labels.join('; ')}`;
    if (text.length <= maxCharacters) return text;
    const kept = [];
    for (const label of labels) {
      const candidate = `${prefix}: ${[...kept, label].join('; ')}; vollständige Quellen im Sidecar`;
      if (candidate.length > maxCharacters) break;
      kept.push(label);
    }
    if (!kept.length) return `${prefix}: vollständige Quellen im Sidecar`;
    return `${prefix}: ${kept.join('; ')}; vollständige Quellen im Sidecar`;
  }

  async function buildSidecar(options) {
    const opts = options || {};
    const normalized = await normalizeAndHash(opts.manifest);
    const artifactName = requiredString(opts.artifactName, 'artifactName');
    const artifactMediaType = requiredString(opts.artifactMediaType, 'artifactMediaType');
    const artifactBytes = opts.artifactBytes == null ? null : bytes(opts.artifactBytes);
    const artifactSha256 = opts.artifactSha256
      ? requiredString(opts.artifactSha256, 'artifactSha256').toLowerCase()
      : artifactBytes ? await sha256(artifactBytes) : null;
    if (artifactSha256 && !/^[a-f0-9]{64}$/.test(artifactSha256)) {
      fail('invalid_artifact_hash', 'artifactSha256 must be a SHA-256 hex digest');
    }
    const sidecar = {
      schemaVersion: SIDECAR_SCHEMA_VERSION,
      artifact: {
        name: artifactName,
        mediaType: artifactMediaType,
        ...(artifactBytes ? { bytes: artifactBytes.byteLength } : {}),
        ...(artifactSha256 ? { sha256: artifactSha256 } : {}),
      },
      sourceManifest: normalized.manifest,
      sourceManifestSha256: normalized.sha256,
      visibleSourceNotice: compactSourceNotice(normalized.manifest, opts.noticeOptions),
    };
    const json = `${JSON.stringify(sidecar, null, 2)}\n`;
    return Object.freeze({ sidecar: Object.freeze(sidecar), json, sha256: await sha256(json) });
  }

  function readmeText(baseName, manifest, manifestHash, options = {}) {
    const title = options.title || `Datenexport ${baseName}`;
    return `${title}\n${'='.repeat(title.length)}\n\n` +
      `Dieses Paket enthält die ausgewählten Fachdaten sowie das vollständige ` +
      `maschinenlesbare SourceManifest.\n\n` +
      `Dateien\n-------\n` +
      `- ${baseName}.csv: UTF-8-CSV mit den exportierten Datensätzen.\n` +
      `- sources.json: vollständige Quellen, Lizenzen, Zeitstände, Transformationen und Source-IDs.\n` +
      `- README.txt: diese Erläuterung.\n\n` +
      `SourceManifest SHA-256: ${manifestHash}\n\n` +
      `${visibleSourceLines(manifest).join('\n')}\n`;
  }

  async function buildCsvPackageEntries(options) {
    const opts = options || {};
    const baseName = safeBaseName(opts.baseName || 'unfallwerkbank-export');
    const csv = requiredString(opts.csv, 'csv');
    const normalized = await normalizeAndHash(opts.manifest);
    const readme = readmeText(baseName, normalized.manifest, normalized.sha256, opts);
    return Object.freeze({
      schemaVersion: 1,
      packageMediaType: 'application/zip',
      baseName,
      sourceManifestSha256: normalized.sha256,
      entries: Object.freeze([
        Object.freeze({ name: `${baseName}.csv`, mediaType: 'text/csv;charset=utf-8', content: csv }),
        Object.freeze({ name: 'sources.json', mediaType: 'application/json', content: normalized.prettyJson }),
        Object.freeze({ name: 'README.txt', mediaType: 'text/plain;charset=utf-8', content: readme }),
      ]),
    });
  }

  function cloneJson(value, path) {
    try { return JSON.parse(JSON.stringify(value)); }
    catch (error) { fail('invalid_json', `${path} is not JSON-serializable`, { message: error.message }); }
  }

  async function attachGeoJsonProvenance(featureCollectionValue, manifestValue, options = {}) {
    const collection = cloneJson(featureCollectionValue, 'featureCollection');
    if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
      fail('invalid_geojson', 'GeoJSON must be a FeatureCollection');
    }
    const normalized = await normalizeAndHash(manifestValue);
    const defaultIds = normalizeSourceIds(options.defaultSourceIds, normalized.manifest,
      'defaultSourceIds', { defaultAll: true });
    collection.features.forEach((feature, index) => {
      if (!feature || feature.type !== 'Feature') fail('invalid_geojson', `features[${index}] is not a Feature`);
      feature.properties = feature.properties && typeof feature.properties === 'object'
        ? feature.properties : {};
      const existing = feature.properties[SOURCE_IDS_PROPERTY];
      feature.properties[SOURCE_IDS_PROPERTY] = normalizeSourceIds(
        existing == null ? defaultIds : existing,
        normalized.manifest,
        `features[${index}].properties.${SOURCE_IDS_PROPERTY}`,
        { allowEmpty: false }
      );
    });
    collection.metadata = collection.metadata && typeof collection.metadata === 'object'
      ? collection.metadata : {};
    if (collection.metadata.sourceManifest || collection.metadata[MANIFEST_HASH_PROPERTY]) {
      fail('existing_provenance', 'GeoJSON already contains provenance metadata');
    }
    collection.metadata.sourceManifest = normalized.manifest;
    collection.metadata[MANIFEST_HASH_PROPERTY] = normalized.sha256;
    collection.metadata.visibleSourceNotice = compactSourceNotice(normalized.manifest, options.noticeOptions);
    return Object.freeze({
      geojson: collection,
      json: `${JSON.stringify(collection, null, 2)}\n`,
      sourceManifestSha256: normalized.sha256,
    });
  }

  function escapeXml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function kmlData(name, value) {
    return `<Data name="${escapeXml(name)}"><value>${escapeXml(value)}</value></Data>`;
  }

  async function buildKmlExtendedData(manifestValue, options = {}) {
    const normalized = await normalizeAndHash(manifestValue);
    const lines = visibleSourceLines(normalized.manifest);
    const fields = [
      kmlData(MANIFEST_HASH_PROPERTY, normalized.sha256),
      kmlData('unfallatlas:sourceManifestSchemaVersion', normalized.manifest.schemaVersion),
      kmlData('unfallatlas:sourceIds', normalized.manifest.sources.map(source => source.sourceId).join(',')),
      kmlData('unfallatlas:sourceNotice', compactSourceNotice(normalized.manifest, options.noticeOptions)),
      kmlData('unfallatlas:sourceDetails', lines.join('\n')),
      kmlData('unfallatlas:sourceManifestJson', normalized.canonicalJson),
    ];
    return Object.freeze({
      xml: `<ExtendedData>${fields.join('')}</ExtendedData>`,
      sourceManifestSha256: normalized.sha256,
    });
  }

  async function injectKmlProvenance(kmlValue, manifestValue, options = {}) {
    const kml = requiredString(kmlValue, 'kml');
    if (/<ExtendedData\b[^>]*>[\s\S]*unfallatlas:sourceManifestSha256/i.test(kml)) {
      fail('existing_provenance', 'KML already contains Unfallatlas provenance');
    }
    const match = kml.match(/<Document\b[^>]*>/i);
    if (!match) fail('invalid_kml', 'KML requires one Document element');
    const extended = await buildKmlExtendedData(manifestValue, options);
    const offset = match.index + match[0].length;
    return Object.freeze({
      kml: `${kml.slice(0, offset)}${extended.xml}${kml.slice(offset)}`,
      sourceManifestSha256: extended.sourceManifestSha256,
    });
  }

  async function buildMediaProvenance(options) {
    const opts = options || {};
    const sidecar = await buildSidecar(opts);
    return Object.freeze({
      visibleNotice: sidecar.sidecar.visibleSourceNotice,
      sidecarFileName: `${requiredString(opts.artifactName, 'artifactName')}.sources.json`,
      sidecarJson: sidecar.json,
      sidecarSha256: sidecar.sha256,
      sourceManifestSha256: sidecar.sidecar.sourceManifestSha256,
    });
  }

  return Object.freeze({
    SIDECAR_SCHEMA_VERSION,
    SOURCE_IDS_PROPERTY,
    MANIFEST_HASH_PROPERTY,
    ArtifactProvenanceError,
    sha256,
    normalizeAndHash,
    visibleSourceLines,
    compactSourceNotice,
    buildSidecar,
    buildCsvPackageEntries,
    attachGeoJsonProvenance,
    buildKmlExtendedData,
    injectKmlProvenance,
    buildMediaProvenance,
  });
});
