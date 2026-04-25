'use strict';

/**
 * Unit tests für den bundesweiten Städte-/Regionen-Katalog.
 *
 * Getestete Einheiten:
 *   - server/cities/cityRegistry.js
 *   - server/cities/supportLevels.js
 *   - Kopplung politische Recherche (cityPortalRegistry) → Katalog
 *   - capabilities.cities()
 */

const path = require('path');
const fs   = require('fs');

const cityRegistry = require('../../server/cities/cityRegistry.js');
const {
  SUPPORT_LEVELS,
  SUPPORT_STATUS,
  VALID_STATUSES,
  describeSupport,
  hasSupport,
  getStatus
} = require('../../server/cities/supportLevels.js');

// ── supportLevels ──────────────────────────────────────────────────────────────

describe('supportLevels – Konstanten', () => {
  test('SUPPORT_LEVELS enthält A/B/C', () => {
    expect(SUPPORT_LEVELS.A).toBe('supportLevelA');
    expect(SUPPORT_LEVELS.B).toBe('supportLevelB');
    expect(SUPPORT_LEVELS.C).toBe('supportLevelC');
  });
  test('SUPPORT_STATUS enthält die drei erlaubten Werte', () => {
    expect(SUPPORT_STATUS.SUPPORTED).toBe('supported');
    expect(SUPPORT_STATUS.PARTIALLY_SUPPORTED).toBe('partially_supported');
    expect(SUPPORT_STATUS.UNSUPPORTED).toBe('unsupported');
    expect(VALID_STATUSES).toEqual(expect.arrayContaining(['supported','partially_supported','unsupported']));
  });
});

describe('supportLevels – getStatus / hasSupport', () => {
  const cityFull    = { accidentDataSupport: 'supported',           politicalContextSupport: 'supported',           analysisServiceSupport: 'supported' };
  const cityPartial = { accidentDataSupport: 'supported',           politicalContextSupport: 'partially_supported', analysisServiceSupport: 'unsupported' };
  const cityNone    = { accidentDataSupport: 'unsupported',         politicalContextSupport: 'unsupported',         analysisServiceSupport: 'unsupported' };

  test('getStatus liest den korrekten Status pro Stufe', () => {
    expect(getStatus(cityFull,    SUPPORT_LEVELS.A)).toBe('supported');
    expect(getStatus(cityPartial, SUPPORT_LEVELS.B)).toBe('partially_supported');
    expect(getStatus(cityNone,    SUPPORT_LEVELS.C)).toBe('unsupported');
  });

  test('getStatus fällt auf unsupported zurück bei unbekannter Stufe oder null-Eingabe', () => {
    expect(getStatus(cityFull, 'supportLevelZ')).toBe('unsupported');
    expect(getStatus(null,     SUPPORT_LEVELS.A)).toBe('unsupported');
  });

  test('hasSupport ist true für supported und partially_supported', () => {
    expect(hasSupport(cityFull,    SUPPORT_LEVELS.B)).toBe(true);
    expect(hasSupport(cityPartial, SUPPORT_LEVELS.B)).toBe(true);
    expect(hasSupport(cityNone,    SUPPORT_LEVELS.B)).toBe(false);
  });

  test('describeSupport liefert pro Stufe einen Status', () => {
    const d = describeSupport(cityPartial);
    expect(d).toEqual({
      supportLevelA: 'supported',
      supportLevelB: 'partially_supported',
      supportLevelC: 'unsupported'
    });
  });
});

// ── cityRegistry – Daten und Validierung ──────────────────────────────────────

