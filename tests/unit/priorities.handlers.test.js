'use strict';

/**
 * Tests für die Prioritäten-Handler (`server/priorities/handlers.js`).
 *
 * Geprüft wird die HTTP-Vertragsschicht ohne echten Express-Server: ein
 * stub'd `analysisServiceClient` wird injiziert und einfache `req`/`res`-
 * Objekte simulieren die Express-Schnittstelle.
 *
 * Abdeckung der Aufgabenstellung:
 *   - Top-N Abruf
 *   - leeres Ranking → `empty: true`, `count: 0`, dataStatus loaded_from_store
 *   - gespeicherter Brief wird geladen (by-location)
 *   - Fallback wenn Analysis Service fehlt (unconfigured / disabled / unreachable)
 *   - Statuskennzeichnung korrekt (alle vier `dataStatus`-Werte sichtbar)
 */

const { createPrioritiesHandlers } = require('../../server/priorities/handlers.js');
const { CATEGORIES, sendError }    = require('../../server/lib/errors.js');

const PROFILE_IDS    = ['low_hanging_fruit', 'safety_first'];
const DEFAULT_PROFILE = 'low_hanging_fruit';

function makeClient(overrides) {
  const o = overrides || {};
  return Object.assign({
    describeStatus: () => ({ configured: true, enabled: true }),
    fetchTopByCityProfile: async () => ({ ok: true, status: 200, data: [], attempts: 1 }),
    fetchByLocationKey:    async () => ({ ok: true, status: 200, data: [], attempts: 1 })
  }, o);
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
  return res;
}

function makeHandlers(client) {
  return createPrioritiesHandlers({
    analysisServiceClient: client,
    profileIds:            PROFILE_IDS,
    defaultProfile:        DEFAULT_PROFILE,
    sendError,
    categories:            CATEGORIES
  });
}

// ── /api/priorities/profiles ─────────────────────────────────────────────────

describe('priorities handlers – /profiles', () => {
  test('liefert Profile + dataStatusValues, unabhängig vom Service', () => {
    const h = makeHandlers(makeClient({ describeStatus: () => ({ configured: false, enabled: false }) }));
    const res = makeRes();
    h.profilesHandler({}, res);
    expect(res.body.profiles).toEqual(PROFILE_IDS);
    expect(res.body.defaultProfile).toBe(DEFAULT_PROFILE);
    expect(res.body.dataStatusValues).toEqual([
      'freshly_computed', 'loaded_from_store', 'persisted', 'fallback_result'
    ]);
  });
});

// ── /api/priorities/top ──────────────────────────────────────────────────────

