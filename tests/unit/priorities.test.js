'use strict';

/**
 * Tests für das Prioritäten-/Ranking-Modul (`server/priorities/`).
 *
 * Geprüft werden:
 *   - stabiles `dataStatus`-Vokabular und Mapping aus `persistence.status`
 *   - Decision-Card-Normalisierung (Konfliktmuster, Maßnahmen, Profil-Score,
 *     politischer Kontext-Hinweis)
 *   - Sortierung „neuester / passendes Profil zuerst"
 *   - Antwort-Envelope (Top-N, leeres Ranking, Fallback)
 *
 * Kein HTTP-Mock nötig: das Modul ist rein funktional.
 */

const {
  DATA_STATUS,
  DATA_STATUS_VALUES,
  mapPersistenceStatusToDataStatus,
  normalizeBriefCard,
  pickLatestPersistedFirst,
  pickTopPatterns,
  pickTopMeasures,
  pickProfileScore,
  buildPrioritiesResponse
} = require('../../server/priorities');

// ── DATA_STATUS-Vokabular ────────────────────────────────────────────────────

describe('priorities – DATA_STATUS', () => {
  test('enthält die vier stabilen Werte und ist eingefroren', () => {
    expect(DATA_STATUS.FRESHLY_COMPUTED).toBe('freshly_computed');
    expect(DATA_STATUS.LOADED_FROM_STORE).toBe('loaded_from_store');
    expect(DATA_STATUS.PERSISTED).toBe('persisted');
    expect(DATA_STATUS.FALLBACK_RESULT).toBe('fallback_result');
    expect(Object.isFrozen(DATA_STATUS)).toBe(true);
    expect(DATA_STATUS_VALUES).toEqual([
      'freshly_computed', 'loaded_from_store', 'persisted', 'fallback_result'
    ]);
  });

  test('mapPersistenceStatusToDataStatus deckt alle bekannten Stati ab', () => {
    expect(mapPersistenceStatusToDataStatus('persisted')).toBe(DATA_STATUS.PERSISTED);
    expect(mapPersistenceStatusToDataStatus('loaded_from_store')).toBe(DATA_STATUS.LOADED_FROM_STORE);
    expect(mapPersistenceStatusToDataStatus('persist_skipped')).toBe(DATA_STATUS.FALLBACK_RESULT);
    expect(mapPersistenceStatusToDataStatus('freshly_computed')).toBe(DATA_STATUS.FRESHLY_COMPUTED);
  });

  test('mapPersistenceStatusToDataStatus fällt für unbekannte/leere Werte konservativ auf freshly_computed', () => {
    expect(mapPersistenceStatusToDataStatus(undefined)).toBe(DATA_STATUS.FRESHLY_COMPUTED);
    expect(mapPersistenceStatusToDataStatus(null)).toBe(DATA_STATUS.FRESHLY_COMPUTED);
    expect(mapPersistenceStatusToDataStatus('')).toBe(DATA_STATUS.FRESHLY_COMPUTED);
    expect(mapPersistenceStatusToDataStatus('something_new')).toBe(DATA_STATUS.FRESHLY_COMPUTED);
  });
});

// ── Hilfs-Helfer ─────────────────────────────────────────────────────────────

describe('priorities – pickTopPatterns', () => {
  test('sortiert Primary vor Secondary und liefert maximal 3 Einträge', () => {
    const r = pickTopPatterns([
      { id: 'a', label: 'A', classification: 'secondary', confidence: 'high' },
      { id: 'b', label: 'B', classification: 'primary',   confidence: 'medium' },
      { id: 'c', label: 'C', classification: 'primary',   confidence: 'low' },
      { id: 'd', label: 'D', classification: 'secondary', confidence: 'high' },
      { id: 'e', label: 'E', classification: 'primary',   confidence: 'medium' }
    ]);
    expect(r).toHaveLength(3);
    expect(r.map(p => p.id)).toEqual(['b', 'c', 'e']);
    expect(r[0].classification).toBe('primary');
  });

  test('akzeptiert sowohl "id" als auch "patternId" und filtert Duplikate', () => {
    const r = pickTopPatterns([
      { patternId: 'right_turn_conflict', label: 'X', classification: 'primary', confidence: 'high' },
      { id: 'right_turn_conflict',         label: 'Y', classification: 'primary', confidence: 'low'  },
      { id: 'left_turn_conflict',          label: 'Z', classification: 'primary', confidence: 'medium' }
    ]);
    expect(r.map(p => p.id)).toEqual(['right_turn_conflict', 'left_turn_conflict']);
  });

  test('liefert leeres Array für ungültige Eingaben', () => {
    expect(pickTopPatterns(null)).toEqual([]);
    expect(pickTopPatterns(undefined)).toEqual([]);
    expect(pickTopPatterns('foo')).toEqual([]);
  });
});

