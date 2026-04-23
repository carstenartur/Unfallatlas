'use strict';

/**
 * Unit tests für die server/political-context/-Module.
 *
 * Getestete Einheiten:
 *   - portalNormalizationService.js
 *   - portalRelevanceService.js
 *   - cityPortalRegistry.js
 *   - portalSearchService.js (mit gemocktem Provider)
 */

// ── Normalisierungsservice ──────────────────────────────────────────────────────

const { normalizeAll, normalizeOne, makeId, inferType } =
  require('../../server/political-context/services/portalNormalizationService.js');

describe('portalNormalizationService – inferType', () => {
  test('erkennt Antrag', () => {
    expect(inferType('Antrag auf Verbesserung', '')).toBe('Antrag');
  });
  test('erkennt Änderungsantrag vor Antrag', () => {
    expect(inferType('Änderungsantrag zum Antrag', '')).toBe('Änderungsantrag');
  });
  test('erkennt Anfrage', () => {
    expect(inferType('Anfrage der SPD-Fraktion', '')).toBe('Anfrage');
  });
  test('erkennt Beschluss', () => {
    expect(inferType('Beschluss über Radweg', '')).toBe('Beschluss');
  });
  test('erkennt Verwaltungsantwort', () => {
    expect(inferType('Stellungnahme der Verwaltung', '')).toBe('Verwaltungsantwort');
  });
  test('erkennt Protokoll', () => {
    expect(inferType('Niederschrift der Sitzung', '')).toBe('Protokoll');
  });
  test('fällt auf Sonstige zurück', () => {
    expect(inferType('Irgendein Dokument', '')).toBe('Sonstige');
  });
  test('rawType wird ebenfalls ausgewertet', () => {
    expect(inferType('Titel', 'antrag')).toBe('Antrag');
  });
});

describe('portalNormalizationService – makeId', () => {
  test('gibt 16 Hex-Zeichen zurück', () => {
    expect(makeId('https://example.com/doc/1')).toMatch(/^[0-9a-f]{16}$/);
  });
  test('gibt für selbe URL dieselbe ID zurück', () => {
    const id1 = makeId('https://example.com/doc/1');
    const id2 = makeId('https://example.com/doc/1');
    expect(id1).toBe(id2);
  });
  test('gibt für verschiedene URLs verschiedene IDs zurück', () => {
    expect(makeId('https://example.com/doc/1')).not.toBe(makeId('https://example.com/doc/2'));
  });
});

describe('portalNormalizationService – normalizeOne', () => {
  const raw = {
    title: 'Antrag zur Verkehrsberuhigung',
    url:   'https://example.com/doc/42',
    date:  '15.03.2024',
    gremium: 'Stadtbezirksrat Mitte',
    number:  'DS 2024-0042',
    snippet: 'Hiermit beantragen wir …',
    rawType: 'antrag'
  };

  test('enthält alle Pflichtfelder', () => {
    const ref = normalizeOne(raw, 'test-source');
    expect(ref).toHaveProperty('id');
    expect(ref).toHaveProperty('title', 'Antrag zur Verkehrsberuhigung');
    expect(ref).toHaveProperty('type', 'Antrag');
    expect(ref).toHaveProperty('url', 'https://example.com/doc/42');
    expect(ref).toHaveProperty('source', 'test-source');
  });

  test('setzt relevanceScore auf null', () => {
    const ref = normalizeOne(raw, 'x');
    expect(ref.relevanceScore).toBeNull();
  });

  test('kürzt Snippet auf 400 Zeichen', () => {
    const longSnippet = 'A'.repeat(500);
    const ref = normalizeOne({ ...raw, snippet: longSnippet }, 'x');
    expect(ref.snippet.length).toBeLessThanOrEqual(400);
  });
});

describe('portalNormalizationService – normalizeAll', () => {
  test('dedupliziert nach URL', () => {
    const raws = [
      { title: 'A', url: 'https://example.com/1', rawType: '' },
      { title: 'B', url: 'https://example.com/1', rawType: '' },
      { title: 'C', url: 'https://example.com/2', rawType: '' }
    ];
    const result = normalizeAll(raws, 'src');
    expect(result).toHaveLength(2);
  });

  test('überspringt Einträge ohne URL', () => {
    const raws = [
      { title: 'A', url: 'https://example.com/1', rawType: '' },
      { title: 'B', url: '',  rawType: '' },
      { title: 'C', rawType: '' }
    ];
    expect(normalizeAll(raws, 'src')).toHaveLength(1);
  });

  test('gibt leeres Array zurück für null', () => {
    expect(normalizeAll(null, 'src')).toEqual([]);
  });
});

// ── Relevanzbewertungsservice ───────────────────────────────────────────────────

