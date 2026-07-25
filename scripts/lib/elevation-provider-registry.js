'use strict';

const PROVIDER_SCHEMA_VERSION = 1;
const MODEL_TYPES = new Set(['DTM', 'DSM', 'mixed']);
const COVERAGE_TYPES = new Set(['city-list', 'global']);
const STATUS_VALUES = new Set(['active', 'disabled']);
const PRIORITY_MIN = 1;
const PRIORITY_MAX = 5;

function invariant(condition, message) {
  if (!condition) throw new Error(`[elevation-provider-registry] ${message}`);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeCity(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function assertHttpUrl(value, field) {
  invariant(isNonEmptyString(value), `${field} is required`);
  let url;
  try { url = new URL(value); }
  catch (_) { throw new Error(`[elevation-provider-registry] ${field} is not a URL`); }
  invariant(url.protocol === 'https:', `${field} must use HTTPS`);
  return url.href;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function normalizeCoverage(raw) {
  invariant(raw && typeof raw === 'object' && !Array.isArray(raw), 'coverage is required');
  invariant(COVERAGE_TYPES.has(raw.type), `unsupported coverage type ${JSON.stringify(raw.type)}`);
  if (raw.type === 'global') return Object.freeze({ type: 'global' });
  invariant(Array.isArray(raw.cities) && raw.cities.length > 0, 'city-list coverage requires cities');
  const cities = [...new Set(raw.cities.map(normalizeCity).filter(Boolean))].sort();
  invariant(cities.length > 0, 'city-list coverage has no valid city');
  return Object.freeze({ type: 'city-list', cities: Object.freeze(cities) });
}

function validateStaticDescriptor(raw) {
  invariant(raw && typeof raw === 'object' && !Array.isArray(raw), 'provider descriptor must be an object');
  invariant(raw.schemaVersion === PROVIDER_SCHEMA_VERSION, `provider ${raw.id || '<unknown>'} has unsupported schemaVersion`);
  for (const field of [
    'id', 'publisher', 'datasetTitle', 'licenseId', 'licenseName',
    'requiredAttribution', 'horizontalCrs', 'retrievedAtPolicy',
  ]) invariant(isNonEmptyString(raw[field]), `provider ${raw.id || '<unknown>'} lacks ${field}`);
  invariant(/^[a-z0-9][a-z0-9._-]*$/.test(raw.id), `invalid provider id ${JSON.stringify(raw.id)}`);
  invariant(STATUS_VALUES.has(raw.status), `provider ${raw.id} has invalid status`);
  invariant(Number.isInteger(raw.priority) && raw.priority >= PRIORITY_MIN && raw.priority <= PRIORITY_MAX,
    `provider ${raw.id} priority must be ${PRIORITY_MIN}..${PRIORITY_MAX}`);
  invariant(Number.isFinite(raw.resolutionMeters) && raw.resolutionMeters > 0,
    `provider ${raw.id} resolutionMeters must be positive`);
  invariant(MODEL_TYPES.has(raw.modelType), `provider ${raw.id} has invalid modelType`);
  if (raw.status === 'disabled') invariant(isNonEmptyString(raw.disabledReason), `disabled provider ${raw.id} lacks disabledReason`);
  if (raw.verticalDatum != null) invariant(isNonEmptyString(raw.verticalDatum), `provider ${raw.id} has invalid verticalDatum`);
  if (raw.acquisitionPeriod != null) invariant(isNonEmptyString(raw.acquisitionPeriod), `provider ${raw.id} has invalid acquisitionPeriod`);
  if (raw.publicationDate != null) invariant(/^\d{4}-\d{2}-\d{2}$/.test(raw.publicationDate), `provider ${raw.id} has invalid publicationDate`);
  if (raw.modifiedDataNotice != null) invariant(isNonEmptyString(raw.modifiedDataNotice), `provider ${raw.id} has invalid modifiedDataNotice`);

  const normalized = {
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    id: raw.id,
    status: raw.status,
    disabledReason: raw.status === 'disabled' ? raw.disabledReason : null,
    priority: raw.priority,
    publisher: raw.publisher,
    datasetTitle: raw.datasetTitle,
    datasetUrl: assertHttpUrl(raw.datasetUrl, `${raw.id}.datasetUrl`),
    distributionUrl: raw.distributionUrl == null ? null : assertHttpUrl(raw.distributionUrl, `${raw.id}.distributionUrl`),
    licenseId: raw.licenseId,
    licenseName: raw.licenseName,
    licenseUrl: assertHttpUrl(raw.licenseUrl, `${raw.id}.licenseUrl`),
    requiredAttribution: raw.requiredAttribution,
    resolutionMeters: Number(raw.resolutionMeters),
    modelType: raw.modelType,
    horizontalCrs: raw.horizontalCrs,
    verticalDatum: raw.verticalDatum || null,
    acquisitionPeriod: raw.acquisitionPeriod || null,
    publicationDate: raw.publicationDate || null,
    retrievedAtPolicy: raw.retrievedAtPolicy,
    modifiedDataNotice: raw.modifiedDataNotice || null,
    coverage: normalizeCoverage(raw.coverage),
  };
  return deepFreeze(normalized);
}

function coversCity(provider, city) {
  const slug = normalizeCity(city);
  if (!slug || provider.status !== 'active') return false;
  return provider.coverage.type === 'global' || provider.coverage.cities.includes(slug);
}

function compareProviders(left, right) {
  return (left.priority - right.priority)
    || (left.resolutionMeters - right.resolutionMeters)
    || left.id.localeCompare(right.id);
}

function createRegistry(input) {
  const rawProviders = Array.isArray(input) ? input : input && input.providers;
  invariant(Array.isArray(rawProviders), 'providers must be an array');
  if (!Array.isArray(input) && input) {
    invariant(input.schemaVersion === PROVIDER_SCHEMA_VERSION, 'registry schemaVersion is unsupported');
  }
  const providers = rawProviders.map(validateStaticDescriptor).sort(compareProviders);
  const byId = new Map();
  for (const provider of providers) {
    invariant(!byId.has(provider.id), `duplicate provider id ${provider.id}`);
    byId.set(provider.id, provider);
  }

  function select(city, requirements = {}) {
    const candidates = providers.filter(provider => {
      if (!coversCity(provider, city)) return false;
      if (Number.isFinite(requirements.maxResolutionMeters)
          && provider.resolutionMeters > requirements.maxResolutionMeters) return false;
      if (Array.isArray(requirements.modelTypes) && requirements.modelTypes.length > 0
          && !requirements.modelTypes.includes(provider.modelType)) return false;
      if (isNonEmptyString(requirements.horizontalCrs)
          && provider.horizontalCrs !== requirements.horizontalCrs) return false;
      return true;
    });
    return candidates.length > 0 ? candidates[0] : null;
  }

  return Object.freeze({
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    providers: Object.freeze(providers.slice()),
    get(id) { return byId.get(id) || null; },
    select,
    coversCity(id, city) {
      const provider = byId.get(id);
      return provider ? coversCity(provider, city) : false;
    },
  });
}

function materializeSourceDescriptor(provider, runtime) {
  const p = validateStaticDescriptor(provider);
  const retrievedAt = runtime && runtime.retrievedAt;
  invariant(isNonEmptyString(retrievedAt) && Number.isFinite(Date.parse(retrievedAt)),
    `provider ${p.id} requires a valid retrievedAt timestamp`);
  invariant(coversCity(p, runtime.city), `provider ${p.id} does not cover ${runtime.city}`);
  return deepFreeze({
    id: p.id,
    publisher: p.publisher,
    datasetTitle: p.datasetTitle,
    datasetUrl: p.datasetUrl,
    distributionUrl: p.distributionUrl,
    licenseId: p.licenseId,
    licenseName: p.licenseName,
    licenseUrl: p.licenseUrl,
    requiredAttribution: p.requiredAttribution,
    resolutionMeters: p.resolutionMeters,
    modelType: p.modelType,
    horizontalCrs: p.horizontalCrs,
    verticalDatum: p.verticalDatum,
    acquisitionPeriod: p.acquisitionPeriod,
    publicationDate: p.publicationDate,
    retrievedAt: new Date(retrievedAt).toISOString(),
    modifiedDataNotice: p.modifiedDataNotice,
  });
}

function classifyGradientSemantics(provider, analysis) {
  const p = validateStaticDescriptor(provider);
  const a = analysis || {};
  const risks = Array.isArray(a.risks) ? a.risks.filter(Boolean) : [];
  const robustRoadProfile = a.roadMatched === true
    && a.method === 'robust-linear-regression'
    && Number.isFinite(a.windowMeters) && a.windowMeters >= 20
    && Number.isInteger(a.sampleCount) && a.sampleCount >= 5;
  const highResolutionTerrain = p.modelType === 'DTM' && p.resolutionMeters <= 5;
  const reliableForRoad = robustRoadProfile && highResolutionTerrain && risks.length === 0;
  return deepFreeze({
    label: reliableForRoad ? 'Straßenlängsneigung' : 'Geländeneigung im Umfeld',
    reliableForRoad,
    decimals: reliableForRoad ? 1 : 0,
    quality: reliableForRoad ? 'high' : (robustRoadProfile ? 'limited' : 'low'),
    uncertaintyReasons: Object.freeze([
      ...risks,
      ...(highResolutionTerrain ? [] : [`source-resolution-${p.resolutionMeters}m`]),
      ...(a.roadMatched === true ? [] : ['road-not-matched']),
      ...(a.method === 'robust-linear-regression' ? [] : ['non-robust-profile-method']),
    ]),
  });
}

module.exports = Object.freeze({
  PROVIDER_SCHEMA_VERSION,
  MODEL_TYPES,
  COVERAGE_TYPES,
  normalizeCity,
  validateStaticDescriptor,
  createRegistry,
  coversCity,
  materializeSourceDescriptor,
  classifyGradientSemantics,
});
