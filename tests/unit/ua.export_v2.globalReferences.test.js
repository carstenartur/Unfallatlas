/**
 * Unit tests for global + city-specific reference document merging.
 *
 * Covers:
 * - references_global.json exists and has the required structure.
 * - loadReferenceDocuments merges global + city docs (tested via global.fetch mock).
 * - City entry wins on title+author collision.
 * - DARK_FIGURE_NOTE exposes `sources` array with the statistical definition and the primary underreporting study.
 * - Both source links appear in text and html output.
 */

const fs   = require('fs');
const path = require('path');

// ---- Static JSON structure tests (no JS runtime needed) ----

const GLOBAL_REFS_PATH = path.resolve(__dirname, '../../templates/references_global.json');
const GLOBAL_REFS = JSON.parse(fs.readFileSync(GLOBAL_REFS_PATH, 'utf8'));

describe('references_global.json – structure', () => {
  test('exists and has documents array with at least 5 entries', () => {
    expect(Array.isArray(GLOBAL_REFS.documents)).toBe(true);
    expect(GLOBAL_REFS.documents.length).toBeGreaterThanOrEqual(5);
  });

  test('every entry has at least title and author', () => {
    for (const doc of GLOBAL_REFS.documents) {
      expect(typeof doc.title).toBe('string');
      expect(doc.title.length).toBeGreaterThan(0);
      expect(typeof doc.author).toBe('string');
      expect(doc.author.length).toBeGreaterThan(0);
    }
  });

  test('UDV Alleinunfälle entry is present with correct URL', () => {
    const udv = GLOBAL_REFS.documents.find(d => /Alleinunf/i.test(d.title));
    expect(udv).toBeDefined();
    expect(udv.url).toMatch(/udv\.de/);
  });

  test('BASt Kosten entry is present with specific URL (not just domain root)', () => {
    const bast = GLOBAL_REFS.documents.find(d => /volkswirtschaftlich/i.test(d.title));
    expect(bast).toBeDefined();
    expect(bast.url).toMatch(/bast\.de/);
    expect(bast.url.length).toBeGreaterThan('https://www.bast.de/'.length);
  });

  test('FGSV ERA entry is present', () => {
    const era = GLOBAL_REFS.documents.find(d => /ERA/i.test(d.title) && /FGSV/i.test(d.author));
    expect(era).toBeDefined();
  });

  test('FGSV RASt entry is present', () => {
    const rast = GLOBAL_REFS.documents.find(d => /RASt/i.test(d.title) && /FGSV/i.test(d.author));
    expect(rast).toBeDefined();
  });
});

// ---- Runtime tests: reference merging via computeExportReport ----

