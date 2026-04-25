/**
 * Express-Server für die Docker-Distribution der Unfallwerkbank.
 *
 * Stellt die statischen Werkbank-Dateien bereit und bietet folgende Endpunkte:
 *   POST /api/export-video                – GIF-Video-Export (Playwright/ffmpeg)
 *   POST /api/ai/export-assessment        – optionale KI-gestützte Bewertung (Gemini)
 *   GET  /api/ai-assessment-available     – Feature-Flag (GEMINI_API_KEY vorhanden?)
 *   POST /api/political-context/search    – serverseitige Recherche politischer Vorgänge
 *   GET  /api/political-context/supported – Liste unterstützter Städte
 *   POST /api/location-brief              – deterministischer Maßnahmen-Steckbrief je Stelle
 *   GET  /api/location-briefs/by-location/:key – gespeicherte Briefs einer Stelle
 *   GET  /api/location-briefs/top         – Top-N gespeicherte Briefs (Stadt+Profil)
 *   GET  /api/location-briefs?city=…      – gespeicherte Briefs einer Stadt
 *   GET  /api/priorities/top              – Top-N als kompakte Decision-Cards
 *   GET  /api/priorities/by-location/:key – gespeicherte Briefs einer Stelle als Cards
 *   GET  /api/priorities/profiles         – verfügbare Profile + dataStatus-Vokabular
 *
 * Die Lese-Endpunkte unter `/api/location-briefs` sind dünne Forwarder zum
 * separaten Analysis Service (Spring Boot, siehe `analysis-service/`) und
 * antworten 503, wenn dieser nicht konfiguriert ist.
 *
 * Start: node server/index.js
 * Port:  8000 (konfigurierbar über Umgebungsvariable PORT)
 */

'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const { exportVideo }   = require('./video-export.js');
const { runAssessment, isAvailable } = require('./ai/aiAssessmentService.js');
const { runAssessmentV2, VALID_MODES, activeProviderName } = require('./ai/aiAssessmentServiceV2.js');
const { sharedQueue: aiJobQueue } = require('./ai/jobs/aiJobQueue.js');
const { search: politicalContextSearch } = require('./political-context/services/portalSearchService.js');
const { listSupportedCities }            = require('./political-context/registry/cityPortalRegistry.js');
const { buildLocationBrief, PROFILE_IDS, DEFAULT_PROFILE } = require('./location-brief');
const { getCapabilities }                = require('./lib/capabilities.js');
const { sendError, attachFallbackInfo, CATEGORIES } = require('./lib/errors.js');
const analysisServiceClient              = require('./analysis-service/analysisServiceClient.js');
const priorities                         = require('./priorities');
const { createPrioritiesHandlers }       = require('./priorities/handlers.js');
const { correlationIdMiddleware, HEADER_NAME: CORRELATION_HEADER } = require('./lib/correlationId.js');

const app = express();
const PORT = process.env.PORT || 8000;
const ROOT = path.resolve(__dirname, '..');

// Parse JSON request bodies
app.use(express.json());

// Korrelations-ID-Middleware: jede Anfrage erhält ein stabiles Tracing-
// Token, das in Logs auftaucht und im Antwort-Header gespiegelt wird.
// Muss vor allen Handlern stehen, damit `req.correlationId` überall
// verfügbar ist.
app.use(correlationIdMiddleware());

// Rate limiter for the video export endpoint (3 requests/minute per IP).
// Video generation is expensive; this guards against unintentional hammering.
const videoExportRateLimit = rateLimit({
  windowMs: 60_000,      // 1 minute window
  max: 3,                // max 3 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen – bitte warte kurz und versuche es erneut.' }
});

// Rate limiter for the AI assessment endpoint (10 requests/minute per IP).
const aiAssessmentRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen – bitte warte kurz und versuche es erneut.' }
});

// Rate limiter for the political context search endpoint (20 requests/minute per IP).
const politicalContextRateLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen – bitte warte kurz und versuche es erneut.' }
});

// Rate limiter for the location-brief endpoint (30 requests/minute per IP).
// The endpoint is purely deterministic and CPU-cheap, but we still rate-limit
// to protect against accidental loops in the UI.
const locationBriefRateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen – bitte warte kurz und versuche es erneut.' }
});

// Concurrency guard: at most MAX_CONCURRENT Playwright/ffmpeg jobs at once.
const MAX_CONCURRENT = 2;
let activeExports = 0;

function concurrencyGuard(req, res, next) {
  if (activeExports >= MAX_CONCURRENT) {
    return res.status(429).json({
      error: 'Server ist ausgelastet – bitte versuche es in Kürze erneut.'
    });
  }
  activeExports++;
  next();
}

// Statische Werkbank-Dateien aus dem Repository-Root ausliefern
app.use(express.static(ROOT, {
  index: 'werkbank_v2.html',
  extensions: ['html']
}));

// ── Health-Check ──────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Status / Capability-Übersicht ─────────────────────────────────────────────
/**
 * GET /api/status
 *
 * Aggregierter Status-Endpunkt.  Liefert pro optionalem Feature einen
 * strukturierten Capability-Eintrag (`available`, `reasonCode`, `reason`,
 * optional `details`).  Gedacht für:
 *   - Frontend (Single-Call statt n Feature-Flag-Endpunkte)
 *   - Dokumentation / Smoke-Test-Skripte
 *   - Debugging im Betrieb
 *
 * Bestehende Single-Feature-Endpunkte (`/api/ai-assessment-available`,
 * `/api/video-export-available`, `/api/political-context/supported`) bleiben
 * unverändert verfügbar.
 *
 * Antwort:
 *   {
 *     status:    'ok',
 *     timestamp: '<ISO-8601>',
 *     version:   '<package.json#version>',
 *     uptimeSec: <number>,
 *     capabilities: { aiAssessmentV1, aiAssessmentV2, politicalContext, videoExport }
 *   }
 */
