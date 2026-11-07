(() => {
  'use strict';

  const SCHEMA_VERSION = 1;
  const MAX_BYTES = 16 * 1024 * 1024;
  const MAX_COUNT = 50_000;
  const MAX_AGE = 8 * 24 * 60 * 60 * 1000;
  const MAX_FALLBACK_AGE = 14 * 24 * 60 * 60 * 1000;
  const MANIFEST_TTL = 5 * 60 * 1000;

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

  function validAsset(entry, key, kind) {
    return entry && /^[a-f0-9]{64}$/.test(entry.sha256)
      && entry.path === `${key}.${entry.sha256}.${kind}.json.gz`
      && Number.isInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= MAX_BYTES
      && Number.isInteger(entry.count) && entry.count >= 0 && entry.count <= MAX_COUNT;
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
        || !coverage.bodies.every(validText) || !coverage.warnings.every(validText)
        || !validDay(coverage.from) || !validDay(coverage.to)
        || (coverage.from && coverage.to && coverage.from > coverage.to)
        || !validRefreshFailure(manifest.refreshFailure, manifest.generatedAt)
        || !validAsset(manifest.records, key, 'records') || !manifest.records.count
        || !validAsset(manifest.map, key, 'map')) throw invalid();
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
    return { city: manifest.city, generatedAt: manifest.generatedAt, sha256: manifest.records.sha256, complete, stale, warnings };
  }

  function attachSnapshot(record, snapshot) {
    return {
      ...record,
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
      const score = terms.reduce((total, term) => {
        const phrase = ` ${term} `;
        if (number === phrase) return total + 100 + term.length;
        if (number.includes(phrase) || title.includes(phrase)) return total + 10 + term.length;
        return total;
      }, 0);
      if (score > 0) matched.push({ record, score });
    }
    matched.sort((a, b) => b.score - a.score || (b.record.date || '').localeCompare(a.record.date || ''));
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
            || !validText(record.source) || !validDay(record.date) || !isSourceUrl(record.url, manifest.sources))) {
        throw invalid();
      }
      const ids = new Set(records.map(record => record.id));
      if (ids.size !== records.length) throw invalid();
      if (!withMap) return { manifest, records };
      const features = await loadAsset(manifest.map);
      if (features?.type !== 'FeatureCollection' || !Array.isArray(features.features)
          || features.features.length !== manifest.map.count
          || features.features.some(feature => !ids.has(feature?.properties?.recordId))) throw invalid();
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
          if (!reference.snapshot) return reference;
          const record = byId.get(reference.id);
          if (!record || reference.snapshot.city !== snapshot.city || reference.snapshot.sha256 !== snapshot.sha256
              || !isSourceUrl(reference.url, manifest.sources) || new URL(reference.url).href !== new URL(record.url).href) {
            throw error('RIS_SNAPSHOT_REFERENCE_MISMATCH',
              'Der ausgewählte Ratsvorgang gehört nicht zum aktuellen geprüften Datenstand. Bitte die Recherche erneut öffnen.');
          }
          return attachSnapshot(record, snapshot);
        });
      },
      loadMap: city => load(city, true)
    };
  }

  if (typeof module === 'object' && module.exports) module.exports = { cityKey, createCatalogue, searchSnapshot, snapshotStatus };
  if (typeof window === 'object') {
    const UA = (window.UA = window.UA || {});
    UA.RisCatalogue = createCatalogue({ base: document.baseURI });
  }
})();
