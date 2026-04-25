'use strict';

/**
 * Zentrale Erkennung der optionalen Server-Features ("Capabilities").
 *
 * Bündelt die Verfügbarkeitsabfrage einzelner Endpunkte (KI v1, KI v2,
 * Video-Export, politische Recherche) an einer Stelle und liefert pro
 * Feature einen strukturierten Status.  Damit kann
 *   - das Frontend pro Feature entscheiden, ob/wie es es anbietet,
 *   - Doku/Debugging zentral abfragen, was gerade aktiv ist,
 *   - der Status-Endpunkt (`GET /api/status`) eine kompakte Zusammenfassung
 *     ausliefern,
 * ohne dass die jeweiligen Single-Feature-Flag-Endpunkte
 * (`/api/ai-assessment-available`, `/api/video-export-available`,
 * `/api/political-context/supported`) verschwinden – die bleiben
 * abwärtskompatibel bestehen.
 *
 * **Reine Lese­operation, keine Seiteneffekte.**  Alle Werte werden bei
 * jedem Aufruf aus `process.env` und den jeweiligen Modulen frisch
 * abgeleitet, damit Tests Umgebungsvariablen mocken können.
 *
 * @module server/lib/capabilities
 */

/**
 * @typedef {object} Capability
 * @property {boolean} available   – Feature ist nutzbar
 * @property {string}  reasonCode  – maschinenlesbarer Grund (siehe REASON_CODES)
 * @property {string}  reason      – kurze, lesbare Begründung
 * @property {object}  [details]   – optionale Zusatzinfos (z. B. Provider-Name)
 */

/**
 * Standardisierte Gründe.  Bewusst klein gehalten – das Frontend kann
 * darauf abbilden, ohne sich mit String-Inhalten beschäftigen zu müssen.
 *
 * @readonly
 * @enum {string}
 */
const REASON_CODES = Object.freeze({
  OK:                  'ok',
  MISSING_API_KEY:     'missing_api_key',
  PROVIDER_DISABLED:   'provider_disabled',
  SERVER_ONLY_FEATURE: 'server_only_feature',
  NOT_CONFIGURED:      'not_configured',
  UPSTREAM_TIMEOUT:    'upstream_timeout'
});

/**
 * AI v1 (klassisch, ohne Cache/Fallback).  Verfügbar nur mit API-Key.
 *
 * @returns {Capability}
 */
function aiAssessmentV1() {
  if (process.env.GEMINI_API_KEY) {
    return {
      available: true,
      reasonCode: REASON_CODES.OK,
      reason:    'GEMINI_API_KEY ist gesetzt.'
    };
  }
  return {
    available: false,
    reasonCode: REASON_CODES.MISSING_API_KEY,
    reason:    'GEMINI_API_KEY fehlt – KI-Bewertung v1 ist nicht verfügbar.'
  };
}

/**
 * AI v2.  Antwortet auch ohne API-Key noch sinnvoll (deterministischer
 * Fallback), daher gilt das Feature als "available", auch wenn der echte
 * KI-Pfad inaktiv ist – `details.aiCallEnabled` zeigt den Unterschied.
 *
 * @returns {Capability}
 */
function aiAssessmentV2() {
  // Provider-Override "null" deaktiviert KI-Calls vollständig.
  const providerEnv = String(process.env.AI_PROVIDER || 'gemini').toLowerCase();
  const providerDisabled = providerEnv === 'null';

  const hasKey = Boolean(process.env.GEMINI_API_KEY);

  let activeProvider = providerDisabled ? 'null' : 'gemini';
  try {
    // Defensive: dynamic require so tests/mocks don't have to stub it.
    // eslint-disable-next-line global-require
    const { activeProviderName } = require('../ai/providers/index.js');
    activeProvider = activeProviderName();
  } catch (_) { /* fall back to providerEnv */ }

  if (providerDisabled) {
    return {
      available: true, // Fallback liefert noch ein gültiges Ergebnis
      reasonCode: REASON_CODES.PROVIDER_DISABLED,
      reason:    'AI_PROVIDER=null – KI-Calls sind deaktiviert; v2 liefert deterministischen Fallback.',
      details:   { aiCallEnabled: false, provider: activeProvider, fallback: true }
    };
  }
  if (!hasKey) {
    return {
      available: true, // Fallback liefert noch ein gültiges Ergebnis
      reasonCode: REASON_CODES.MISSING_API_KEY,
      reason:    'GEMINI_API_KEY fehlt – v2 liefert deterministischen Fallback ohne KI-Texte.',
      details:   { aiCallEnabled: false, provider: activeProvider, fallback: true }
    };
  }
  return {
    available: true,
    reasonCode: REASON_CODES.OK,
    reason:    'KI-Bewertung v2 inkl. echter KI-Aufrufe ist aktiv.',
    details:   { aiCallEnabled: true, provider: activeProvider, fallback: false }
  };
}