app.get('/api/status', (_req, res) => {
  let version = 'unknown';
  try {
    // eslint-disable-next-line global-require
    version = require('../package.json').version || 'unknown';
  } catch (_) { /* keep 'unknown' */ }

  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    version,
    uptimeSec: Math.round(process.uptime()),
    ...getCapabilities()
  });
});

// ── Feature-Flag: Video-Export verfügbar? ─────────────────────────────────────
app.get('/api/video-export-available', (_req, res) => {
  res.json({ available: true });
});

// ── Video-Export ──────────────────────────────────────────────────────────────
/**
 * POST /api/export-video
 *
 * Body (JSON): aktuelle URL-Parameter der Werkbank (alle optional):
 *   city, severity, includeCyclist, includePedestrian, includeCar,
 *   includeMotorcycle, involvementMode, hourFrom, hourTo, dayType,
 *   roadCondition, showCluster, showHeatmap, showOnlyAboveAverage,
 *   centerLat, centerLon, zoom, selSouth, selWest, selNorth, selEast,
 *   maxPoints, viewportPaddingPct, heatRadius
 *
 * Antwort: GIF-Datei als Download
 */
app.post('/api/export-video', videoExportRateLimit, concurrencyGuard, async (req, res) => {
  const params = req.body || {};

  // Note: activeExports is incremented in concurrencyGuard (before next())
  let gifPath = null;
  try {
    gifPath = await exportVideo(params);

    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Content-Disposition', 'attachment; filename="unfallatlas-analyse.gif"');
    res.sendFile(gifPath, (err) => {
      activeExports--;
      if (err && !res.headersSent) {
        res.status(500).json({ error: 'Fehler beim Senden der Datei' });
      }
      // Temporäre GIF-Datei aufräumen
      try { fs.unlinkSync(gifPath); } catch (_) { /* ignore */ }
    });
  } catch (err) {
    activeExports--;
    console.error('[export-video] Fehler:', err);
    // Temporäre GIF-Datei aufräumen falls vorhanden
    if (gifPath) {
      try { fs.unlinkSync(gifPath); } catch (_) { /* ignore */ }
    }
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Interner Fehler beim Video-Export' });
    }
  }
});

// ── Feature-Flag: KI-Bewertung verfügbar? ─────────────────────────────────────
/**
 * GET /api/ai-assessment-available
 *
 * Gibt { available: true } zurück, wenn GEMINI_API_KEY gesetzt ist, sonst
 * { available: false }.  Ermöglicht dem Frontend, die KI-Option aus- oder
 * einzublenden ohne einen vollen Request zu schicken.
 */
app.get('/api/ai-assessment-available', (_req, res) => {
  res.json({ available: isAvailable() });
});

// ── KI-Bewertung ──────────────────────────────────────────────────────────────
/**
 * POST /api/ai/export-assessment
 *
 * Body (JSON):
 *   structured    – strukturiertes Export-Objekt aus computeExportReport()
 *   contextHints  – (optional) manuelle Kontext-Hinweise
 *     { knownHazards: string[], locationHints: string[], surfaceHints: string[], notes: string[] }
 *
 * Antwort (JSON):
 *   { assessment: ExportAssessmentOutput }
 *
 * Fehler:
 *   503 – KI nicht konfiguriert (GEMINI_API_KEY fehlt)
 *   400 – Pflichtfelder im Body fehlen
 *   500 – Interner Fehler
 */
app.post('/api/ai/export-assessment', aiAssessmentRateLimit, async (req, res) => {
  if (!isAvailable()) {
    return sendError(res, {
      status: 503,
      category: CATEGORIES.FEATURE_UNAVAILABLE,
      code: 'AI_NOT_CONFIGURED',
      message: 'KI-Bewertung ist nicht konfiguriert (GEMINI_API_KEY fehlt).'
    });
  }

  const { structured, contextHints } = req.body || {};
  if (!structured || typeof structured !== 'object') {
    return sendError(res, {
      category: CATEGORIES.INVALID_REQUEST,
      code: 'STRUCTURED_REQUIRED',
      message: 'Pflichtfeld "structured" fehlt oder ist kein Objekt.'
    });
  }

  try {
    const assessment = await runAssessment(structured, contextHints);
    return res.json({ assessment });
  } catch (err) {
    // Log without sensitive data (no API key, no raw prompt)
    console.error('[ai/export-assessment] Fehler:', err.message);
    return sendError(res, {
      category: CATEGORIES.UPSTREAM_ERROR,
      code: 'AI_REQUEST_FAILED',
      message: err.message || 'Interner Fehler bei der KI-Bewertung.'
    });
  }
});

// ── KI-Bewertung v2 (Modi: assessment | proposal-brief) ──────────────────────
/**
 * POST /api/ai/export-assessment/v2?mode=assessment|proposal-brief
 *
 * Body (JSON):
 *   structured    – strukturiertes Export-Objekt aus computeExportReport()
 *   contextHints  – (optional) manuelle Kontext-Hinweise
 *   mode          – (optional) 'assessment' (default) oder 'proposal-brief';
 *                    kann auch via ?mode=… als Query-Parameter gesetzt werden.
 *   withFallback  – (optional, default true) bei Fehlern deterministisch antworten?
 *
 * Antwort (JSON):
 *   {
 *     mode:     string,
 *     source:   'cache'|'ai'|'ai-repaired'|'fallback',
 *     cacheKey: string,
 *     result:   <Schema-konformer Output>
 *   }
 *
 * Hinweis zu Free-Tier:
 *   - Identische Anfragen (gleicher Input + Modus + Modell) werden aus dem
 *     Cache bedient (sha256, TTL 1h). Reduziert Kontingentverbrauch.
 *   - Provider nutzt Retry/Backoff bei 429/5xx.
 *   - Fehlt der GEMINI_API_KEY, antwortet der Endpunkt mit Status 200 +
 *     `source: 'fallback'` (deterministischer Output ohne KI-Texte), sofern
 *     `withFallback !== false`.  Bei `withFallback: false` antwortet er 503.
 */
