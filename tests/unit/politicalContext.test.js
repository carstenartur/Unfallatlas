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
const { sharedCache: politicalSearchCache } =
  require('../../server/political-context/services/portalSearchCache.js');

describe('portalSearchService – search', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    // Shared in-memory Cache zwischen Tests leeren, damit Treffer aus dem
    // vorherigen Testcase nicht in den nächsten Test bleeden.
    politicalSearchCache.clear();
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

  test('propagiert Provider-Fehler an den Aufrufer', async () => {
    registry.getProviderForCity.mockReturnValue({
      search: async () => { throw new Error('Netzwerk-Fehler'); }
    });
    // portalSearchService schluckt Provider-Fehler bewusst nicht – einzelne
    // fehlgeschlagene HTTP-Requests werden bereits *innerhalb* der Provider
    // (per try/catch um jeden Suchbegriff) abgefangen.  Wirft ein Provider
    // dennoch, soll der Aufrufer (z. B. der HTTP-Layer in server/index.js)
    // entscheiden können, wie er reagiert.
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

// ── Reicheres Referenzmodell – Folge-PR A ──────────────────────────────────────

describe('hannoverSimProvider – mapReferenceType', () => {
  const { mapReferenceType } = hannoverProvider;
  test('mapped Antrag/Änderungsantrag auf Antrag', () => {
    expect(mapReferenceType('Antrag')).toBe('Antrag');
    expect(mapReferenceType('Änderungsantrag')).toBe('Antrag');
  });
  test('mapped Protokoll auf Protokollnotiz', () => {
    expect(mapReferenceType('Protokoll')).toBe('Protokollnotiz');
  });
  test('Sonstige wird "verwandtes Thema"', () => {
    expect(mapReferenceType('Sonstige')).toBe('verwandtes Thema');
    expect(mapReferenceType('UnbekannterTyp')).toBe('verwandtes Thema');
  });
  test('Beschluss/Anfrage/Verwaltungsantwort bleiben gleich', () => {
    expect(mapReferenceType('Beschluss')).toBe('Beschluss');
    expect(mapReferenceType('Anfrage')).toBe('Anfrage');
    expect(mapReferenceType('Verwaltungsantwort')).toBe('Verwaltungsantwort');
  });
});

describe('hannoverSimProvider – classifyTermLocation', () => {
  const { classifyTermLocation } = hannoverProvider;
  test('erkennt Straßen', () => {
    expect(classifyTermLocation('Limmerstraße')).toBe('street');
    expect(classifyTermLocation('Marienstraße Querung')).toBe('street');
    expect(classifyTermLocation('Lister Platz')).toBe('street');
    expect(classifyTermLocation('Lange Allee')).toBe('street');
  });
  test('erkennt Stadtbezirke', () => {
    expect(classifyTermLocation('Stadtbezirk Linden-Limmer')).toBe('district');
    expect(classifyTermLocation('Stadtteil Mitte')).toBe('district');
  });
  test('fällt auf topic-only zurück', () => {
    expect(classifyTermLocation('Radverkehr')).toBe('topic-only');
    expect(classifyTermLocation('')).toBe('topic-only');
  });
});

describe('hannoverSimProvider – enrichWithReferenceModel', () => {
  const { enrichWithReferenceModel } = hannoverProvider;
  const baseRaw = {
    title:   'Antrag zur Verkehrsberuhigung Limmerstraße',
    url:     'https://example.com/doc/1',
    date:    '15.03.2024',
    gremium: 'Stadtbezirksrat Linden-Limmer',
    number:  'DS 2024-0042',
    snippet: 'Beantragung einer Tempo-30-Zone in der Limmerstraße.',
    rawType: 'antrag'
  };

  test('befüllt alle neuen Felder', () => {
    const enriched = enrichWithReferenceModel(baseRaw, 'Limmerstraße');
    expect(enriched).toHaveProperty('referenceType');
    expect(enriched).toHaveProperty('reason');
    expect(enriched).toHaveProperty('locationMatch');
    expect(enriched).toHaveProperty('topicMatch');
    expect(enriched).toHaveProperty('streetHints');
    expect(enriched).toHaveProperty('areaHints');
  });

  test('referenceType wird über inferType + Mapping gesetzt', () => {
    expect(enrichWithReferenceModel(baseRaw, 'x').referenceType).toBe('Antrag');
    const beschluss = { ...baseRaw, title: 'Beschluss über Radweg', rawType: '' };
    expect(enrichWithReferenceModel(beschluss, 'x').referenceType).toBe('Beschluss');
  });

  test('topicMatch enthält den Suchbegriff, wenn er im Titel vorkommt', () => {
    const enriched = enrichWithReferenceModel(baseRaw, 'Limmerstraße');
    expect(enriched.topicMatch).toContain('Limmerstraße');
  });

  test('topicMatch ist leer, wenn der Suchbegriff nicht vorkommt', () => {
    const enriched = enrichWithReferenceModel(baseRaw, 'Fössebad');
    expect(enriched.topicMatch).toEqual([]);
  });

  test('locationMatch klassifiziert Straße', () => {
    expect(enrichWithReferenceModel(baseRaw, 'Limmerstraße').locationMatch).toBe('street');
  });

  test('locationMatch klassifiziert Stadtbezirk', () => {
    expect(enrichWithReferenceModel(baseRaw, 'Stadtbezirk Linden-Limmer').locationMatch).toBe('district');
  });

  test('reason verweist auf Titeltreffer', () => {
    const enriched = enrichWithReferenceModel(baseRaw, 'Limmerstraße');
    expect(enriched.reason).toContain('Titel');
    expect(enriched.reason).toContain('Limmerstraße');
  });

  test('reason ist auf 240 Zeichen begrenzt', () => {
    const longTerm = 'A'.repeat(500);
    const enriched = enrichWithReferenceModel(baseRaw, longTerm);
    expect(enriched.reason.length).toBeLessThanOrEqual(240);
  });

  test('streetHints extrahiert Straßennamen aus Titel/Snippet', () => {
    const enriched = enrichWithReferenceModel(baseRaw, 'Tempo 30');
    expect(enriched.streetHints.some(s => s.includes('limmerstraße'))).toBe(true);
  });

  test('originalfelder bleiben unverändert', () => {
    const enriched = enrichWithReferenceModel(baseRaw, 'Limmerstraße');
    expect(enriched.title).toBe(baseRaw.title);
    expect(enriched.url).toBe(baseRaw.url);
    expect(enriched.gremium).toBe(baseRaw.gremium);
  });
});

describe('portalNormalizationService – Reicheres Referenzmodell', () => {
  test('reicht alle neuen Felder unverändert durch', () => {
    const raw = {
      title:         'Antrag X',
      url:           'https://example.com/doc/42',
      rawType:       'antrag',
      referenceType: 'Antrag',
      reason:        'Suchbegriff „Limmerstraße" im Titel.',
      locationMatch: 'street',
      topicMatch:    ['Limmerstraße'],
      streetHints:   ['limmerstraße'],
      areaHints:     []
    };
    const ref = normalizeOne(raw, 'hannover-sim');
    expect(ref.referenceType).toBe('Antrag');
    expect(ref.reason).toBe('Suchbegriff „Limmerstraße" im Titel.');
    expect(ref.locationMatch).toBe('street');
    expect(ref.topicMatch).toEqual(['Limmerstraße']);
    expect(ref.streetHints).toEqual(['limmerstraße']);
    expect(ref.areaHints).toEqual([]);
  });

  test('defensive Defaults für fehlende neue Felder', () => {
    const raw = { title: 'A', url: 'https://example.com/x', rawType: '' };
    const ref = normalizeOne(raw, 'src');
    expect(ref.referenceType).toBeNull();
    expect(ref.reason).toBeNull();
    expect(ref.locationMatch).toBeNull();
    expect(ref.topicMatch).toBeNull();
    expect(ref.streetHints).toEqual([]);
    expect(ref.areaHints).toEqual([]);
  });

  test('verwirft ungültige enum-Werte', () => {
    const raw = {
      title: 'A', url: 'https://example.com/x', rawType: '',
      referenceType: 'KEIN_GUELTIGER_TYP',
      locationMatch: 'irgendwas'
    };
    const ref = normalizeOne(raw, 'src');
    expect(ref.referenceType).toBeNull();
    expect(ref.locationMatch).toBeNull();
  });

  test('kürzt überlangen reason auf 240 Zeichen', () => {
    const raw = {
      title: 'A', url: 'https://example.com/x', rawType: '',
      reason: 'X'.repeat(500)
    };
    const ref = normalizeOne(raw, 'src');
    expect(ref.reason.length).toBeLessThanOrEqual(240);
  });

  test('coerciert nicht-String-Einträge in *Hints heraus', () => {
    const raw = {
      title: 'A', url: 'https://example.com/x', rawType: '',
      streetHints: ['Limmerstraße', 42, '', null, '  Engelbosteler Damm  '],
      areaHints:   'kein-array'
    };
    const ref = normalizeOne(raw, 'src');
    expect(ref.streetHints).toEqual(['Limmerstraße', 'Engelbosteler Damm']);
    expect(ref.areaHints).toEqual([]);
  });
});

// ── Neue Stadt-Provider: Berlin / Bonn / Hamburg ───────────────────────────────

const berlinProvider  = require('../../server/political-context/providers/berlinAllrisProvider.js');
const bonnProvider    = require('../../server/political-context/providers/bonnAllrisProvider.js');
const hamburgProvider = require('../../server/political-context/providers/hamburgParldokProvider.js');

describe('berlinAllrisProvider – supportsCity', () => {
  test('akzeptiert Berlin', () => {
    expect(berlinProvider.supportsCity('Berlin')).toBe(true);
    expect(berlinProvider.supportsCity('berlin')).toBe(true);
  });
  test('lehnt andere Städte ab', () => {
    expect(berlinProvider.supportsCity('Hannover')).toBe(false);
    expect(berlinProvider.supportsCity('Bonn')).toBe(false);
    expect(berlinProvider.supportsCity('')).toBe(false);
    expect(berlinProvider.supportsCity(null)).toBe(false);
  });
  test('exponiert _key für Logging/Meta', () => {
    expect(berlinProvider._key).toBe('berlin-allris');
  });
});

describe('berlinAllrisProvider – parseResults', () => {
  test('extrahiert Titel, URL, Datum und Drucksachennummer aus Tabellenzeile', () => {
    const html = `
      <table>
        <tr>
          <td><a href="/starweb/adis/citat/VT/19/Document?id=42">Antrag zur Verkehrsberuhigung Friedrichstraße</a></td>
          <td>15.03.2024</td>
          <td>Abgeordnetenhaus von Berlin</td>
          <td>Drs 19/12345</td>
        </tr>
      </table>`;
    const out = berlinProvider.parseResults(html, 'https://pardok.parlament-berlin.de');
    expect(out).toHaveLength(1);
    expect(out[0].title).toContain('Friedrichstraße');
    expect(out[0].url).toMatch(/^https:\/\/pardok\.parlament-berlin\.de\//);
    expect(out[0].date).toBe('15.03.2024');
    expect(out[0].number).toBe('Drs 19/12345');
    expect(out[0].gremium).toMatch(/Abgeordnetenhaus/);
  });
  test('liefert leeres Array für leeres HTML', () => {
    expect(berlinProvider.parseResults('', 'https://x')).toEqual([]);
    expect(berlinProvider.parseResults('<html></html>', 'https://x')).toEqual([]);
  });
});

describe('bonnAllrisProvider – supportsCity', () => {
  test('akzeptiert Bonn', () => {
    expect(bonnProvider.supportsCity('Bonn')).toBe(true);
    expect(bonnProvider.supportsCity('bonn')).toBe(true);
  });
  test('lehnt andere Städte ab', () => {
    expect(bonnProvider.supportsCity('Köln')).toBe(false);
    expect(bonnProvider.supportsCity('Berlin')).toBe(false);
    expect(bonnProvider.supportsCity('')).toBe(false);
    expect(bonnProvider.supportsCity(null)).toBe(false);
  });
  test('exponiert _key', () => {
    expect(bonnProvider._key).toBe('bonn-allris');
  });
});

describe('bonnAllrisProvider – buildSearchUrl', () => {
  test('enthält PORTAL_BASE und Suchparameter', () => {
    const url = bonnProvider.buildSearchUrl('Limmerstraße');
    expect(url).toMatch(/^https:\/\/www2\.bonn\.de\//);
    expect(url).toMatch(/SUCH=Limmerstra/);
    expect(url).toMatch(/SUCH_OBJ=V/);
  });
});

describe('bonnAllrisProvider – parseResults', () => {
  test('extrahiert Allris-Vorlagen-Link', () => {
    const html = `
      <table>
        <tr>
          <td><a href="vo020.asp?VOLFDNR=12345">Vorlage zur Verkehrsplanung Beethovenplatz</a></td>
          <td>10.06.2024</td>
          <td>Hauptausschuss</td>
          <td>0815/2024</td>
        </tr>
      </table>`;
    const out = bonnProvider.parseResults(html);
    expect(out).toHaveLength(1);
    expect(out[0].title).toContain('Beethovenplatz');
    expect(out[0].url).toMatch(/^https:\/\/www2\.bonn\.de\/bo_ris\/ws_buergerinfo\/vo020\.asp/);
    expect(out[0].date).toBe('10.06.2024');
    expect(out[0].number).toBe('0815/2024');
    expect(out[0].gremium).toBe('Hauptausschuss');
  });
  test('verwirft Treffer ohne passenden Link', () => {
    const html = '<table><tr><td><a href="https://example.com/other">x</a></td></tr></table>';
    expect(bonnProvider.parseResults(html)).toEqual([]);
  });
});

describe('hamburgParldokProvider – supportsCity', () => {
  test('akzeptiert Hamburg', () => {
    expect(hamburgProvider.supportsCity('Hamburg')).toBe(true);
    expect(hamburgProvider.supportsCity('hamburg')).toBe(true);
  });
  test('lehnt andere Städte ab', () => {
    expect(hamburgProvider.supportsCity('Bremen')).toBe(false);
    expect(hamburgProvider.supportsCity('Berlin')).toBe(false);
    expect(hamburgProvider.supportsCity('')).toBe(false);
  });
  test('exponiert _key', () => {
    expect(hamburgProvider._key).toBe('hamburg-parldok');
  });
});

describe('hamburgParldokProvider – parseResults', () => {
  test('extrahiert Drucksachen aus Tabellenzeile', () => {
    const html = `
      <table>
        <tr>
          <td><a href="/parldok/Drucksache/12345">Antrag der Fraktion zur Reeperbahn</a></td>
          <td>22.04.2024</td>
          <td>Hamburgische Bürgerschaft</td>
          <td>21/9876</td>
        </tr>
      </table>`;
    const out = hamburgProvider.parseResults(html, 'https://www.buergerschaft-hh.de');
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0].title).toContain('Reeperbahn');
    expect(out[0].url).toMatch(/^https:\/\/www\.buergerschaft-hh\.de\//);
    expect(out[0].number).toBe('21/9876');
  });
  test('extrahiert Treffer aus Listenelementen', () => {
    const html = `
      <ul>
        <li>
          <a href="/parldok/Drucksache/77">Kleine Anfrage zum Jungfernstieg</a>
          <span>15.01.2024</span>
          <span>Bürgerschaft</span>
        </li>
      </ul>`;
    const out = hamburgProvider.parseResults(html, 'https://www.buergerschaft-hh.de');
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0].title).toContain('Jungfernstieg');
  });
  test('dedupliziert identische URLs aus tr- und li-Blöcken', () => {
    const html = `
      <table><tr><td><a href="/parldok/Drucksache/1">Antrag A</a></td></tr></table>
      <ul><li><a href="/parldok/Drucksache/1">Antrag A</a></li></ul>`;
    const out = hamburgProvider.parseResults(html, 'https://x');
    expect(out).toHaveLength(1);
  });
});

// ── Registry-Integration für die neuen Städte ─────────────────────────────────

describe('cityPortalRegistry – neue Städte', () => {
  test('liefert berlinAllrisProvider für Berlin', () => {
    const p = getProviderForCityActual('Berlin');
    expect(p).toBe(berlinProvider);
    expect(p._key).toBe('berlin-allris');
  });
  test('liefert bonnAllrisProvider für Bonn', () => {
    const p = getProviderForCityActual('Bonn');
    expect(p).toBe(bonnProvider);
    expect(p._key).toBe('bonn-allris');
  });
  test('liefert hamburgParldokProvider für Hamburg', () => {
    const p = getProviderForCityActual('Hamburg');
    expect(p).toBe(hamburgProvider);
    expect(p._key).toBe('hamburg-parldok');
  });
  test('listSupportedCities enthält die neuen Slugs', () => {
    const list = listSupportedCitiesActual();
    expect(list).toEqual(expect.arrayContaining(['hannover', 'berlin', 'bonn', 'hamburg']));
  });
});

// ── searchVariantBuilder ───────────────────────────────────────────────────────

const {
  buildSearchVariants,
  looksLikeStreet,
  looksLikeDistrict,
  looksLikeIntersection,
  MAX_VARIANTS
} = require('../../server/political-context/services/searchVariantBuilder.js');

describe('searchVariantBuilder – Hilfsheuristiken', () => {
  test('looksLikeStreet erkennt typische Endungen', () => {
    expect(looksLikeStreet('Limmerstraße')).toBe(true);
    expect(looksLikeStreet('Lange Allee')).toBe(true);
    expect(looksLikeStreet('Lister Platz')).toBe(true);
    expect(looksLikeStreet('Engelbosteler Damm')).toBe(true);
    expect(looksLikeStreet('Radverkehr')).toBe(false);
  });
  test('looksLikeDistrict erkennt Stadtbezirks-Marker', () => {
    expect(looksLikeDistrict('Stadtbezirk Linden-Limmer')).toBe(true);
    expect(looksLikeDistrict('Stadtteil Mitte')).toBe(true);
    expect(looksLikeDistrict('Limmerstraße')).toBe(false);
  });
  test('looksLikeIntersection erkennt Knotenpunkt-Hinweise', () => {
    expect(looksLikeIntersection('Kreuzung Limmer/Leinau')).toBe(true);
    expect(looksLikeIntersection('Kreisverkehr')).toBe(true);
    expect(looksLikeIntersection('Limmerstraße')).toBe(false);
  });
});

describe('searchVariantBuilder – buildSearchVariants', () => {
  test('Originalbegriffe stehen vorne und werden nicht entfernt', () => {
    const out = buildSearchVariants(['Limmerstraße'], {});
    expect(out[0]).toBe('Limmerstraße');
  });

  test('erzeugt Straße + Radverkehr und Straße + Verkehrssicherheit', () => {
    const out = buildSearchVariants(['Limmerstraße'], {});
    expect(out).toEqual(expect.arrayContaining([
      'Limmerstraße Radverkehr',
      'Limmerstraße Verkehrssicherheit'
    ]));
  });

  test('kombiniert Straße + Gremium', () => {
    const out = buildSearchVariants(['Limmerstraße'], {
      gremium: 'Stadtbezirksrat Linden-Limmer'
    });
    expect(out).toEqual(expect.arrayContaining([
      'Limmerstraße Stadtbezirksrat Linden-Limmer'
    ]));
  });

  test('erzeugt Stadtbezirk + Straße sowie Thema + Stadtteil', () => {
    const out = buildSearchVariants(['Limmerstraße'], {
      district: 'Linden'
    });
    expect(out).toEqual(expect.arrayContaining([
      'Linden Limmerstraße',
      'Radverkehr Linden',
      'Verkehrssicherheit Linden'
    ]));
  });

  test('strippt explizite Stadtteil-Marker', () => {
    const out = buildSearchVariants(['Limmerstraße'], {
      district: 'Stadtteil Linden'
    });
    expect(out).toEqual(expect.arrayContaining(['Linden Limmerstraße']));
    // "Stadtteil Linden Limmerstraße" sollte NICHT dabei sein
    expect(out).not.toEqual(expect.arrayContaining(['Stadtteil Linden Limmerstraße']));
  });

  test('ergänzt „Kreuzung", wenn Original eine Straße ohne Knotenmarker ist', () => {
    const out = buildSearchVariants(['Limmerstraße'], {});
    expect(out).toEqual(expect.arrayContaining(['Limmerstraße Kreuzung']));
  });

  test('lässt Kreuzungs-Originale unverändert (kein doppeltes „Kreuzung")', () => {
    const out = buildSearchVariants(['Kreuzung Limmer/Leinau'], {});
    expect(out).toContain('Kreuzung Limmer/Leinau');
    expect(out.some(v => v === 'Kreuzung Limmer/Leinau Kreuzung')).toBe(false);
  });

  test('classifiziert context.location als Straße ODER Bezirk', () => {
    const fromStreet = buildSearchVariants(['Radverkehr'], { location: 'Limmerstraße' });
    expect(fromStreet).toEqual(expect.arrayContaining(['Limmerstraße Radverkehr']));

    const fromDistrict = buildSearchVariants(['Radverkehr'], { location: 'Stadtteil Linden' });
    expect(fromDistrict).toEqual(expect.arrayContaining(['Radverkehr Linden']));
  });

  test('dedupliziert case-insensitiv', () => {
    const out = buildSearchVariants(['limmerstraße', 'Limmerstraße'], {});
    const norm = out.map(v => v.toLowerCase());
    const seen = new Set();
    norm.forEach(v => seen.add(v));
    expect(seen.size).toBe(out.length);
  });

  test('respektiert MAX_VARIANTS', () => {
    const out = buildSearchVariants(
      ['Limmerstraße', 'Leinaustraße', 'Engelbosteler Damm'],
      { gremium: 'Stadtbezirksrat Linden-Limmer', district: 'Linden' }
    );
    expect(out.length).toBeLessThanOrEqual(MAX_VARIANTS);
  });

  test('akzeptiert leeren Input (kein Crash)', () => {
    expect(buildSearchVariants(null, null)).toEqual([]);
    expect(buildSearchVariants([], {})).toEqual([]);
  });

  test('expandVariants ist deterministisch', () => {
    const a = buildSearchVariants(['Limmerstraße'], { district: 'Linden', gremium: 'Stadtbezirksrat Linden-Limmer' });
    const b = buildSearchVariants(['Limmerstraße'], { district: 'Linden', gremium: 'Stadtbezirksrat Linden-Limmer' });
    expect(a).toEqual(b);
  });
});

// ── trafficRelevanceService ────────────────────────────────────────────────────

const {
  classifyTrafficRelevance,
  enrichWithTrafficRelevance,
  enrichAllWithTrafficRelevance,
  RELEVANCE_THRESHOLD
} = require('../../server/political-context/services/trafficRelevanceService.js');

describe('trafficRelevanceService – classifyTrafficRelevance', () => {
  test('direkte Verkehrssicherheitsvorlage → direct_traffic, hoher Score', () => {
    const ref = {
      title:   'Antrag zur Verkehrssicherheit an der Limmerstraße',
      snippet: 'Schutzstreifen für den Radverkehr und Tempo 30',
      gremium: 'Stadtbezirksrat Linden-Limmer'
    };
    const cls = classifyTrafficRelevance(ref);
    expect(cls.trafficCategory).toBe('direct_traffic');
    expect(cls.trafficRelevanceScore).toBeGreaterThanOrEqual(RELEVANCE_THRESHOLD);
    expect(cls.trafficSubtopics).toEqual(expect.arrayContaining(['Verkehrssicherheit', 'Radverkehr']));
    expect(cls.isTrafficRelevant).toBe(true);
    expect(cls.trafficReason).toMatch(/Verkehrsbezug/i);
  });

  test('gleiche Straße, aber kein Verkehrsbezug → non_traffic', () => {
    const ref = {
      title:   'Kunstausstellung in der Limmerstraße',
      snippet: 'Galerieeröffnung mit Werken regionaler Künstler',
      gremium: 'Kulturausschuss'
    };
    const cls = classifyTrafficRelevance(ref);
    expect(cls.trafficCategory).toBe('non_traffic');
    expect(cls.trafficRelevanceScore).toBe(0);
    expect(cls.isTrafficRelevant).toBe(false);
    expect(cls.trafficSubtopics).toEqual([]);
  });

  test('Verkehrsbezug ohne exakten Straßennamen → direct_traffic', () => {
    const ref = {
      title:   'Maßnahmen zur Schulwegsicherung im Stadtteil',
      snippet: 'Querungshilfe und Fußgängerüberweg vorgesehen',
      gremium: 'Verkehrsausschuss'
    };
    const cls = classifyTrafficRelevance(ref);
    expect(cls.trafficCategory).toBe('direct_traffic');
    expect(cls.trafficSubtopics).toEqual(expect.arrayContaining(['Schulweg', 'Fußverkehr']));
  });

  test('Bezirksratsprotokoll OHNE relevanten Verkehrsinhalt → non_traffic', () => {
    const ref = {
      title:   'Niederschrift der 12. Sitzung',
      snippet: 'Begrüßung, Tagesordnung, Verschiedenes',
      gremium: 'Stadtbezirksrat Linden-Limmer',
      type:    'Protokoll'
    };
    const cls = classifyTrafficRelevance(ref);
    expect(cls.trafficCategory).toBe('non_traffic');
  });

  test('Bezirksratsprotokoll MIT Verkehrsthema → direct_traffic', () => {
    const ref = {
      title:   'Niederschrift der 12. Sitzung',
      snippet: 'TOP 4: Antrag zum Radweg Limmerstraße. Diskussion zu Tempo 30.',
      gremium: 'Stadtbezirksrat Linden-Limmer',
      type:    'Protokoll'
    };
    const cls = classifyTrafficRelevance(ref);
    expect(cls.trafficCategory).toBe('direct_traffic');
    expect(cls.trafficSubtopics).toEqual(expect.arrayContaining(['Radverkehr']));
  });

  test('indirektes Thema ohne direkten Verkehrsbezug → indirect_traffic', () => {
    const ref = {
      title:   'Sanierung des Lichtenbergplatzes',
      snippet: 'Neugestaltung der Platzfläche, Lärmschutz',
      gremium: 'Bauausschuss'
    };
    const cls = classifyTrafficRelevance(ref);
    expect(cls.trafficCategory).toBe('indirect_traffic');
    expect(cls.trafficRelevanceScore).toBeGreaterThan(0);
    expect(cls.trafficReason).toMatch(/[Ii]ndirekt/);
  });

  test('Score bleibt im Bereich [0, 100]', () => {
    const ref = {
      title:   'Radverkehr Schulweg Verkehrssicherheit Tempo 30 Knotenpunkt ÖPNV',
      snippet: 'Radweg Schutzstreifen Fußgänger Querungshilfe Ampel Bus',
      gremium: 'Verkehrsausschuss'
    };
    const cls = classifyTrafficRelevance(ref);
    expect(cls.trafficRelevanceScore).toBeGreaterThanOrEqual(0);
    expect(cls.trafficRelevanceScore).toBeLessThanOrEqual(100);
  });

  test('Title-Treffer geben mehr Punkte als Snippet-Treffer', () => {
    const inTitle   = classifyTrafficRelevance({ title: 'Radverkehr Antrag', snippet: '' });
    const inSnippet = classifyTrafficRelevance({ title: 'Antrag', snippet: 'Radverkehr' });
    expect(inTitle.trafficRelevanceScore).toBeGreaterThan(inSnippet.trafficRelevanceScore);
  });

  test('reason ist auf 240 Zeichen begrenzt', () => {
    const ref = {
      title:   'Radverkehr Schulweg Verkehrssicherheit Tempo 30 Knotenpunkt ÖPNV Ruhender Verkehr Fahrbahn Mobilität Fußverkehr',
      snippet: 'X'.repeat(500)
    };
    const cls = classifyTrafficRelevance(ref);
    expect(cls.trafficReason.length).toBeLessThanOrEqual(240);
  });

  test('isTrafficRelevant respektiert Schwellwert', () => {
    // direct_traffic mit nur einem schwachen Snippet-Treffer kann unter Schwelle liegen
    const weak = classifyTrafficRelevance({ title: '', snippet: 'parken' });
    if (weak.trafficCategory === 'direct_traffic') {
      expect(weak.isTrafficRelevant).toBe(weak.trafficRelevanceScore >= RELEVANCE_THRESHOLD);
    }
  });
});

describe('trafficRelevanceService – enrichWithTrafficRelevance', () => {
  test('lässt Originalfelder unverändert und ergänzt nur die neuen Felder', () => {
    const original = {
      id: 'x', title: 'Antrag Radverkehr', url: 'https://example.com/1',
      type: 'Antrag', source: 'src'
    };
    const enriched = enrichWithTrafficRelevance(original);
    expect(enriched.id).toBe(original.id);
    expect(enriched.title).toBe(original.title);
    expect(enriched).toHaveProperty('trafficCategory');
    expect(enriched).toHaveProperty('trafficRelevanceScore');
    expect(enriched).toHaveProperty('trafficSubtopics');
    expect(enriched).toHaveProperty('isTrafficRelevant');
    expect(enriched).toHaveProperty('trafficReason');
  });

  test('enrichAllWithTrafficRelevance gibt leeres Array für null zurück', () => {
    expect(enrichAllWithTrafficRelevance(null)).toEqual([]);
  });
});

// ── aiGatingService ────────────────────────────────────────────────────────────

const {
  shouldAllowForAiEvaluation,
  filterReferencesForAi,
  enrichWithAiGating
} = require('../../server/political-context/services/aiGatingService.js');

describe('aiGatingService – shouldAllowForAiEvaluation', () => {
  test('non_traffic wird NIE zugelassen', () => {
    const ref = {
      trafficCategory: 'non_traffic',
      isTrafficRelevant: false,
      locationMatch: 'street',
      topicMatch: ['Limmerstraße'],
      streetHints: ['limmerstraße'],
      areaHints: []
    };
    const dec = shouldAllowForAiEvaluation(ref, {});
    expect(dec.allowed).toBe(false);
    expect(dec.reason).toMatch(/Kein Verkehrsbezug/);
  });

  test('direct_traffic mit Straßen-Ortsbezug wird zugelassen', () => {
    const ref = {
      trafficCategory: 'direct_traffic',
      isTrafficRelevant: true,
      locationMatch: 'street',
      topicMatch: ['Limmerstraße'],
      streetHints: ['limmerstraße'],
      areaHints: []
    };
    const dec = shouldAllowForAiEvaluation(ref, {});
    expect(dec.allowed).toBe(true);
    expect(dec.reason).toMatch(/Direkter Verkehrsbezug/);
  });

  test('direct_traffic ohne jeden Orts-/Themenbezug wird abgelehnt', () => {
    const ref = {
      trafficCategory: 'direct_traffic',
      isTrafficRelevant: true,
      locationMatch: 'topic-only',
      topicMatch: [],
      streetHints: [],
      areaHints: []
    };
    const dec = shouldAllowForAiEvaluation(ref, {});
    expect(dec.allowed).toBe(false);
    expect(dec.reason).toMatch(/weder Orts- noch Themenbezug/);
  });

  test('direct_traffic mit Straßenhinweis im Text reicht (auch ohne locationMatch)', () => {
    const ref = {
      trafficCategory: 'direct_traffic',
      isTrafficRelevant: true,
      locationMatch: 'topic-only',
      topicMatch: [],
      streetHints: ['limmerstraße'],
      areaHints: []
    };
    const dec = shouldAllowForAiEvaluation(ref, {});
    expect(dec.allowed).toBe(true);
  });

  test('indirect_traffic mit gutem Ortsbezug (street) wird zugelassen', () => {
    const ref = {
      trafficCategory: 'indirect_traffic',
      isTrafficRelevant: true,
      locationMatch: 'street',
      topicMatch: [],
      streetHints: [],
      areaHints: []
    };
    const dec = shouldAllowForAiEvaluation(ref, {});
    expect(dec.allowed).toBe(true);
    expect(dec.reason).toMatch(/Indirekter Verkehrsbezug/);
  });

  test('indirect_traffic NUR mit bbox wird abgelehnt (zu schwacher Ortsbezug)', () => {
    const ref = {
      trafficCategory: 'indirect_traffic',
      isTrafficRelevant: true,
      locationMatch: 'bbox',
      topicMatch: [],
      streetHints: [],
      areaHints: []
    };
    const dec = shouldAllowForAiEvaluation(ref, {});
    expect(dec.allowed).toBe(false);
  });

  test('indirect_traffic mit topicMatch wird zugelassen', () => {
    const ref = {
      trafficCategory: 'indirect_traffic',
      isTrafficRelevant: true,
      locationMatch: 'topic-only',
      topicMatch: ['Limmerstraße'],
      streetHints: [],
      areaHints: []
    };
    const dec = shouldAllowForAiEvaluation(ref, {});
    expect(dec.allowed).toBe(true);
  });

  test('isTrafficRelevant=false (knapp unter Schwelle) wird abgelehnt', () => {
    const ref = {
      trafficCategory: 'direct_traffic',
      isTrafficRelevant: false,
      locationMatch: 'street',
      topicMatch: ['Limmerstraße']
    };
    const dec = shouldAllowForAiEvaluation(ref, {});
    expect(dec.allowed).toBe(false);
    expect(dec.reason).toMatch(/Schwellwert/);
  });

  test('fehlende Klassifikation wird konservativ abgelehnt', () => {
    expect(shouldAllowForAiEvaluation({}, {}).allowed).toBe(false);
    expect(shouldAllowForAiEvaluation(null, {}).allowed).toBe(false);
  });

  test('filterReferencesForAi gibt nur zugelassene Treffer zurück', () => {
    const refs = [
      { trafficCategory: 'non_traffic',     isTrafficRelevant: false, locationMatch: 'street', topicMatch: ['x'] },
      { trafficCategory: 'direct_traffic',  isTrafficRelevant: true,  locationMatch: 'street', topicMatch: ['x'] },
      { trafficCategory: 'indirect_traffic',isTrafficRelevant: true,  locationMatch: 'bbox',   topicMatch: [] }
    ];
    const filtered = filterReferencesForAi(refs, {});
    expect(filtered).toHaveLength(1);
    expect(filtered[0].trafficCategory).toBe('direct_traffic');
  });

  test('enrichWithAiGating ergänzt aiGating-Feld mit allowed/reason', () => {
    const ref = {
      trafficCategory: 'direct_traffic', isTrafficRelevant: true,
      locationMatch: 'street', topicMatch: ['x'], streetHints: [], areaHints: []
    };
    const enriched = enrichWithAiGating(ref, {});
    expect(enriched.aiGating).toMatchObject({ allowed: true });
    expect(typeof enriched.aiGating.reason).toBe('string');
  });
});

// ── Integrationstest: portalSearchService inkl. Verkehrs-/Gating-Felder ────────

describe('portalSearchService – Variantensuche + Verkehrsklassifikation + Gating', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    politicalSearchCache.clear();
  });

  test('Variantensuche wird an den Provider übergeben, Original bleibt im meta', async () => {
    const captured = [];
    registry.getProviderForCity.mockReturnValue({
      _key: 'mock',
      search: async ({ searchTerms }) => {
        captured.push(...searchTerms);
        return [];
      }
    });
    const result = await search({
      city: 'Hannover',
      searchTerms: ['Limmerstraße'],
      context: { gremium: 'Stadtbezirksrat Linden-Limmer', district: 'Linden' }
    });
    // Variantensuche hat die Liste vergrößert
    expect(captured.length).toBeGreaterThan(1);
    expect(captured).toContain('Limmerstraße');
    expect(captured).toEqual(expect.arrayContaining(['Limmerstraße Radverkehr']));
    // Meta zeigt nach wie vor die Originalbegriffe
    expect(result.meta.searchTerms).toEqual(['Limmerstraße']);
  });

  test('expandVariants:false deaktiviert die Variantensuche', async () => {
    const captured = [];
    registry.getProviderForCity.mockReturnValue({
      _key: 'mock',
      search: async ({ searchTerms }) => { captured.push(...searchTerms); return []; }
    });
    await search({
      city: 'Hannover',
      searchTerms: ['Limmerstraße'],
      expandVariants: false
    });
    expect(captured).toEqual(['Limmerstraße']);
  });

  test('Treffer enthalten trafficCategory, trafficRelevanceScore und aiGating', async () => {
    registry.getProviderForCity.mockReturnValue({
      _key: 'mock',
      search: async () => ([
        {
          title:   'Antrag zur Verkehrssicherheit an der Limmerstraße',
          url:     'https://example.com/1',
          rawType: 'antrag',
          gremium: 'Stadtbezirksrat Linden-Limmer',
          snippet: 'Schutzstreifen für den Radverkehr',
          topicMatch: ['Limmerstraße'],
          locationMatch: 'street',
          streetHints: ['limmerstraße']
        },
        {
          title:   'Kunstausstellung in der Limmerstraße',
          url:     'https://example.com/2',
          rawType: '',
          snippet: 'Galerieeröffnung'
        }
      ])
    });

    const out = await search({
      city: 'Hannover',
      searchTerms: ['Limmerstraße'],
      context: {}
    });

    expect(out.references.length).toBe(2);
    for (const r of out.references) {
      expect(r).toHaveProperty('trafficCategory');
      expect(r).toHaveProperty('trafficRelevanceScore');
      expect(r).toHaveProperty('trafficSubtopics');
      expect(r).toHaveProperty('isTrafficRelevant');
      expect(r).toHaveProperty('trafficReason');
      expect(r).toHaveProperty('aiGating');
      expect(typeof r.aiGating.allowed).toBe('boolean');
    }

    // Verkehrsantrag wird zugelassen, Kunstausstellung nicht
    const verkehr = out.references.find(r => r.url === 'https://example.com/1');
    const kunst   = out.references.find(r => r.url === 'https://example.com/2');
    expect(verkehr.trafficCategory).toBe('direct_traffic');
    expect(verkehr.aiGating.allowed).toBe(true);
    expect(kunst.trafficCategory).toBe('non_traffic');
    expect(kunst.aiGating.allowed).toBe(false);
  });
});
