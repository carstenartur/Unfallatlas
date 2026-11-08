(() => {
  'use strict';

  const SCHEMA_VERSION = 1;
  const MAX_BYTES = 16 * 1024 * 1024;
  const MAX_COUNT = 50_000;
  const MAX_LOCATIONS_PER_RECORD = 8;
  const MAX_AGE = 8 * 24 * 60 * 60 * 1000;
  const MAX_FALLBACK_AGE = 14 * 24 * 60 * 60 * 1000;
  const MANIFEST_TTL = 5 * 60 * 1000;
  const LOCATION_GEOMETRY_TYPES = new Map([
    ['junction', ['Point']],
    ['section', ['LineString']],
    ['street', ['LineString', 'MultiLineString']],
    ['address', ['Point']],
    ['place', ['Point', 'Polygon', 'MultiPolygon']]
  ]);
  const LOCATION_STATUSES = new Set(['mapped', 'partial', 'unresolved', 'unavailable']);
  const LOCATION_SOURCES = new Set(['title', 'document', 'official']);
  const LOCATION_REASONS = new Set([
    'gazetteer_unavailable', 'document_text_unavailable', 'evidence_truncated', 'location_limit',
    'unverified_name', 'no_specific_location', 'unmapped_location', 'non_traffic_address'
  ]);
  const LOCATION_TOTALS = ['attempted', 'mapped', 'partial', 'unresolved', 'unavailable', 'truncated'];

  function cityKey(city) {
    return String(city || '').trim().toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '').slice(0, 80);
  }

  function error(code, message) {
    return Object.assign(new Error(message), { code });
  }

  function invalid() {
    return error('RIS_SNAPSHOT_INVALID', 'Der veröffentlichte Ratsdatenstand konnte nicht geprüft werden.');
  }

  function isSourceUrl(value, sources) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password
        && (!sources || sources.some(source => new URL(source).host === url.host));
    } catch (_) {
      return false;
    }
  }

  function validAsset(entry, key, kind, maxCount = MAX_COUNT) {
    return entry && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256)
      && entry.path === `${key}.${entry.sha256}.${kind}.json.gz`
      && Number.isInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= MAX_BYTES
      && Number.isInteger(entry.count) && entry.count >= 0 && entry.count <= maxCount;
  }

  function validDay(value) {
    if (value === null) return true;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
  }

  function validText(value) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function validLocationText(value) {
    return validText(value) && value === value.replace(/[\s\u0000-\u001f\u007f-\u009f]+/gu, ' ').trim();
  }

  function validLocationRevision(value) {
    return value === undefined || (Number.isSafeInteger(value) && value > 0);
  }

  function validCoverageScope(value) {
    return value === undefined || value === 'citywide' || value === 'selected-bodies';
  }

  function listOf(values, minimum, validItem) {
    if (!Array.isArray(values) || values.length < minimum) return false;
    for (const value of values) if (!validItem(value)) return false;
    return true;
  }

  function validLocation(location) {
    const evidence = location?.evidence;
    return isObject(location) && Object.keys(location).length === 4
      && validLocationText(location.label) && LOCATION_GEOMETRY_TYPES.has(location.kind) && typeof location.mapped === 'boolean'
      && isObject(evidence) && Object.keys(evidence).length === 2
      && (evidence.source === 'title' || evidence.source === 'document') && validLocationText(evidence.text);
  }

  function validLocations(locations) {
    return locations === undefined || (Array.isArray(locations) && locations.length <= MAX_LOCATIONS_PER_RECORD
      && listOf(locations, 0, validLocation));
  }

  function validLocationAssessment(value, locations) {
    if (value === undefined) return true;
    if (!isObject(value) || Object.keys(value).length !== 4 || !LOCATION_STATUSES.has(value.status)
        || typeof value.truncated !== 'boolean') return false;
    const uniqueList = (values, allowed, minimum) => listOf(values, minimum, item => allowed.has(item))
      && values.length <= allowed.size && new Set(values).size === values.length;
    if (!uniqueList(value.sources, LOCATION_SOURCES, 1) || !uniqueList(value.reasons, LOCATION_REASONS, 0)) return false;
    const truncated = value.reasons.includes('evidence_truncated') || value.reasons.includes('location_limit');
    if (value.truncated !== truncated) return false;
    const mapped = value.sources.includes('official') || locations?.some(location => location.mapped) === true;
    if (value.status === 'mapped') return mapped && !value.reasons.length
      && !locations?.some(location => !location.mapped);
    if (value.status === 'partial') return mapped && value.reasons.length > 0;
    if (mapped || !value.reasons.length) return false;
    return value.status !== 'unavailable' || value.reasons.includes('gazetteer_unavailable');
  }

  function summarizeLocationAssessments(records) {
    const summary = { attempted: 0, mapped: 0, partial: 0, unresolved: 0, unavailable: 0, truncated: 0 };
    for (const { locationAssessment } of records) {
      if (!locationAssessment) continue;
      summary.attempted++;
      summary[locationAssessment.status]++;
      if (locationAssessment.truncated) summary.truncated++;
    }
    return summary.attempted ? summary : undefined;
  }

  function validLocationAssessmentSummary(value, count, records) {
    if (value === undefined) return true;
    if (!isObject(value) || Object.keys(value).length !== LOCATION_TOTALS.length
        || !LOCATION_TOTALS.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= count)
        || value.mapped + value.partial + value.unresolved + value.unavailable !== value.attempted
        || value.truncated > value.attempted) return false;
    if (!records) return true;
    const actual = summarizeLocationAssessments(records);
    return LOCATION_TOTALS.every(key => value[key] === (actual?.[key] ?? 0));
  }

  function position(value) {
    return Array.isArray(value) && (value.length === 2 || value.length === 3)
      && listOf(value, 2, Number.isFinite) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
  }

  const line = value => listOf(value, 2, position);
  function ring(value) {
    if (!listOf(value, 4, position)) return false;
    const first = value[0];
    const last = value[value.length - 1];
    return first.length === last.length && first.every((coordinate, i) => coordinate === last[i]);
  }
  const polygon = value => listOf(value, 1, ring);
  const geometryValidators = new Map([
    ['Point', position],
    ['MultiPoint', value => listOf(value, 1, position)],
    ['LineString', line],
    ['MultiLineString', value => listOf(value, 1, line)],
    ['Polygon', polygon],
    ['MultiPolygon', value => listOf(value, 1, polygon)]
  ]);

  function validGeometry(geometry) {
    if (!isObject(geometry) || Object.hasOwn(geometry, 'crs')) return false;
    return Boolean(geometryValidators.get(geometry.type)?.(geometry.coordinates));
  }

  function validLocationGeometry(geometry, kind) {
    return LOCATION_GEOMETRY_TYPES.get(kind)?.includes(geometry?.type) === true && validGeometry(geometry);
  }

  function validAccuracy(accuracy) {
    return accuracy === 'official' || accuracy === 'derived';
  }

  function validMap(value, recordsById, count) {
    if (!isObject(value) || value.type !== 'FeatureCollection' || Object.hasOwn(value, 'crs')
        || !Array.isArray(value.features) || value.features.length !== count) return false;
    const seen = new Map();
    const official = new Set();
    for (const feature of value.features) {
      if (!isObject(feature) || feature.type !== 'Feature' || Object.hasOwn(feature, 'crs')
          || !isObject(feature.properties)) return false;
      const { recordId, accuracy, label, locationIndex } = feature.properties;
      const record = recordsById.get(recordId);
      if (!record) return false;
      const indices = seen.get(recordId) || new Set();
      if (indices.has(locationIndex)) return false;
      if (Object.hasOwn(feature.properties, 'locationIndex')) {
        if (!Number.isInteger(locationIndex) || locationIndex < 0 || accuracy !== 'derived') return false;
        const location = record.locations?.[locationIndex];
        if (!location?.mapped || !validLocationGeometry(feature.geometry, location.kind)) return false;
        if (!validLocationText(label) || (label !== location.label && !label.startsWith(`${location.label} — `))) return false;
      } else {
        if (!validAccuracy(accuracy) || !validGeometry(feature.geometry)) return false;
        if (record.locations?.length && (accuracy !== 'official' || !record.locationAssessment?.sources.includes('official'))) return false;
        if (accuracy === 'official') official.add(recordId);
      }
      indices.add(locationIndex);
      if (indices.size > MAX_LOCATIONS_PER_RECORD) return false;
      seen.set(recordId, indices);
    }
    for (const [id, record] of recordsById) {
      if (record.locations?.some(({ mapped }, i) => mapped && !seen.get(id)?.has(i))) return false;
      const assessment = record.locationAssessment;
      if (assessment && (assessment.sources.includes('official') !== official.has(id)
          || (assessment.status === 'mapped' || assessment.status === 'partial') !== Boolean(seen.get(id)?.size))) return false;
    }
    return true;
  }

  function validTimestamp(value, canonical = false) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return false;
    const iso = new Date(time).toISOString();
    return value === iso || (!canonical && value === iso.replace('.000Z', 'Z'));
  }

  function validRefreshFailure(failure, generatedAt) {
    return failure === undefined || Boolean(failure
      && validTimestamp(failure.attemptedAt, true) && validTimestamp(failure.expiresAt, true)
      && typeof failure.reason === 'string' && failure.reason.length > 0 && failure.reason.length <= 240
      && failure.reason === failure.reason.replace(/\s+/gu, ' ').trim()
      && !/[<>\p{Cc}\p{Cf}\p{Cs}]/u.test(failure.reason)
      && Date.parse(failure.attemptedAt) >= Date.parse(generatedAt)
      && Date.parse(failure.attemptedAt) < Date.parse(failure.expiresAt)
      && Date.parse(failure.expiresAt) === Date.parse(generatedAt) + MAX_FALLBACK_AGE);
  }

  function checkManifest(manifest, key) {
    const coverage = manifest?.coverage;
    if (manifest?.schemaVersion !== SCHEMA_VERSION || manifest.city !== key
        || !validTimestamp(manifest.generatedAt)
        || !Array.isArray(manifest.sources) || !manifest.sources.length
        || !manifest.sources.every(source => isSourceUrl(source))
        || typeof coverage?.complete !== 'boolean'
        || !Array.isArray(coverage.bodies) || !Array.isArray(coverage.warnings)
        || !validCoverageScope(coverage.scope)
        || !coverage.bodies.every(validText) || !coverage.warnings.every(validText)
        || !validDay(coverage.from) || !validDay(coverage.to)
        || (coverage.from && coverage.to && coverage.from > coverage.to)
        || !validRefreshFailure(manifest.refreshFailure, manifest.generatedAt)
        || !validLocationRevision(manifest.locationRevision)
        || !validAsset(manifest.records, key, 'records') || !manifest.records.count
        || !validAsset(manifest.map, key, 'map', manifest.records.count * MAX_LOCATIONS_PER_RECORD)
        || !validLocationAssessmentSummary(manifest.locationAssessment, manifest.records.count)) throw invalid();
    return manifest;
  }

  async function readBytes(stream, maxBytes) {
    if (!stream) throw invalid();
    const reader = stream.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) {
          await reader.cancel();
          throw invalid();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  function decodeJson(bytes) {
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (_) {
      throw invalid();
    }
  }

  async function readAsset(response, asset) {
    if (response.status === 404) {
      throw error('RIS_SNAPSHOT_ASSET_MISSING', 'Der Ratsdatenstand wurde während des Abrufs aktualisiert.');
    }
    if (response.ok && !globalThis.crypto?.subtle) {
      throw error('RIS_SECURE_CONTEXT_REQUIRED', 'Bitte die Werkbank über HTTPS oder localhost öffnen, damit der Ratsdatenstand geprüft werden kann.');
    }
    try {
      if (!response.ok) throw invalid();
      const payload = await readBytes(response.body, MAX_BYTES);
      // Pages serves .gz as binary; an HTTP server may decompress it in transit.
      const bytes = payload[0] === 0x1f && payload[1] === 0x8b
        ? await readBytes(new Blob([payload]).stream().pipeThrough(new DecompressionStream('gzip')), asset.bytes)
        : payload;
      if (bytes.byteLength !== asset.bytes) throw invalid();
      const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
      const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
      if (hex !== asset.sha256) throw invalid();
      return decodeJson(bytes);
    } catch (_) {
      throw invalid();
    }
  }

  function fold(value) {
    return String(value || '').toLowerCase().replace(/ß/g, 'ss')
      .normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  function snapshotStatus(manifest, now = new Date()) {
    const failure = manifest.refreshFailure;
    const generated = Date.parse(manifest.generatedAt);
    const staleAt = generated + MAX_AGE + 1;
    const expiresAt = generated + MAX_FALLBACK_AGE;
    const stale = now.getTime() >= staleAt;
    const expired = now.getTime() >= expiresAt;
    const warnings = [...(manifest.coverage.warnings || [])];
    if (failure) warnings.push(`${failure.reason} Letzter Versuch am ${failure.attemptedAt.slice(0, 10)}.`);
    if (stale) warnings.push('Der veröffentlichte Datenstand ist älter als acht Tage.');
    return {
      complete: manifest.coverage.complete && !stale && !failure,
      stale, expired, warnings, nextCheckAt: stale ? expiresAt : staleAt
    };
  }

  function availableStatus(manifest, now) {
    const status = snapshotStatus(manifest, now);
    if (status.expired) throw error('RIS_SNAPSHOT_EXPIRED',
      'Der letzte geprüfte Ratsdatenstand ist abgelaufen. Bitte das amtliche Portal öffnen.');
    return status;
  }

  function referenceSnapshot(manifest, { complete, stale, warnings }) {
    return {
      city: manifest.city, generatedAt: manifest.generatedAt, sha256: manifest.records.sha256,
      mapSha256: manifest.map.sha256, complete, stale, warnings
    };
  }

  function attachSnapshot(record, snapshot) {
    return {
      ...record,
      ...(record.locations ? { locations: record.locations.map(location => ({ ...location, evidence: { ...location.evidence } })) } : {}),
      ...(record.locationAssessment ? { locationAssessment: {
        ...record.locationAssessment, sources: [...record.locationAssessment.sources], reasons: [...record.locationAssessment.reasons]
      } } : {}),
      snapshot,
      aiGating: { allowed: false, reason: 'Der veröffentlichte Katalog ergänzt die manuelle Recherche.' }
    };
  }

  function searchSnapshot({ manifest, records }, params, now = new Date()) {
    const status = availableStatus(manifest, now);
    const city = params.city || manifest.city;
    const terms = [...new Set((params.searchTerms || []).map(fold))]
      .filter(term => term.length >= 3 && term !== fold(city)).slice(0, 12);
    const matched = [];
    const byId = new Map(records.map(record => [record.id, record]));
    const children = new Map();
    for (const record of records) {
      if (record.relatedTo) {
        const family = children.get(record.relatedTo) || [];
        family.push(record);
        children.set(record.relatedTo, family);
      }
      const title = ` ${fold(record.title)} `;
      const number = ` ${fold(record.number)} `;
      const locations = record.locations?.map(location => ` ${fold(location.label)} `) || [];
      let score = 0;
      let locationScore = 0;
      for (const term of terms) {
        const phrase = ` ${term} `;
        if (number === phrase) score += 100 + term.length;
        else if (number.includes(phrase) || title.includes(phrase)) score += 10 + term.length;
        else if (locations.some(location => location.includes(phrase))) locationScore += 1 + term.length;
      }
      if (score || locationScore) matched.push({ record, score, locationScore });
    }
    matched.sort((a, b) => b.score - a.score || b.locationScore - a.locationScore
      || (b.record.date || '').localeCompare(a.record.date || ''));
    const selected = new Map();
    const limit = Number.isInteger(params.maxResults) ? Math.max(0, Math.min(params.maxResults, 30)) : 15;
    for (const { record } of matched) {
      if (selected.size >= limit) break;
      const parent = byId.get(record.relatedTo) || record;
      for (const entry of [record, parent, ...(children.get(parent.id) || [])]) {
        if (selected.size < limit) selected.set(entry.id, entry);
      }
    }
    const complete = terms.length > 0 && status.complete;
    const searchStatus = matched.length
      ? (complete ? 'results-found' : 'partial-results')
      : (complete ? 'searched-no-results' : 'incomplete');
    const snapshot = referenceSnapshot(manifest, status);
    const warnings = terms.length ? status.warnings
      : [...status.warnings, 'Bitte einen Ort, ein Thema oder eine Drucksachennummer eingeben.'];
    return {
      references: [...selected.values()].map(record => attachSnapshot(record, snapshot)),
      meta: {
        city, supported: true, searchTerms: params.searchTerms, searchedAt: now.toISOString(),
        totalFound: matched.length, searchStatus, stale: status.stale,
        providerKey: 'ris-snapshot', sourceType: 'ris-snapshot', sourceUrl: manifest.sources[0],
        sourceFingerprint: manifest.records.sha256, generatedAt: manifest.generatedAt,
        coverage: manifest.coverage, warnings,
        ...(manifest.refreshFailure ? { refreshFailure: manifest.refreshFailure } : {}),
        // A published selection has a bounded scope and cannot certify full live research.
        truncated: !complete
      }
    };
  }

  function createCatalogue({ base, fetch: fetchImpl = globalThis.fetch, now = () => new Date() }) {
    const directory = new URL('data/ris/', base);
    const manifests = new Map();
    const payloads = new Map();
    const get = (file, cache) => fetchImpl(new URL(file, directory).href, {
      cache, credentials: 'same-origin', redirect: 'error'
    });

    function loadManifest(city, revalidate = false) {
      const key = cityKey(city);
      if (!key) return Promise.reject(error('RIS_SNAPSHOT_UNAVAILABLE', 'Für diese Stadt ist kein Ratsdatenstand verfügbar.'));
      const cached = manifests.get(key);
      const checkedAt = now().getTime();
      if (cached && (!cached.settled || (!revalidate && checkedAt - cached.checkedAt < MANIFEST_TTL))) return cached.promise;
      if (manifests.size >= 4 && !cached) manifests.delete(manifests.keys().next().value);
      const entry = { checkedAt };
      entry.promise = get(`${key}.json`, 'no-cache').then(async response => {
        if (response.status === 404) {
          throw error('RIS_SNAPSHOT_UNAVAILABLE', 'Für diese Stadt ist kein Ratsdatenstand verfügbar.');
        }
        if (!response.ok) throw invalid();
        entry.manifest = checkManifest(decodeJson(await readBytes(response.body, 256 * 1024)), key);
        return entry.manifest;
      }).finally(() => { entry.settled = true; });
      manifests.set(key, entry);
      return entry.promise;
    }

    function loadAsset(asset) {
      const key = JSON.stringify([asset.path, asset.sha256, asset.bytes, asset.count]);
      const cached = payloads.get(key);
      if (cached) return cached;
      if (payloads.size >= 4) payloads.delete(payloads.keys().next().value);
      const pending = get(asset.path, 'force-cache').then(response => readAsset(response, asset));
      payloads.set(key, pending);
      pending.catch(() => { if (payloads.get(key) === pending) payloads.delete(key); });
      return pending;
    }

    async function readBundle(city, withMap, revalidate) {
      const manifest = await loadManifest(city, revalidate);
      availableStatus(manifest, now());
      const records = await loadAsset(manifest.records);
      if (!Array.isArray(records) || records.length !== manifest.records.count
          || records.some(record => !validText(record?.id) || !validText(record.title) || !validText(record.type)
            || !validText(record.source) || !validDay(record.date) || !isSourceUrl(record.url, manifest.sources)
            || !validLocations(record.locations) || !validLocationAssessment(record.locationAssessment, record.locations))
          || !validLocationAssessmentSummary(manifest.locationAssessment, records.length, records)) {
        throw invalid();
      }
      const byId = new Map(records.map(record => [record.id, record]));
      if (byId.size !== records.length) throw invalid();
      if (!withMap) return { manifest, records };
      const features = await loadAsset(manifest.map);
      if (!validMap(features, byId, manifest.map.count)) throw invalid();
      const snapshot = referenceSnapshot(manifest, availableStatus(manifest, now()));
      return { manifest, records: records.map(record => attachSnapshot(record, snapshot)), features };
    }

    async function load(city, withMap = false, revalidate = false) {
      try {
        return await readBundle(city, withMap, revalidate);
      } catch (error) {
        if (error.code !== 'RIS_SNAPSHOT_ASSET_MISSING') throw error;
        return readBundle(city, withMap, true);
      }
    }

    return {
      cityKey,
      snapshotStatus: manifest => snapshotStatus(manifest, now()),
      async loadManifest(city) {
        const manifest = await loadManifest(city);
        availableStatus(manifest, now());
        return manifest;
      },
      hasManifest(city) {
        const manifest = manifests.get(cityKey(city))?.manifest;
        return Boolean(manifest && !snapshotStatus(manifest, now()).expired);
      },
      async search(params) {
        return searchSnapshot(await load(params.city), params, now());
      },
      async resolveReferences(city, references) {
        const { manifest, records } = await load(city, false, true);
        const snapshot = referenceSnapshot(manifest, availableStatus(manifest, now()));
        const byId = new Map(records.map(record => [record.id, record]));
        return references.map(reference => {
          const prior = reference.snapshot;
          if (!prior) return reference;
          const record = byId.get(reference.id);
          if (!record || prior.city !== snapshot.city || prior.sha256 !== snapshot.sha256
              || (prior.mapSha256 !== undefined && prior.mapSha256 !== snapshot.mapSha256)
              || !isSourceUrl(reference.url, manifest.sources) || new URL(reference.url).href !== new URL(record.url).href) {
            throw error('RIS_SNAPSHOT_REFERENCE_MISMATCH',
              'Der ausgewählte Ratsvorgang gehört nicht zum aktuellen geprüften Datenstand. Bitte die Recherche erneut öffnen.');
          }
          return attachSnapshot(record, snapshot);
        });
      },
      loadMap: (city, options) => load(city, true, options?.revalidate === true)
    };
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = {
      cityKey, createCatalogue, searchSnapshot, snapshotStatus,
      snapshotFormat: {
        MAX_LOCATIONS_PER_RECORD, validLocations, validGeometry, validLocationGeometry, validAccuracy, validMap, validLocationRevision,
        validCoverageScope, validLocationAssessment, validLocationAssessmentSummary, summarizeLocationAssessments
      }
    };
  }
  if (typeof window === 'object') {
    const UA = (window.UA = window.UA || {});
    UA.RisCatalogue = createCatalogue({ base: document.baseURI });
  }
})();