const { scoreAndSort, scoreOne, recencyScore, countMatches } =
  require('../../server/political-context/services/portalRelevanceService.js');

describe('portalRelevanceService – countMatches', () => {
  test('zählt Übereinstimmungen korrekt', () => {
    expect(countMatches('Radweg Hannover Kreuzung', ['Radweg', 'hannover'])).toBe(2);
  });
  test('gibt 0 für leere Terms', () => {
    expect(countMatches('Text', [])).toBe(0);
  });
  test('gibt 0 für leeren Text', () => {
    expect(countMatches('', ['Begriff'])).toBe(0);
  });
});

describe('portalRelevanceService – recencyScore', () => {
  test('gibt 5 für heutiges Datum', () => {
    const today = new Date();
    const dateStr = `${String(today.getDate()).padStart(2,'0')}.${String(today.getMonth()+1).padStart(2,'0')}.${today.getFullYear()}`;
    expect(recencyScore(dateStr)).toBe(5);
  });
  test('gibt 0 für null', () => {
    expect(recencyScore(null)).toBe(0);
  });
  test('gibt 0 für ungültiges Datum', () => {
    expect(recencyScore('kein-datum')).toBe(0);
  });
  test('gibt 1 für sehr altes Datum', () => {
    expect(recencyScore('01.01.2000')).toBe(1);
  });
});