describe('priorities – pickTopMeasures', () => {
  test('bevorzugt empfohlene Maßnahmen, sortiert nach fitScore absteigend', () => {
    const r = pickTopMeasures(
      [
        { id: 'm1', title: 'Schutzstreifen', fitScore: 0.5, costBand: 'low' },
        { id: 'm2', title: 'Protected Bike Lane', fitScore: 0.9, costBand: 'high', implementationEffort: 'medium' },
        { id: 'm3', title: 'Tempo 30', fitScore: 0.7 }
      ],
      [ /* candidates ignoriert wenn recommended vorhanden */
        { id: 'mX', title: 'Anderes', fitScore: 0.99 }
      ]
    );
    expect(r).toHaveLength(2);
    expect(r[0].id).toBe('m2');
    expect(r[0].costBand).toBe('high');
    expect(r[0].effort).toBe('medium');
    expect(r[1].id).toBe('m3');
  });

  test('fällt auf Kandidaten zurück, wenn keine Empfehlungen vorhanden', () => {
    const r = pickTopMeasures([], [
      { measureId: 'mc1', title: 'A', fitScore: 0.4 },
      { measureId: 'mc2', title: 'B', fitScore: 0.8 }
    ]);
    expect(r).toHaveLength(2);
    expect(r[0].id).toBe('mc2');
    expect(r[0].title).toBe('B');
  });

  test('nutzt position als Sekundärkriterium, wenn fitScore fehlt', () => {
    const r = pickTopMeasures([], [
      { measureId: 'a', title: 'A', position: 3 },
      { measureId: 'b', title: 'B', position: 1 },
      { measureId: 'c', title: 'C', position: 2 }
    ]);
    expect(r[0].id).toBe('b'); // niedrigste Position = wichtiger
    expect(r[1].id).toBe('c');
  });

  test('liefert leeres Array, wenn beide Listen leer sind', () => {
    expect(pickTopMeasures([], [])).toEqual([]);
    expect(pickTopMeasures(undefined, undefined)).toEqual([]);
  });
});

describe('priorities – pickProfileScore', () => {
  test('liest Java-Service-Form (profileScores: Liste)', () => {
    const brief = {
      profileScores: [
        { profileKey: 'safety_first',     total: 88.0, subScores: { safetyImpactScore: 0.9 } },
        { profileKey: 'low_hanging_fruit', total: 65.5, subScores: { quickWinScore: 0.8 } }
      ]
    };
    const r = pickProfileScore(brief, 'low_hanging_fruit');
    expect(r.profileKey).toBe('low_hanging_fruit');
    expect(r.total).toBe(65.5);
    expect(r.subScores.quickWinScore).toBe(0.8);
  });

  test('fällt auf ersten Eintrag zurück, wenn das gewünschte Profil fehlt', () => {
    const brief = {
      profileScores: [
        { profileKey: 'safety_first', total: 50, subScores: {} }
      ]
    };
    const r = pickProfileScore(brief, 'unknown_profile');
    expect(r.profileKey).toBe('safety_first');
    expect(r.total).toBe(50);
  });

  test('liest Node-Brief-Form (profileScores.byProfile: Objekt)', () => {
    const brief = {
      profileScores: {
        byProfile: {
          low_hanging_fruit: { profile: 'low_hanging_fruit', total: 12, subScores: { quickWinScore: 1 } }
        }
      }
    };
    const r = pickProfileScore(brief, 'low_hanging_fruit');
    expect(r.profileKey).toBe('low_hanging_fruit');
    expect(r.total).toBe(12);
    expect(r.subScores.quickWinScore).toBe(1);
  });

  test('liefert null-Score, wenn keine Daten vorhanden', () => {
    const r = pickProfileScore({}, 'low_hanging_fruit');
    expect(r.total).toBeNull();
    expect(r.subScores).toBeNull();
    expect(r.profileKey).toBe('low_hanging_fruit');
  });
});

// ── Decision-Card-Normalisierung ─────────────────────────────────────────────

