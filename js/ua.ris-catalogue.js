(() => {
  'use strict';

  const partitions = () => typeof module === 'object' && module.exports ? require('./ua.ris-partitions') : window.UA.RisPartitions;
  const spatialGrid = () => typeof module === 'object' && module.exports ? require('./ua.spatial-grid') : window.UA.SpatialGrid;
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

  function validLocations(locations, maximum = MAX_LOCATIONS_PER_RECORD) {
    return locations === undefined || (Array.isArray(locations) && locations.length <= maximum
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

  function validMap(value, recordsById, count, maximum = MAX_LOCATIONS_PER_RECORD) {
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
      if (indices.size > maximum) return false;
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
    if (manifest?.schemaVersion === 2) {
      partitions().manifest(manifest,key);
      const hash='a'.repeat(64);
      checkManifest({...manifest,schemaVersion:1,provenance:undefined,locationAssessment:undefined,records:{path:`${key}.${hash}.records.json.gz`,sha256:hash,bytes:1,count:1},map:{path:`${key}.${hash}.map.json.gz`,sha256:hash,bytes:1,count:0}},key);
      if(!validLocationAssessmentSummary(manifest.locationAssessment,manifest.recordCount))throw invalid();
      return manifest;
    }
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
    if (manifest.provenance !== undefined && !partitions()?.validProvenance(manifest.provenance, manifest.generatedAt, manifest.records.count, coverage)) throw invalid('Invalid RIS provenance');
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
      const payload = await readBytes(response.body, Math.min(MAX_BYTES, asset.bytes + 65536));
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
      city: manifest.city, generatedAt: manifest.generatedAt, sha256: manifest.generation || manifest.records.sha256,
      mapSha256: manifest.generation || manifest.map.sha256, complete, stale, warnings
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
        sourceFingerprint: manifest.generation || manifest.records.sha256, generatedAt: manifest.generatedAt,
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
        if(entry.manifest.schemaVersion===2){
          if(!globalThis.crypto?.subtle)throw error('RIS_SECURE_CONTEXT_REQUIRED','Bitte HTTPS oder localhost verwenden.');
          const digest=new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(entry.manifest.roots))));
          if(Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('')!==entry.manifest.generation)throw invalid();
        }
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

    const partitionReaders = new Map();
    async function partition(city, options = {}) {
      const manifest = await loadManifest(city, options.revalidate === true);
      availableStatus(manifest, now());
      if (options.snapshot && (options.snapshot.city && options.snapshot.city !== manifest.city || (options.snapshot.generation || options.snapshot.records?.sha256 || options.snapshot.sha256) !== (manifest.generation || manifest.records?.sha256))) throw error('RIS_SNAPSHOT_REFERENCE_MISMATCH', 'Der Ratsdatenstand hat sich geändert. Bitte erneut öffnen.');
      if (manifest.schemaVersion !== 2) return null;
      let reader = partitionReaders.get(manifest.generation);
      if (!reader) {
        reader = partitions().createReader({
          manifest,
          load: asset => get(asset.path, 'force-cache').then(response => readAsset(response, asset))
        });
        if (partitionReaders.size >= 2) partitionReaders.delete(partitionReaders.keys().next().value);
        partitionReaders.set(manifest.generation, reader);
      }
      return {
        manifest,
        reader
      };
    }
    function validPartitionRecord(record, manifest) {
      if (!record || !validText(record.id) || !validText(record.title) || !validText(record.type) || !validText(record.source) || !validDay(record.date) || !isSourceUrl(record.url, manifest.sources) || !Number.isSafeInteger(record.locationCount) || record.locationCount < 0) throw invalid();
      return record;
    }
    async function recordFrom(part, id) {
      const record = await part.reader.get('records', id);
      if (!record) return null;
      validPartitionRecord(record, part.manifest);
      if (record.id !== id) throw invalid();
      const locations = await part.reader.page('locations', id, 0);
      if (locations.total !== record.locationCount) throw invalid();
      for (const {
        id: locationId,
        geometryId,
        ...location
      } of locations.items) if (!validLocations([location]) || !/^location:[a-f0-9]{64}$/.test(locationId) || geometryId !== undefined && !/^geometry:[a-f0-9]{64}$/.test(geometryId)) throw invalid();
      const geometry = await part.reader.page('links', `record:${id}`, 0);
      const {
        hasLocations,
        ...publicRecord
      } = record;
      return attachSnapshot({
        ...publicRecord,
        geometryIds: geometry.items,
        geometryNextPage: geometry.nextPage,
        ...(record.locationCount ? {
          locations: locations.items,
          locationsNextPage: locations.nextPage
        } : {})
      }, referenceSnapshot(part.manifest, availableStatus(part.manifest, now())));
    }
    async function loadRecord(city, id, options = {}) {
      const part = await partition(city, options);
      if (!part) {
        const bundle = await load(city);
        return bundle.records.find(r => r.id === id) || null;
      }
      return recordFrom(part, id);
    }
    async function loadRecordLocations(city, id, page = 0, options = {}) {
      const part = await partition(city, options);
      if (!part) {
        const record = await loadRecord(city, id);
        return {
          locations: record?.locations || [],
          total: record?.locations?.length || 0,
          start: 0,
          page: 0,
          nextPage: null,
          complete: true,
          missing: []
        };
      }
      const result = await part.reader.page('locations', id, page);
      const record = await part.reader.get('records', id);
      if (!record || record.id !== id || result.total !== record.locationCount) throw invalid();
      for (const {
        id: locationId,
        geometryId,
        ...location
      } of result.items) if (!validLocations([location]) || !/^location:[a-f0-9]{64}$/.test(locationId) || geometryId !== undefined && !/^geometry:[a-f0-9]{64}$/.test(geometryId)) throw invalid();
      const {
        items,
        ...meta
      } = result;
      return {
        ...meta,
        locations: items
      };
    }
    async function relationPage(part, id, page = 0) {
      const membership = await part.reader.get('relations', `member:${id}`);
      if (!membership) return {
        items: [],
        total: 0,
        start: 0,
        page,
        nextPage: null,
        complete: true,
        missing: []
      };
      const result = await part.reader.page('relations', membership.component, page);
      if (membership.position >= result.total || membership.position >= result.start && membership.position < result.start + result.items.length && result.items[membership.position - result.start] !== id) throw invalid();
      return {
        ...result,
        start: result.start - (membership.position < result.start ? 1 : 0),
        total: Math.max(0, result.total - 1),
        items: result.items.filter(member => member !== id)
      };
    }
    async function loadRecordGeometries(city, id, page = 0, options = {}) {
      const part = await partition(city, options);
      if (!part) return {
        geometryIds: [],
        total: 0,
        start: 0,
        page: 0,
        nextPage: null,
        complete: true,
        missing: []
      };
      const {
        items,
        ...metadata
      } = await part.reader.page('links', `record:${id}`, page);
      if (!items.every(value => /^geometry:[a-f0-9]{64}$/.test(value))) throw invalid();
      return {
        ...metadata,
        geometryIds: items
      };
    }
    async function loadRelatedRecords(city, id, page = 0, options = {}) {
      const part = await partition(city, options);
      if (!part) {
        const {
          records
        } = await load(city);
        const current = records.find(r => r.id === id);
        const related = records.filter(r => r.relatedTo === id || r.id === current?.relatedTo);
        return {
          records: related,
          total: related.length,
          start: 0,
          page: 0,
          nextPage: null,
          complete: true,
          missing: []
        };
      }
      const {
        items,
        ...meta
      } = await relationPage(part, id, page);
      const records = await Promise.all(items.map(id => recordFrom(part, id)));
      return {
        ...meta,
        records: records.filter(Boolean),
        complete: records.every(Boolean),
        missing: items.filter((_, i) => !records[i])
      };
    }
    async function loadFeatureRecords(city, id, page = 0, options = {}) {
      const part = await partition(city, options);
      if (!part) throw invalid();
      const {
        items: links,
        ...meta
      } = await part.reader.page('links', id, page);
      const ids = [...new Set(links.map(l => l.recordId))],
        records = await Promise.all(ids.map(id => recordFrom(part, id)));
      return {
        ...meta,
        links,
        records: records.filter(Boolean),
        complete: records.every(Boolean),
        missing: ids.filter((_, i) => !records[i])
      };
    }
    function checkedFeature(feature, id) {
      if (!feature || !validGeometry(feature.geometry) || feature.properties?.geometryId !== id
          || !['official', 'derived', 'mixed'].includes(feature.properties.accuracy)
          || !Number.isSafeInteger(feature.properties.recordCount) || feature.properties.recordCount < 1
          || JSON.stringify(feature.bounds) !== JSON.stringify(spatialGrid().geometryBounds(feature.geometry))) throw invalid();
      return feature;
    }
    async function geometryFrom(part, id) {
      const value = await part.reader.get('geometry', id);
      if (!value) return null;
      if (part.manifest.spatialFormat === partitions().SPATIAL_FORMAT) {
        if (!partitions().spatialLocator(value, id, part.manifest.city)) throw invalid();
        const found = await part.reader.locate('spatial', value.spatialKey);
        if (!found || !['path', 'sha256', 'bytes', 'count', 'kind', 'featureCount'].every(field => found.reference[field] === value.asset[field])
            || JSON.stringify(found.reference.bounds) !== JSON.stringify(value.asset.bounds)) throw invalid();
        return checkedFeature(found.value, id);
      }
      return checkedFeature(value, id);
    }
    async function loadGeometry(city, id, options = {}) {
      const part = await partition(city, options);
      if (!part) return null;
      return geometryFrom(part, id);
    }
    function requestedBounds(value) {
      if (!value) return [-180, -85, 180, 85];
      if (typeof value.getWest === 'function') return [value.getWest(), value.getSouth(), value.getEast(), value.getNorth()];
      if (Array.isArray(value)) return value;
      return [value.west, value.south, value.east, value.north];
    }
    async function overviewMap(part, bounds) {
      part = {
        ...part,
        reader: part.reader.scoped({
          maxBytes: 1024 * 1024,
          maxAssets: 128
        })
      };
      const grid = spatialGrid();
      let zoom = 0,
        tiles = [];
      for (const candidate of [8, 6, 4, 0].filter(z => z <= part.manifest.overviewZoom)) {
        try {
          tiles = grid.tilesForBounds({
            west: bounds[0],
            south: bounds[1],
            east: bounds[2],
            north: bounds[3]
          }, candidate, {
            maxTiles: 64
          });
          zoom = candidate;
          break;
        } catch (e) {
          if (e.code !== 'SPATIAL_TILE_LIMIT') throw e;
        }
      }
      const features = [];
      for (const [x, y] of tiles) {
        const cell = await part.reader.get('spatial', `overview:${zoom}/${x}/${y}`);
        if (!cell) continue;
        const [w, s, e, n] = cell.bounds;
        features.push({
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]]
          },
          bounds: cell.bounds,
          properties: {
            overview: true,
            geometryId: `overview:${zoom}/${x}/${y}`,
            count: cell.count,
            recordCount: cell.count,
            geometryCount: cell.geometryCount,
            label: 'Ratsvorgänge im Rasterbereich'
          }
        });
      }
      return {
        manifest: part.manifest,
        partitioned: true,
        features: {
          type: 'FeatureCollection',
          features
        },
        coverage: {
          complete: false,
          missing: [],
          truncated: true
        },
        overview: true,
        recordCount: part.manifest.mappedRecordCount
      };
    }
    async function loadPartitionMap(city, options = {}) {
      const originalPart = await partition(city, options);
      if (!originalPart) return load(city, true, false);
      const part = {
        ...originalPart,
        reader: originalPart.reader.scoped()
      };
      try {
        const grid = spatialGrid(),
          bounds = requestedBounds(options.bounds),
          budget = Math.min(2000, Math.max(1, options.maxFeatures || 1000));
        if (part.manifest.spatialFormat === partitions().SPATIAL_FORMAT) {
          const extent = grid.tileRange({west: bounds[0], south: bounds[1], east: bounds[2], north: bounds[3]}, 12);
          if (extent?.count > 64) return overviewMap(originalPart, bounds);
          const {features, truncated} = await part.reader.spatial(bounds, budget);
          if (truncated) return overviewMap(originalPart, bounds);
          for (const feature of features) checkedFeature(feature, feature.properties.geometryId);
          return {
            manifest: part.manifest, partitioned: true, features: {type: 'FeatureCollection', features},
            coverage: {complete: true, missing: [], truncated: false}, overview: false,
            recordCount: part.manifest.mappedRecordCount
          };
        }
        let tiles;
        try {
          tiles = grid.tilesForBounds({
            west: bounds[0],
            south: bounds[1],
            east: bounds[2],
            north: bounds[3]
          }, 12, {
            maxTiles: 64
          }).map(t => typeof t === 'string' ? t : `${t[0]}/${t[1]}`);
        } catch (e) {
          if (e.code !== 'SPATIAL_TILE_LIMIT') throw e;
          return overviewMap(originalPart, bounds);
        }
        const ids = new Set(),
          features = [];
        let truncated = false,
          requests = 0;
        outer: for (const tile of [...tiles, 'global']) {
          let page = 0;
          do {
            if (++requests > 128) {
              truncated = true;
              break outer;
            }
            const result = await part.reader.page('spatial', tile, page);
            for (const id of result.items) {
              if (ids.has(id)) continue;
              ids.add(id);
              const feature = await geometryFrom(part, id);
              if (!feature) throw invalid();
              if (grid.intersectsBounds(feature.bounds, bounds)) {
                if (features.length >= budget) {
                  truncated = true;
                  break outer;
                }
                features.push(feature);
              }
            }
            page = result.nextPage;
          } while (page !== null);
        }
        if (truncated) return overviewMap(originalPart, bounds);
        return {
          manifest: part.manifest,
          partitioned: true,
          features: {
            type: 'FeatureCollection',
            features
          },
          coverage: {
            complete: true,
            missing: [],
            truncated: false
          },
          overview: false,
          recordCount: part.manifest.mappedRecordCount
        };
      } catch (failure) {
        if (failure.code === 'RIS_QUERY_BUDGET') return overviewMap(originalPart, requestedBounds(options.bounds));
        throw failure;
      }
    }
    async function cursorDigest(value) {
      const bytes = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
      return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }
    function invalidCursor() {
      return error('RIS_SNAPSHOT_CURSOR_INVALID', 'Die Suchfortsetzung ist ungültig. Bitte die Suche erneut starten.');
    }
    async function encodeCursor(state) {
      const raw = JSON.stringify(state);
      const encoded = btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return `ris2.${encoded}.${await cursorDigest(raw)}`;
    }
    async function decodeCursor(token, query, manifest, terms) {
      if (typeof token !== 'string' || token.length > 2048 || !/^ris2\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token)) throw invalidCursor();
      const [, encoded, checksum] = token.split('.');
      let raw, state;
      try {
        raw = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
        state = JSON.parse(raw);
      } catch (_) {
        throw invalidCursor();
      }
      if (checksum !== (await cursorDigest(raw)) || !state || Object.keys(state).length !== 8 || state.v !== 1 || state.q !== query || !Number.isSafeInteger(state.t) || state.t < 0 || state.t >= terms.length || !Number.isSafeInteger(state.p) || state.p < 0 || !Number.isSafeInteger(state.o) || state.o < 0 || state.o > 64 || state.l !== null && (!Number.isSafeInteger(state.l) || state.l < 1) || typeof state.f !== 'boolean') throw invalidCursor();
      if (state.g !== manifest.generation) throw error('RIS_SNAPSHOT_REFERENCE_MISMATCH', 'Der Ratsdatenstand hat sich geändert. Bitte erneut suchen.');
      return state;
    }
    async function searchPartition(originalPart, params) {
      const terms = [...new Set((params.searchTerms || []).map(term => fold(term)))].filter(term => term.length >= 3 && term !== fold(params.city)).slice(0, 12);
      const limit = Number.isInteger(params.maxResults) ? Math.max(0, Math.min(30, params.maxResults)) : 15;
      const query = await cursorDigest(JSON.stringify([originalPart.manifest.city, terms, limit]));
      if (params.page != null && !params.snapshot) throw invalidCursor();
      const state = params.page != null ? await decodeCursor(params.page, query, originalPart.manifest, terms) : {
        v: 1,
        g: originalPart.manifest.generation,
        q: query,
        t: 0,
        p: 0,
        o: 0,
        l: null,
        f: false
      };
      const part = {
        ...originalPart,
        reader: originalPart.reader.scoped({
          maxBytes: 8 * 1024 * 1024,
          maxAssets: 256
        })
      };
      const records = [],
        plans = new Map(),
        matchedLocations = new Map(),
        seenOnPage = new Set();
      let scanned = 0,
        locationReads = 0,
        limited = false,
        currentPosting = null;
      const nextTerm = () => {
        state.t++;
        state.p = 0;
        state.o = 0;
        state.l = null;
        currentPosting = null;
      };
      const locationMatch = (locations, phrase) => locations.some(location => ` ${fold(location.label)} `.includes(phrase));
      try {
        while (state.t < terms.length && records.length < limit) {
          if (scanned >= 256 || locationReads >= 128) {
            limited = true;
            break;
          }
          let chosen = plans.get(state.t);
          if (!chosen) {
            const postings = await Promise.all(terms[state.t].split(' ').slice(0, 8).map(async word => ({
              word,
              result: await part.reader.page('search', word, 0)
            })));
            postings.sort((a, b) => a.result.total - b.result.total || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
            chosen = postings[0];
            plans.set(state.t, chosen);
          }
          if (!chosen?.result.total) {
            nextTerm();
            continue;
          }
          currentPosting = state.p === 0 ? chosen.result : await part.reader.page('search', chosen.word, state.p);
          if (state.o > currentPosting.items.length) throw invalidCursor();
          if (state.o === currentPosting.items.length) {
            if (currentPosting.nextPage === null) nextTerm();else {
              state.p = currentPosting.nextPage;
              state.o = 0;
              state.l = null;
            }
            continue;
          }
          const id = currentPosting.items[state.o];
          const record = await recordFrom(part, id);
          if (!record) throw invalid();
          const phrase = ` ${terms[state.t]} `;
          let matched = ` ${fold(record.title)} `.includes(phrase) || ` ${fold(record.number)} `.includes(phrase) || locationMatch(record.locations || [], phrase);
          let locationPage = state.l ?? record.locationsNextPage;
          while (!matched && locationPage != null) {
            state.l = locationPage;
            if (locationReads >= 128) {
              limited = true;
              break;
            }
            const result = await part.reader.page('locations', id, locationPage);
            if (result.total !== record.locationCount) throw invalid();
            for (const {
              id: locationId,
              geometryId,
              ...location
            } of result.items) {
              if (!validLocations([location]) || !/^location:[a-f0-9]{64}$/.test(locationId) || geometryId !== undefined && !/^geometry:[a-f0-9]{64}$/.test(geometryId)) throw invalid();
            }
            locationReads++;
            matched = locationMatch(result.items, phrase);
            if (matched) matchedLocations.set(id, result.items.find(location => locationMatch([location], phrase)));
            locationPage = result.nextPage;
            state.l = locationPage;
          }
          if (limited) break;
          state.o++;
          state.l = null;
          scanned++;
          if (matched) {
            if (!seenOnPage.has(record.id)) {
              records.push(record);
              seenOnPage.add(record.id);
            }
            state.f = true;
          }
        }
      } catch (failure) {
        if (failure.code !== 'RIS_QUERY_BUDGET') throw failure;
        limited = true;
      }
      // Normalize a completed posting so an exact full final page needs no empty follow-up.
      if (!limited && currentPosting && state.o === currentPosting.items.length) {
        if (currentPosting.nextPage === null) nextTerm();else {
          state.p = currentPosting.nextPage;
          state.o = 0;
        }
      }
      const hasMore = limit > 0 && state.t < terms.length;
      const result = searchSnapshot({
        manifest: part.manifest,
        records: records.map(record => matchedLocations.has(record.id) ? {
          ...record,
          locations: [...(record.locations || []), matchedLocations.get(record.id)]
        } : record)
      }, params, now());
      const byId = new Map(records.map(record => [record.id, record]));
      const selected = new Map(result.references.map(record => [record.id, byId.get(record.id) || record]));
      let relatedIncomplete = false;
      try {
        for (const record of result.references) {
          if (selected.size >= limit) break;
          const family = await relationPage(part, record.id, 0);
          if (family.nextPage !== null || family.total > limit - selected.size) relatedIncomplete = true;
          for (const id of family.items) {
            if (selected.size >= limit) break;
            if (selected.has(id)) continue;
            const relative = await recordFrom(part, id);
            if (relative) selected.set(id, relative);else relatedIncomplete = true;
          }
        }
      } catch (failure) {
        if (failure.code !== 'RIS_QUERY_BUDGET') throw failure;
        relatedIncomplete = true;
      }
      result.references = [...selected.values()];
      const status = availableStatus(part.manifest, now());
      const complete = terms.length > 0 && limit > 0 && status.complete && !hasMore && !limited && !relatedIncomplete;
      result.meta.searchStatus = state.f || result.references.length ? complete ? 'results-found' : 'partial-results' : complete ? 'searched-no-results' : 'incomplete';
      result.meta.truncated = !complete;
      result.meta.complete = complete;
      result.meta.missing = [];
      result.meta.nextPage = hasMore ? await encodeCursor(state) : null;
      result.meta.snapshot = referenceSnapshot(part.manifest, status);
      result.meta.totalFoundIsLowerBound = hasMore || params.page != null || limited;
      result.meta.scannedItems = scanned;
      if (hasMore) result.meta.warnings.push('Weitere Treffer sind über die nächste Suchseite erreichbar.');
      return result;
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
        const part=await partition(params.city,{snapshot:params.snapshot,revalidate:params.page!=null});
        if(!part && params.page!=null)throw invalidCursor();
        return part ? searchPartition(part,params) : searchSnapshot(await load(params.city), params, now());
      },
      async resolveReferences(city, references) {
        const part=await partition(city,{revalidate:true});
        if(part) {
          const snapshot=referenceSnapshot(part.manifest,availableStatus(part.manifest,now()));
          return Promise.all(references.map(async reference=>{
            if(!reference.snapshot)return reference;
            const record=await recordFrom(part,reference.id),prior=reference.snapshot;
            if(!record || prior.city!==snapshot.city || prior.sha256!==snapshot.sha256 || (prior.mapSha256!==undefined && prior.mapSha256!==snapshot.mapSha256) || reference.url!==record.url)throw error('RIS_SNAPSHOT_REFERENCE_MISMATCH','Der Ratsvorgang gehört nicht zum aktuellen Datenstand.');
            return record;
          }));
        }
        const { manifest, records } = await load(city, false, false);
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
      loadRecord, loadRecordLocations, loadRecordGeometries, loadRelatedRecords, loadFeatureRecords, loadGeometry,
      loadMap: loadPartitionMap
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