describe('UA.loadReferenceDocuments – global + city merging', () => {
  let UA;
  let savedGlobalFetch;

  const globalDocs = { documents: [
    { title: "Global A", author: "Org A", url: "https://example.org/a" },
    { title: "Shared Entry", author: "Shared Org", description: "global version" }
  ]};
  const cityDocs = { documents: [
    { title: "City B", author: "City Org B" },
    { title: "Shared Entry", author: "Shared Org", description: "city wins" }
  ]};

  function makeFetch(responses) {
    return async (url, _opts) => {
      const key = Object.keys(responses).find(k => String(url).includes(k));
      if (!key || responses[key] === null) {
        return { ok: false, json: async () => ({}), text: async () => '' };
      }
      return { ok: true, json: async () => responses[key], text: async () => '' };
    };
  }

  function loadUA(fetchImpl) {
    const mockWindow = { UA: {} };
    const load = (rel) => {
      const p = path.resolve(__dirname, '../../js/' + rel);
      (function (window) { eval(fs.readFileSync(p, 'utf8')); })(mockWindow);
    };
    mockWindow.L = { latLngBounds: () => {} };
    mockWindow.location = { href: 'http://localhost/?city=Hannover' };
    load('ua.utils.js');
    load('ua.filters.js');
    load('ua.accident_views.js');
    load('ua.export_v2.js');
    // Also set on mockWindow for belt-and-suspenders
    mockWindow.fetch = fetchImpl;
    return mockWindow.UA;
  }

  function makeCtx(UA, cityRaw) {
    const sw = { lat: 52.0, lng: 9.7 };
    const ne = { lat: 52.5, lng: 9.9 };
    const bounds = {
      getSouthWest: () => sw,
      getNorthEast: () => ne,
      getCenter: () => ({ lat: 52.25, lng: 9.8 }),
      contains: () => false
    };
    UA.reverseGeocode = async () => null;
    return {
      CITY_RAW: cityRaw,
      allPts: [],
      selectionBounds: bounds,
      exportOptions: { includeCosts: false, includeMeasures: false }
    };
  }

  beforeEach(() => {
    savedGlobalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = savedGlobalFetch;
  });

  test('returns global docs when no city file exists', async () => {
    const fetchImpl = makeFetch({ 'references_global.json': globalDocs });
    global.fetch = fetchImpl;
    UA = loadUA(fetchImpl);
    const r = await UA.computeExportReport(makeCtx(UA, '__nonexistent_city__'));
    expect(r.structured.references).not.toBeNull();
    const titles = r.structured.references.documents.map(d => d.title);
    expect(titles).toContain("Global A");
    expect(titles).toContain("Shared Entry");
  });

  test('merges global + city docs; city entry wins on duplicate title+author', async () => {
    const fetchImpl = makeFetch({
      'references_global.json': globalDocs,
      'references_testcity.json': cityDocs
    });
    global.fetch = fetchImpl;
    UA = loadUA(fetchImpl);
    const r = await UA.computeExportReport(makeCtx(UA, 'testcity'));
    const docs = r.structured.references.documents;
    const titles = docs.map(d => d.title);
    expect(titles).toContain("Global A");
    expect(titles).toContain("Shared Entry");
    expect(titles).toContain("City B");
    // No duplicates
    expect(titles.filter(t => t === "Shared Entry").length).toBe(1);
    // City version wins
    const shared = docs.find(d => d.title === "Shared Entry");
    expect(shared.description).toBe("city wins");
  });

  test.each(['hannover', 'berlin'])('cites the publisher record for ERA 2010 once in %s and keeps the local publications', async city => {
    const cityCatalog = require(`../../templates/references_${city}.json`);
    const fetchImpl = makeFetch({
      'references_global.json': GLOBAL_REFS,
      [`references_${city}.json`]: cityCatalog
    });
    global.fetch = fetchImpl;
    UA = loadUA(fetchImpl);
    const report = await UA.computeExportReport(makeCtx(UA, city));
    const documents = report.structured.references.documents;
    const title = 'Empfehlungen für Radverkehrsanlagen (ERA)';
    expect(documents.filter(doc => doc.title === title)).toEqual([expect.objectContaining({
      title, author: 'Forschungsgesellschaft für Straßen- und Verkehrswesen (FGSV)',
      date: '2010', isbn: '978-3-941790-63-6', url: 'https://www.fgsv-verlag.de/era'
    })]);
    expect(documents.map(doc => doc.title)).toEqual(expect.arrayContaining(cityCatalog.documents.map(doc => doc.title)));
    expect(report.text.split(title)).toHaveLength(2);
  });

  test('uses the source publications for the four Hannover planning references', async () => {
    const cityCatalog = require('../../templates/references_hannover.json');
    const fetchImpl = makeFetch({ 'references_global.json': GLOBAL_REFS, 'references_hannover.json': cityCatalog });
    global.fetch = fetchImpl;
    UA = loadUA(fetchImpl);
    const report = await UA.computeExportReport(makeCtx(UA, 'Hannover'));
    const references = report.structured.references.documents;
    const byTitle = new Map(references.map(doc => [doc.title, doc]));
    const regionalGuide = byTitle.get('Die Ideale Kreuzung – Ein Leitfaden für Planerinnen und Planer');
    expect(regionalGuide).toMatchObject({ date: '2021', url: expect.stringContaining('/875371/file/') });
    const dutchDesign = byTitle.get('Kreuzungen für alle von 8 bis 80 – Gestaltungsvarianten aus den Niederlanden');
    expect(dutchDesign).toMatchObject({ date: '2020', url: expect.stringContaining('/adfc_innorad_kreuzungen_web.pdf') });
    expect(byTitle.get('Schulwegpläne für die Grundschule')).toMatchObject({
      author: 'Verkehrswacht Medien & Service GmbH', url: expect.stringContaining('/105-Infoblatt-Schulwegplaene-fuer-die-Grundschule.pdf')
    });
    expect(byTitle.get('Richtlinien für die Anlage von Stadtstraßen (RASt 06)').url).toBe('https://www.fgsv-verlag.de/rast');
    const preview = new DOMParser().parseFromString(report.html, 'text/html');
    const links = Array.from(preview.querySelectorAll('a[href]'), anchor => anchor.href);
    for (const entry of references) expect(links).toContain(entry.url);
  });

  test('retains different editions and publishers even when their title or catalogue URL agrees', async () => {
    const shared = { title: 'Planungsleitfaden', author: 'Verkehrsverlag', date: '2010', url: 'https://example.org/katalog' };
    const local = [
      { ...shared, date: '2025' },
      { ...shared, author: 'Stadt Hannover' },
      { ...shared, isbn: '978-3-941790-07-0' }
    ];
    const fetchImpl = makeFetch({
      'references_global.json': { documents: [{ ...shared, isbn: '978-3-941790-63-6' }] },
      'references_testcity.json': { documents: local }
    });
    global.fetch = fetchImpl;
    UA = loadUA(fetchImpl);
    const report = await UA.computeExportReport(makeCtx(UA, 'testcity'));
    expect(report.structured.references.documents).toHaveLength(4);
    expect(report.structured.references.documents).toEqual(expect.arrayContaining(local));
  });

  test('gracefully falls back to global docs when city file fetch fails', async () => {
    const fetchImpl = makeFetch({ 'references_global.json': globalDocs });
    global.fetch = fetchImpl;
    UA = loadUA(fetchImpl);
    const r = await UA.computeExportReport(makeCtx(UA, 'cityWithNoFile'));
    expect(r.structured.references).not.toBeNull();
    const titles = r.structured.references.documents.map(d => d.title);
    expect(titles).toContain("Global A");
  });

  test('includes the documented Hannover junction in the report independently of the RIS view', async () => {
    const cityData = require('../../templates/references_hannover.json');
    const fetchImpl = makeFetch({ 'references_hannover.json': cityData });
    global.fetch = fetchImpl;
    UA = loadUA(fetchImpl);
    const bounds = (south, west, north, east) => ({
      getSouthWest: () => ({ lat: south, lng: west }),
      getNorthEast: () => ({ lat: north, lng: east }),
      contains: ([lat, lon]) => lat >= south && lat <= north && lon >= west && lon <= east
    });
    const selection = bounds(52.391108, 9.719819, 52.391889, 9.721093);
    const manuallySelected = [
      { title: 'Manuell übernommene Drucksache', url: 'https://example.org/ris/another' },
      { title: 'Übernommener Änderungsantrag', url: 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-1865-2024',
        snapshot: { sha256: 'b'.repeat(64) } }
    ];
    const risView = { query: 'Weidendamm, Nord, Nordstadt', sourceLevels: ['federal'], searchCursor: 'old-page' };
    const ctx = {
      ...makeCtx(UA, 'Hannover'), selectionBounds: selection, risView,
      areaNameOverride: 'Engelbosteler Damm / Haltenhoffstraße / Bodestraße',
      politicalReferences: manuallySelected
    };
    const automatic = await UA.computeExportReport({ ...ctx, politicalReferences: [] });
    expect(automatic.structured.politicalReferences.map(ref => ref.number)).toEqual(['15-1865/2024', '1411/2024 E1']);

    const report = await UA.computeExportReport(ctx);
    const supplement = 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/1411-2024E1';
    expect(report.structured.politicalReferences).toEqual([
      manuallySelected[0],
      expect.objectContaining({ ...manuallySelected[1], number: '15-1865/2024', scope: 'export-area', reason: expect.stringContaining('Fußquerungen') }),
      expect.objectContaining({ number: '1411/2024 E1', url: supplement, scope: 'export-area', reason: expect.stringContaining('allen Knotenpunktarmen') })
    ]);
    expect(report.text).toContain('Bisherige politische Befassung');
    expect(report.text).toContain('1411/2024 E1');
    expect(report.html).toContain(`href="${supplement}"`);
    expect(ctx.politicalReferences).toEqual(manuallySelected);
    expect(ctx.politicalReferences[1]).not.toHaveProperty('scope');
    expect(ctx.risView).toEqual(risView);

    const elsewhere = await UA.computeExportReport({ ...ctx, selectionBounds: bounds(52.391108, 9.7207, 52.391889, 9.721093) });
    expect(elsewhere.structured.politicalReferences).toEqual(manuallySelected);
    const viewportOnly = await UA.computeExportReport({ ...ctx, selectionBounds: null, map: { getBounds: () => selection } });
    expect(viewportOnly.structured.politicalReferences).toEqual(manuallySelected);
  });
});