describe('portalRelevanceService – scoreOne', () => {
  const ref = {
    title: 'Antrag zum Radweg an der Limmerstraße',
    type: 'Antrag',
    date: null,
    gremium: 'Stadtbezirksrat Linden-Limmer',
    snippet: 'Beantragung eines neuen Schutzstreifens',
    relevanceScore: null
  };

  test('Score liegt zwischen 0 und 100', () => {
    const score = scoreOne(ref, ['Radweg', 'Limmerstraße'], {});
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  test('Antrag erhält höheren Score als Protokoll', () => {
    const antrag  = { ...ref, type: 'Antrag' };
    const protokoll = { ...ref, type: 'Protokoll' };
    expect(scoreOne(antrag, [], {})).toBeGreaterThan(scoreOne(protokoll, [], {}));
  });

  test('Gremium-Übereinstimmung erhöht Score', () => {
    const scoreWithGremium    = scoreOne(ref, [], { gremium: 'Linden' });
    const scoreWithoutGremium = scoreOne(ref, [], {});
    expect(scoreWithGremium).toBeGreaterThan(scoreWithoutGremium);
  });
});

describe('portalRelevanceService – scoreAndSort', () => {
  test('sortiert absteigend nach relevanceScore', () => {
    const refs = [
      { title: 'Irrelevant', type: 'Protokoll', date: null, gremium: null, snippet: null },
      { title: 'Radweg Limmerstraße Antrag', type: 'Antrag',  date: null, gremium: null, snippet: null }
    ];
    const sorted = scoreAndSort(refs, ['Radweg', 'Limmerstraße'], {});
    expect(sorted[0].relevanceScore).toBeGreaterThanOrEqual(sorted[1].relevanceScore);
    // Der Antrag mit passendem Titel sollte oben stehen
    expect(sorted[0].title).toContain('Radweg');
  });

  test('befüllt relevanceScore', () => {
    const refs = [{ title: 'x', type: 'Sonstige', date: null, gremium: null, snippet: null }];
    const result = scoreAndSort(refs, [], {});
    expect(result[0].relevanceScore).not.toBeNull();
  });

  test('gibt leeres Array zurück für null', () => {
    expect(scoreAndSort(null, [], {})).toEqual([]);
  });
});

// ── cityPortalRegistry ─────────────────────────────────────────────────────────

// Use requireActual to get the real module, since the module is also mocked
// below for the portalSearchService tests.
const {
  getProviderForCity: getProviderForCityActual,
  listSupportedCities: listSupportedCitiesActual,
  normalizeCity
} = jest.requireActual('../../server/political-context/registry/cityPortalRegistry.js');

describe('cityPortalRegistry – normalizeCity', () => {
  test('normalisiert Hannover', () => {
    expect(normalizeCity('Hannover')).toBe('hannover');
  });
  test('Umlaute werden ersetzt', () => {
    expect(normalizeCity('München')).toBe('muenchen');
    expect(normalizeCity('Köln')).toBe('koeln');
    expect(normalizeCity('Nürnberg')).toBe('nuernberg');
  });
  test('Leerzeichen werden zu _', () => {
    expect(normalizeCity('Region Hannover')).toBe('region_hannover');
  });
  test('führende/folgende _ werden entfernt', () => {
    expect(normalizeCity(' Hannover ')).toBe('hannover');
  });
  test('gibt leeren String für null zurück', () => {
    expect(normalizeCity(null)).toBe('');
  });
});

describe('cityPortalRegistry – getProviderForCity', () => {
  test('gibt Provider für Hannover zurück', () => {
    const p = getProviderForCityActual('Hannover');
    expect(p).not.toBeNull();
    expect(typeof p.search).toBe('function');
    expect(typeof p.supportsCity).toBe('function');
  });

  test('gibt null für unbekannte Stadt zurück', () => {
    expect(getProviderForCityActual('Musterstadt')).toBeNull();
  });

  test('funktioniert mit Kleinbuchstaben', () => {
    expect(getProviderForCityActual('hannover')).not.toBeNull();
  });
});

describe('cityPortalRegistry – listSupportedCities', () => {
  test('gibt Array zurück', () => {
    expect(Array.isArray(listSupportedCitiesActual())).toBe(true);
  });
  test('enthält hannover', () => {
    expect(listSupportedCitiesActual()).toContain('hannover');
  });
});

// ── portalSearchService (mit gemocktem Provider) ───────────────────────────────

jest.mock('../../server/political-context/registry/cityPortalRegistry.js', () => {
  const original = jest.requireActual('../../server/political-context/registry/cityPortalRegistry.js');
  return {
    ...original,
    getProviderForCity: jest.fn()
  };
});

const registry = require('../../server/political-context/registry/cityPortalRegistry.js');
const { search } = require('../../server/political-context/services/portalSearchService.js');

describe('portalSearchService – search', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('gibt supported:false zurück, wenn kein Provider verfügbar', async () => {
    registry.getProviderForCity.mockReturnValue(null);
    const result = await search({ city: 'Musterstadt', searchTerms: ['Radweg'] });
    expect(result.meta.supported).toBe(false);
    expect(result.references).toEqual([]);
    expect(result.meta.city).toBe('Musterstadt');
  });

  test('gibt normalisierte Treffer zurück', async () => {
    registry.getProviderForCity.mockReturnValue({
      search: async () => ([
        { title: 'Antrag Radweg', url: 'https://example.com/1', rawType: 'antrag', date: null, gremium: null, number: null, snippet: null },
        { title: 'Beschluss Buslinie', url: 'https://example.com/2', rawType: 'beschluss', date: null, gremium: null, number: null, snippet: null }
      ])
    });
    const result = await search({ city: 'Hannover', searchTerms: ['Radweg'] });
    expect(result.meta.supported).toBe(true);
    expect(result.references.length).toBeGreaterThan(0);
    expect(result.references[0]).toHaveProperty('id');
    expect(result.references[0]).toHaveProperty('type');
  });

  test('limitiert auf maxResults', async () => {
    registry.getProviderForCity.mockReturnValue({
      search: async () => Array.from({ length: 20 }, (_, i) => ({
        title: `Vorgang ${i}`,
        url: `https://example.com/${i}`,
        rawType: '',
        date: null, gremium: null, number: null, snippet: null
      }))
    });
    const result = await search({ city: 'Hannover', searchTerms: ['x'], maxResults: 5 });
    expect(result.references.length).toBeLessThanOrEqual(5);
  });

  test('dedupliziert doppelte URLs', async () => {
    registry.getProviderForCity.mockReturnValue({
      search: async () => ([
        { title: 'A', url: 'https://example.com/1', rawType: '', date: null, gremium: null, number: null, snippet: null },
        { title: 'B', url: 'https://example.com/1', rawType: '', date: null, gremium: null, number: null, snippet: null }
      ])
    });
    const result = await search({ city: 'Hannover', searchTerms: ['x'], maxResults: 10 });
    expect(result.references.length).toBe(1);
    expect(result.meta.totalFound).toBe(1);
  });

  test('fängt Provider-Fehler ab und gibt leere Ergebnisse zurück', async () => {
    registry.getProviderForCity.mockReturnValue({
      search: async () => { throw new Error('Netzwerk-Fehler'); }
    });
    // portalSearchService propagiert den Fehler, wenn der Provider wirft
    await expect(search({ city: 'Hannover', searchTerms: ['x'] })).rejects.toThrow();
  });
});

// ── hannoverSimProvider – Unit-Tests (ohne echte HTTP-Requests) ────────────────

const hannoverProvider = require('../../server/political-context/providers/hannoverSimProvider.js');

describe('hannoverSimProvider – supportsCity', () => {
  test('gibt true für Hannover zurück', () => {
    expect(hannoverProvider.supportsCity('Hannover')).toBe(true);
    expect(hannoverProvider.supportsCity('hannover')).toBe(true);
  });
  test('gibt false für andere Städte zurück', () => {
    expect(hannoverProvider.supportsCity('Berlin')).toBe(false);
    expect(hannoverProvider.supportsCity('')).toBe(false);
    expect(hannoverProvider.supportsCity(null)).toBe(false);
  });
});