/**
 * Politische Kontextrecherche.  Server-only Feature; ohne Server schlicht
 * nicht erreichbar, daher hier "verfügbar" sobald die Registry existiert.
 *
 * @returns {Capability}
 */
function politicalContext() {
  let cities = [];
  try {
    // eslint-disable-next-line global-require
    const reg = require('../political-context/registry/cityPortalRegistry.js');
    cities = (typeof reg.listSupportedCities === 'function')
      ? reg.listSupportedCities()
      : [];
  } catch (_) { /* registry not loadable */ }

  if (!Array.isArray(cities) || cities.length === 0) {
    return {
      available: false,
      reasonCode: REASON_CODES.NOT_CONFIGURED,
      reason:    'Keine unterstützten Städte registriert.',
      details:   { cities: [] }
    };
  }
  return {
    available: true,
    reasonCode: REASON_CODES.OK,
    reason:    `${cities.length} unterstützte Stadt-Portale registriert.`,
    details:   { cities }
  };
}

/**
 * Video-Export ist ein Server-only Feature; Erfolg setzt voraus, dass
 * Playwright + ffmpeg im Container vorhanden sind.  Wir zeigen `available`
 * auf Endpoint-Ebene, melden aber per `reasonCode`, dass das Feature
 * server-/Docker-gebunden ist.
 *
 * @returns {Capability}
 */
function videoExport() {
  return {
    available: true,
    reasonCode: REASON_CODES.SERVER_ONLY_FEATURE,
    reason:    'Video-Export erfordert den Server und (in der Praxis) das Docker-Image.',
    details:   { dockerRecommended: true }
  };
}

/**
 * Optionale Persistenz-Anbindung an den separaten Analysis Service
 * (`analysis-service/`, Spring Boot).  Konfiguration siehe
 * `server/analysis-service/analysisServiceClient.js`.  Die Capability gilt
 * als "available", sobald `ANALYSIS_SERVICE_BASE_URL` gesetzt **und** das
 * Feature nicht explizit per `ANALYSIS_SERVICE_ENABLED=false` deaktiviert
 * wurde.  Erreichbarkeit selbst wird hier bewusst NICHT geprüft (kein
 * Netz-Call im Status-Endpoint); ein aktiver Liveness-Check kann bei
 * Bedarf separat über {@code analysisServiceClient.probe()} ausgelöst
 * werden.
 *
 * @returns {Capability}
 */
function analysisService() {
  let status = { configured: false, enabled: false, baseUrl: null, timeoutMs: 0, retries: 0 };
  try {
    // eslint-disable-next-line global-require
    const client = require('../analysis-service/analysisServiceClient.js');
    if (typeof client.describeStatus === 'function') {
      status = client.describeStatus();
    }
  } catch (_) { /* module not loadable – treat as not configured */ }

  if (!status.configured) {
    return {
      available: false,
      reasonCode: REASON_CODES.NOT_CONFIGURED,
      reason:    'ANALYSIS_SERVICE_BASE_URL ist nicht gesetzt – Persistenz im Analysis Service ist nicht verfügbar.',
      details:   { configured: false, enabled: false }
    };
  }
  if (!status.enabled) {
    return {
      available: false,
      reasonCode: REASON_CODES.PROVIDER_DISABLED,
      reason:    'Analysis Service ist konfiguriert, aber per ANALYSIS_SERVICE_ENABLED=false deaktiviert.',
      details:   { configured: true, enabled: false, baseUrl: status.baseUrl }
    };
  }
  return {
    available: true,
    reasonCode: REASON_CODES.OK,
    reason:    `Analysis Service konfiguriert (Erreichbarkeit nicht geprüft) unter ${status.baseUrl}.`,
    details:   {
      configured: true,
      enabled:    true,
      baseUrl:    status.baseUrl,
      timeoutMs:  status.timeoutMs,
      retries:    status.retries
    }
  };
}

/**
 * Batch-Jobs im separaten Analysis Service.  Eigene Capability, weil sie
 * unabhängig von der reinen Persistenz-Anbindung von Bedeutung sind: ein
 * konfigurierter aber deaktivierter Service stellt zwar Persistenz nicht
 * bereit, aber Batch-Forwarder sind dann auch automatisch aus.  Wir
 * spiegeln deshalb genau den Verfügbarkeitsstatus der Persistenz-Capability,
 * geben aber zusätzlich die unterstützten Job-Namen mit – das ist der
 * stabile API-Vertrag, an dem sich die Node-/UI-Seite orientieren kann.
 *
 * @returns {Capability}
 */