// ---- DARK_FIGURE_NOTE sources array ----

describe('UA.DARK_FIGURE_NOTE – sources array', () => {
  let UA;

  beforeEach(() => {
    const mockWindow = { UA: {} };
    const load = (rel) => {
      const p = path.resolve(__dirname, '../../js/' + rel);
      (function (window) { eval(fs.readFileSync(p, 'utf8')); })(mockWindow);
    };
    mockWindow.fetch = async () => ({ ok: false, json: async () => ({}), text: async () => '' });
    mockWindow.L = { latLngBounds: () => {} };
    mockWindow.location = { href: 'http://localhost/?city=Hannover' };
    load('ua.utils.js');
    load('ua.filters.js');
    load('ua.accident_views.js');
    load('ua.export_v2.js');
    UA = mockWindow.UA;
  });

  function makeCtx() {
    const sw = { lat: 52.0, lng: 9.7 };
    const ne = { lat: 52.5, lng: 9.9 };
    const bounds = {
      getSouthWest: () => sw,
      getNorthEast: () => ne,
      getCenter: () => ({ lat: 52.25, lng: 9.8 }),
      contains: () => false
    };
    UA.reverseGeocode = async () => null;
    return {
      CITY_RAW: 'Hannover',
      allPts: [],
      selectionBounds: bounds,
      exportOptions: { includeCosts: false, includeMeasures: false }
    };
  }

  const atlas = 'https://www.statistikportal.de/de/karten/unfallatlas';
  const study = 'https://pubmed.ncbi.nlm.nih.gov/22105099/';

  test('the primary source describes the counted population and the study names its city and period', () => {
    const note = UA.DARK_FIGURE_NOTE;
    expect(note.sourceUrl).toBe(atlas);
    expect(note.sources).toEqual(expect.arrayContaining([
      { label: expect.stringMatching(/Unfallatlas/), url: atlas },
      { label: expect.stringMatching(/Münster.*2009.*2010/), url: study }
    ]));
  });

  test('readers can open both original sources from the preview or copy them from the text', async () => {
    const report = await UA.computeExportReport(makeCtx());
    const html = new DOMParser().parseFromString(report.html, 'text/html');
    for (const url of [atlas, study]) {
      expect(report.text).toContain(url);
      expect([...html.querySelectorAll('a[href]')].map(a => a.href)).toContain(url);
    }
  });

  test('structured darkFigureNote includes sources array passthrough', async () => {
    const r = await UA.computeExportReport(makeCtx());
    expect(Array.isArray(r.structured.darkFigureNote.sources)).toBe(true);
    expect(r.structured.darkFigureNote.sources.length).toBeGreaterThanOrEqual(2);
  });
});