describe('priorities handlers – /top', () => {
  test('Erfolg: liefert normalisierte Decision-Cards mit dataStatus loaded_from_store', async () => {
    const upstreamPayload = [
      {
        id: 'b-1', locationKey: 'hannover::a', city: 'Hannover',
        title: 'Stelle A', profileKey: 'low_hanging_fruit', confidence: 0.8,
        conflictPatterns: [{ patternId: 'right_turn_conflict', label: 'RTC',
          classification: 'PRIMARY', confidence: 'high' }],
        candidateMeasures: [{ measureId: 'protected_bike_lane', title: 'Schutzspur',
          fitScore: 0.9, costBand: 'high', implementationEffort: 'medium', position: 1 }],
        profileScores: [{ profileKey: 'low_hanging_fruit', total: 80, subScores: { quickWinScore: 0.7 } }],
        politicalReferences: [{ title: 'Antrag', relevance: 0.9 }],
        createdAt: '2026-04-01T00:00:00Z'
      }
    ];
    const client = makeClient({
      fetchTopByCityProfile: async (city, profile, limit) => {
        expect(city).toBe('Hannover');
        expect(profile).toBe('low_hanging_fruit');
        expect(limit).toBe(5);
        return { ok: true, status: 200, data: upstreamPayload, attempts: 1 };
      }
    });
    const h = makeHandlers(client);
    const res = makeRes();
    await h.topHandler({ query: { city: 'Hannover', profile: 'low_hanging_fruit', limit: 5 } }, res);

    expect(res.body.mode).toBe('top');
    expect(res.body.dataStatus).toBe('loaded_from_store');
    expect(res.body.empty).toBe(false);
    expect(res.body.count).toBe(1);
    expect(res.body.items[0].locationKey).toBe('hannover::a');
    expect(res.body.items[0].score.total).toBe(80);
    expect(res.body.items[0].conflictPatterns[0].id).toBe('right_turn_conflict');
    expect(res.body.items[0].recommendedMeasures[0].id).toBe('protected_bike_lane');
    expect(res.body.items[0].political.count).toBe(1);
    expect(res.body.items[0].political.hasHighRelevance).toBe(true);
    expect(res.body.query).toEqual({ city: 'Hannover', profile: 'low_hanging_fruit', limit: 5 });
  });

  test('leeres Ranking: empty=true, count=0, dataStatus loaded_from_store (kein 404)', async () => {
    const client = makeClient({
      fetchTopByCityProfile: async () => ({ ok: true, status: 200, data: [], attempts: 1 })
    });
    const h = makeHandlers(client);
    const res = makeRes();
    await h.topHandler({ query: { city: 'Bonn', profile: 'safety_first' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.empty).toBe(true);
    expect(res.body.count).toBe(0);
    expect(res.body.items).toEqual([]);
    expect(res.body.dataStatus).toBe('loaded_from_store');
  });

  test('Service unkonfiguriert: dataStatus fallback_result + fallbackReason', async () => {
    const client = makeClient({ describeStatus: () => ({ configured: false, enabled: false }) });
    const h = makeHandlers(client);
    const res = makeRes();
    await h.topHandler({ query: { city: 'Hannover', profile: 'safety_first' } }, res);
    expect(res.body.dataStatus).toBe('fallback_result');
    expect(res.body.fallbackReason).toBe('analysis_service_unconfigured');
    expect(res.body.empty).toBe(true);
  });

  test('Service deaktiviert (configured=true, enabled=false): fallback_result mit Grund analysis_service_disabled', async () => {
    const client = makeClient({ describeStatus: () => ({ configured: true, enabled: false }) });
    const h = makeHandlers(client);
    const res = makeRes();
    await h.topHandler({ query: { city: 'X', profile: 'safety_first' } }, res);
    expect(res.body.dataStatus).toBe('fallback_result');
    expect(res.body.fallbackReason).toBe('analysis_service_disabled');
  });

  test('Upstream-Fehler 5xx wird zu sanftem fallback_result mit Reason aus dem Client', async () => {
    const client = makeClient({
      fetchTopByCityProfile: async () => ({ ok: false, status: 503, error: 'http_503', attempts: 2 })
    });
    const h = makeHandlers(client);
    const res = makeRes();
    await h.topHandler({ query: { city: 'X', profile: 'safety_first' } }, res);
    expect(res.body.dataStatus).toBe('fallback_result');
    expect(res.body.fallbackReason).toBe('http_503');
    expect(res.body.empty).toBe(true);
  });

  test('404 vom Upstream gilt als „kein Ranking gespeichert" (loaded_from_store + empty)', async () => {
    const client = makeClient({
      fetchTopByCityProfile: async () => ({ ok: false, status: 404, error: 'http_404', attempts: 1 })
    });
    const h = makeHandlers(client);
    const res = makeRes();
    await h.topHandler({ query: { city: 'X', profile: 'safety_first' } }, res);
    expect(res.body.dataStatus).toBe('loaded_from_store');
    expect(res.body.empty).toBe(true);
  });

  test('fehlende city/profile → sendError', async () => {
    const h = makeHandlers(makeClient());
    const res = makeRes();
    await h.topHandler({ query: { city: '', profile: '' } }, res);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.body.error).toBeDefined();
    expect(res.body.code).toBe('CITY_AND_PROFILE_REQUIRED');
  });

  test('unbekanntes Profil → 4xx UNKNOWN_PROFILE', async () => {
    const h = makeHandlers(makeClient());
    const res = makeRes();
    await h.topHandler({ query: { city: 'Hannover', profile: 'bogus' } }, res);
    expect(res.body.code).toBe('UNKNOWN_PROFILE');
  });
});

// ── /api/priorities/by-location ──────────────────────────────────────────────

describe('priorities handlers – /by-location', () => {
  test('lädt gespeicherte Briefs, neuester / passendes Profil zuerst', async () => {
    const upstream = [
      { id: 'old-other',  locationKey: 'h::a', profileKey: 'safety_first',
        title: 'Old', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'new-pref',   locationKey: 'h::a', profileKey: 'low_hanging_fruit',
        title: 'NewPref', createdAt: '2026-04-15T00:00:00Z',
        profileScores: [{ profileKey: 'low_hanging_fruit', total: 70 }] },
      { id: 'older-pref', locationKey: 'h::a', profileKey: 'low_hanging_fruit',
        title: 'OlderPref', createdAt: '2026-02-01T00:00:00Z' }
    ];
    const client = makeClient({
      fetchByLocationKey: async (key) => {
        expect(key).toBe('h::a');
        return { ok: true, status: 200, data: upstream, attempts: 1 };
      }
    });
    const h = makeHandlers(client);
    const res = makeRes();
    await h.byLocationHandler({
      params: { locationKey: 'h::a' },
      query:  { profile: 'low_hanging_fruit' }
    }, res);

    expect(res.body.dataStatus).toBe('loaded_from_store');
    expect(res.body.empty).toBe(false);
    // Reihenfolge: passendes Profil zuerst (nach createdAt), dann andere
    expect(res.body.items.map(x => x.id)).toEqual(['new-pref', 'older-pref', 'old-other']);
    expect(res.body.query.locationKey).toBe('h::a');
  });

  test('leerer Ort: empty=true ohne 404', async () => {
    const client = makeClient({
      fetchByLocationKey: async () => ({ ok: true, status: 200, data: [], attempts: 1 })
    });
    const h = makeHandlers(client);
    const res = makeRes();
    await h.byLocationHandler({ params: { locationKey: 'unknown' }, query: {} }, res);
    expect(res.body.empty).toBe(true);
    expect(res.body.dataStatus).toBe('loaded_from_store');
  });

  test('Fallback bei nicht erreichbarem Service: dataStatus fallback_result', async () => {
    const client = makeClient({ describeStatus: () => ({ configured: false, enabled: false }) });
    const h = makeHandlers(client);
    const res = makeRes();
    await h.byLocationHandler({ params: { locationKey: 'h::a' }, query: {} }, res);
    expect(res.body.dataStatus).toBe('fallback_result');
    expect(res.body.fallbackReason).toBe('analysis_service_unconfigured');
  });

  test('fehlender locationKey → 4xx LOCATION_KEY_REQUIRED', async () => {
    const h = makeHandlers(makeClient());
    const res = makeRes();
    await h.byLocationHandler({ params: { locationKey: '' }, query: {} }, res);
    expect(res.body.code).toBe('LOCATION_KEY_REQUIRED');
  });

  test('unbekanntes Profil → UNKNOWN_PROFILE', async () => {
    const h = makeHandlers(makeClient());
    const res = makeRes();
    await h.byLocationHandler({ params: { locationKey: 'h::a' }, query: { profile: 'wat' } }, res);
    expect(res.body.code).toBe('UNKNOWN_PROFILE');
  });
});

// ── Statuskennzeichnung: alle vier Werte tatsächlich erreichbar ──────────────

describe('priorities handlers – Statuskennzeichnung', () => {
  test('alle vier dataStatus-Werte sind über die API beobachtbar', async () => {
    // 1. loaded_from_store (Top-N erfolgreich)
    let res = makeRes();
    await makeHandlers(makeClient({
      fetchTopByCityProfile: async () => ({ ok: true, data: [{ id: 'x', locationKey: 'h::a', profileKey: 'safety_first', title: 'T' }] })
    })).topHandler({ query: { city: 'H', profile: 'safety_first' } }, res);
    expect(res.body.dataStatus).toBe('loaded_from_store');

    // 2. fallback_result (Service unkonfiguriert)
    res = makeRes();
    await makeHandlers(makeClient({ describeStatus: () => ({ configured: false, enabled: false }) }))
      .topHandler({ query: { city: 'H', profile: 'safety_first' } }, res);
    expect(res.body.dataStatus).toBe('fallback_result');

    // 3. + 4. (freshly_computed, persisted) sind Brief-Endpunkt-spezifisch und
    // werden in tests/unit/locationBrief/* abgedeckt; hier verifizieren wir
    // wenigstens, dass das Vokabular `freshly_computed` und `persisted` kennt.
    const profilesRes = makeRes();
    makeHandlers(makeClient()).profilesHandler({}, profilesRes);
    expect(profilesRes.body.dataStatusValues).toContain('freshly_computed');
    expect(profilesRes.body.dataStatusValues).toContain('persisted');
  });
});
