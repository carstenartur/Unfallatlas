'use strict';

/**
 * Optionaler HTTP-Client/Forwarder zum separaten Analysis Service
 * (Spring-Boot, siehe `analysis-service/`).
 *
 * Aufgabe in diesem PR:
 *   - Forwarden eines bereits berechneten LocationActionBrief (Node) an
 *     `POST {ANALYSIS_SERVICE_BASE_URL}/api/location-briefs` im versionierten
 *     `locationBriefIngest.v1`-Format.
 *   - Optionales Lesen gespeicherter Briefs (by location, by city, top-N).
 *
 * Leitplanken:
 *   - **Vollständig optional.**  Wenn der Service nicht aktiviert oder nicht
 *     erreichbar ist, darf nichts kaputtgehen.  Aufrufer sehen ein klares
 *     Ergebnisobjekt `{ ok, status, data, error, fallback }` und entscheiden
 *     selbst, wie reagiert wird.
 *   - **Keine harte Abhängigkeit.**  Verwendet ausschließlich Node-Builtins
 *     (`http`, `https`, `URL`) – kein zusätzliches HTTP-Lib-Paket.
 *   - **Idempotente Persistenz.**  Der Service deduplikiert intern über
 *     `locationKey + profileKey + sourceFingerprint`; mehrfaches Persistieren
 *     desselben Briefs ist sicher.
 *
 * Konfiguration (alle Env-Variablen optional):
 *   - `ANALYSIS_SERVICE_BASE_URL`    z. B. `http://localhost:8081`
 *   - `ANALYSIS_SERVICE_ENABLED`     `true|false` (Default: `true` wenn URL gesetzt)
 *   - `ANALYSIS_SERVICE_TIMEOUT_MS`  Default `4000`
 *   - `ANALYSIS_SERVICE_RETRIES`     Default `1` (zusätzlich zum ersten Versuch)
 *   - `ANALYSIS_SERVICE_RETRY_DELAY_MS`  Default `200`
 *
 * @module server/analysis-service/analysisServiceClient
 */

const http  = require('http');
const https = require('https');
const { URL } = require('url');
const { getCurrentCorrelationId } = require('../lib/correlationId.js');

const INGEST_SCHEMA_VERSION = 'locationBriefIngest.v1';

// ── Konfiguration ────────────────────────────────────────────────────────────

/**
 * Liest die aktuelle Konfiguration aus `process.env` (frisch bei jedem
 * Aufruf, damit Tests Variablen umsetzen können).
 *
 * @returns {{
 *   baseUrl: string|null,
 *   enabled: boolean,
 *   timeoutMs: number,
 *   retries: number,
 *   retryDelayMs: number
 * }}
 */
function getConfig() {
  const baseUrlRaw = (process.env.ANALYSIS_SERVICE_BASE_URL || '').trim();
  const baseUrl    = baseUrlRaw ? baseUrlRaw.replace(/\/+$/, '') : null;

  // ENABLED Default: true, sobald eine BASE_URL existiert; explizit "false"
  // schaltet den Forwarder aus, ohne dass die URL entfernt werden muss.
  const enabledRaw = (process.env.ANALYSIS_SERVICE_ENABLED || '').trim().toLowerCase();
  let enabled;
  if (enabledRaw === 'true' || enabledRaw === '1') enabled = true;
  else if (enabledRaw === 'false' || enabledRaw === '0') enabled = false;
  else enabled = Boolean(baseUrl);

  const timeoutMs = Number(process.env.ANALYSIS_SERVICE_TIMEOUT_MS);
  const retries   = Number(process.env.ANALYSIS_SERVICE_RETRIES);
  const retryDelayMs = Number(process.env.ANALYSIS_SERVICE_RETRY_DELAY_MS);

  return {
    baseUrl,
    enabled: enabled && Boolean(baseUrl),
    timeoutMs:    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 4000,
    retries:      Number.isFinite(retries)   && retries   >= 0 ? retries   : 1,
    retryDelayMs: Number.isFinite(retryDelayMs) && retryDelayMs >= 0 ? retryDelayMs : 200
  };
}

