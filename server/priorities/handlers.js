'use strict';

/**
 * Express-Handler-Fabrik für die Prioritäten-Endpunkte.
 *
 * Bewusst von `server/index.js` getrennt, damit:
 *   - die Handler ohne HTTP-Server testbar sind (siehe
 *     `tests/unit/priorities.handlers.test.js`),
 *   - der Analysis-Service-Client per Dependency-Injection ausgetauscht
 *     werden kann (Mock im Test, echter Client in Produktion),
 *   - die Wiring-Schicht in `server/index.js` minimal bleibt.
 *
 * Konvention:
 *   - Leere Resultate kommen mit HTTP 200 + `{ empty: true, items: [] }`,
 *     niemals als 404 – die UI braucht zwischen „kein Ranking gespeichert"
 *     und „Service nicht erreichbar" zu unterscheiden.
 *   - Ist der Analysis Service nicht verfügbar, antworten wir mit HTTP 200
 *     + `dataStatus: "fallback_result"` und `fallbackReason`.  So kann die
 *     Werkbank auch ohne Persistenz sinnvoll degradieren.
 *   - Validierungsfehler nutzen den vorhandenen `sendError`-Envelope und
 *     liefern HTTP 4xx; sie unterscheiden sich klar von Fallback-Antworten.
 *
 * @module server/priorities/handlers
 */

const priorities = require('./index.js');

/**
 * Erstellt die Handler.  Die Abhängigkeiten werden injiziert, damit Tests
 * einen Stub für den Analysis-Service-Client bereitstellen können.
 *
 * @param {{
 *   analysisServiceClient: {
 *     describeStatus: function(): {configured:boolean, enabled:boolean},
 *     fetchTopByCityProfile: function(string,string,number): Promise<object>,
 *     fetchByLocationKey: function(string): Promise<object>
 *   },
 *   profileIds: string[],
 *   defaultProfile: string,
 *   sendError: function,
 *   categories: object
 * }} deps
 */
function createPrioritiesHandlers(deps) {
  if (!deps || !deps.analysisServiceClient) {
    throw new Error('createPrioritiesHandlers: analysisServiceClient ist Pflicht.');
  }
  const {
    analysisServiceClient,
    profileIds,
    defaultProfile,
    sendError,
    categories
  } = deps;

  /**
   * GET /api/priorities/profiles
   * Stabile Liste der Profile + dataStatus-Vokabular.  Hängt **nicht**
   * vom Analysis Service ab – funktioniert auch im Browser-only-Modus.
   */
  function profilesHandler(_req, res) {
    res.json({
      profiles:         (profileIds || []).slice(),
      defaultProfile:   defaultProfile || (profileIds && profileIds[0]) || null,
      dataStatusValues: priorities.DATA_STATUS_VALUES.slice()
    });
  }

  /**
   * GET /api/priorities/top?city=&profile=&limit=
   */
  async function topHandler(req, res) {
    const city    = String((req.query && req.query.city)    || '').trim();
    const profile = String((req.query && req.query.profile) || '').trim();
    const limit   = Number((req.query && req.query.limit))  || 10;

    if (!city || !profile) {
      return sendError(res, {
        category: categories.INVALID_REQUEST,
        code:     'CITY_AND_PROFILE_REQUIRED',
        message:  'Pflicht-Query-Parameter "city" und "profile" fehlen.'
      });
    }
    if (profileIds && profileIds.length > 0 && !profileIds.includes(profile)) {
      return sendError(res, {
        category: categories.INVALID_REQUEST,
        code:     'UNKNOWN_PROFILE',
        message:  `Unbekanntes Profil "${profile}". Erlaubt: ${profileIds.join(', ')}`
      });
    }

    const status = analysisServiceClient.describeStatus();
    if (!status.configured || !status.enabled) {
      return res.json(priorities.buildPrioritiesResponse({
        mode:           'top',
        items:          [],
        dataStatus:     priorities.DATA_STATUS.FALLBACK_RESULT,
        fallbackReason: status.configured ? 'analysis_service_disabled' : 'analysis_service_unconfigured',
        query:          { city, profile, limit }
      }));
    }

    const result = await analysisServiceClient.fetchTopByCityProfile(city, profile, limit);
    if (!result.ok && result.status !== 404) {
      return res.json(priorities.buildPrioritiesResponse({
        mode:           'top',
        items:          [],
        dataStatus:     priorities.DATA_STATUS.FALLBACK_RESULT,
        fallbackReason: result.error || 'analysis_service_unreachable',
        query:          { city, profile, limit }
      }));
    }
    const raw   = (result.ok && Array.isArray(result.data)) ? result.data : [];
    const items = raw.map((b) => priorities.normalizeBriefCard(b, { preferredProfile: profile }));
    return res.json(priorities.buildPrioritiesResponse({
      mode:       'top',
      items,
      dataStatus: priorities.DATA_STATUS.LOADED_FROM_STORE,
      query:      { city, profile, limit }
    }));
  }

  /**
   * GET /api/priorities/by-location/:locationKey?profile=
   */
  async function byLocationHandler(req, res) {
    const key     = String((req.params && req.params.locationKey) || '').trim();
    const profile = String((req.query && req.query.profile)       || '').trim();

    if (!key) {
      return sendError(res, {
        category: categories.INVALID_REQUEST,
        code:     'LOCATION_KEY_REQUIRED',
        message:  'Pflicht-Pfadparameter "locationKey" fehlt.'
      });
    }
    if (profile && profileIds && profileIds.length > 0 && !profileIds.includes(profile)) {
      return sendError(res, {
        category: categories.INVALID_REQUEST,
        code:     'UNKNOWN_PROFILE',
        message:  `Unbekanntes Profil "${profile}". Erlaubt: ${profileIds.join(', ')}`
      });
    }

    const status = analysisServiceClient.describeStatus();
    if (!status.configured || !status.enabled) {
      return res.json(priorities.buildPrioritiesResponse({
        mode:           'by-location',
        items:          [],
        dataStatus:     priorities.DATA_STATUS.FALLBACK_RESULT,
        fallbackReason: status.configured ? 'analysis_service_disabled' : 'analysis_service_unconfigured',
        query:          { locationKey: key, profile: profile || null }
      }));
    }

    const result = await analysisServiceClient.fetchByLocationKey(key);
    if (!result.ok && result.status !== 404) {
      return res.json(priorities.buildPrioritiesResponse({
        mode:           'by-location',
        items:          [],
        dataStatus:     priorities.DATA_STATUS.FALLBACK_RESULT,
        fallbackReason: result.error || 'analysis_service_unreachable',
        query:          { locationKey: key, profile: profile || null }
      }));
    }
    const raw    = (result.ok && Array.isArray(result.data)) ? result.data : [];
    const sorted = priorities.pickLatestPersistedFirst(raw, profile);
    const items  = sorted.map((b) => priorities.normalizeBriefCard(b, { preferredProfile: profile }));
    return res.json(priorities.buildPrioritiesResponse({
      mode:       'by-location',
      items,
      dataStatus: priorities.DATA_STATUS.LOADED_FROM_STORE,
      query:      { locationKey: key, profile: profile || null }
    }));
  }

  return { profilesHandler, topHandler, byLocationHandler };
}

module.exports = { createPrioritiesHandlers };