app.post('/api/ai/export-assessment/v2', aiAssessmentRateLimit, async (req, res) => {
  const body = req.body || {};
  const mode = String(body.mode || req.query.mode || 'assessment');
  if (!VALID_MODES.includes(mode)) {
    return sendError(res, {
      category: CATEGORIES.INVALID_REQUEST,
      code: 'INVALID_MODE',
      message: `Ungültiger mode "${mode}". Erlaubt: ${VALID_MODES.join(', ')}`
    });
  }
  const { structured, contextHints } = body;
  if (!structured || typeof structured !== 'object') {
    return sendError(res, {
      category: CATEGORIES.INVALID_REQUEST,
      code: 'STRUCTURED_REQUIRED',
      message: 'Pflichtfeld "structured" fehlt oder ist kein Objekt.'
    });
  }
  const withFallback = body.withFallback !== false;

  try {
    const out = await runAssessmentV2({ structured, contextHints, mode, withFallback });
    const payload = {
      mode,
      source: out.source,
      cacheKey: out.cacheKey,
      result: out.result,
      ...(out.error ? { fallbackReason: out.error } : {})
    };
    // Bei Fallback zusätzlich strukturierte Fehler-Info anhängen, ohne die
    // bestehende Antwort­form zu verändern.
    if (out.source === 'fallback') {
      return res.json(attachFallbackInfo(payload, {
        code:    'AI_FALLBACK_USED',
        message: out.error || 'KI nicht verfügbar – deterministischer Fallback wurde geliefert.',
        details: { aiCallEnabled: false }
      }));
    }
    return res.json(payload);
  } catch (err) {
    if (err && err.code === 'AI_NOT_CONFIGURED') {
      return sendError(res, {
        status: 503,
        category: CATEGORIES.FEATURE_UNAVAILABLE,
        code: 'AI_NOT_CONFIGURED',
        message: err.message
      });
    }
    console.error('[ai/export-assessment/v2] Fehler:', err.message);
    return sendError(res, {
      category: CATEGORIES.UPSTREAM_ERROR,
      code: 'AI_REQUEST_FAILED',
      message: err.message || 'Interner Fehler bei der KI-Bewertung.'
    });
  }
});

// ── Async Jobs für KI-Bewertung ──────────────────────────────────────────────
/**
 * Registriert den Runner für asynchrone v2-Jobs.  Der Job-Payload entspricht
 * dem Body von POST /api/ai/export-assessment/v2 (structured, contextHints,
 * mode, withFallback).  Das Ergebnis ist exakt das, was der synchrone
 * Endpunkt zurückgibt (mode/source/cacheKey/result).
 */
aiJobQueue.registerRunner('export-assessment-v2', async (payload) => {
  const mode = String(payload?.mode || 'assessment');
  const withFallback = payload?.withFallback !== false;
  const out = await runAssessmentV2({
    structured: payload?.structured,
    contextHints: payload?.contextHints,
    mode,
    withFallback
  });
  return {
    mode,
    source: out.source,
    cacheKey: out.cacheKey,
    result: out.result,
    ...(out.error ? { fallbackReason: out.error } : {})
  };
});

/**
 * POST /api/ai/jobs
 *
 * Body: { kind, payload }
 *   - kind:    z. B. "export-assessment-v2"
 *   - payload: Body wie für den synchronen Endpunkt
 *
 * Antwort: { id, status, kind, submittedAt }
 *
 * Hinweis: Der Job wird asynchron abgearbeitet.  Status/Result via
 *   GET /api/ai/jobs/:id
 */