/**
 * Strukturierter Verfügbarkeits-/Statusbericht für `/api/status`.
 *
 * @returns {{
 *   enabled: boolean,
 *   configured: boolean,
 *   baseUrl: (string|null),
 *   timeoutMs: number,
 *   retries: number
 * }}
 */
function describeStatus() {
  const c = getConfig();
  return {
    enabled:    c.enabled,
    configured: Boolean(c.baseUrl),
    baseUrl:    c.baseUrl,
    timeoutMs:  c.timeoutMs,
    retries:    c.retries
  };
}

// ── HTTP-Helfer ──────────────────────────────────────────────────────────────

/**
 * Promise-Wrapper um `http(s).request` mit Timeout, JSON-Body, Retry.
 * Liefert immer ein Result-Objekt, wirft NICHT.
 *
 * @param {string} url
 * @param {{method?: string, body?: any, timeoutMs: number}} opts
 * @returns {Promise<{ok: boolean, status: number, data: any, error: (string|null)}>}
 */
function rawRequest(url, opts) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return resolve({ ok: false, status: 0, data: null, error: `invalid_url:${err.message}` });
    }

    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const method = opts.method || 'GET';
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : null;

    const headers = {
      Accept: 'application/json'
    };
    if (bodyStr !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    // Korrelations-ID an den Analysis Service weiterreichen.  Reihenfolge:
    //  1. expliziter Wert aus `opts.correlationId` (Tests, manuelle Aufrufe),
    //  2. aktueller AsyncLocalStorage-Frame der Express-Middleware
    //     (`getCurrentCorrelationId`).
    // Akzeptiert wird nur, was dem Whitelisting-Muster entspricht; damit
    // kann ein Aufrufer keine beliebigen Strings in den Header und damit
    // in unsere Logs schmuggeln.
    const cid = (opts.correlationId && typeof opts.correlationId === 'string')
      ? opts.correlationId
      : getCurrentCorrelationId();
    if (cid && /^[A-Za-z0-9._:-]{4,128}$/.test(cid)) {
      headers['X-Correlation-Id'] = cid;
    }

    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port:     parsed.port || (isHttps ? 443 : 80),
        path:     parsed.pathname + (parsed.search || ''),
        method,
        headers
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsedBody = null;
          if (raw && raw.length > 0) {
            try { parsedBody = JSON.parse(raw); }
            catch (_) { parsedBody = raw; }
          }
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          resolve({
            ok,
            status: res.statusCode,
            data:   parsedBody,
            error:  ok ? null : `http_${res.statusCode}`
          });
        });
      }
    );

    req.setTimeout(opts.timeoutMs, () => {
      req.destroy(new Error(`timeout_after_${opts.timeoutMs}ms`));
    });

    req.on('error', (err) => {
      resolve({ ok: false, status: 0, data: null, error: err.message || 'network_error' });
    });

    if (bodyStr !== null) req.write(bodyStr);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Führt einen Request mit konfiguriertem Retry aus.  Retry erfolgt nur bei
 * Netzwerk-/Timeout-Fehlern oder 5xx-Antworten (4xx wird sofort zurückgegeben,
 * weil der Client/Body falsch ist und ein Retry nichts ändert).
 *
 * @returns {Promise<{ok: boolean, status: number, data: any, error: (string|null), attempts: number}>}
 */
async function withRetry(url, opts, retries, retryDelayMs) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    const r = await rawRequest(url, opts);
    if (r.ok) return Object.assign(r, { attempts: attempt });
    const retriable = r.status === 0 || r.status >= 500;
    if (!retriable || attempt > retries) {
      return Object.assign(r, { attempts: attempt });
    }
    if (retryDelayMs > 0) await sleep(retryDelayMs);
  }
}

// ── Mapping: LocationActionBrief (Node) → locationBriefIngest.v1 ─────────────

/**
 * Wandelt einen vom Node-`buildLocationBrief()` erzeugten Brief in das
 * versionierte Ingest-Format des Analysis Service um.  Dabei werden vor allem
 * die `meta`-Felder ergänzt (Stadt, Profil, Schemaversion), die im
 * Java-Service Pflicht sind.
 *
 * @param {object} brief    – Ergebnis aus `server/location-brief/briefService.js`
 * @param {object} [extra]  – optionale Zusatzfelder (city/areaName/locationId)
 * @returns {object}        – versioniertes Ingest-DTO
 */