describe('cityRegistry – Katalog-Daten', () => {
  test('listCities liefert ein nichtleeres, eingefrorenes Array', () => {
    const cities = cityRegistry.listCities();
    expect(Array.isArray(cities)).toBe(true);
    expect(cities.length).toBeGreaterThan(20);
    expect(Object.isFrozen(cities)).toBe(true);
  });

  test('jeder Eintrag erfüllt das Pflicht-Schema', () => {
    for (const c of cityRegistry.listCities()) {
      expect(typeof c.id).toBe('string');
      expect(c.id).toMatch(/^[a-z0-9_]+$/);
      expect(typeof c.displayName).toBe('string');
      expect(c.displayName.length).toBeGreaterThan(0);
      expect(cityRegistry.VALID_STATES).toContain(c.state);
      expect(c.officialCodes).toBeDefined();
      expect(['supported','partially_supported','unsupported']).toContain(c.accidentDataSupport);
      expect(['supported','partially_supported','unsupported']).toContain(c.politicalContextSupport);
      expect(['supported','partially_supported','unsupported']).toContain(c.analysisServiceSupport);
      expect(['supported','partially_supported','unsupported']).toContain(c.rankingSupport);
      expect(Array.isArray(c.qualityFlags)).toBe(true);
    }
  });

  test('IDs sind eindeutig', () => {
    const ids = cityRegistry.listCities().map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('die vier portal-unterstützten Städte sind als politisch supported markiert', () => {
    for (const id of ['hannover', 'berlin', 'bonn', 'hamburg']) {
      const c = cityRegistry.getCityById(id);
      expect(c).toBeTruthy();
      expect(c.politicalContextSupport).toBe('supported');
      expect(c.knownPortalType).toBeTruthy();
    }
  });

  test('mindestens eine Stadt pro Bundesland abgedeckt', () => {
    const states = new Set(cityRegistry.listCities().map(c => c.state));
    for (const s of cityRegistry.VALID_STATES) {
      expect(states.has(s)).toBe(true);
    }
  });
});

describe('cityRegistry – Validierung schlägt bei kaputten Einträgen fehl', () => {
  // Wir laden den Validator über reload(), nachdem wir die JSON-Datei
  // temporär durch eine kaputte Variante ersetzen.
  const originalContent = fs.readFileSync(cityRegistry.CATALOG_PATH, 'utf8');
  afterEach(() => {
    fs.writeFileSync(cityRegistry.CATALOG_PATH, originalContent, 'utf8');
    cityRegistry.reload();
  });

  test('wirft bei doppelter id', () => {
    const dup = JSON.parse(originalContent);
    dup.cities = [dup.cities[0], dup.cities[0]];
    fs.writeFileSync(cityRegistry.CATALOG_PATH, JSON.stringify(dup), 'utf8');
    expect(() => cityRegistry.reload()).toThrow(/doppelte id/);
  });

  test('wirft bei ungültigem Bundesland', () => {
    const bad = JSON.parse(originalContent);
    bad.cities[0].state = 'XX';
    fs.writeFileSync(cityRegistry.CATALOG_PATH, JSON.stringify(bad), 'utf8');
    expect(() => cityRegistry.reload()).toThrow(/Bundesland/);
  });

  test('wirft bei ungültigem Support-Status', () => {
    const bad = JSON.parse(originalContent);
    bad.cities[0].politicalContextSupport = 'maybe';
    fs.writeFileSync(cityRegistry.CATALOG_PATH, JSON.stringify(bad), 'utf8');
    expect(() => cityRegistry.reload()).toThrow(/Support-Status/);
  });

  test('wirft bei ungültiger Portal-URL', () => {
    const bad = JSON.parse(originalContent);
    bad.cities[0].portalBaseUrl = 'javascript:alert(1)';
    fs.writeFileSync(cityRegistry.CATALOG_PATH, JSON.stringify(bad), 'utf8');
    expect(() => cityRegistry.reload()).toThrow(/portalBaseUrl/);
  });
});

// ── cityRegistry – Lookups und Suche ───────────────────────────────────────────

describe('cityRegistry – Lookups', () => {
  test('getCityById findet exakte ids', () => {
    expect(cityRegistry.getCityById('hannover')).toBeTruthy();
    expect(cityRegistry.getCityById('frankfurt_am_main')).toBeTruthy();
    expect(cityRegistry.getCityById('nope')).toBeNull();
  });

  test('findCity über displayName, id und Gemeindecode', () => {
    expect(cityRegistry.findCity('Hannover')?.id).toBe('hannover');
    expect(cityRegistry.findCity('München')?.id).toBe('muenchen');
    expect(cityRegistry.findCity('frankfurt_am_main')?.id).toBe('frankfurt_am_main');
    // AGS Berlin
    expect(cityRegistry.findCity('11000000')?.id).toBe('berlin');
  });

  test('findCity gibt für unbekannte / leere Eingaben null zurück', () => {
    expect(cityRegistry.findCity('Atlantis')).toBeNull();
    expect(cityRegistry.findCity('')).toBeNull();
    expect(cityRegistry.findCity(null)).toBeNull();
  });

  test('listCitiesByState filtert nach Bundesland', () => {
    const nw = cityRegistry.listCitiesByState('NW');
    expect(nw.length).toBeGreaterThan(1);
    for (const c of nw) expect(c.state).toBe('NW');
  });

  test('listCitiesWithSupport(B) liefert nur politisch unterstützte', () => {
    const list = cityRegistry.listCitiesWithSupport(SUPPORT_LEVELS.B);
    const ids = list.map(c => c.id);
    expect(ids).toEqual(expect.arrayContaining(['hannover','berlin','bonn','hamburg']));
    for (const c of list) {
      expect(c.politicalContextSupport).not.toBe('unsupported');
    }
  });

  test('searchCities findet per Substring (case- und diakritik-insensitiv)', () => {
    const a = cityRegistry.searchCities('Hannover').map(c => c.id);
    const b = cityRegistry.searchCities('München').map(c => c.id);
    const c = cityRegistry.searchCities('frankfurt').map(c => c.id);
    expect(a).toContain('hannover');
    expect(b).toContain('muenchen');
    expect(c).toContain('frankfurt_am_main');
  });

  test('searchCities respektiert das limit', () => {
    expect(cityRegistry.searchCities('e', { limit: 3 }).length).toBeLessThanOrEqual(3);
  });
});

describe('cityRegistry – describeCity / summarize', () => {
  test('describeCity ergänzt supportLevels und capabilities', () => {
    const d = cityRegistry.describeCity(cityRegistry.getCityById('hannover'));
    expect(d.supportLevels).toEqual({
      supportLevelA: 'supported',
      supportLevelB: 'supported',
      supportLevelC: 'supported'
    });
    expect(d.capabilities.politicalContext).toBe(true);
    expect(d.capabilities.accidentAnalysis).toBe(true);
    expect(d.capabilities.analysisService).toBe(true);
  });

  test('describeCity einer rein A-supportierten Stadt zeigt korrekt false-Capabilities', () => {
    const d = cityRegistry.describeCity(cityRegistry.getCityById('muenchen'));
    expect(d.supportLevels.supportLevelB).toBe('unsupported');
    expect(d.capabilities.politicalContext).toBe(false);
    // München ist analysisService-„supported" laut Katalog → ranking auch
    expect(d.capabilities.analysisService).toBe(true);
  });

  test('summarize liefert Counts pro Stufe, summe ist gleich Gesamtzahl', () => {
    const s = cityRegistry.summarize();
    const total = s.total;
    for (const level of Object.values(SUPPORT_LEVELS)) {
      const c = s.byLevel[level];
      expect(c.supported + c.partially_supported + c.unsupported).toBe(total);
    }
    // mindestens die 4 portal-unterstützten Städte zählen für B
    expect(s.byLevel.supportLevelB.supported).toBeGreaterThanOrEqual(4);
  });
});

// ── Kopplung an cityPortalRegistry ────────────────────────────────────────────

describe('cityPortalRegistry – Katalog-Gating', () => {
  // Auflösung muss frisch erfolgen, weil andere Tests den Katalog
  // möglicherweise mocken; wir laden hier explizit das echte Modul.
  const portalRegistry = jest.requireActual(
    '../../server/political-context/registry/cityPortalRegistry.js'
  );

  test('liefert Provider für katalog-supported Stadt (Hannover)', () => {
    expect(portalRegistry.getProviderForCity('Hannover')).not.toBeNull();
  });

  test('getProviderForCityRaw existiert und ignoriert Katalog-Gate', () => {
    expect(typeof portalRegistry.getProviderForCityRaw).toBe('function');
    expect(portalRegistry.getProviderForCityRaw('Hannover')).not.toBeNull();
  });

  test('liefert null für Städte ohne Provider (auch wenn im Katalog)', () => {
    expect(portalRegistry.getProviderForCity('München')).toBeNull();
  });

  test('liefert null für Städte ohne Katalog-Eintrag und ohne Provider', () => {
    expect(portalRegistry.getProviderForCity('Atlantis')).toBeNull();
  });
});

// ── capabilities.cities() ─────────────────────────────────────────────────────

describe('capabilities – cities()', () => {
  // Frisches require, da capabilities.js den Katalog dynamisch lädt.
  const { cities: citiesCapability } = require('../../server/lib/capabilities.js');

  test('meldet available:true mit Summary', () => {
    const cap = citiesCapability();
    expect(cap.available).toBe(true);
    expect(cap.reasonCode).toBe('ok');
    expect(cap.details.total).toBeGreaterThan(0);
    expect(cap.details.byLevel.supportLevelA).toBeDefined();
    expect(cap.details.byLevel.supportLevelB).toBeDefined();
    expect(cap.details.byLevel.supportLevelC).toBeDefined();
  });
});
