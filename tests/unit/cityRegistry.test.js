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

const fs = require('fs');

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
  // Wir laden den Validator über reload(), stubben dafür aber nur das
  // Lesen des Katalogs, statt die echte JSON-Datei auf dem Dateisystem
  // zu ersetzen – sonst kommt es bei parallelen Jest-Workern zu
  // Race-Conditions mit Tests, die den Katalog ebenfalls laden.
  const originalContent = fs.readFileSync(cityRegistry.CATALOG_PATH, 'utf8');
  let readFileSyncSpy;

  function stubCatalogContent(content) {
    if (readFileSyncSpy) readFileSyncSpy.mockRestore();
    const originalReadFileSync = fs.readFileSync;
    readFileSyncSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((filePath, ...args) => {
      if (filePath === cityRegistry.CATALOG_PATH) return content;
      return originalReadFileSync.call(fs, filePath, ...args);
    });
  }

  afterEach(() => {
    if (readFileSyncSpy) {
      readFileSyncSpy.mockRestore();
      readFileSyncSpy = undefined;
    }
    cityRegistry.reload();
  });

  test('wirft bei doppelter id', () => {
    const dup = JSON.parse(originalContent);
    dup.cities = [dup.cities[0], dup.cities[0]];
    stubCatalogContent(JSON.stringify(dup));
    expect(() => cityRegistry.reload()).toThrow(/doppelte id/);
  });

  test('wirft bei ungültigem Bundesland', () => {
    const bad = JSON.parse(originalContent);
    bad.cities[0].state = 'XX';
    stubCatalogContent(JSON.stringify(bad));
    expect(() => cityRegistry.reload()).toThrow(/Bundesland/);
  });

  test('wirft bei ungültigem Support-Status', () => {
    const bad = JSON.parse(originalContent);
    bad.cities[0].politicalContextSupport = 'maybe';
    stubCatalogContent(JSON.stringify(bad));
    expect(() => cityRegistry.reload()).toThrow(/Support-Status/);
  });

  test('wirft bei ungültiger Portal-URL', () => {
    const bad = JSON.parse(originalContent);
    bad.cities[0].portalBaseUrl = 'javascript:alert(1)';
    stubCatalogContent(JSON.stringify(bad));
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
    // Erfurt steht im Katalog, aber ohne Portal-Eintrag → Stufe B unsupported.
    const d = cityRegistry.describeCity(cityRegistry.getCityById('erfurt'));
    expect(d.supportLevels.supportLevelB).toBe('unsupported');
    expect(d.capabilities.politicalContext).toBe(false);
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

// ── Konsistenz mit den GitHub-Workflows / cities.txt ──────────────────────────

describe('cityRegistry – Kopplung an cities.txt und out/', () => {
  test('readCitiesTxt liefert pro Zeile name + normalisierten slug', () => {
    const list = cityRegistry.readCitiesTxt();
    expect(list.length).toBeGreaterThan(0);
    for (const entry of list) {
      expect(typeof entry.name).toBe('string');
      expect(entry.slug).toBe(cityRegistry.normalizeCityName(entry.name));
      expect(entry.slug).toMatch(/^[a-z0-9_]+$/);
    }
  });

  test('alle Städte in cities.txt haben einen Katalog-Eintrag mit derselben id', () => {
    // Der GitHub-Workflow generate-and-commit.yml triggert
    // convertAmt2gmaps.sh genau für diese Liste.  Damit der Katalog
    // nicht von der Realität entkoppelt, muss jeder Eintrag in
    // cities.txt im Katalog auftauchen – sonst würde die UI Daten
    // ausliefern, für die sie keine Capability-Stufe hat.
    const txt = cityRegistry.readCitiesTxt();
    for (const entry of txt) {
      const city = cityRegistry.getCityById(entry.slug);
      expect(city).toBeTruthy();
      expect(city.id).toBe(entry.slug);
    }
  });

  test('Rollout-Invariante: cities.txt ist Obermenge der "supported"-Slugs', () => {
    // cities.txt ist die Rollout-Queue für `Generate & Commit`.
    // Bedingung in beide Richtungen wäre zu streng (eine neu in die
    // Queue aufgenommene Stadt darf in einem PR landen, bevor der
    // Workflow gelaufen ist).  Eine Stadt darf jedoch nicht als
    // `accidentDataSupport: 'supported'` markiert sein, ohne in der
    // Rollout-Liste zu stehen – sonst würde sie nie regenerierbar
    // sein.
    const txtSlugs = new Set(cityRegistry.readCitiesTxt().map(e => e.slug));
    const supportedSlugs = cityRegistry.listCities()
      .filter(c => c.accidentDataSupport === 'supported')
      .map(c => c.id);
    for (const slug of supportedSlugs) {
      expect(txtSlugs.has(slug)).toBe(true);
    }
  });

  test('Materialisierungs-Honesty: "supported" gilt nur, wenn out/output_all_years_<id>.geojson existiert', () => {
    // Kernforderung des Rollout-Modells: `accidentDataSupport:
    // 'supported'` ist eine Aussage über die *tatsächlich nutzbare*
    // Datenlage, nicht über die *geplante*.  Sobald jemand den Status
    // hochzieht, ohne dass die Workflow-Datei vorliegt, fällt dieser
    // Test – das schützt die UI vor toten Stadt-Tabs.
    const cities = cityRegistry.listCities();
    for (const c of cities) {
      if (c.accidentDataSupport === 'supported') {
        const assets = cityRegistry.getDataAssets(c.id);
        expect(assets.accidents).toBe(true);
      }
    }
  });

  test('Katalog-Städte ohne Workflow-Daten sind nicht als Stufe A "supported" geführt', () => {
    // Komplement zur Materialisierungs-Honesty: liegt keine GeoJSON
    // vor, darf der Status höchstens `partially_supported` sein – also
    // nicht `supported`.  `unsupported` ist ebenfalls zulässig (z. B.
    // Portal-only-Einträge ohne Plan zur Datenmaterialisierung).
    const cities = cityRegistry.listCities();
    let withoutData = 0;
    for (const c of cities) {
      const assets = cityRegistry.getDataAssets(c.id);
      if (!assets.accidents) {
        expect(c.accidentDataSupport).not.toBe('supported');
        withoutData++;
      }
    }
    // Mindestens die Rollout-Kandidaten >500k/>300k aus cities.txt
    // (Stuttgart, Leipzig, … Münster) sind hier vertreten.
    expect(withoutData).toBeGreaterThan(0);
  });

  test('Rollout-Queue: alle Städte mit qualityFlag "rollout-queued" stehen in cities.txt und sind partially_supported', () => {
    // Garantiert, dass das `rollout-queued`-Flag (Anzeige in UI/API)
    // eine sinnvolle Aussage trifft und nicht versehentlich an einer
    // bereits supported-Stadt hängenbleibt.
    const txtSlugs = new Set(cityRegistry.readCitiesTxt().map(e => e.slug));
    const queued = cityRegistry.listCities()
      .filter(c => (c.qualityFlags || []).includes('rollout-queued'));
    expect(queued.length).toBeGreaterThan(0);
    for (const c of queued) {
      expect(txtSlugs.has(c.id)).toBe(true);
      expect(c.accidentDataSupport).toBe('partially_supported');
    }
  });

  test('Upgrade-Pfad-Konsistenz: keine Stadt in cities.txt mit Daten in out/ darf "rollout-queued" tragen', () => {
    // Spiegel zur Materialisierungs-Honesty: sobald die Workflows
    // GeoJSON+POI für eine Stadt geliefert haben (und sie in
    // cities.txt steht), muss sie auch wirklich auf `supported`
    // hochgezogen werden – sonst behauptet die UI weiterhin
    // „partially_supported", obwohl die Datenlage längst da ist.
    // Genau dieses Drift-Szenario erkennt scripts/check-city-rollout.js
    // als „Upgrade-Kandidat".  Der Test schiebt das automatisch in CI.
    const txtSlugs = new Set(cityRegistry.readCitiesTxt().map(e => e.slug));
    const stale = [];
    for (const c of cityRegistry.listCities()) {
      const assets = cityRegistry.getDataAssets(c.id);
      if (assets.accidents && txtSlugs.has(c.id) &&
          c.accidentDataSupport !== 'supported') {
        stale.push(c.id);
      }
    }
    expect(stale).toEqual([]);
  });

  test('"accident-data-generated" Flag korrespondiert mit tatsächlicher GeoJSON in out/', () => {
    // Das Flag ist eine Behauptung, dass die Materialisierung gelaufen
    // ist – wenn die Datei fehlt, ist das Flag eine Lüge.  Umgekehrt
    // erwarten wir das Flag nur dort, wo `supported` gesetzt ist; ein
    // partially_supported-Eintrag mit dem Flag wäre selbst inkonsistent.
    for (const c of cityRegistry.listCities()) {
      const hasFlag = (c.qualityFlags || []).includes('accident-data-generated');
      const hasFile = cityRegistry.getDataAssets(c.id).accidents;
      if (hasFlag) expect(hasFile).toBe(true);
    }
  });

  test('Großstädte > 500.000 (populationClass=metropolis) sind in cities.txt eingetragen', () => {
    // Strategische Vorgabe der Rollout-Phase: alle Metropolen
    // (>500k) sollen mindestens in der Rollout-Liste stehen, damit
    // der Workflow sie reproduzierbar nachgenerieren kann.  Sie
    // dürfen Stufe A noch `partially_supported` führen – das wird
    // durch andere Tests separat geprüft.
    const txtSlugs = new Set(cityRegistry.readCitiesTxt().map(e => e.slug));
    const missing = cityRegistry.listCities()
      .filter(c => c.populationClass === 'metropolis' && !txtSlugs.has(c.id))
      .map(c => c.id);
    expect(missing).toEqual([]);
  });

  test('getDataAssets meldet vorhandene Outputs für die Workflow-Städte', () => {
    // Wir prüfen das nur für Hannover – die Datei ist im Repo
    // (out/output_all_years_hannover.geojson) und entstammt dem
    // generate-and-commit-Workflow.  Damit ist der Test stabil,
    // ohne die Existenz aller weiteren Outputs vorauszusetzen.
    const a = cityRegistry.getDataAssets('hannover');
    expect(a.accidents).toBe(true);
    // POI-Daten sind in cities.txt-Untermenge weniger vollständig –
    // wir testen die Erkennung mindestens für eine bekannte Stadt.
    const b = cityRegistry.getDataAssets('berlin');
    expect(b.poi).toBe(true);
  });

  test('getDataAssets meldet false für unbekannte ids', () => {
    const a = cityRegistry.getDataAssets('atlantis');
    expect(a).toEqual({ accidents: false, poi: false });
  });

  test('describeCity ergänzt dataAssets', () => {
    const d = cityRegistry.describeCity(cityRegistry.getCityById('hannover'));
    expect(d.dataAssets).toBeDefined();
    expect(d.dataAssets.accidents).toBe(true);
  });
});

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

  test('liefert null für katalog-Städte mit politicalContextSupport=partially_supported (Portal bekannt, kein Provider)', () => {
    // Beispiel aus dem Portal-Seed: München hat ein bekanntes Portal,
    // aber noch keinen Provider → Gating verhindert Halb-Funktionalität.
    expect(portalRegistry.getProviderForCity('München')).toBeNull();
    expect(portalRegistry.getProviderForCity('Stuttgart')).toBeNull();
  });
});

