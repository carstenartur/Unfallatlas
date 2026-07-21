/**
 * Renderer-independent provenance contract for every Unfallwerkbank artifact.
 *
 * The contract is shared by browser and Node consumers. It deliberately owns
 * validation, canonicalisation and licence policy in one place so PDF, DOCX,
 * CSV, GeoJSON, KML, screenshots and video cannot maintain divergent source
 * strings or silently omit required attribution.
 */
(function initSourceManifest(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    const UA = root.UA = root.UA || {};
    UA.sourceManifest = api;
  }
})(typeof window !== 'undefined' ? window : null, function createSourceManifestApi() {
  'use strict';

  const SCHEMA_VERSION = 1;
  const SOURCE_ROLES = Object.freeze([
    'accidents',
    'basemap',
    'orthophoto',
    'elevation',
    'traffic_count',
    'road_context',
    'poi',
    'political_reference',
    'cost_factor',
    'measure_evidence',
    'other',
  ]);

  const LICENSE_POLICIES = Object.freeze({
    'DL-DE-ZERO-2.0': Object.freeze({
      id: 'DL-DE-Zero-2.0',
      name: 'Datenlizenz Deutschland – Zero – Version 2.0',
      requiresAttribution: false,
      requiresChangeNotice: false,
      shareAlike: false,
    }),
    'DL-DE-BY-2.0': Object.freeze({
      id: 'DL-DE-BY-2.0',
      name: 'Datenlizenz Deutschland – Namensnennung – Version 2.0',
      requiresAttribution: true,
      requiresChangeNotice: true,
      shareAlike: false,
    }),
    'CC0-1.0': Object.freeze({
      id: 'CC0-1.0',
      name: 'Creative Commons CC0 1.0 Universal',
      requiresAttribution: false,
      requiresChangeNotice: false,
      shareAlike: false,
    }),
    'CC-BY-4.0': Object.freeze({
      id: 'CC-BY-4.0',
      name: 'Creative Commons Attribution 4.0 International',
      requiresAttribution: true,
      requiresChangeNotice: true,
      shareAlike: false,
    }),
    'ODBL-1.0': Object.freeze({
      id: 'ODbL-1.0',
      name: 'Open Data Commons Open Database License 1.0',
      requiresAttribution: true,
      requiresChangeNotice: true,
      shareAlike: true,
    }),
  });

  const LICENSE_ALIASES = Object.freeze({
    'DL-DE/ZERO-2-0': 'DL-DE-ZERO-2.0',
    'DL-DE/ZERO/2.0': 'DL-DE-ZERO-2.0',
    'DL-DE-ZERO-2.0': 'DL-DE-ZERO-2.0',
    'DL-DE/BY-2-0': 'DL-DE-BY-2.0',
    'DL-DE/BY/2.0': 'DL-DE-BY-2.0',
    'DL-DE-BY-2.0': 'DL-DE-BY-2.0',
    'CC0': 'CC0-1.0',
    'CC0-1.0': 'CC0-1.0',
    'CC-BY-4.0': 'CC-BY-4.0',
    'CC BY 4.0': 'CC-BY-4.0',
    'ODBL': 'ODBL-1.0',
    'ODBL-1.0': 'ODBL-1.0',
    'ODBL 1.0': 'ODBL-1.0',
  });

  const MANIFEST_KEYS = Object.freeze([
    'schemaVersion', 'artifactId', 'artifactHash', 'generatedAt',
    'applicationVersion', 'buildFingerprint', 'dataFingerprint',
    'scenario', 'sources', 'transformations',
  ]);
  const SCENARIO_KEYS = Object.freeze(['city', 'bounds', 'filters', 'years']);
  const SOURCE_KEYS = Object.freeze([
    'sourceId', 'role', 'publisher', 'datasetTitle', 'datasetUrl',
    'distributionUrl', 'licenseId', 'licenseName', 'licenseUrl',
    'requiredAttribution', 'temporalCoverage', 'spatialCoverage',
    'versionOrPublicationDate', 'retrievedAt', 'contentHash',
    'changedOrDerived', 'changeNotice', 'qualityNotes', 'permissions',
  ]);
  const PERMISSION_KEYS = Object.freeze([
    'permitsRedistribution', 'permitsDerivatives', 'commercialUseAllowed',
  ]);
  const TRANSFORMATION_KEYS = Object.freeze([
    'transformationId', 'label', 'description', 'sourceIds', 'outputFields',
    'softwareVersion', 'parameters',
  ]);

  class SourceManifestError extends Error {
    constructor(code, path, value, message) {
      super(message ? `${code}: ${message}` : `${code}:${path}`);
      this.name = 'SourceManifestError';
      this.code = code;
      this.path = path;
      this.value = value;
      this.status = 422;
    }
  }

  function fail(code, path, value, message) {
    throw new SourceManifestError(code, path, value, message);
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function objectValue(value, path) {
    if (!isPlainObject(value)) fail('invalid_object', path, value, `${path} must be an object`);
    return value;
  }

  function assertKnownKeys(value, allowed, path) {
    const unknown = Object.keys(value).filter(key => !allowed.includes(key));
    if (unknown.length) {
      fail('unknown_field', path, unknown, `${path} contains unknown fields: ${unknown.join(', ')}`);
    }
  }

  function requiredString(value, path) {
    if (typeof value !== 'string' || !value.trim()) {
      fail('missing_required_value', path, value, `${path} must be a non-empty string`);
    }
    return value.trim();
  }

  function optionalString(value, path) {
    if (value == null || value === '') return undefined;
    return requiredString(value, path);
  }

  function validDate(value, path) {
  const text = requiredString(value, path);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(text);
  if (!match) {
    fail('invalid_date', path, value, `${path} must be an ISO-8601 date or timestamp with timezone`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year ||
      calendarDate.getUTCMonth() !== month - 1 ||
      calendarDate.getUTCDate() !== day) {
    fail('invalid_date', path, value, `${path} contains an impossible calendar date`);
  }
  if (match[4] != null) {
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = match[6] == null ? 0 : Number(match[6]);
    if (hour > 23 || minute > 59 || second > 59) {
      fail('invalid_date', path, value, `${path} contains an invalid time`);
    }
    if (match[8] !== 'Z') {
      const offsetHour = Number(match[8].slice(1, 3));
      const offsetMinute = Number(match[8].slice(4, 6));
      if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
        fail('invalid_date', path, value, `${path} contains an invalid timezone offset`);
      }
    }
    if (!Number.isFinite(Date.parse(text))) {
      fail('invalid_date', path, value, `${path} must be an ISO-8601 timestamp`);
    }
  }
  return text;
}

  function httpsUrl(value, path, optional) {
    if ((value == null || value === '') && optional) return undefined;
    const text = requiredString(value, path);
    let parsed;
    try { parsed = new URL(text); } catch (_) {
      fail('invalid_url', path, value, `${path} must be an absolute URL`);
    }
    if (parsed.protocol !== 'https:') {
      fail('unsafe_url', path, value, `${path} must use https`);
    }
    parsed.hash = '';
    return parsed.toString();
  }

  function sha256(value, path, optional) {
    if ((value == null || value === '') && optional) return undefined;
    const text = requiredString(value, path).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(text)) {
      fail('invalid_sha256', path, value, `${path} must be a 64-character SHA-256 hex digest`);
    }
    return text;
  }

  function identifier(value, path) {
    const text = requiredString(value, path);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) {
      fail('invalid_identifier', path, value, `${path} contains unsupported characters`);
    }
    return text;
  }

  function stringArray(value, path, options) {
    const opts = options || {};
    if (value == null) {
    if (opts.allowEmpty) return [];
    fail('missing_required_value', path, value, `${path} must be a non-empty array`);
  }
    if (!Array.isArray(value)) fail('invalid_array', path, value, `${path} must be an array`);
    const values = value.map((item, index) => requiredString(item, `${path}[${index}]`));
    const unique = [...new Set(values)];
    if (!opts.allowEmpty && unique.length === 0) {
      fail('empty_array', path, value, `${path} must not be empty`);
    }
    return opts.preserveOrder ? unique : unique.sort((a, b) => a.localeCompare(b));
  }

  function canonicalLicenseId(value, path) {
    const raw = requiredString(value, path);
    const key = raw.toUpperCase().replace(/_/g, '-').replace(/\s+/g, ' ');
    const canonicalKey = LICENSE_ALIASES[key];
    if (!canonicalKey || !LICENSE_POLICIES[canonicalKey]) {
      fail('unsupported_license', path, value, `${path} is not in the open-licence allowlist`);
    }
    return LICENSE_POLICIES[canonicalKey];
  }

  function normalizeBounds(value, path) {
    if (value == null) return undefined;
    const bounds = objectValue(value, path);
    assertKnownKeys(bounds, ['south', 'west', 'north', 'east'], path);
    const normalized = {};
    for (const key of ['south', 'west', 'north', 'east']) {
      const number = Number(bounds[key]);
      if (!Number.isFinite(number)) fail('invalid_coordinate', `${path}.${key}`, bounds[key]);
      normalized[key] = number;
    }
    if (normalized.south >= normalized.north || normalized.west >= normalized.east ||
        normalized.south < -90 || normalized.north > 90 ||
        normalized.west < -180 || normalized.east > 180) {
      fail('invalid_bounds', path, value, `${path} is not a valid geographic bounding box`);
    }
    return normalized;
  }

  function normalizeScenario(value) {
    const scenario = objectValue(value, 'manifest.scenario');
    assertKnownKeys(scenario, SCENARIO_KEYS, 'manifest.scenario');
    let years = [];
  if (scenario.years != null) {
    if (!Array.isArray(scenario.years)) {
      fail('invalid_array', 'manifest.scenario.years', scenario.years,
        'manifest.scenario.years must be an array');
    }
    years = scenario.years.map((year, index) => {
      const number = Number(year);
      if (!Number.isInteger(number) || number < 1900 || number > 2100) {
        fail('invalid_year', `manifest.scenario.years[${index}]`, year);
      }
      return number;
    });
  }
    return {
      city: requiredString(scenario.city, 'manifest.scenario.city'),
      ...(scenario.bounds == null ? {} : { bounds: normalizeBounds(scenario.bounds, 'manifest.scenario.bounds') }),
      filters: cloneJson(objectValue(scenario.filters || {}, 'manifest.scenario.filters'), 'manifest.scenario.filters'),
      ...(years.length ? { years: [...new Set(years)].sort((a, b) => a - b) } : {}),
    };
  }

  function normalizePermissions(value, path) {
    if (value == null) return undefined;
    const permissions = objectValue(value, path);
    assertKnownKeys(permissions, PERMISSION_KEYS, path);
    const normalized = {};
    for (const key of PERMISSION_KEYS) {
      if (permissions[key] == null) continue;
      if (typeof permissions[key] !== 'boolean') {
        fail('invalid_permission', `${path}.${key}`, permissions[key], `${path}.${key} must be boolean`);
      }
      normalized[key] = permissions[key];
    }
    if (normalized.permitsRedistribution === false ||
        normalized.permitsDerivatives === false ||
        normalized.commercialUseAllowed === false) {
      fail('restricted_source', path, permissions, `${path} does not permit standard distribution and derivatives`);
    }
    return normalized;
  }

  function normalizeSource(value, index) {
    const path = `manifest.sources[${index}]`;
    const source = objectValue(value, path);
    assertKnownKeys(source, SOURCE_KEYS, path);
    const role = requiredString(source.role, `${path}.role`);
    if (!SOURCE_ROLES.includes(role)) fail('invalid_role', `${path}.role`, role);
    const policy = canonicalLicenseId(source.licenseId, `${path}.licenseId`);
    const changedOrDerived = source.changedOrDerived;
    if (typeof changedOrDerived !== 'boolean') {
      fail('missing_derivation_flag', `${path}.changedOrDerived`, changedOrDerived,
        `${path}.changedOrDerived must explicitly be true or false`);
    }
    const requiredAttribution = optionalString(source.requiredAttribution, `${path}.requiredAttribution`);
    if (policy.requiresAttribution && !requiredAttribution) {
      fail('missing_attribution', `${path}.requiredAttribution`, source.requiredAttribution,
        `${policy.id} requires an attribution statement`);
    }
    const changeNotice = optionalString(source.changeNotice, `${path}.changeNotice`);
    if (changedOrDerived && policy.requiresChangeNotice && !changeNotice) {
      fail('missing_change_notice', `${path}.changeNotice`, source.changeNotice,
        `${policy.id} requires a modification notice for derived data`);
    }
    const declaredLicenseName = requiredString(source.licenseName, `${path}.licenseName`);
    if (declaredLicenseName !== policy.name) {
      fail('license_name_mismatch', `${path}.licenseName`, declaredLicenseName,
        `${path}.licenseName must equal the canonical name for ${policy.id}`);
    }
    const distributionUrl = httpsUrl(source.distributionUrl, `${path}.distributionUrl`, true);
  const versionOrPublicationDate = source.versionOrPublicationDate == null || source.versionOrPublicationDate === ''
    ? undefined
    : validDate(source.versionOrPublicationDate, `${path}.versionOrPublicationDate`);
  return {
    sourceId: identifier(source.sourceId, `${path}.sourceId`),
      role,
      publisher: requiredString(source.publisher, `${path}.publisher`),
      datasetTitle: requiredString(source.datasetTitle, `${path}.datasetTitle`),
      datasetUrl: httpsUrl(source.datasetUrl, `${path}.datasetUrl`),
      ...(distributionUrl ? { distributionUrl } : {}),
      licenseId: policy.id,
      licenseName: policy.name,
      licenseUrl: httpsUrl(source.licenseUrl, `${path}.licenseUrl`),
      ...(requiredAttribution ? { requiredAttribution } : {}),
      ...(source.temporalCoverage ? { temporalCoverage: requiredString(source.temporalCoverage, `${path}.temporalCoverage`) } : {}),
      ...(source.spatialCoverage ? { spatialCoverage: requiredString(source.spatialCoverage, `${path}.spatialCoverage`) } : {}),
      ...(versionOrPublicationDate ? { versionOrPublicationDate } : {}),
      retrievedAt: validDate(source.retrievedAt, `${path}.retrievedAt`),
      ...(source.contentHash ? { contentHash: sha256(source.contentHash, `${path}.contentHash`) } : {}),
      changedOrDerived,
      ...(changeNotice ? { changeNotice } : {}),
      ...(source.qualityNotes == null ? {} : {
        qualityNotes: stringArray(source.qualityNotes, `${path}.qualityNotes`, { allowEmpty: true }),
      }),
      ...(source.permissions == null ? {} : {
        permissions: normalizePermissions(source.permissions, `${path}.permissions`),
      }),
    };
  }

  function cloneJson(value, path) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('invalid_number', path, value);
      return value;
    }
    if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${path}[${index}]`));
    const object = objectValue(value, path);
    return Object.fromEntries(Object.keys(object).sort().map(key =>
      [key, cloneJson(object[key], `${path}.${key}`)]
    ));
  }

  function normalizeTransformation(value, index, sourceIds) {
    const path = `manifest.transformations[${index}]`;
    const transformation = objectValue(value, path);
    assertKnownKeys(transformation, TRANSFORMATION_KEYS, path);
    const refs = stringArray(transformation.sourceIds, `${path}.sourceIds`);
    const orphaned = refs.filter(sourceId => !sourceIds.has(sourceId));
    if (orphaned.length) {
      fail('orphaned_source_reference', `${path}.sourceIds`, orphaned,
        `${path} references unknown source IDs: ${orphaned.join(', ')}`);
    }
    return {
      transformationId: identifier(transformation.transformationId, `${path}.transformationId`),
      label: requiredString(transformation.label, `${path}.label`),
      description: requiredString(transformation.description, `${path}.description`),
      sourceIds: refs,
      outputFields: stringArray(transformation.outputFields, `${path}.outputFields`, { allowEmpty: true }),
      ...(transformation.softwareVersion ? {
        softwareVersion: requiredString(transformation.softwareVersion, `${path}.softwareVersion`),
      } : {}),
      ...(transformation.parameters == null ? {} : {
        parameters: cloneJson(transformation.parameters, `${path}.parameters`),
      }),
    };
  }

  function normalizeManifest(value) {
    const manifest = objectValue(value, 'manifest');
    assertKnownKeys(manifest, MANIFEST_KEYS, 'manifest');
    const schemaVersion = Number(manifest.schemaVersion);
    if (schemaVersion !== SCHEMA_VERSION) {
      fail('unsupported_schema', 'manifest.schemaVersion', manifest.schemaVersion,
        `manifest.schemaVersion must be ${SCHEMA_VERSION}`);
    }
    if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) {
      fail('missing_sources', 'manifest.sources', manifest.sources, 'manifest.sources must not be empty');
    }
    const sources = manifest.sources.map(normalizeSource)
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    const sourceIds = new Set();
    for (const source of sources) {
      if (sourceIds.has(source.sourceId)) {
        fail('duplicate_source_id', 'manifest.sources', source.sourceId,
          `duplicate source ID: ${source.sourceId}`);
      }
      sourceIds.add(source.sourceId);
    }
    let transformationValues = [];
  if (manifest.transformations != null) {
    if (!Array.isArray(manifest.transformations)) {
      fail('invalid_array', 'manifest.transformations', manifest.transformations,
        'manifest.transformations must be an array');
    }
    transformationValues = manifest.transformations;
  }
  const transformations = transformationValues
    .map((item, index) => normalizeTransformation(item, index, sourceIds))
    .sort((a, b) => a.transformationId.localeCompare(b.transformationId));
    const transformationIds = new Set();
    for (const transformation of transformations) {
      if (transformationIds.has(transformation.transformationId)) {
        fail('duplicate_transformation_id', 'manifest.transformations', transformation.transformationId);
      }
      transformationIds.add(transformation.transformationId);
    }
    return deepFreeze({
      schemaVersion: SCHEMA_VERSION,
      artifactId: identifier(manifest.artifactId, 'manifest.artifactId'),
      ...(manifest.artifactHash ? { artifactHash: sha256(manifest.artifactHash, 'manifest.artifactHash') } : {}),
      generatedAt: validDate(manifest.generatedAt, 'manifest.generatedAt'),
      applicationVersion: requiredString(manifest.applicationVersion, 'manifest.applicationVersion'),
      buildFingerprint: sha256(manifest.buildFingerprint, 'manifest.buildFingerprint'),
      dataFingerprint: sha256(manifest.dataFingerprint, 'manifest.dataFingerprint'),
      scenario: normalizeScenario(manifest.scenario),
      sources,
      transformations,
    });
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
  }

  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ).join(',')}}`;
  }

  function visibleSourceSummary(manifestValue) {
    const manifest = normalizeManifest(manifestValue);
    return manifest.sources.map(source => ({
      sourceId: source.sourceId,
      role: source.role,
      label: `${source.publisher}: ${source.datasetTitle}`,
      datasetUrl: source.datasetUrl,
      licenseLabel: `${source.licenseName} (${source.licenseId})`,
      licenseUrl: source.licenseUrl,
      attribution: source.requiredAttribution || null,
      changedOrDerived: source.changedOrDerived,
      changeNotice: source.changeNotice || null,
    }));
  }

  function sourceIdsForFields(manifestValue, fields) {
    const manifest = normalizeManifest(manifestValue);
    const requested = new Set(stringArray(fields, 'fields', { allowEmpty: true }));
    const ids = new Set();
    for (const transformation of manifest.transformations) {
      if (transformation.outputFields.some(field => requested.has(field))) {
        for (const sourceId of transformation.sourceIds) ids.add(sourceId);
      }
    }
    return [...ids].sort((a, b) => a.localeCompare(b));
  }

  return Object.freeze({
    SCHEMA_VERSION,
    SOURCE_ROLES,
    LICENSE_POLICIES,
    SourceManifestError,
    normalizeManifest,
    sourceIdsForFields,
    stableStringify,
    visibleSourceSummary,
  });
});