app.post('/api/ai/jobs', aiAssessmentRateLimit, (req, res) => {
  const { kind, payload } = req.body || {};
  if (typeof kind !== 'string' || !kind) {
    return res.status(400).json({ error: 'Pflichtfeld "kind" fehlt.' });
  }
  if (kind !== 'export-assessment-v2') {
    return res.status(400).json({ error: `Unbekannter kind "${kind}".` });
  }
  if (!payload || typeof payload !== 'object' || !payload.structured) {
    return res.status(400).json({ error: 'payload.structured fehlt oder ist ungültig.' });
  }
  const mode = String(payload.mode || 'assessment');
  if (!VALID_MODES.includes(mode)) {
    return res.status(400).json({ error: `Ungültiger mode "${mode}". Erlaubt: ${VALID_MODES.join(', ')}` });
  }
  try {
    const job = aiJobQueue.submit({ kind, payload });
    return res.status(202).json({
      id: job.id, status: job.status, kind: job.kind, submittedAt: job.submittedAt
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Job konnte nicht angelegt werden.' });
  }
});

/**
 * GET /api/ai/jobs/:id
 *
 * Antwort:
 *   { id, kind, status: 'queued'|'running'|'done'|'error',
 *     submittedAt, startedAt?, finishedAt?, result?, error? }
 *
 * Statuscodes: 200 (gefunden), 404 (unbekannte ID).
 */
app.get('/api/ai/jobs/:id', (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[a-f0-9]{8,64}$/i.test(id)) {
    return res.status(400).json({ error: 'Ungültige Job-ID.' });
  }
  const job = aiJobQueue.getJob(id);
  if (!job) return res.status(404).json({ error: 'Job nicht gefunden.' });
  // Don't echo back the full original payload (can be large)
  const { payload, ...publicJob } = job;
  return res.json(publicJob);
});

// ── Politische Kontextrecherche ───────────────────────────────────────────────

/**
 * GET /api/political-context/supported
 *
 * Gibt eine Liste aller unterstützten Städte zurück.
 *
 * Antwort: { cities: string[] }
 */
app.get('/api/political-context/supported', (_req, res) => {
  res.json({ cities: listSupportedCities() });
});

/**
 * POST /api/political-context/search
 *
 * Recherchiert politische Vorgänge für einen Kartenbereich / eine Stadt.
 *
 * Body (JSON):
 *   city        {string}    – Stadtname (z. B. "Hannover")
 *   searchTerms {string[]}  – Suchbegriffe (Straße, Kreuzung, Stadtbezirk …)
 *   context     {object}    – optionaler Kontext
 *     gremium   {string}    – bevorzugtes Gremium
 *     location  {string}    – Ortshinweis
 *   maxResults  {number}    – max. Trefferzahl (Standard: 10, max: 30)
 *
 * Antwort: PoliticalReferenceSearchResult
 *   { references: PoliticalReference[], meta: { city, searchTerms, searchedAt,
 *     totalFound, providerKey, supported } }
 *
 * Fehler:
 *   400 – Pflichtfelder fehlen / ungültige Eingabe
 *   500 – Interner Fehler
 */
app.post('/api/political-context/search', politicalContextRateLimit, async (req, res) => {
  const { city, searchTerms, context, maxResults } = req.body || {};

  if (!city || typeof city !== 'string' || !city.trim()) {
    return sendError(res, {
      category: CATEGORIES.INVALID_REQUEST,
      code: 'CITY_REQUIRED',
      message: 'Pflichtfeld "city" fehlt oder ist leer.'
    });
  }
  if (!Array.isArray(searchTerms) || searchTerms.length === 0) {
    return sendError(res, {
      category: CATEGORIES.INVALID_REQUEST,
      code: 'SEARCH_TERMS_REQUIRED',
      message: 'Pflichtfeld "searchTerms" fehlt oder ist kein nichtleeres Array.'
    });
  }
  // Sanitize: alle Einträge müssen Strings sein, max. 200 Zeichen
  const sanitizedTerms = searchTerms
    .filter(t => typeof t === 'string' && t.trim())
    .map(t => t.trim().substring(0, 200));
  if (sanitizedTerms.length === 0) {
    return sendError(res, {
      category: CATEGORIES.INVALID_REQUEST,
      code: 'SEARCH_TERMS_EMPTY',
      message: 'searchTerms enthält keine gültigen Suchbegriffe.'
    });
  }

  const parsed = parseInt(maxResults, 10);
  const resolvedMax = Math.min(30, Math.max(0, isNaN(parsed) ? 10 : parsed));

  try {
    const result = await politicalContextSearch({
      city: city.trim().substring(0, 100),
      searchTerms: sanitizedTerms,
      context: (context && typeof context === 'object') ? context : {},
      maxResults: resolvedMax
    });
    return res.json(result);
  } catch (err) {
    console.error('[political-context/search] Fehler:', err.message);
    return sendError(res, {
      category: CATEGORIES.INTERNAL_ERROR,
      code: 'POLITICAL_SEARCH_FAILED',
      message: err.message || 'Interner Fehler bei der politischen Recherche.'
    });
  }
});

// ── Location Action Brief (deterministische Maßnahmen-Steckbriefe) ───────────

/**
 * POST /api/location-brief
 *
 * Erzeugt für eine einzelne Stelle einen strukturierten Maßnahmen-Steckbrief
 * (`LocationActionBrief`).  Die Berechnung ist vollständig deterministisch
 * und benötigt KEINEN KI-Provider.  Optional kann eine bereits durchgeführte
 * KI-Veredelung (`aiPolish`) übergeben werden – sie wirkt rein additiv und
 * darf weder Maßnahmen noch Konfliktmuster erfinden.
 *
 * Body (JSON):
 *   structured        {object}   – aus `computeExportReport()` (Pflicht)
 *   contextHints      {object}   – knownHazards, surfaceHints, locationHints, notes
 *   politicalContext  {object}   – Suchergebnis aus /api/political-context/search
 *   locationId        {string}   – frei wählbare ID der Stelle
 *   profile           {string}   – Bewertungsprofil (Default: low_hanging_fruit)
 *   aiPolish          {object}   – optionale, zuvor erzeugte KI-Veredelung
 *
 * Antwort: LocationActionBrief
 * Fehler:
 *   400 – Pflichtfeld fehlt / unbekanntes Profil
 *   500 – Interner Fehler
 */
app.post('/api/location-brief', locationBriefRateLimit, async (req, res) => {
  const { structured, contextHints, politicalContext, locationId, profile, aiPolish, persist, useStored } = req.body || {};

  if (!structured || typeof structured !== 'object') {
    return sendError(res, {
      category: CATEGORIES.INVALID_REQUEST,
      code: 'STRUCTURED_REQUIRED',
      message: 'Pflichtfeld "structured" fehlt oder ist kein Objekt.'
    });
  }
  const resolvedProfile = profile || DEFAULT_PROFILE;
  if (!PROFILE_IDS.includes(resolvedProfile)) {
    return sendError(res, {
      category: CATEGORIES.INVALID_REQUEST,
      code: 'UNKNOWN_PROFILE',
      message: `Unbekanntes Profil "${resolvedProfile}". Erlaubt: ${PROFILE_IDS.join(', ')}`
    });
  }

  // `useStored: true` wurde explizit angefragt?  Falls ja und der Cache-Lookup
  // weiter unten kein Treffer liefert (oder der Service nicht erreichbar ist),
  // berichten wir das über einen separaten `storedLookup`-Block – die UI
  // weiß dann, dass die persistierte Sicht gewollt, aber nicht möglich war,
  // ohne dass sich der Persistenz-Lifecycle damit vermischt.
  //
  // `storedLookup.reason`-Vokabular:
  //   * `not_requested`        – useStored war false / kein locationId
  //   * `cache_hit`             – Treffer (in diesem Pfad nie sichtbar,
  //                               weil wir oben direkt zurückkehren)
  //   * `cache_miss`            – Service erreichbar, aber kein Brief
  //                               für (locationKey, profile) vorhanden
  //   * `service_unreachable`   – Aufruf scheiterte (Netzwerk/HTTP/Parse)
  const storedRequested = useStored === true && typeof locationId === 'string' && locationId.length > 0;
  /** @type {{requested:boolean, found:boolean, reason:string, attempts:number}} */
  const storedLookup = {
    requested: storedRequested,
    found:     false,
    reason:    storedRequested ? 'cache_miss' : 'not_requested',
    attempts:  0
  };

  // Optional: vor der Berechnung in den Analysis Service schauen, ob für die
  // gleiche Stelle + Profil bereits ein gespeicherter Brief existiert.  Diese
  // Optimierung ist rein additiv – wenn sie fehlschlägt, wird ganz normal neu
  // berechnet.  Aktiviert über `useStored: true` im Request-Body und nur
  // sinnvoll, wenn die Node-Seite eine stabile `locationId` mitschickt.
  if (storedRequested) {
    try {
      const cached = await analysisServiceClient.fetchByLocationKey(locationId);
      storedLookup.attempts = cached.attempts || 1;
      if (cached.ok && Array.isArray(cached.data) && cached.data.length > 0) {
        const match = cached.data.find((b) => b && b.profileKey === resolvedProfile) || cached.data[0];
        if (match) {
          return res.json({
            source: 'analysis-service',
            stored: { id: match.id, createdAt: match.createdAt, profileKey: match.profileKey },
            persistence: {
              status: 'loaded_from_store',
              persisted: true,
              persistRequested: false,
              storedId: match.id || null,
              attempts: cached.attempts || 1
            },
            storedLookup: {
              requested: true,
              found:     true,
              reason:    'cache_hit',
              attempts:  cached.attempts || 1
            },
            dataStatus: priorities.DATA_STATUS.LOADED_FROM_STORE,
            brief: match
          });
        }
        // Service erreichbar, Daten vorhanden, aber kein passendes Profil:
        // Live-Compute, nur als Lookup-Miss markieren.
        storedLookup.reason = 'cache_miss';
      } else if (cached.ok) {
        // Service hat geantwortet, aber leere Trefferliste.
        storedLookup.reason = 'cache_miss';
      } else {
        // Aufruf nicht erfolgreich – Service nicht erreichbar.
        storedLookup.reason = 'service_unreachable';
      }
    } catch (_) {
      storedLookup.reason = 'service_unreachable'; /* fall through to fresh compute */
    }
  }

  let brief;
  try {
    brief = buildLocationBrief({
      structured,
      contextHints: (contextHints && typeof contextHints === 'object') ? contextHints : undefined,
      politicalContext: (politicalContext && typeof politicalContext === 'object') ? politicalContext : undefined,
      locationId: typeof locationId === 'string' ? locationId : undefined,
      profile: resolvedProfile,
      aiPolish: (aiPolish && typeof aiPolish === 'object') ? aiPolish : undefined
    });
  } catch (err) {
    console.error('[location-brief] Fehler:', err.message);
    return sendError(res, {
      category: CATEGORIES.INTERNAL_ERROR,
      code: 'LOCATION_BRIEF_FAILED',
      message: err.message || 'Interner Fehler beim Erzeugen des Maßnahmen-Steckbriefs.'
    });
  }

  // Optionaler Forward an den Analysis Service.  Standardverhalten: nicht
  // forwarden, damit bestehende Clients und Tests sich nicht ändern.  Wer
  // forwarden möchte, schickt `persist: true` mit (oder setzt Env-Variable
  // `ANALYSIS_SERVICE_AUTO_PERSIST=true`, dann gilt sie als Default).
  const autoPersist = String(process.env.ANALYSIS_SERVICE_AUTO_PERSIST || '').toLowerCase() === 'true';
  const wantPersist = persist === true || (persist !== false && autoPersist);
  if (!wantPersist) {
    // Klar markieren, dass der Brief frisch berechnet und NICHT gespeichert
    // wurde.  `persistence.status` bleibt unabhängig vom (optionalen)
    // `useStored`-Lookup auf `freshly_computed` – der Cache-Miss/-Fehler
    // ist über den separaten `storedLookup`-Block sichtbar.  `dataStatus`
    // schaltet nur dann auf `fallback_result`, wenn der Aufrufer eine
    // gespeicherte Sicht angefordert hat und der Service tatsächlich nicht
    // erreichbar war (echter Fallback) – ein reiner Cache-Miss bleibt
    // `freshly_computed`, weil die fehlende Persistenz dann erwartbar ist.
    const isUnreachable = storedLookup.requested
      && storedLookup.reason === 'service_unreachable';
    return res.json(Object.assign({}, brief, {
      persistence: {
        status:           'freshly_computed',
        persisted:        false,
        persistRequested: false,
        attempts:         0
      },
      storedLookup,
      dataStatus: isUnreachable
        ? priorities.DATA_STATUS.FALLBACK_RESULT
        : priorities.DATA_STATUS.FRESHLY_COMPUTED
    }));
  }

  try {
    const result = await analysisServiceClient.persistLocationBrief(brief, { locationId });
    if (result.ok) {
      // Antwort um Persistenz-Info ergänzen, ohne die bestehende
      // Brief-Struktur zu verändern.
      console.info('[location-brief][persist] persisted (status=%s, attempts=%d, locationKey=%s)',
        'persisted', result.attempts || 1, locationId || '<none>');
      return res.json(Object.assign({}, brief, {
        persistence: {
          status:    'persisted',
          persisted: true,
          persistRequested: true,
          storedId:  (result.data && result.data.id) || null,
          attempts:  result.attempts || 1
        },
        storedLookup,
        dataStatus: priorities.DATA_STATUS.PERSISTED
      }));
    }
    // Skipped/Fehler: Brief trotzdem ausliefern, mit klarer Fallback-Info.
    const reason = result.skipped
      ? `analysis_service_${result.skipped}`
      : (result.error || 'analysis_service_unreachable');
    console.warn('[location-brief][persist] skipped (status=%s, reason=%s, attempts=%d, locationKey=%s)',
      'persist_skipped', reason, result.attempts || 0, locationId || '<none>');
    return res.json(Object.assign({}, brief, {
      persistence: {
        status:   'persist_skipped',
        persisted: false,
        persistRequested: true,
        reason,
        attempts: result.attempts || 0
      },
      storedLookup,
      dataStatus: priorities.DATA_STATUS.FALLBACK_RESULT
    }));
  } catch (err) {
    console.error('[location-brief][persist] exception (locationKey=%s): %s',
      locationId || '<none>', err.message);
    return res.json(Object.assign({}, brief, {
      persistence: {
        status:   'persist_skipped',
        persisted: false,
        persistRequested: true,
        reason:   'persist_exception',
        attempts: 0
      },
      storedLookup,
      dataStatus: priorities.DATA_STATUS.FALLBACK_RESULT
    }));
  }
});

// ── Gespeicherte Briefs (Lese-Pfad gegen den Analysis Service) ───────────────
//
// Diese Endpunkte sind dünne Forwarder.  Wenn der Analysis Service nicht
// konfiguriert ist, antworten sie mit 503 (Feature nicht verfügbar).  Bei
// Upstream-Fehlern sehen Aufrufer eine klare `category: 'upstream_error'`
// Antwort, ohne dass die Node-App selbst Persistenz übernimmt.

function ensureAnalysisServiceConfigured(res) {
  const status = analysisServiceClient.describeStatus();
  if (!status.configured) {
    sendError(res, {
      status: 503,
      category: CATEGORIES.FEATURE_UNAVAILABLE,
      code: 'ANALYSIS_SERVICE_NOT_CONFIGURED',
      message: 'Analysis Service ist nicht konfiguriert (ANALYSIS_SERVICE_BASE_URL fehlt).'
    });
    return false;
  }
  if (!status.enabled) {
    sendError(res, {
      status: 503,
      category: CATEGORIES.FEATURE_UNAVAILABLE,
      code: 'ANALYSIS_SERVICE_DISABLED',
      message: 'Analysis Service ist per Konfiguration deaktiviert (ANALYSIS_SERVICE_ENABLED=false).'
    });
    return false;
  }
  return true;
}

function forwardUpstream(res, result, notFoundIsEmpty) {
  if (result.ok) {
    return res.json(result.data);
  }
  if (notFoundIsEmpty && result.status === 404) {
    return res.json([]);
  }
  return sendError(res, {
    status: 502,
    category: CATEGORIES.UPSTREAM_ERROR,
    code: 'ANALYSIS_SERVICE_UPSTREAM_ERROR',
    message: `Analysis Service nicht erreichbar (${result.error || 'unknown_error'}).`,
    details: { status: result.status || 0, attempts: result.attempts || 0 }
  });
}

/**
 * GET /api/location-briefs/by-location/:locationKey
 *
 * Forwarder: alle gespeicherten Auswertungen einer Stelle, neueste zuerst.
 */
app.get('/api/location-briefs/by-location/:locationKey', locationBriefRateLimit, async (req, res) => {
  if (!ensureAnalysisServiceConfigured(res)) return;
  const result = await analysisServiceClient.fetchByLocationKey(req.params.locationKey);
  return forwardUpstream(res, result, true);
});

/**
 * GET /api/location-briefs/top?city=&profile=&limit=
 *
 * Forwarder: Top-N Briefs für eine Stadt + Profil.
 */
app.get('/api/location-briefs/top', locationBriefRateLimit, async (req, res) => {
  if (!ensureAnalysisServiceConfigured(res)) return;
  const city = String(req.query.city || '').trim();
  const profile = String(req.query.profile || '').trim();
  const limit = Number(req.query.limit) || 10;
  if (!city || !profile) {
    return sendError(res, {
      category: CATEGORIES.INVALID_REQUEST,
      code: 'CITY_AND_PROFILE_REQUIRED',
      message: 'Pflicht-Query-Parameter "city" und "profile" fehlen.'
    });
  }
  const result = await analysisServiceClient.fetchTopByCityProfile(city, profile, limit);
  return forwardUpstream(res, result, true);
});

/**
 * GET /api/location-briefs?city=&profile=&page=&size=
 *
 * Forwarder: Liste gespeicherter Briefs einer Stadt (paginiert).
 */
app.get('/api/location-briefs', locationBriefRateLimit, async (req, res) => {
  if (!ensureAnalysisServiceConfigured(res)) return;
  const city = String(req.query.city || '').trim();
  if (!city) {
    return sendError(res, {
      category: CATEGORIES.INVALID_REQUEST,
      code: 'CITY_REQUIRED',
      message: 'Pflicht-Query-Parameter "city" fehlt.'
    });
  }
  const result = await analysisServiceClient.fetchByCity(city, {
    profile: req.query.profile ? String(req.query.profile) : undefined,
    page:    req.query.page    !== undefined ? Number(req.query.page) : undefined,
    size:    req.query.size    !== undefined ? Number(req.query.size) : undefined
  });
  return forwardUpstream(res, result, true);
});

// ── Prioritäten-/Ranking-Sicht ───────────────────────────────────────────────
//
// Diese Endpunkte verdichten die rohen Analysis-Service-Antworten zu
// kompakten Decision-Cards für die Prioritätenansicht in der Werkbank
// („Welche Stelle ist wichtig, warum, mit welcher Maßnahme?").  Sie sind
// reine *Lese*-Endpunkte, nutzen den vorhandenen Forwarder und liefern
// einen einheitlichen Antwort-Envelope mit stabilem `dataStatus`.
//
// Verhalten ohne Analysis Service: statt 503 antworten wir mit
// `dataStatus: "fallback_result"` und `empty: true` – die UI kann dann
// klar zwischen „kein Ranking gespeichert" (loaded_from_store + empty) und
// „Persistenz steht nicht bereit" (fallback_result) unterscheiden.

/**
 * GET /api/priorities/profiles
 *
 * Liefert die unterstützten Bewertungsprofile und das stabile
 * `dataStatus`-Vokabular.  Wird von der Prioritäten-UI für Dropdowns und
 * Status-Anzeigen genutzt; unabhängig vom Analysis Service.
 */
const _prioritiesHandlers = createPrioritiesHandlers({
  analysisServiceClient,
  profileIds:     PROFILE_IDS,
  defaultProfile: DEFAULT_PROFILE,
  sendError,
  categories:     CATEGORIES
});

app.get('/api/priorities/profiles', _prioritiesHandlers.profilesHandler);

/**
 * GET /api/priorities/top?city=&profile=&limit=
 *
 * Liefert die Top-N gespeicherten Briefs einer Stadt für ein Profil als
 * normalisierte Decision-Cards.  Leeres Ranking: `{ items: [], empty: true,
 * dataStatus: "loaded_from_store" }`.  Service nicht erreichbar:
 * `{ items: [], empty: true, dataStatus: "fallback_result", fallbackReason }`.
 */
app.get('/api/priorities/top', locationBriefRateLimit, _prioritiesHandlers.topHandler);

/**
 * GET /api/priorities/by-location/:locationKey?profile=
 *
 * Liefert alle gespeicherten Briefs einer Stelle als Decision-Cards,
 * neuester / passendes Profil zuerst.  Antwort-Envelope wie bei `/top`.
 */
app.get('/api/priorities/by-location/:locationKey', locationBriefRateLimit, _prioritiesHandlers.byLocationHandler);

// ── Batch-Jobs (Forwarder zum analysis-service) ──────────────────────────────
//
// Diese Endpunkte sind dünne Forwarder zu den Spring-Batch-Endpunkten im
// Analysis Service.  Sie sind voll optional und antworten mit 503, wenn der
// Service nicht konfiguriert/aktiviert ist.  Damit kann die bestehende
// Node-App Batch-Läufe später anstoßen und beobachten, ohne dass eine
// UI-Neugestaltung nötig wird – stabile API-Verträge reichen.

/**
 * POST /api/batch/jobs/city-prioritization
 *
 * Forwarder: startet den city-prioritization-job im Analysis Service.
 * Body: { city, profile, recomputeExisting?, limit?, runLabel? }
 */
app.post('/api/batch/jobs/city-prioritization', locationBriefRateLimit, async (req, res) => {
  if (!ensureAnalysisServiceConfigured(res)) return;
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const city = String(body.city || '').trim();
  const profile = String(body.profile || '').trim();
  if (!city || !profile) {
    return sendError(res, {
      category: CATEGORIES.INVALID_REQUEST,
      code: 'CITY_AND_PROFILE_REQUIRED',
      message: 'Pflichtfelder "city" und "profile" fehlen.'
    });
  }
  const payload = {
    city,
    profile,
    recomputeExisting: body.recomputeExisting === true,
    limit:    Number.isFinite(Number(body.limit))    ? Number(body.limit)    : undefined,
    runLabel: typeof body.runLabel === 'string'      ? body.runLabel         : undefined
  };
  Object.keys(payload).forEach((k) => { if (payload[k] === undefined) delete payload[k]; });
  const result = await analysisServiceClient.startCityPrioritizationJob(payload);
  if (result.ok) {
    console.info('[batch][forwarder] city-prioritization gestartet (executionId=%s, city=%s, profile=%s, attempts=%d)',
      (result.data && result.data.executionId) || '?', city, profile, result.attempts || 1);
    // Status-Code des Upstreams (202) beibehalten, falls vorhanden.
    return res.status(result.status || 202).json(result.data);
  }
  console.warn('[batch][forwarder] city-prioritization start failed (city=%s, profile=%s, status=%s, error=%s)',
    city, profile, result.status || 0, result.error || 'unknown');
  return forwardUpstream(res, result, false);
});

/**
 * GET /api/batch/jobs
 * Forwarder: jüngste Batch-Läufe (jobType + Status).
 */
app.get('/api/batch/jobs', locationBriefRateLimit, async (req, res) => {
  if (!ensureAnalysisServiceConfigured(res)) return;
  const result = await analysisServiceClient.listBatchJobs(Number(req.query.limit));
  return forwardUpstream(res, result, true);
});

/**
 * GET /api/batch/jobs/:executionId
 * Forwarder: technischer Status (Steps, Exit-Codes, Zeitstempel).
 */
app.get('/api/batch/jobs/:executionId', locationBriefRateLimit, async (req, res) => {
  if (!ensureAnalysisServiceConfigured(res)) return;
  const result = await analysisServiceClient.fetchBatchJobStatus(req.params.executionId);
  return forwardUpstream(res, result, false);
});

/**
 * GET /api/batch/jobs/:executionId/summary
 * Forwarder: fachliche Zusammenfassung (Top-N, Counts, Fehler).
 */
app.get('/api/batch/jobs/:executionId/summary', locationBriefRateLimit, async (req, res) => {
  if (!ensureAnalysisServiceConfigured(res)) return;
  const result = await analysisServiceClient.fetchBatchJobSummary(req.params.executionId);
  return forwardUpstream(res, result, false);
});

/**
 * GET /api/batch/jobs/:executionId/ranking
 * Forwarder: persistierte Ranking-Artefakte einer Execution.  Lese-Pfad
 * für die UI-Funktion „Aus Batch-Lauf laden" / Vergleichsmodus.
 */
app.get('/api/batch/jobs/:executionId/ranking', locationBriefRateLimit, async (req, res) => {
  if (!ensureAnalysisServiceConfigured(res)) return;
  const result = await analysisServiceClient.fetchBatchJobRanking(req.params.executionId);
  return forwardUpstream(res, result, false);
});

/**
 * POST /api/batch/jobs/:executionId/restart
 * Forwarder: restartet eine Execution über den Spring-Batch-JobOperator.
 */
app.post('/api/batch/jobs/:executionId/restart', locationBriefRateLimit, async (req, res) => {
  if (!ensureAnalysisServiceConfigured(res)) return;
  const result = await analysisServiceClient.restartBatchJob(req.params.executionId);
  return forwardUpstream(res, result, false);
});

// ── Search-Forwarder ────────────────────────────────────────────────────────
//
// Drei dünne Forwarder zu den Hibernate-Search-basierten Endpunkten im
// Analysis Service.  Sie sind voll optional: ist der Service nicht
// konfiguriert/aktiviert, wird via `ensureAnalysisServiceConfigured`
// ein konsistenter 503 mit klarem Fehlertext geliefert – damit das UI
// einen "Suche degradiert"-Hinweis rendern kann, statt zu raten.

/**
 * GET /api/search/briefs
 * Such-Parameter (alle optional, mindestens einer sollte gesetzt sein):
 *   q, city, profile, conflictPattern, limit
 */
app.get('/api/search/briefs', locationBriefRateLimit, async (req, res) => {
  if (!ensureAnalysisServiceConfigured(res)) return;
  const result = await analysisServiceClient.searchBriefs({
    q:               req.query.q,
    city:            req.query.city,
    profile:         req.query.profile,
    conflictPattern: req.query.conflictPattern,
    limit:           req.query.limit
  });
  return forwardUpstream(res, result, true);
});

/**
 * GET /api/search/political-refs
 * Such-Parameter (alle optional): q, type, topic, limit
 */
app.get('/api/search/political-refs', locationBriefRateLimit, async (req, res) => {
  if (!ensureAnalysisServiceConfigured(res)) return;
  const result = await analysisServiceClient.searchPoliticalRefs({
    q:     req.query.q,
    type:  req.query.type,
    topic: req.query.topic,
    limit: req.query.limit
  });
  return forwardUpstream(res, result, true);
});

/**
 * GET /api/search/similar/:briefId
 * Liefert ähnliche Briefs (More-Like-This) zur referenzierten ID.
 */
app.get('/api/search/similar/:briefId', locationBriefRateLimit, async (req, res) => {
  if (!ensureAnalysisServiceConfigured(res)) return;
  const result = await analysisServiceClient.findSimilarBriefs(
    req.params.briefId,
    { limit: req.query.limit }
  );
  return forwardUpstream(res, result, true);
});

// ── Server starten ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Unfallwerkbank läuft auf http://localhost:${PORT}`);
  console.log(`Status:        GET  http://localhost:${PORT}/api/status`);
  console.log(`Video-Export: POST http://localhost:${PORT}/api/export-video`);
  console.log(`KI-Bewertung v1: POST http://localhost:${PORT}/api/ai/export-assessment (verfügbar: ${isAvailable()})`);
  console.log(`KI-Bewertung v2: POST http://localhost:${PORT}/api/ai/export-assessment/v2?mode=assessment|proposal-brief`);
  console.log(`KI-Bewertung Jobs: POST http://localhost:${PORT}/api/ai/jobs  und  GET /api/ai/jobs/:id`);
  console.log(`KI-Provider: ${activeProviderName()}`);
  console.log(`Politische Recherche: POST http://localhost:${PORT}/api/political-context/search`);
  console.log(`Maßnahmen-Steckbrief: POST http://localhost:${PORT}/api/location-brief`);
  console.log(`Prioritätenansicht:  GET  http://localhost:${PORT}/api/priorities/top?city=&profile=&limit=`);
  const analysisStatus = analysisServiceClient.describeStatus();
  if (analysisStatus.configured) {
    console.log(`Analysis Service:    ${analysisStatus.enabled ? 'aktiv' : 'deaktiviert'} (${analysisStatus.baseUrl}, timeout ${analysisStatus.timeoutMs}ms, retries ${analysisStatus.retries})`);
  } else {
    console.log('Analysis Service:    nicht konfiguriert (ANALYSIS_SERVICE_BASE_URL fehlt) – Persistenz-Forwarder inaktiv.');
  }
});