// ── Portal-Seed-Liste: Konsistenz Stadt ↔ Portal ↔ Support-Stufe ──────────────

describe('cityRegistry – Portal-Seed-Konsistenz (Stufe B)', () => {
  const allCities = cityRegistry.listCities();

  test('jede Stadt mit knownPortalType hat auch eine portalBaseUrl (und umgekehrt)', () => {
    for (const c of allCities) {
      const hasType = !!c.knownPortalType;
      const hasUrl  = !!c.portalBaseUrl;
      expect(hasType).toBe(hasUrl);
    }
  });

  test('politicalContextSupport=supported|partially_supported impliziert konkretes Portal', () => {
    // „supported" ohne Portalreferenz wäre Scheinunterstützung, und
    // „partially_supported" ohne Portal wäre eine leere Aussage.
    for (const c of allCities) {
      if (c.politicalContextSupport === 'supported' ||
          c.politicalContextSupport === 'partially_supported') {
        expect(c.knownPortalType).toBeTruthy();
        expect(c.portalBaseUrl).toMatch(/^https?:\/\//);
      }
    }
  });

  test('politicalContextSupport=unsupported impliziert kein Portal hinterlegt', () => {
    // Ehrlichkeitsregel: kein Halb-Wissen.  Wenn unsupported, dann
    // auch kein hängengebliebener Portallink im Katalog.
    for (const c of allCities) {
      if (c.politicalContextSupport === 'unsupported') {
        expect(c.knownPortalType).toBeNull();
        expect(c.portalBaseUrl).toBeNull();
      }
    }
  });

  test('politicalContextSupport=supported nur dann, wenn auch ein Provider registriert ist', () => {
    // Spiegel zur Implementierung in cityPortalRegistry.getProviderForCity:
    // ohne Provider wäre "supported" nicht einlösbar.
    const portalRegistry = jest.requireActual(
      '../../server/political-context/registry/cityPortalRegistry.js'
    );
    for (const c of allCities) {
      if (c.politicalContextSupport === 'supported') {
        expect(portalRegistry.getProviderForCityRaw(c.displayName)).not.toBeNull();
      }
    }
  });

  test('Portal-Seed-Quelle: mindestens 25 Städte tragen das Flag "portal-from-seed"', () => {
    // Dokumentiert die Herkunft der Portalreferenzen aus der kuratierten
    // Seed-Liste – damit später nachvollziehbar ist, welche Einträge
    // automatisch und welche manuell entstanden sind.
    const seeded = allCities.filter(c => c.qualityFlags.includes('portal-from-seed'));
    expect(seeded.length).toBeGreaterThanOrEqual(25);
    // Alle Seed-Einträge müssen ein Portal hinterlegt haben.
    for (const c of seeded) {
      expect(c.portalBaseUrl).toMatch(/^https?:\/\//);
      expect(c.knownPortalType).toBeTruthy();
    }
  });

  test('alle aus der Seed-Liste neu aufgenommenen Städte sind höchstens Stufe-B-„partially_supported"', () => {
    // Reine Portal-only-Einträge (Portal in Seed-Liste, aber KEIN
    // implementierter Provider in cityPortalRegistry) dürfen nicht
    // versehentlich auf Stufe A oder C hochgestuft werden, solange
    // weder Workflow-Daten noch Persistenz-Backing existieren.
    // Hinweis: Städte aus der Seed-Liste, für die inzwischen ein
    // Provider angebunden wurde (z. B. via sessionNetProvider), sind
    // hier bewusst NICHT mehr aufgeführt – ihr Stufe-B-Status ist
    // dann legitim `supported`.
    const portalOnlyIds = [
      'gelsenkirchen', 'aachen',
      'freiburg_im_breisgau', 'luebeck', 'krefeld', 'oberhausen',
      'rostock', 'kassel'
    ];
    for (const id of portalOnlyIds) {
      const c = cityRegistry.getCityById(id);
      expect(c).toBeTruthy();
      expect(c.accidentDataSupport).toBe('unsupported');
      expect(c.analysisServiceSupport).toBe('unsupported');
      expect(c.politicalContextSupport).toBe('partially_supported');
    }
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
