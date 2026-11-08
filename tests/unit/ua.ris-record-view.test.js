'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SOURCE = 'https://ris.hannit.de/public/';
const SNAPSHOT = { city: 'hannover', sha256: 'a'.repeat(64), mapSha256: 'b'.repeat(64) };
const BASE_RECORD = {
  id: 'region-hannover-ris:vo:2003037', title: 'Radverkehr am Mittellandkanal',
  number: '2073 (V) BDs', type: 'Beschlussdrucksache', source: 'region-hannover-ris',
  url: SOURCE + 'vo020?VOLFDNR=2003037', snapshot: SNAPSHOT,
};
const DEFAULT_VIEW = { section: 'history', eventsPage: 0, relationsPage: 0, relatedPage: 0, locationsPage: 0, collapsed: false };
const event = (date, body, outcome = null) => ({ date, body, outcome, url: SOURCE + 'to020?TOLFDNR=1', evidence: 'Öffentliche Beratung laut Sitzungsbeleg.' });
const page = (field, items = [], extra = {}) => ({ [field]: items, known: true, start: 0, total: items.length, page: 0, nextPage: null, complete: true, missing: [], ...extra });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function button(root, name) { return [...root.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') || node.textContent).includes(name)); }
function script(name) {
  const file = path.resolve(__dirname, '../../js', name);
  if (fs.existsSync(file)) (function(window) { eval(fs.readFileSync(file, 'utf8')); })(window);
}

describe('shared council record presentation', () => {
  let UA, mounted;

  beforeEach(() => {
    document.body.innerHTML = '<button id="outside">Karte</button>';
    UA = window.UA = {};
    script('ua.ris-record-view.js');
    UA.RisCatalogue = {
      loadRecordEvents: jest.fn().mockResolvedValue(page('events')),
      loadRecordRelationships: jest.fn().mockResolvedValue(page('relationships')),
      loadRelatedRecords: jest.fn().mockResolvedValue(page('records')),
      loadRecordLocations: jest.fn().mockResolvedValue(page('locations')),
      loadRecordGeometries: jest.fn().mockResolvedValue(page('geometryIds')),
    };
    mounted = [];
  });

  afterEach(() => { mounted.forEach(instance => instance.destroy()); delete window.UA; });

  function mount(record = BASE_RECORD, initialView = {}, callbacks = {}) {
    expect(UA.RisRecordView?.create).toEqual(expect.any(Function));
    let view = { ...DEFAULT_VIEW, ...initialView };
    const changes = [];
    let instance;
    instance = UA.RisRecordView.create({
      record, city: 'hannover', snapshot: SNAPSHOT, view, isActive: () => true,
      onViewChange(patch) {
        changes.push(patch);
        view = { ...view, ...patch };
        instance?.update(view);
      },
      ...callbacks,
    });
    document.body.append(instance.element);
    mounted.push(instance);
    return { ...instance, changes, setView(patch) { view = { ...view, ...patch }; instance.update(view); } };
  }

  // Break caught: displaying source order as chronology or omitting missing fields.
  test('shows dated evidence chronologically and undated evidence separately without inventing outcomes', async () => {
    const record = { ...BASE_RECORD, events: [
      event('2026-06-20', 'Regionsversammlung', 'Vertagt'),
      event(null, 'Ausschuss ohne Datum'),
      event('2026-01-10', 'Verkehrsausschuss', 'Zur Kenntnis genommen'),
    ], sourceContext: { level: 'region', publisher: 'Region Hannover', issuer: 'Fachbereich Verkehr',
      documentKind: 'Drucksache', status: 'proposal', documentDate: '2026-01-01' } };
    const { element } = mount(record);
    await flush();
    expect([...element.querySelectorAll('time')].map(node => node.dateTime)).toEqual(['2026-01-01', '2026-01-10', '2026-06-20']);
    const timeline = element.querySelector('[aria-label="Datierte Beratungen"]');
    expect(timeline.textContent.indexOf('Verkehrsausschuss')).toBeLessThan(timeline.textContent.indexOf('Regionsversammlung'));
    expect(element.querySelector('[aria-label="Beratungen ohne Datumsangabe"]').textContent).toContain('Ausschuss ohne Datum');
    expect(element.textContent).toContain('Ergebnis nicht dokumentiert');
    expect(element.textContent).toContain('Region Hannover');
    expect(element.textContent).toContain('Öffentliche Beratung laut Sitzungsbeleg.');
    expect(element.textContent).not.toMatch(/Umsetzung abgeschlossen|Vorbereitung abgeschlossen/);
    expect(UA.RisCatalogue.loadRecordRelationships).not.toHaveBeenCalled();
    expect(UA.RisCatalogue.loadRelatedRecords).not.toHaveBeenCalled();
  });

  // Break caught: treating a shared page as a request to replay all preceding pages.
  test('loads exactly the selected history page with its snapshot and replaces it on navigation', async () => {
    UA.RisCatalogue.loadRecordEvents.mockImplementation(async (_city, _id, index) => index === 2
      ? page('events', [event('2026-03-01', 'Dritte Seite')], { start: 128, total: 129, page: 2 })
      : page('events', [event('2026-02-01', 'Zweite Seite')], { start: 64, total: 129, page: 1, nextPage: 2 }));
    const view = mount({ ...BASE_RECORD, eventCount: 129 }, { eventsPage: 2 });
    await flush();
    expect(UA.RisCatalogue.loadRecordEvents.mock.calls).toEqual([['hannover', BASE_RECORD.id, 2, { snapshot: SNAPSHOT }]]);
    expect(view.element.textContent).toContain('129 von 129');
    const previous = button(view.element, 'Vorherige Seite Beratungsverlauf');
    previous.focus(); previous.click();
    await flush();
    expect(view.changes).toContainEqual({ eventsPage: 1 });
    expect(view.element.textContent).toContain('Zweite Seite');
    expect(view.element.textContent).not.toContain('Dritte Seite');
    expect(document.activeElement).toBe(previous);
    expect(UA.RisCatalogue.loadRecordEvents.mock.calls.map(call => call[2])).toEqual([2, 1]);
  });

  // Break caught: claiming unavailable history is known empty, or silently dropping partial evidence.
  test('distinguishes unknown, known empty and incomplete histories and retries the same partial page', async () => {
    UA.RisCatalogue.loadRecordEvents
      .mockResolvedValueOnce(page('events', [], { known: false, total: null }))
      .mockResolvedValueOnce(page('events'))
      .mockResolvedValueOnce(page('events', [event('2026-01-10', 'Beleg aus Teilabruf')], { total: 2, complete: false, missing: ['part'] }))
      .mockResolvedValueOnce(page('events', [event('2026-01-10', 'Vollständiger Beleg'), event('2026-01-11', 'Zweiter Beleg')]));
    const unknown = mount(); await flush();
    expect(unknown.element.textContent).toMatch(/Beratungsverlauf.*nicht dokumentiert/);
    expect(unknown.element.textContent).not.toContain('Keine öffentlichen Beratungen');
    const empty = mount(); await flush();
    expect(empty.element.textContent).toContain('Keine öffentlichen Beratungen');
    const partial = mount(); await flush();
    expect(partial.element.textContent).toContain('Beleg aus Teilabruf');
    expect(partial.element.textContent).toMatch(/unvollständig/);
    button(partial.element, 'Erneut laden').click(); await flush();
    expect(partial.element.textContent).toContain('Zweiter Beleg');
    expect(partial.element.textContent).not.toContain('Beleg aus Teilabruf');
    expect(UA.RisCatalogue.loadRecordEvents.mock.calls.map(call => call[2])).toEqual([0, 0, 0, 0]);
  });

  // Break caught: an old async response replacing a newer page or writing after destroy.
  test('ignores out-of-order pages and all delayed content after destruction', async () => {
    const first = deferred(), second = deferred();
    UA.RisCatalogue.loadRecordEvents.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = mount({ ...BASE_RECORD, eventCount: 129 });
    view.setView({ eventsPage: 1 });
    second.resolve(page('events', [event('2026-02-01', 'Aktuelle Seite')], { page: 1, start: 64, total: 129, nextPage: 2 }));
    await flush();
    first.resolve(page('events', [event('2026-01-01', 'Veraltete Seite')], { total: 129, nextPage: 1 }));
    await flush();
    expect(view.element.textContent).toContain('Aktuelle Seite');
    expect(view.element.textContent).not.toContain('Veraltete Seite');
    const pending = deferred();
    UA.RisCatalogue.loadRecordEvents.mockReturnValueOnce(pending.promise);
    view.setView({ eventsPage: 2 });
    view.destroy();
    const before = view.element.textContent;
    pending.resolve(page('events', [event('2026-03-01', 'Geschlossener Vorgang')], { page: 2, start: 128, total: 129 }));
    await flush();
    expect(view.element.textContent).toBe(before);
  });

  // Break caught: merging independent relation page states or treating a component member as a direct parent.
  test('keeps direct references and related records separate and navigates only supplied stable IDs', async () => {
    const opened = [];
    UA.RisCatalogue.loadRecordRelationships.mockResolvedValue(page('relationships', [
      { type: 'related', targetId: 'region-hannover-ris:vo:2003038', targetUrl: SOURCE + 'vo020?VOLFDNR=2003038',
        targetRole: 'answer', label: 'Antwort auf die Anfrage', evidence: 'In der amtlichen Vorlage verknüpft.' },
      { type: 'mentions', targetId: null, targetUrl: SOURCE + 'vo020?VOLFDNR=2003039',
        targetRole: null, label: 'Erwähnte Drucksache', evidence: 'Nur im Dokument erwähnt.' },
    ], { page: 2, start: 128, total: 130 }));
    UA.RisCatalogue.loadRelatedRecords.mockResolvedValue(page('records', [
      { ...BASE_RECORD, id: 'region-hannover-ris:vo:2003040', title: 'Weiterer zusammenhängender Vorgang' },
    ], { page: 1, start: 63, total: 64 }));
    const view = mount({ ...BASE_RECORD, relationshipCount: 130 },
      { section: 'relations', relationsPage: 2, relatedPage: 1 }, { onOpenRecord: id => opened.push(id) });
    await flush();
    const direct = view.element.querySelector('[aria-label="Direkte Querverweise"]');
    const related = view.element.querySelector('[aria-label="Verknüpfte Vorgänge"]');
    expect(direct.textContent).toContain('Amtlicher Querverweis');
    expect(direct.textContent).toContain('Im Dokument erwähnt');
    expect(related.textContent).toContain('Weiterer zusammenhängender Vorgang');
    expect(related.textContent).not.toMatch(/Gehört zu|Antwort auf|Beschlossen/);
    button(direct, 'Vorgang öffnen: Antwort auf die Anfrage').click();
    button(related, 'Vorgang öffnen: Weiterer zusammenhängender Vorgang').click();
    expect(opened).toEqual(['region-hannover-ris:vo:2003038', 'region-hannover-ris:vo:2003040']);
    expect([...direct.querySelectorAll('button')].filter(node => node.getAttribute('aria-label')?.startsWith('Vorgang öffnen:'))).toHaveLength(1);
    expect(UA.RisCatalogue.loadRecordRelationships.mock.calls).toEqual([['hannover', BASE_RECORD.id, 2, { snapshot: SNAPSHOT }]]);
    expect(UA.RisCatalogue.loadRelatedRecords.mock.calls).toEqual([['hannover', BASE_RECORD.id, 1, { snapshot: SNAPSHOT }]]);
    expect(UA.RisCatalogue.loadRecordEvents).not.toHaveBeenCalled();
  });

  // Break caught: interpolating source markup or accepting executable/credential-bearing external links.
  test('renders source text literally and permits only credential-free HTTPS links', async () => {
    const title = '<img src=x onerror=alert(1)> Gemeinsamer Vorgang';
    const view = mount({ ...BASE_RECORD, title, url: 'javascript:alert(1)',
      originalPdfUrl: 'https://user:password@ris.hannit.de/private.pdf',
      events: [{ ...event('2026-01-10', '<script>bad()</script>'), url: 'http://ris.hannit.de/public/', evidence: '<svg onload=bad()>Beleg</svg>' }] });
    await flush();
    expect(view.element.textContent).toContain(title);
    expect(view.element.textContent).toContain('<svg onload=bad()>Beleg</svg>');
    expect(view.element.querySelector('img,script,svg')).toBeNull();
    expect(view.element.querySelectorAll('a')).toHaveLength(0);
  });

  // Break caught: losing keyboard access or allowing a hidden section's delayed results to take effect.
  test('uses arrow-key section navigation and invalidates the former section request', async () => {
    const pending = deferred();
    UA.RisCatalogue.loadRecordEvents.mockReturnValueOnce(pending.promise);
    const view = mount();
    const history = view.element.querySelector('[role="tab"][aria-selected="true"]');
    history.focus();
    history.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flush();
    expect(view.changes).toContainEqual({ section: 'relations' });
    expect(document.activeElement.textContent).toContain('Zusammenhänge');
    expect(document.activeElement.getAttribute('aria-selected')).toBe('true');
    pending.resolve(page('events', [event('2026-01-01', 'Nicht mehr aktiver Abschnitt')]));
    await flush();
    expect(view.element.textContent).not.toContain('Nicht mehr aktiver Abschnitt');
    expect([...view.element.querySelectorAll('[role="tabpanel"]')].filter(panel => !panel.hidden)).toHaveLength(1);
  });

  // Break caught: eagerly requesting collapsed details or completing stale actions after a city change.
  test('defers collapsed content and suppresses updates when the owning context becomes inactive', async () => {
    let active = true;
    const pending = deferred();
    UA.RisCatalogue.loadRecordEvents.mockReturnValueOnce(pending.promise);
    const view = mount(BASE_RECORD, { collapsed: true }, { isActive: () => active });
    await flush();
    expect(UA.RisCatalogue.loadRecordEvents).not.toHaveBeenCalled();
    view.setView({ collapsed: false });
    expect(UA.RisCatalogue.loadRecordEvents).toHaveBeenCalledTimes(1);
    active = false;
    pending.resolve(page('events', [event('2026-01-01', 'Andere Stadt')]));
    await flush();
    expect(view.element.textContent).not.toContain('Andere Stadt');
  });

  // Break caught: a wholly local history still needs to correct an impossible slice without catalogue reads.
  test('normalizes a locally sliced history page without remote requests', async () => {
    const view = mount({ ...BASE_RECORD, events: [event('2026-03-01', 'Lokaler Beleg')] }, { eventsPage: 1000000 });
    await flush();
    expect(view.changes).toContainEqual({ eventsPage: 0 });
    expect(UA.RisCatalogue.loadRecordEvents).not.toHaveBeenCalled();
    expect(view.element.textContent).toContain('Lokaler Beleg');
  });

  // Break caught: treating a page lookup error as an empty relation set or recursively replaying pages.
  test('returns a nonexistent related-record page to the first page without a replay loop', async () => {
    UA.RisCatalogue.loadRelatedRecords
      .mockRejectedValueOnce(Object.assign(new Error('RIS page does not exist'), { code: 'RIS_SNAPSHOT_INVALID' }))
      .mockResolvedValueOnce(page('records', [{ ...BASE_RECORD, id: 'region-hannover-ris:vo:other', title: 'Gültig verknüpft' }]));
    const view = mount(BASE_RECORD, { section: 'relations', relatedPage: 999 });
    await flush(); await flush();
    expect(view.changes).toContainEqual({ relatedPage: 0 });
    expect(UA.RisCatalogue.loadRelatedRecords.mock.calls.map(call => call[2])).toEqual([999, 0]);
    expect(view.element.textContent).toContain('Gültig verknüpft');
  });

  // Break caught: dropping unlocated evidence or sending a paged location's wrong identity to the map.
  test('keeps unlocated place evidence visible and sends exact location and geometry identities to the map', async () => {
    const geometryId = 'geometry:' + 'c'.repeat(64);
    const location = { id: 'location:' + 'd'.repeat(64), geometryId, label: 'Mittellandkanal', kind: 'section', mapped: true,
      evidence: { source: 'document', text: 'Radverkehr am Mittellandkanal.' } };
    UA.RisCatalogue.loadRecordLocations.mockResolvedValue(page('locations', [location,
      { label: 'Spielplatz', kind: 'place', mapped: false, evidence: { source: 'title', text: 'Sicherheit am Spielplatz' } }],
    { page: 1, start: 64, total: 66 }));
    const shown = [];
    const view = mount({ ...BASE_RECORD, locationCount: 66, geometryIds: [], geometryNextPage: null },
      { section: 'locations', locationsPage: 1 }, { onShowLocation: (...args) => shown.push(args) });
    await flush();
    expect(view.element.textContent).toContain('Sicherheit am Spielplatz');
    expect(view.element.textContent).toContain('Nicht auf der Karte verortet');
    const mapButton = button(view.element, 'Auf Karte zeigen: Mittellandkanal');
    expect(button(view.element, 'Auf Karte zeigen: Spielplatz')).toBeUndefined();
    mapButton.click(); await flush();
    expect(shown[0][0].id).toBe(BASE_RECORD.id);
    expect(shown[0][1]).toEqual(location);
    expect(shown[0][2]).toMatchObject({ index: 64, geometryId });
    expect(UA.RisCatalogue.loadRecordLocations.mock.calls).toEqual([['hannover', BASE_RECORD.id, 1, { snapshot: SNAPSHOT }]]);
  });

  // Break caught: hiding official geometry merely because the record has no location text.
  test('offers geometry-only records a map action without inventing location evidence', async () => {
    const geometryId = 'geometry:' + 'e'.repeat(64);
    const shown = [];
    const view = mount({ ...BASE_RECORD, locationCount: 0, geometryIds: [geometryId], geometryNextPage: null },
      { section: 'locations' }, { onShowLocation: (...args) => shown.push(args) });
    await flush();
    const mapButton = button(view.element, 'Auf Karte zeigen: Kartenlage');
    expect(mapButton).toBeDefined();
    mapButton.click(); await flush();
    expect(shown[0][1]).toBeNull();
    expect(shown[0][2]).toMatchObject({ geometryId });
    expect(view.element.textContent).not.toContain('Beleg im Dokument');
  });

  // Break caught: removing the focused retry action after success leaves keyboard focus on a hidden control.
  test('moves a completed retry to its result status while leaving outside focus untouched', async () => {
    UA.RisCatalogue.loadRecordEvents
      .mockRejectedValueOnce(new Error('temporarily unavailable'))
      .mockResolvedValueOnce(page('events', [event('2026-01-01', 'Erneut geladener Beleg')]));
    const view = mount(); await flush();
    const retry = button(view.element, 'Erneut laden');
    retry.focus(); retry.click(); await flush();
    expect(document.activeElement.getAttribute('role')).toBe('status');
    expect(document.activeElement.textContent).toContain('1 von 1');
    const outside = document.getElementById('outside');
    outside.focus();
    view.setView({ section: 'relations' }); await flush();
    expect(document.activeElement).toBe(outside);
  });

  // Break caught: abandoning a retry leaves its cached partial result permanently marked as loading.
  test('restarts a hidden partial retry when its section is selected again', async () => {
    const pending = deferred();
    UA.RisCatalogue.loadRecordEvents
      .mockResolvedValueOnce(page('events', [event('2026-01-01', 'Teilbestand')], { complete: false, total: 2 }))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(page('events', [event('2026-01-02', 'Aktueller vollständiger Bestand')]));
    const view = mount(); await flush();
    button(view.element, 'Erneut laden').click();
    view.setView({ section: 'relations' }); await flush();
    view.setView({ section: 'history' }); await flush();
    expect(view.element.querySelector('[data-ris-collection="events"]').getAttribute('aria-busy')).toBe('false');
    expect(view.element.textContent).toContain('Aktueller vollständiger Bestand');
    pending.resolve(page('events', [event('2026-01-03', 'Veralteter Wiederholungsversuch')]));
    await flush();
    expect(view.element.textContent).not.toContain('Veralteter Wiederholungsversuch');
  });

  // Break caught: an empty location page erases the recorded reason why map evidence is unavailable.
  test('keeps the documented scope and gaps of a location assessment visible', async () => {
    const view = mount({ ...BASE_RECORD, locations: [], geometryIds: [], locationCount: 0,
      locationAssessment: { status: 'unavailable', sources: ['title', 'document'],
        reasons: ['document_text_unavailable', 'gazetteer_unavailable'], truncated: true } }, { section: 'locations' });
    await flush();
    const assessment = view.element.querySelector('[aria-label="Ortsprüfung"]');
    expect(assessment).not.toBeNull();
    expect(assessment.textContent).toContain('Dokumenttext');
    expect(assessment.textContent).toMatch(/nicht vollständig verfügbar/);
    expect(assessment.textContent).toContain('Geodaten');
    expect(assessment.textContent).toMatch(/begrenzt/);
    expect(button(view.element, 'Auf Karte zeigen:')).toBeUndefined();
  });

  // Break caught: the catalogue's unknown-count envelope keeps nonexistent shared pages canonical.
  test.each([
    ['history', 'events', 'eventsPage', 'loadRecordEvents', 'Beratungsverlauf'],
    ['relations', 'relationships', 'relationsPage', 'loadRecordRelationships', 'Direkte Querverweise'],
  ])('normalizes an unknown %s page directly to zero without claiming the data is empty', async (section, field, pageKey, method, label) => {
    UA.RisCatalogue[method].mockImplementation(async (_city, _id, index) => ({
      [field]: [], known: false, total: null, start: 0, page: index, nextPage: null, complete: true, missing: [],
    }));
    const view = mount(BASE_RECORD, { section, [pageKey]: 999 });
    await flush(); await flush();
    expect(view.changes).toContainEqual({ [pageKey]: 0 });
    expect(UA.RisCatalogue[method].mock.calls.map(call => call[2])).toEqual([999, 0]);
    const group = view.element.querySelector(`[data-ris-collection="${field}"]`);
    expect(group.textContent).toContain(`${label} im geprüften Datenbestand nicht dokumentiert.`);
    expect(group.textContent).not.toContain('Keine öffentlichen Beratungen');
    expect(group.textContent).not.toContain('Keine direkten amtlichen Querverweise');
    expect(group.querySelector('nav').hidden).toBe(true);
    expect(group.textContent).not.toContain('Seite 1000');
  });

  describe('byte-sized catalogue pages', () => {
    let directory, manifest, reader, reference;

    beforeAll(async () => {
      const { writeRisSnapshot } = require('../../server/political-context/services/risSnapshot');
      const P = require('../../js/ua.ris-partitions');
      const { gunzipSync } = require('node:zlib');
      directory = await fs.promises.mkdtemp(path.join(require('node:os').tmpdir(), 'ris-view-byte-pages-'));
      const { snapshot: _snapshot, ...base } = BASE_RECORD;
      const events = Array.from({ length: 20 }, (_, index) => ({
        ...event('2026-06-01', `Beratung ${index + 1}`), evidence: 'E'.repeat(15000),
      }));
      const relationships = Array.from({ length: 20 }, (_, index) => ({
        type: 'related', targetId: `${base.id}:ref:${index}`, targetUrl: SOURCE + `vo020?VOLFDNR=${index}`,
        targetRole: null, label: `Querverweis ${index + 1}`, evidence: 'Q'.repeat(15000),
      }));
      const locations = Array.from({ length: 20 }, (_, index) => ({
        label: `Ort ${index + 1}: ` + 'L'.repeat(4000), kind: 'place', mapped: false,
        evidence: { source: 'document', text: 'O'.repeat(4000) },
      }));
      manifest = await writeRisSnapshot(directory, 'hannover', {
        sources: [SOURCE], coverage: { from: null, to: null, bodies: [], warnings: [], complete: false },
        records: [{ ...base, date: null, gremium: null, events, relationships, locations }],
      }, { now: new Date('2026-11-08T12:00:00.000Z'), schemaVersion: 2 });
      reader = P.createReader({ manifest,
        load: async asset => JSON.parse(gunzipSync(await fs.promises.readFile(path.join(directory, asset.path))).toString('utf8')) });
      const record = await reader.get('records', base.id);
      const places = await reader.page('locations', base.id, 0);
      reference = { ...record, locations: places.items, locationsNextPage: places.nextPage, geometryIds: [], geometryNextPage: null };
    });

    afterAll(async () => { if (directory) await fs.promises.rm(directory, { recursive: true, force: true }); });

    // Break caught: total/64 incorrectly rejects a real later history page whose rows hit the byte budget first.
    test.each([
      ['history', 'events', 'eventsPage', 'loadRecordEvents', 'Beratungsverlauf'],
      ['relations', 'relationships', 'relationsPage', 'loadRecordRelationships', 'Direkte Querverweise'],
    ])('opens a byte-split %s page directly and navigates by catalogue metadata', async (section, field, pageKey, method, label) => {
      UA.RisCatalogue[method].mockImplementation(async (_city, id, index) => {
        const { items, ...metadata } = await reader.page('links', `${field}:${id}`, index);
        return { ...metadata, [field]: items, known: true };
      });
      const actual = await reader.page('links', `${field}:${reference.id}`, 2);
      expect(actual).toMatchObject({ start: 14, total: 20, page: 2, nextPage: null });
      expect(actual.items).toHaveLength(6);
      const view = mount(reference, { section, [pageKey]: 2 }, { snapshot: manifest });
      await flush(); await flush();
      expect(UA.RisCatalogue[method].mock.calls.map(call => call[2])).toEqual([2]);
      expect(view.changes).toEqual([]);
      const group = view.element.querySelector(`[data-ris-collection="${field}"]`);
      expect(group.textContent).toContain('15–20 von 20');
      expect(group.querySelectorAll(field === 'events' ? '.ris-process-step' : '.ris-record-view__card')).toHaveLength(6);
      button(group, `Vorherige Seite ${label}`).click(); await flush(); await flush();
      expect(group.textContent).toContain('8–14 von 20');
      button(group, `Nächste Seite ${label}`).click(); await flush(); await flush();
      expect(UA.RisCatalogue[method].mock.calls.map(call => call[2])).toEqual([2, 1, 2]);
      expect(group.textContent).toContain('15–20 von 20');
    });

    // Break caught: the location total is treated as a fixed number of 64-item pages.
    test('opens a later byte-split location page despite fewer than 64 total locations', async () => {
      UA.RisCatalogue.loadRecordLocations.mockImplementation(async (_city, id, index) => {
        const { items, ...metadata } = await reader.page('locations', id, index);
        return { ...metadata, locations: items };
      });
      expect(reference.locations).toHaveLength(14);
      const view = mount(reference, { section: 'locations', locationsPage: 1 }, { snapshot: manifest });
      await flush(); await flush();
      expect(UA.RisCatalogue.loadRecordLocations.mock.calls.map(call => call[2])).toEqual([1]);
      expect(view.changes).toEqual([]);
      const group = view.element.querySelector('[data-ris-collection="locations"]');
      expect(group.textContent).toContain('15–20 von 20');
      expect(group.querySelectorAll('.ris-record-view__card')).toHaveLength(6);
      expect(group.textContent).toContain('Ort 15:');
      expect(group.textContent).not.toContain('Ort 1:');
      button(group, 'Vorherige Seite Orte').click(); await flush(); await flush();
      expect(group.textContent).toContain('1–14 von 20');
      expect(UA.RisCatalogue.loadRecordLocations.mock.calls.map(call => call[2])).toEqual([1]);
    });

    // Break caught: a remote page that is actually missing must still recover directly, without guessing a last page.
    test('normalizes an absent remote history page from the reader error without replaying previous pages', async () => {
      UA.RisCatalogue.loadRecordEvents.mockImplementation(async (_city, id, index) => {
        const { items, ...metadata } = await reader.page('links', `events:${id}`, index);
        return { ...metadata, events: items, known: true };
      });
      const view = mount(reference, { eventsPage: 999 }, { snapshot: manifest });
      await flush(); await flush(); await flush();
      expect(UA.RisCatalogue.loadRecordEvents.mock.calls.map(call => call[2])).toEqual([999, 0]);
      expect(view.changes).toEqual([{ eventsPage: 0 }]);
      expect(view.element.querySelector('[data-ris-collection="events"]').textContent).toContain('1–7 von 20');
    });
  });
});