describe('priorities – normalizeBriefCard', () => {
  const javaBrief = {
    id:                'b-1',
    locationKey:       'hannover::altenbekener_damm',
    city:              'Hannover',
    title:             'Maßnahmensteckbrief: Altenbekener Damm',
    profileKey:        'low_hanging_fruit',
    confidence:        0.72,
    schemaVersion:     'locationActionBrief.v1',
    sourceFingerprint: 'sha256:abcd',
    createdAt:         '2026-04-01T10:00:00Z',
    conflictPatterns: [
      { patternId: 'right_turn_conflict', label: 'Rechtsabbiegekonflikt',
        classification: 'PRIMARY', confidence: 'high' },
      { patternId: 'door_zone',           label: 'Dooring',
        classification: 'SECONDARY', confidence: 'medium' }
    ],
    candidateMeasures: [
      { measureId: 'protected_bike_lane', title: 'Geschützte Radspur',
        fitScore: 0.9, costBand: 'high', implementationEffort: 'medium', position: 1 },
      { measureId: 'tempo_30', title: 'Tempo 30',
        fitScore: 0.6, costBand: 'low', implementationEffort: 'low',    position: 2 }
    ],
    profileScores: [
      { profileKey: 'low_hanging_fruit', total: 78, subScores: { quickWinScore: 0.9 } }
    ],
    politicalReferences: [
      { title: 'Antrag X', relevance: 0.8, type: 'Antrag' },
      { title: 'Anfrage Y', relevance: 0.3, type: 'Anfrage' }
    ]
  };

  test('verdichtet einen Java-Brief zu kompakter Karte mit Pflichtfeldern', () => {
    const card = normalizeBriefCard(javaBrief, { preferredProfile: 'low_hanging_fruit' });
    expect(card.id).toBe('b-1');
    expect(card.locationKey).toBe('hannover::altenbekener_damm');
    expect(card.city).toBe('Hannover');
    expect(card.title).toMatch(/Altenbekener Damm/);
    expect(card.profileKey).toBe('low_hanging_fruit');
    expect(card.confidence).toBe(0.72);
    expect(card.score.total).toBe(78);
    expect(card.score.subScores).toEqual({ quickWinScore: 0.9 });
    expect(card.conflictPatterns[0].id).toBe('right_turn_conflict');
    expect(card.conflictPatterns[0].classification).toBe('primary'); // normalisiert
    expect(card.recommendedMeasures[0].id).toBe('protected_bike_lane');
    expect(card.recommendedMeasures[0].fitScore).toBe(0.9);
    expect(card.political.count).toBe(2);
    expect(card.political.hasHighRelevance).toBe(true);
    expect(card.schemaVersion).toBe('locationActionBrief.v1');
    expect(card.sourceFingerprint).toBe('sha256:abcd');
  });

  test('Karte enthält ALLE in der Aufgabenstellung geforderten Vergleichs-Felder', () => {
    const card = normalizeBriefCard(javaBrief);
    // Pflichtfelder: Ort/Titel, Profil, zentrale Scores, Konfliktmuster,
    // empfohlene Maßnahmen, politischer Kontext-Hinweis
    expect(card.title).toBeTruthy();
    expect(card.city).toBeTruthy();
    expect(card.profileKey).toBeTruthy();
    expect(card.score).toBeDefined();
    expect(Array.isArray(card.conflictPatterns)).toBe(true);
    expect(Array.isArray(card.recommendedMeasures)).toBe(true);
    expect(card.political).toBeDefined();
    expect(card.political.count).toBeGreaterThanOrEqual(0);
  });

  test('arbeitet mit einem Node-Brief (meta.city, candidateMeasures)', () => {
    const nodeBrief = {
      title: 'Node-Brief',
      meta: { city: 'Bonn', profile: 'safety_first', areaName: 'Beueler Brücke' },
      conflictPatterns: [{ id: 'p1', label: 'P1', classification: 'primary', confidence: 'high' }],
      candidateMeasures: [{ id: 'm1', title: 'M1', fitScore: 0.5 }],
      profileScores: { byProfile: { safety_first: { profile: 'safety_first', total: 42 } } },
      confidence: 0.4,
      politicalContext: { totalFound: 0 }
    };
    const card = normalizeBriefCard(nodeBrief);
    expect(card.city).toBe('Bonn');
    expect(card.profileKey).toBe('safety_first');
    expect(card.score.total).toBe(42);
    expect(card.recommendedMeasures[0].id).toBe('m1');
    expect(card.political.count).toBe(0);
    expect(card.political.hasHighRelevance).toBe(false);
  });

  test('liefert robuste Defaults für nahezu leere Eingabe', () => {
    const card = normalizeBriefCard({});
    expect(card.title).toBe('Unbekannte Stelle');
    expect(card.conflictPatterns).toEqual([]);
    expect(card.recommendedMeasures).toEqual([]);
    expect(card.score.total).toBeNull();
    expect(card.political.count).toBe(0);
  });
});