function batchJobs() {
  const persist = analysisService();
  if (!persist.available) {
    return {
      available:  false,
      reasonCode: persist.reasonCode,
      reason:     'Batch-Jobs benötigen einen erreichbaren Analysis Service: ' + persist.reason,
      details:    Object.assign({ supportedJobs: [] }, persist.details || {})
    };
  }
  return {
    available:  true,
    reasonCode: REASON_CODES.OK,
    reason:     'Batch-Jobs verfügbar (Forwarder zum Analysis Service).',
    details: {
      configured:    true,
      enabled:       true,
      baseUrl:       persist.details && persist.details.baseUrl,
      supportedJobs: ['city-prioritization-job'],
      // Liste der zusätzlichen Lese-/Steuer-Endpunkte, die der
      // Forwarder zum Analysis Service exponiert.  Stabiler API-Vertrag
      // für die UI: anhand dieser Liste kann ohne Probe entschieden
      // werden, ob "Aus Batch laden" und "Lauf neu starten" angeboten
      // werden.
      supportedEndpoints: [
        'POST /api/batch/jobs/city-prioritization',
        'GET /api/batch/jobs',
        'GET /api/batch/jobs/:executionId',
        'GET /api/batch/jobs/:executionId/summary',
        'GET /api/batch/jobs/:executionId/ranking',
        'POST /api/batch/jobs/:executionId/restart'
      ]
    }
  };
}

/**
 * Such-Forwarder zum Analysis Service (Hibernate Search).  Verfügbar,
 * sobald der Service erreichbar ist – ob die Volltext-Indizes selbst
 * bereit sind, kann erst der Service zur Anfragezeit beantworten und
 * wird dort über das Antwort-Feld `searchAvailable` weitergereicht.
 *
 * @returns {Capability}
 */
function search() {
  const persist = analysisService();
  if (!persist.available) {
    return {
      available:  false,
      reasonCode: persist.reasonCode,
      reason:     'Suche benötigt einen erreichbaren Analysis Service: ' + persist.reason,
      details:    Object.assign({ supportedEndpoints: [] }, persist.details || {})
    };
  }
  return {
    available:  true,
    reasonCode: REASON_CODES.OK,
    reason:     'Suche verfügbar (Forwarder zum Analysis Service / Hibernate Search).',
    details: {
      configured: true,
      enabled:    true,
      baseUrl:    persist.details && persist.details.baseUrl,
      supportedEndpoints: [
        'GET /api/search/briefs',
        'GET /api/search/political-refs',
        'GET /api/search/similar/:briefId'
      ]
    }
  };
}

/**
 * Bundesweiter Städte-/Regionen-Katalog.  Server-only feature, da der
 * Katalog im Modul `server/cities/cityRegistry.js` lebt.  Liefert
 * eine kompakte Zusammenfassung (Gesamtzahl, Verteilung über die
 * Support-Stufen A/B/C), damit Frontend und Smoke-Tests sehen, was
 * pro Stufe abgedeckt ist, ohne den vollen Katalog laden zu müssen.
 *
 * @returns {Capability}
 */
function cities() {
  let summary = null;
  try {
    // eslint-disable-next-line global-require
    const { summarize } = require('../cities/cityRegistry.js');
    summary = summarize();
  } catch (err) {
    return {
      available: false,
      reasonCode: REASON_CODES.NOT_CONFIGURED,
      reason:    'Städte-Katalog konnte nicht geladen werden: ' + (err && err.message || 'unbekannt'),
      details:   { total: 0 }
    };
  }
  if (!summary || !summary.total) {
    return {
      available: false,
      reasonCode: REASON_CODES.NOT_CONFIGURED,
      reason:    'Städte-Katalog ist leer.',
      details:   { total: 0 }
    };
  }
  return {
    available: true,
    reasonCode: REASON_CODES.OK,
    reason:    `${summary.total} Städte/Regionen im Katalog (A/B/C-Capability-Matrix verfügbar).`,
    details:   summary
  };
}

/**
 * Liefert eine kompakte Capability-Übersicht für den Status-Endpunkt.
 *
 * @returns {{
 *   capabilities: {
 *     aiAssessmentV1: Capability,
 *     aiAssessmentV2: Capability,
 *     politicalContext: Capability,
 *     videoExport: Capability,
 *     analysisService: Capability,
 *     batchJobs: Capability,
 *     search: Capability,
 *     cities: Capability
 *   }
 * }}
 */
function getCapabilities() {
  return {
    capabilities: {
      aiAssessmentV1:   aiAssessmentV1(),
      aiAssessmentV2:   aiAssessmentV2(),
      politicalContext: politicalContext(),
      videoExport:      videoExport(),
      analysisService:  analysisService(),
      batchJobs:        batchJobs(),
      search:           search(),
      cities:           cities()
    }
  };
}

module.exports = {
  REASON_CODES,
  getCapabilities,
  aiAssessmentV1,
  aiAssessmentV2,
  politicalContext,
  videoExport,
  analysisService,
  batchJobs,
  search,
  cities
};