function toIngestPayload(brief, extra) {
  const e = extra || {};
  const city = String(
    e.city
      || (brief && brief.meta && brief.meta.city)
      || (brief && brief.location && brief.location.city)
      || ''
  );
  const areaName = String(
    e.areaName
      || (brief && brief.meta && brief.meta.areaName)
      || (brief && brief.location && brief.location.areaName)
      || ''
  );
  const profile = String(
    (brief && brief.meta && brief.meta.profile)
      || e.profile
      || ''
  );

  // Bereits vorhandene meta-Felder beibehalten, ggf. Pflichtfelder ergänzen.
  const incomingMeta = (brief && brief.meta && typeof brief.meta === 'object') ? brief.meta : {};
  const meta = Object.assign({}, incomingMeta, {
    schemaVersion: incomingMeta.schemaVersion || (brief && brief.schemaVersion) || 'locationActionBrief.v1',
    profile,
    city,
    areaName: areaName || incomingMeta.areaName,
    generatedWithAi: Boolean(incomingMeta.generatedWithAi || (brief && brief.aiPolish))
  });

  // Nur tatsächlich vorhandene Felder weiterreichen – dem Java-DTO ist
  // alles Unbekannte egal (`@JsonIgnoreProperties(ignoreUnknown = true)`),
  // aber so bleibt der Payload klein und nachvollziehbar.
  const payload = {
    schemaVersion:        INGEST_SCHEMA_VERSION,
    locationId:           e.locationId || (brief && brief.locationId) || undefined,
    externalLocationId:   e.externalLocationId || (brief && brief.externalLocationId) || undefined,
    title:                (brief && brief.title) || `${city || 'Unbekannt'} – ${areaName || ''}`.trim(),
    problemSummary:       brief && brief.problemSummary,
    accidentProfile:      brief && brief.accidentProfile,
    conflictPatterns:     brief && brief.conflictPatterns,
    candidateMeasures:    brief && brief.candidateMeasures,
    recommendedMeasures:  brief && brief.recommendedMeasures,
    dataQuality:          brief && brief.dataQuality,
    politicalContext:     brief && brief.politicalContext,
    deterministicFindings: brief && brief.deterministicFindings,
    uncertainties:        brief && brief.uncertainties,
    confidence:           brief && brief.confidence,
    aiPolish:             brief && brief.aiPolish,
    meta
  };

  // undefined-Felder ausdünnen (kompakter Payload, deterministischer
  // Fingerprint im Java-Service).
  Object.keys(payload).forEach((k) => {
    if (payload[k] === undefined) delete payload[k];
  });
  return payload;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Persistiert einen LocationActionBrief beim Analysis Service.
 *
 * @param {object}  brief
 * @param {object} [extra]
 * @returns {Promise<{
 *   ok: boolean,
 *   skipped?: 'disabled'|'unconfigured',
 *   status?: number,
 *   data?: object,
 *   error?: string,
 *   attempts?: number
 * }>}
 */
async function persistLocationBrief(brief, extra) {
  const cfg = getConfig();
  if (!cfg.baseUrl) {
    return { ok: false, skipped: 'unconfigured' };
  }
  if (!cfg.enabled) {
    return { ok: false, skipped: 'disabled' };
  }
  const payload = toIngestPayload(brief, extra);
  const url = `${cfg.baseUrl}/api/location-briefs`;
  const r = await withRetry(
    url,
    { method: 'POST', body: payload, timeoutMs: cfg.timeoutMs },
    cfg.retries,
    cfg.retryDelayMs
  );
  return r;
}

/**
 * Liefert alle gespeicherten Auswertungen einer Stelle (neueste zuerst).
 * @param {string} locationKey
 * @returns {Promise<{ok: boolean, status?: number, data?: any, error?: string, attempts?: number, skipped?: string}>}
 */
async function fetchByLocationKey(locationKey) {
  const cfg = getConfig();
  if (!cfg.baseUrl) return { ok: false, skipped: 'unconfigured' };
  if (!cfg.enabled) return { ok: false, skipped: 'disabled' };
  if (!locationKey) return { ok: false, error: 'invalid_request:locationKey_required' };
  const url = `${cfg.baseUrl}/api/location-briefs/by-location/${encodeURIComponent(locationKey)}`;
  return withRetry(url, { method: 'GET', timeoutMs: cfg.timeoutMs }, cfg.retries, cfg.retryDelayMs);
}

/**
 * Liefert die Top-N gespeicherten Briefs einer Stadt für ein Profil.
 * @param {string} city
 * @param {string} profile
 * @param {number} [limit=10]
 */
async function fetchTopByCityProfile(city, profile, limit) {
  const cfg = getConfig();
  if (!cfg.baseUrl) return { ok: false, skipped: 'unconfigured' };
  if (!cfg.enabled) return { ok: false, skipped: 'disabled' };
  if (!city || !profile) return { ok: false, error: 'invalid_request:city_and_profile_required' };
  const safeLimit = Math.min(Math.max(1, Number(limit) || 10), 100);
  const url = `${cfg.baseUrl}/api/location-briefs/top?city=${encodeURIComponent(city)}`
    + `&profile=${encodeURIComponent(profile)}&limit=${safeLimit}`;
  return withRetry(url, { method: 'GET', timeoutMs: cfg.timeoutMs }, cfg.retries, cfg.retryDelayMs);
}

/**
 * Liefert eine Liste gespeicherter Briefs für eine Stadt (paginiert).
 * @param {string} city
 * @param {{profile?: string, page?: number, size?: number}} [opts]
 */
async function fetchByCity(city, opts) {
  const cfg = getConfig();
  if (!cfg.baseUrl) return { ok: false, skipped: 'unconfigured' };
  if (!cfg.enabled) return { ok: false, skipped: 'disabled' };
  if (!city) return { ok: false, error: 'invalid_request:city_required' };
  const o = opts || {};
  const params = new URLSearchParams();
  params.set('city', city);
  if (o.profile) params.set('profile', String(o.profile));
  if (Number.isFinite(o.page)) params.set('page', String(Math.max(0, o.page)));
  if (Number.isFinite(o.size)) params.set('size', String(Math.min(Math.max(1, o.size), 100)));
  const url = `${cfg.baseUrl}/api/location-briefs?${params.toString()}`;
  return withRetry(url, { method: 'GET', timeoutMs: cfg.timeoutMs }, cfg.retries, cfg.retryDelayMs);
}

// ── Batch-Endpunkte (Forwarder) ──────────────────────────────────────────────
//
// Dünne Forwarder zu den Spring-Batch-REST-Endpunkten im Analysis Service.
// Sie sind voll optional: ist der Service nicht konfiguriert/aktiviert, geben
// sie sofort ein klares `skipped`-Ergebnis zurück, ohne Netz-Call.

/**
 * Startet den `city-prioritization-job`.
 * @param {{city:string, profile:string, recomputeExisting?:boolean, limit?:number, runLabel?:string}} req
 */
async function startCityPrioritizationJob(req) {
  const cfg = getConfig();
  if (!cfg.baseUrl) return { ok: false, skipped: 'unconfigured' };
  if (!cfg.enabled) return { ok: false, skipped: 'disabled' };
  if (!req || !req.city || !req.profile) {
    return { ok: false, error: 'invalid_request:city_and_profile_required' };
  }
  const url = `${cfg.baseUrl}/api/batch/jobs/city-prioritization`;
  // Batch-Aufrufe sind in Summe kürzer/teuerer und idempotent über
  // `runTimestamp` – ein milder zusätzlicher Timeout ist ausreichend.
  return withRetry(
    url,
    { method: 'POST', body: req, timeoutMs: Math.max(cfg.timeoutMs, 8000) },
    cfg.retries,
    cfg.retryDelayMs
  );
}

/**
 * Liest den Status einer Batch-Execution.
 * @param {number|string} executionId
 */
async function fetchBatchJobStatus(executionId) {
  const cfg = getConfig();
  if (!cfg.baseUrl) return { ok: false, skipped: 'unconfigured' };
  if (!cfg.enabled) return { ok: false, skipped: 'disabled' };
  if (executionId === undefined || executionId === null || executionId === '') {
    return { ok: false, error: 'invalid_request:executionId_required' };
  }
  const url = `${cfg.baseUrl}/api/batch/jobs/${encodeURIComponent(String(executionId))}`;
  return withRetry(url, { method: 'GET', timeoutMs: cfg.timeoutMs }, cfg.retries, cfg.retryDelayMs);
}

/**
 * Liest die fachliche Zusammenfassung einer Batch-Execution.
 * @param {number|string} executionId
 */
async function fetchBatchJobSummary(executionId) {
  const cfg = getConfig();
  if (!cfg.baseUrl) return { ok: false, skipped: 'unconfigured' };
  if (!cfg.enabled) return { ok: false, skipped: 'disabled' };
  if (executionId === undefined || executionId === null || executionId === '') {
    return { ok: false, error: 'invalid_request:executionId_required' };
  }
  const url = `${cfg.baseUrl}/api/batch/jobs/${encodeURIComponent(String(executionId))}/summary`;
  return withRetry(url, { method: 'GET', timeoutMs: cfg.timeoutMs }, cfg.retries, cfg.retryDelayMs);
}

/**
 * Liefert die Liste der jüngsten Batch-Läufe.
 * @param {number} [limit=20]
 */
async function listBatchJobs(limit) {
  const cfg = getConfig();
  if (!cfg.baseUrl) return { ok: false, skipped: 'unconfigured' };
  if (!cfg.enabled) return { ok: false, skipped: 'disabled' };
  const safe = Math.min(Math.max(1, Number(limit) || 20), 100);
  const url = `${cfg.baseUrl}/api/batch/jobs?limit=${safe}`;
  return withRetry(url, { method: 'GET', timeoutMs: cfg.timeoutMs }, cfg.retries, cfg.retryDelayMs);
}

/**
 * Probt die Erreichbarkeit des Service über `/actuator/health`.  Schnell
 * und kurz, mit reduziertem Timeout und ohne Retry, gedacht für
 * Capability-/Liveness-Checks.  Liefert kein Fallback auf einen
 * fachlichen Endpunkt – ist Actuator deaktiviert, schlägt der Probe
 * fehl.
 *
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
async function probe() {
  const cfg = getConfig();
  if (!cfg.baseUrl) return { ok: false, error: 'unconfigured' };
  const url = `${cfg.baseUrl}/actuator/health`;
  // Probes haben einen kürzeren Timeout und keinen Retry.
  const r = await rawRequest(url, { method: 'GET', timeoutMs: Math.min(cfg.timeoutMs, 2000) });
  return r.ok
    ? { ok: true, status: r.status }
    : { ok: false, status: r.status || 0, error: r.error || 'probe_failed' };
}

/**
 * Liefert die persistierten Ranking-Artefakte einer Batch-Execution.
 * Lese-Pfad für die UI-Funktion „Aus Batch-Lauf laden".
 * @param {number|string} executionId
 */
async function fetchBatchJobRanking(executionId) {
  const cfg = getConfig();
  if (!cfg.baseUrl) return { ok: false, skipped: 'unconfigured' };
  if (!cfg.enabled) return { ok: false, skipped: 'disabled' };
  if (executionId === undefined || executionId === null || executionId === '') {
    return { ok: false, error: 'invalid_request:executionId_required' };
  }
  const url = `${cfg.baseUrl}/api/batch/jobs/${encodeURIComponent(String(executionId))}/ranking`;
  return withRetry(url, { method: 'GET', timeoutMs: cfg.timeoutMs }, cfg.retries, cfg.retryDelayMs);
}

/**
 * Restartet eine zuvor abgebrochene/gescheiterte Spring-Batch-Execution.
 * @param {number|string} executionId
 */
async function restartBatchJob(executionId) {
  const cfg = getConfig();
  if (!cfg.baseUrl) return { ok: false, skipped: 'unconfigured' };
  if (!cfg.enabled) return { ok: false, skipped: 'disabled' };
  if (executionId === undefined || executionId === null || executionId === '') {
    return { ok: false, error: 'invalid_request:executionId_required' };
  }
  const url = `${cfg.baseUrl}/api/batch/jobs/${encodeURIComponent(String(executionId))}/restart`;
  return withRetry(
    url,
    { method: 'POST', body: {}, timeoutMs: Math.max(cfg.timeoutMs, 8000) },
    cfg.retries,
    cfg.retryDelayMs
  );
}

// ── Search-Endpunkte (Forwarder) ────────────────────────────────────────────
//
// Dünne Forwarder zu den Hibernate-Search-basierten Endpunkten im
// Analysis Service.  Antworten enthalten ein `searchAvailable`-Flag,
// damit das UI sauber zwischen "Suche degradiert" und "kein Treffer"
// unterscheiden kann (Antwort wird 1:1 weitergereicht).

/** @param {{q?:string, city?:string, profile?:string, conflictPattern?:string, limit?:number}} [opts] */
async function searchBriefs(opts) {
  const cfg = getConfig();
  if (!cfg.baseUrl) return { ok: false, skipped: 'unconfigured' };
  if (!cfg.enabled) return { ok: false, skipped: 'disabled' };
  const o = opts || {};
  const params = new URLSearchParams();
  if (o.q) params.set('q', String(o.q));
  if (o.city) params.set('city', String(o.city));
  if (o.profile) params.set('profile', String(o.profile));
  if (o.conflictPattern) params.set('conflictPattern', String(o.conflictPattern));
  if (Number.isFinite(Number(o.limit))) {
    params.set('limit', String(Math.min(Math.max(1, Number(o.limit)), 100)));
  }
  const qs = params.toString();
  const url = `${cfg.baseUrl}/api/search/briefs${qs ? '?' + qs : ''}`;
  return withRetry(url, { method: 'GET', timeoutMs: cfg.timeoutMs }, cfg.retries, cfg.retryDelayMs);
}

/** @param {{q?:string, type?:string, topic?:string, limit?:number}} [opts] */
async function searchPoliticalRefs(opts) {
  const cfg = getConfig();
  if (!cfg.baseUrl) return { ok: false, skipped: 'unconfigured' };
  if (!cfg.enabled) return { ok: false, skipped: 'disabled' };
  const o = opts || {};
  const params = new URLSearchParams();
  if (o.q) params.set('q', String(o.q));
  if (o.type) params.set('type', String(o.type));
  if (o.topic) params.set('topic', String(o.topic));
  if (Number.isFinite(Number(o.limit))) {
    params.set('limit', String(Math.min(Math.max(1, Number(o.limit)), 100)));
  }
  const qs = params.toString();
  const url = `${cfg.baseUrl}/api/search/political-refs${qs ? '?' + qs : ''}`;
  return withRetry(url, { method: 'GET', timeoutMs: cfg.timeoutMs }, cfg.retries, cfg.retryDelayMs);
}

/**
 * @param {string} briefId
 * @param {{limit?:number}} [opts]
 */
async function findSimilarBriefs(briefId, opts) {
  const cfg = getConfig();
  if (!cfg.baseUrl) return { ok: false, skipped: 'unconfigured' };
  if (!cfg.enabled) return { ok: false, skipped: 'disabled' };
  if (!briefId) return { ok: false, error: 'invalid_request:briefId_required' };
  const o = opts || {};
  const params = new URLSearchParams();
  if (Number.isFinite(Number(o.limit))) {
    params.set('limit', String(Math.min(Math.max(1, Number(o.limit)), 100)));
  }
  const qs = params.toString();
  const url = `${cfg.baseUrl}/api/search/similar/${encodeURIComponent(briefId)}${qs ? '?' + qs : ''}`;
  return withRetry(url, { method: 'GET', timeoutMs: cfg.timeoutMs }, cfg.retries, cfg.retryDelayMs);
}

module.exports = {
  INGEST_SCHEMA_VERSION,
  getConfig,
  describeStatus,
  toIngestPayload,
  persistLocationBrief,
  fetchByLocationKey,
  fetchTopByCityProfile,
  fetchByCity,
  startCityPrioritizationJob,
  fetchBatchJobStatus,
  fetchBatchJobSummary,
  fetchBatchJobRanking,
  restartBatchJob,
  listBatchJobs,
  searchBriefs,
  searchPoliticalRefs,
  findSimilarBriefs,
  probe
};