// ── Sortierung „neuester / passendes Profil zuerst" ──────────────────────────

describe('priorities – pickLatestPersistedFirst', () => {
  test('Profil-Treffer wird vor anderen Profilen einsortiert, dann nach createdAt', () => {
    const briefs = [
      { id: 'a', profileKey: 'safety_first',     createdAt: '2026-01-01T00:00:00Z' },
      { id: 'b', profileKey: 'low_hanging_fruit', createdAt: '2026-03-01T00:00:00Z' },
      { id: 'c', profileKey: 'low_hanging_fruit', createdAt: '2026-04-15T00:00:00Z' },
      { id: 'd', profileKey: 'safety_first',     createdAt: '2026-04-20T00:00:00Z' }
    ];
    const r = pickLatestPersistedFirst(briefs, 'low_hanging_fruit');
    expect(r.map(x => x.id)).toEqual(['c', 'b', 'd', 'a']);
  });

  test('ohne Profilpräferenz nur nach createdAt absteigend', () => {
    const briefs = [
      { id: 'a', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'b', createdAt: '2026-04-01T00:00:00Z' },
      { id: 'c', createdAt: '2026-03-01T00:00:00Z' }
    ];
    const r = pickLatestPersistedFirst(briefs);
    expect(r.map(x => x.id)).toEqual(['b', 'c', 'a']);
  });

  test('robust gegen leere/nicht-Array Eingaben', () => {
    expect(pickLatestPersistedFirst(undefined)).toEqual([]);
    expect(pickLatestPersistedFirst('foo')).toEqual([]);
    expect(pickLatestPersistedFirst([])).toEqual([]);
  });
});

// ── Antwort-Envelope ─────────────────────────────────────────────────────────

describe('priorities – buildPrioritiesResponse', () => {
  test('Top-N: Items werden weitergereicht, dataStatus loaded_from_store', () => {
    const r = buildPrioritiesResponse({
      mode: 'top',
      items: [{ id: 'a' }, { id: 'b' }],
      dataStatus: 'loaded_from_store',
      query: { city: 'Hannover', profile: 'safety_first', limit: 5 }
    });
    expect(r.mode).toBe('top');
    expect(r.dataStatus).toBe('loaded_from_store');
    expect(r.count).toBe(2);
    expect(r.empty).toBe(false);
    expect(r.items).toHaveLength(2);
    expect(r.query).toEqual({ city: 'Hannover', profile: 'safety_first', limit: 5 });
  });

  test('leeres Ranking → empty:true, count:0, KEIN 404-Signal nötig', () => {
    const r = buildPrioritiesResponse({
      mode: 'top',
      items: [],
      dataStatus: 'loaded_from_store',
      query: { city: 'Bonn', profile: 'low_hanging_fruit' }
    });
    expect(r.empty).toBe(true);
    expect(r.count).toBe(0);
    expect(r.items).toEqual([]);
    expect(r.dataStatus).toBe('loaded_from_store');
  });

  test('Fallback-Antwort enthält fallbackReason und dataStatus fallback_result', () => {
    const r = buildPrioritiesResponse({
      mode: 'top',
      items: [],
      dataStatus: 'fallback_result',
      fallbackReason: 'analysis_service_unconfigured'
    });
    expect(r.dataStatus).toBe('fallback_result');
    expect(r.fallbackReason).toBe('analysis_service_unconfigured');
    expect(r.empty).toBe(true);
  });

  test('unbekannter dataStatus wirft (verhindert versehentliche String-Drift)', () => {
    expect(() => buildPrioritiesResponse({ mode: 'top', items: [], dataStatus: 'bogus' }))
      .toThrow(/unbekannter dataStatus/);
  });

  test('items nicht-Array → leere Liste, count 0', () => {
    const r = buildPrioritiesResponse({ mode: 'top', items: null, dataStatus: 'loaded_from_store' });
    expect(r.items).toEqual([]);
    expect(r.count).toBe(0);
    expect(r.empty).toBe(true);
  });
});
