/** @jest-environment node */
'use strict';

const { collectHannoverCatalogue } = require('../../server/political-context/providers/hannoverSimCatalogue');

const ROOT = 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/';
const SEARCH = ROOT + 'Suche.xsp';
const NOW = new Date('2026-11-08T11:00:00Z');
const html = content => `<html><body><main>${content}</main></body></html>`;

function form() {
  return html('<form method="post" action="/lhhsimwebre.nsf/Suche.xsp">'
    + '<input name="view:dynamic:Edit_SucheTyp" type="radio" value="Vorlage" checked>'
    + '<input name="view:dynamic:Edit_SucheKriterium" type="radio" value="Volltext" checked>'
    + '<input name="view:dynamic:Edit_SucheKriterium" type="radio" value="alle">'
    + '<input name="view:dynamic:Edit_SucheNach" value="">'
    + '<select name="view:dynamic:Edit_Jahr"><option value="egal">Alle</option>'
    + Array.from({ length: 6 }, (_, i) => `<option value="${2021 + i}">${2021 + i}</option>`).join('')
    + '</select><select name="view:dynamic:Edit_Maske"><option value="egal">Alle</option></select>'
    + '<select name="view:dynamic:Edit_Beratungsfolge"><option value="egal">Alle</option></select>'
    + '<select name="view:dynamic:Edit_SortierenNach"><option value="1">Relevanz</option><option value="4">Nummer</option></select>'
    + '<select name="view:dynamic:Edit_Maximal"><option value="10">10</option><option value="0" selected>Alle</option></select>'
    + '<input type="hidden" name="toSearch" value="1">'
    + '<input type="hidden" name="$$viewid" value="public-form-state">'
    + '<input type="hidden" name="view:dynamic" value="view:dynamic"></form>');
}

function row(key, title = 'Radwege an der Limmerstraße', date = '05.11.2026', type = 'Antrag') {
  const number = key.replace(/-(\d{4})([A-Z].*)?$/, (_, year, suffix) => `/${year}${suffix ? ' ' + suffix.replace(/([A-Z]+\d+)(?=[A-Z])/g, '$1 ') : ''}`);
  return `<tr><td>${type}</td><td>${number}</td><td><a href="DS/${key}">${title}</a></td>`
    + `<td>${date} (06.11.2026)</td><td>Öffentlicher Einreicher</td></tr>`;
}

function results(rows, count = rows.length) {
  return html(`<h2>${count} Dokumente wurden gefunden</h2><table><thead><tr>`
    + '<th>Vorlagentyp</th><th>Vorlagennummer</th><th>Titel</th><th>Erschienen (aktualisiert) am</th><th>Eingereicht von</th>'
    + `</tr></thead><tbody>${rows.join('')}</tbody></table>`);
}

function document(key, title = 'Radwege an der Limmerstraße') {
  const number = key.replace(/-(\d{4})([A-Z].*)?$/, (_, year, suffix) => `/${year}${suffix ? ' ' + suffix : ''}`);
  return html(`<h2>Drucksache Nr. ${number}:<br>${title}</h2>`
    + '<h3>Informationen:</h3><h4>Nachrichtlich:</h4><ul><li>Stadtbezirksrat Linden-Limmer</li></ul>'
    + '<h3>Inhalt der Drucksache:</h3><h4>Antrag</h4><p>Der Radweg an der Limmerstraße wird saniert.</p>');
}

function fixture({ years = {}, documents = {}, formText = form() } = {}) {
  const calls = [];
  const requestText = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === SEARCH && options.method === 'POST') {
      const params = new URLSearchParams(options.body);
      expect(params.get('view:dynamic:Edit_SucheKriterium')).toBe('alle');
      expect(params.get('view:dynamic:Edit_SucheNach')).toBe('');
      expect(params.get('view:dynamic:Edit_Maximal')).toBe('0');
      expect(params.get('view:dynamic:Edit_Maske')).toBe('egal');
      expect(params.get('view:dynamic:Edit_Beratungsfolge')).toBe('egal');
      expect(params.get('$$viewid')).toBe('public-form-state');
      expect(options.cookie).toBe('SessionID=public-session');
      return { url, status: 200, contentType: 'text/html', text: years[params.get('view:dynamic:Edit_Jahr')] || results([]) };
    }
    if (url === SEARCH) return { url, status: 200, contentType: 'text/html', text: formText, cookies: ['SessionID=public-session; Path=/; HttpOnly'] };
    const text = documents[url.slice(ROOT.length)];
    return { url, status: text ? 200 : 503, contentType: 'text/html', text: text || 'temporarily unavailable' };
  };
  return { calls, requestText };
}

const options = { now: NOW, from: '2021-01-01', discovery: 'search', includeRss: false, strict: true, includeLocationEvidence: true };

test('reads all six public year lists without a keyword and preserves distinct full document IDs', async () => {
  const keys = ['15-0001-2021', '1047-2026', '1047-2026F1', '15-1000-2026N1S1'];
  const { requestText, calls } = fixture({
    years: { 2021: results([row(keys[0], 'Sicherer Radweg', '01.02.2021')]),
      2026: results([row(keys[1]), row(keys[2]), row(keys[3]), row(keys[1])]) },
    documents: Object.fromEntries(keys.map(key => ['DS/' + key, document(key)])),
  });
  const report = jest.fn();
  const catalogue = await collectHannoverCatalogue({ ...options, requestText, report, maxDocuments: 50_000 });
  const queries = calls.filter(call => call.options.method === 'POST');
  expect(queries.map(call => new URLSearchParams(call.options.body).get('view:dynamic:Edit_Jahr')))
    .toEqual(['2021', '2022', '2023', '2024', '2025', '2026']);
  expect(catalogue.records.map(record => record.id).sort()).toEqual(keys.map(key => 'hannover-sim:' + key).sort());
  expect(calls.filter(call => call.url === ROOT + 'DS/1047-2026')).toHaveLength(1);
  expect(catalogue.records.find(record => record.number === '15-1000/2026 N1 S1')).toBeDefined();
  expect(catalogue.records.find(record => record.id.endsWith('15-0001-2021')).date).toBe('2021-02-01');
  expect(catalogue.records.every(record => record.locationEvidence.length > 0)).toBe(true);
  expect(catalogue.coverage).toMatchObject({ from: '2021-01-01', to: '2026-11-08', scope: 'citywide', complete: false });
  expect(catalogue.sources).toContain(SEARCH);
  expect(calls.some(call => call.url.endsWith('Termine.xsp'))).toBe(false);
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ phase: 'search', year: 2026, rows: 4, documents: 3 }));
});

test('rejects a truncated year list instead of publishing it as a complete discovery result', async () => {
  const { requestText } = fixture({ years: { 2021: results([row('15-0001-2021')], 2) } });
  await expect(collectHannoverCatalogue({ ...options, requestText })).rejects.toThrow(/Treffer|Ergebnis|Suchliste/);
});

test('retains verified list metadata when a public detail page is unavailable and exposes the missing evidence', async () => {
  const { requestText } = fixture({ years: { 2021: results([row('15-0001-2021', 'Radweg an der Limmerstraße', '01.02.2021')]) } });
  const { records, coverage } = await collectHannoverCatalogue({ ...options, requestText });
  expect(records).toEqual([expect.objectContaining({ id: 'hannover-sim:15-0001-2021', title: 'Radweg an der Limmerstraße',
    date: '2021-02-01', type: 'Antrag', locationEvidence: [], locationEvidenceUnavailable: true })]);
  expect(coverage.complete).toBe(false);
  expect(coverage.warnings.join(' ')).toMatch(/Drucksachen.*1.*fehlgeschlagen/);
});

test('fails before detail reads when the discovered catalogue exceeds the configured document budget', async () => {
  const { requestText, calls } = fixture({ years: { 2021: results([row('0001-2021'), row('0002-2021')]) } });
  await expect(collectHannoverCatalogue({ ...options, requestText, maxDocuments: 1 })).rejects.toThrow(/Drucksachenlimit/);
  expect(calls.filter(call => call.url.includes('/DS/'))).toEqual([]);
});

test('rejects a form whose action leaves the official search endpoint', async () => {
  const { requestText, calls } = fixture({ formText: form().replace('action="/lhhsimwebre.nsf/Suche.xsp"', 'action="https://elsewhere.example/search"') });
  await expect(collectHannoverCatalogue({ ...options, requestText })).rejects.toThrow(/Suchformular/);
  expect(calls).toHaveLength(1);
});

test('resumes verified details through the shared source cache', async () => {
  const { requestText, calls } = fixture({ years: { 2021: results([row('0001-2021')]) }, documents: { 'DS/0001-2021': document('0001-2021') } });
  const entries = new Map();
  const sourceCache = { getOrLoad: async (key, revision, loader) => {
    const cacheKey = JSON.stringify([key, revision]);
    if (!entries.has(cacheKey)) entries.set(cacheKey, await loader());
    return entries.get(cacheKey);
  } };
  const first = await collectHannoverCatalogue({ ...options, requestText, sourceCache });
  const second = await collectHannoverCatalogue({ ...options, requestText, sourceCache });
  expect(second.records).toEqual(first.records);
  expect(calls.filter(call => call.url === ROOT + 'DS/0001-2021')).toHaveLength(1);
});

test.each([
  ['Anfrage', 'Drucksache', 'Radweg an der Limmerstraße', 'Anfrage'],
  ['Änderungsantrag', 'Drucksache', 'Radweg an der Limmerstraße', 'Änderungsantrag'],
  ['Anfrage', 'Antrag', 'Radweg an der Limmerstraße', 'Anfrage'],
  ['Anfrage', 'Drucksache', 'Antwort zur Limmerstraße', 'Verwaltungsantwort'],
  ['Anfrage', 'Antwort', 'Radweg an der Limmerstraße', 'Verwaltungsantwort'],
  ['Drucksache', 'Beschlussdrucksache', 'Radweg an der Limmerstraße', 'Beschluss'],
  ['', 'Drucksache', 'Antrag zur Limmerstraße', 'Antrag'],
])('uses verified list type %s with detail type %s and title %s as %s', async (listType, detailType, title, expected) => {
  const { requestText } = fixture({ years: { 2021: results([row('0001-2021', title, '01.02.2021', listType)]) },
    documents: { 'DS/0001-2021': document('0001-2021', title).replace('Drucksache Nr.', `${detailType} Nr.`) } });
  const { records } = await collectHannoverCatalogue({ ...options, to: '2021-12-31', requestText });
  expect(records[0].type).toBe(expected);
});

test.each(['source cache', 'checkpoint details', 'checkpoint catalogue'])('normalizes legacy empty evidence and list types from %s without rereading details', async storage => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { createRisSourceCache } = require('../../server/political-context/services/risSourceCache');
  const { createRisSourceCheckpoint } = require('../../server/political-context/services/risSourceCheckpoint');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-legacy-projection-'));
  const firstCheckedAt = new Date(NOW.getTime() - 86400000);
  let cacheTime = firstCheckedAt.getTime();
  try {
    const key = '0001-2021';
    const usefulKey = '0002-2021';
    const { requestText, calls } = fixture({
      years: { 2021: results([row(key, 'Radweg an der Limmerstraße', '01.02.2021', 'Anfrage'),
        row(usefulKey, 'Radweg an der Limmerstraße', '01.02.2021', 'Änderungsantrag')]) },
      documents: { ['DS/' + key]: document(key).replace('<h4>Antrag</h4>', '<h4>Sachverhalt</h4>'),
        ['DS/' + usefulKey]: document(usefulKey) },
    });
    const sourceCache = storage === 'source cache' ? createRisSourceCache({ directory: folder, now: () => cacheTime }) : undefined;
    const checkpoint = storage !== 'source cache' ? createRisSourceCheckpoint({ directory: folder }) : undefined;
    const collectOptions = { ...options, to: '2021-12-31', requestText, sourceCache, checkpoint };
    await collectHannoverCatalogue({ ...collectOptions, now: firstCheckedAt });
    let cachedBytes;
    if (sourceCache) {
      for (const name of await fs.readdir(folder)) {
        const filename = path.join(folder, name);
        const entry = JSON.parse(await fs.readFile(filename, 'utf8'));
        delete entry.payload.locationEvidenceUnavailable;
        entry.payload.detailVerifiedAt = firstCheckedAt.toISOString();
        await fs.writeFile(filename, JSON.stringify(entry));
      }
      cachedBytes = await Promise.all((await fs.readdir(folder)).sort().map(name => fs.readFile(path.join(folder, name), 'utf8')));
    } else {
      const work = await checkpoint.read('hannover-sim', 'public-year-search:true', 2021, 'sim-history-v1');
      delete work.details[key].result.locationEvidenceUnavailable;
      for (const record of work.catalogue.records) {
        delete record.locationEvidenceUnavailable;
        record.type = 'Sonstige';
      }
      await checkpoint.write('hannover-sim', 'public-year-search:true', 2021, 'sim-history-v1', work);
    }
    cacheTime = NOW.getTime();
    const { records } = await collectHannoverCatalogue({ ...collectOptions,
      ...(storage === 'checkpoint catalogue' ? { from: '2022-01-01', to: '2022-12-31', workBudget: 0 } : {}) });
    expect(records.find(record => record.id === 'hannover-sim:' + key))
      .toMatchObject({ type: 'Anfrage', locationEvidence: [], locationEvidenceUnavailable: true });
    const useful = records.find(record => record.id === 'hannover-sim:' + usefulKey);
    expect(useful.type).toBe('Änderungsantrag');
    expect(useful.locationEvidence).toEqual(['Der Radweg an der Limmerstraße wird saniert.']);
    expect(useful.locationEvidenceUnavailable).toBeUndefined();
    expect(records.find(record => record.id === 'hannover-sim:' + key).detailVerifiedAt).toBe(firstCheckedAt.toISOString());
    if (sourceCache) expect(useful.detailVerifiedAt).toBe(firstCheckedAt.toISOString());
    expect(calls.filter(call => call.url.includes('/DS/'))).toHaveLength(2);
    if (sourceCache) {
      expect(sourceCache.stats).toEqual({ hits: 2, misses: 2, writes: 2 });
      expect(await Promise.all((await fs.readdir(folder)).sort().map(name => fs.readFile(path.join(folder, name), 'utf8')))).toEqual(cachedBytes);
    } else {
      const work = await checkpoint.read('hannover-sim', 'public-year-search:true', 2021, 'sim-history-v1');
      expect(work.details[key].checkedAt).toBe(firstCheckedAt.toISOString());
      expect(work.details[usefulKey].checkedAt).toBe(firstCheckedAt.toISOString());
    }
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('an old checkpoint catalogue cannot become a freshly verified snapshot when empty evidence is qualified', async () => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { createRisSourceCheckpoint } = require('../../server/political-context/services/risSourceCheckpoint');
  const { refreshRisCatalogues } = require('../../scripts/refresh-ris-catalogues');
  const { readRisSnapshot } = require('../../server/political-context/services/risSnapshot');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-legacy-clock-'));
  const verifiedAt = new Date('2026-11-01T11:00:00Z');
  const later = new Date('2026-11-20T11:00:00Z');
  try {
    const checkpoint = createRisSourceCheckpoint({ directory: folder });
    const key = '0001-2021';
    const { requestText, calls } = fixture({ years: { 2021: results([row(key)]) },
      documents: { ['DS/' + key]: document(key).replace('<h4>Antrag</h4>', '<h4>Sachverhalt</h4>') } });
    await collectHannoverCatalogue({ ...options, to: '2021-12-31', now: verifiedAt, checkpoint, requestText });
    const work = await checkpoint.read('hannover-sim', 'public-year-search:true', 2021, 'sim-history-v1');
    delete work.details[key].result.locationEvidenceUnavailable;
    delete work.catalogue.records[0].locationEvidenceUnavailable;
    await checkpoint.write('hannover-sim', 'public-year-search:true', 2021, 'sim-history-v1', work);
    const catalogue = await collectHannoverCatalogue({ ...options, from: '2022-01-01', to: '2022-12-31',
      now: later, workBudget: 0, checkpoint, requestText });
    expect(catalogue.records[0]).toMatchObject({ locationEvidenceUnavailable: true, detailVerifiedAt: verifiedAt.toISOString() });
    expect(calls).toHaveLength(3);
    const directory = path.join(folder, 'published');
    await expect(refreshRisCatalogues({ directory, cities: ['hannover'], now: later,
      fetchPublished: async () => new Response(null, { status: 404 }), collect: async () => catalogue }))
      .resolves.toMatchObject([{ status: 'unavailable' }]);
    await expect(readRisSnapshot(directory, 'hannover')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('marks bounded operative text as truncated instead of claiming that every paragraph was examined', async () => {
  const content = document('0001-2021').replace('</main>', Array.from({ length: 45 }, (_, i) =>
    `<p>Der Radweg an der Limmerstraße erhält Maßnahme ${i + 1}.</p>`).join('') + '</main>');
  const { requestText } = fixture({ years: { 2021: results([row('0001-2021')]) }, documents: { 'DS/0001-2021': content } });
  const { records } = await collectHannoverCatalogue({ ...options, requestText });
  expect(records[0].locationEvidence).toHaveLength(40);
  expect(records[0].locationEvidenceTruncated).toBe(true);
});

test('keeps a verified list entry on a detail failure in non-strict mode too', async () => {
  const { requestText } = fixture({ years: { 2021: results([row('0001-2021')]) } });
  const { records, coverage } = await collectHannoverCatalogue({ ...options, strict: false, requestText });
  expect(records).toHaveLength(1);
  expect(records[0].locationEvidenceUnavailable).toBe(true);
  expect(coverage.warnings.join(' ')).toMatch(/Drucksachen: 1 Abruf/);
});

test('retains all verified year-list entries when an auxiliary older document is unavailable', async () => {
  const content = document('0001-2021').replace('<h3>Inhalt der Drucksache:',
    `<h4>Verwandte Drucksachen:</h4><a href="${ROOT}DS/9999-2019">9999/2019 (Originalvorlage)</a><h3>Inhalt der Drucksache:`);
  const { requestText, calls } = fixture({ years: { 2021: results([row('0001-2021')]) },
    documents: { 'DS/0001-2021': content } });
  const { records, coverage } = await collectHannoverCatalogue({ ...options, requestText });
  expect(calls.some(call => call.url === ROOT + 'DS/9999-2019')).toBe(true);
  expect(records.map(record => record.id)).toEqual(['hannover-sim:0001-2021']);
  expect(records[0].locationEvidence).toContain('Der Radweg an der Limmerstraße wird saniert.');
  expect(coverage.warnings.join(' ')).toMatch(/Drucksachen: 1 Abruf/);
  expect(coverage.warnings.join(' ')).toContain('9999-2019');
  expect(coverage.complete).toBe(false);
});

test('persists year work at a document budget, resumes remaining details and preserves completed earlier years', async () => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-history-'));
  try {
    const { createRisSourceCheckpoint } = require('../../server/political-context/services/risSourceCheckpoint');
    const checkpoint = createRisSourceCheckpoint({ directory: folder });
    const { requestText, calls } = fixture({
      years: { 2021: results([row('0001-2021', 'Alte Vorlage', '01.02.2021'), row('0002-2021', 'Zweite Vorlage', '02.02.2021')]),
        2022: results([row('0001-2022', 'Neue Vorlage', '01.02.2022')]) },
      documents: { 'DS/0001-2021': document('0001-2021'), 'DS/0002-2021': document('0002-2021'), 'DS/0001-2022': document('0001-2022') },
    });
    const first = await collectHannoverCatalogue({ ...options, to: '2022-12-31', checkpoint, workBudget: 1, requestText });
    expect(first.records.map(record => record.id)).toEqual(['hannover-sim:0001-2021', 'hannover-sim:0002-2021']);
    expect(first.coverage.warnings.join(' ')).toMatch(/fortsetz|offen/i);
    expect(first.history.pending).toBe(true);
    expect(first.history.interrupted).toBe(true);
    const second = await collectHannoverCatalogue({ ...options, to: '2022-12-31', checkpoint, workBudget: 10, requestText });
    expect(second.records.map(record => record.id)).toEqual(['hannover-sim:0001-2021', 'hannover-sim:0001-2022', 'hannover-sim:0002-2021']);
    expect(second.history.pending).toBe(false);
    expect(calls.filter(call => call.url === ROOT + 'DS/0001-2021')).toHaveLength(1);
    const third = await collectHannoverCatalogue({ ...options, from: '2022-01-01', to: '2022-12-31', checkpoint, requestText });
    expect(third.records).toHaveLength(3);
    expect(third.coverage.from).toBe('2021-01-01');
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('checkpoint retries failed detail metadata and detects changed source revisions', async () => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-revision-'));
  try {
    const { createRisSourceCheckpoint } = require('../../server/political-context/services/risSourceCheckpoint');
    const checkpoint = createRisSourceCheckpoint({ directory: folder });
    const broken = fixture({ years: { 2021: results([row('0001-2021')]) } });
    const first = await collectHannoverCatalogue({ ...options, to: '2021-12-31', checkpoint, requestText: broken.requestText });
    expect(first.records[0].locationEvidenceUnavailable).toBe(true);
    expect(first.history.pending).toBe(true);
    expect(first.history.interrupted).toBe(false);
    const fixed = fixture({ years: { 2021: results([row('0001-2021')]) }, documents: { 'DS/0001-2021': document('0001-2021') } });
    const second = await collectHannoverCatalogue({ ...options, to: '2021-12-31', checkpoint, requestText: fixed.requestText });
    expect(second.records[0].locationEvidence).toHaveLength(1);
    expect(second.history.pending).toBe(false);
    const changed = fixture({ years: { 2021: results([row('0001-2021')]).replace('06.11.2026', '07.11.2026') },
      documents: { 'DS/0001-2021': document('0001-2021', 'Geänderte Vorlage') } });
    const third = await collectHannoverCatalogue({ ...options, to: '2021-12-31', checkpoint, requestText: changed.requestText });
    expect(third.records[0].title).toBe('Geänderte Vorlage');
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});


test.each([false, true])('failed refreshed checkpoint details preserve their verification clock through publication (checkpoint only=%s)', async checkpointOnly => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { createRisSourceCheckpoint } = require('../../server/political-context/services/risSourceCheckpoint');
  const { refreshRisCatalogues } = require('../../scripts/refresh-ris-catalogues');
  const { readRisSnapshot } = require('../../server/political-context/services/risSnapshot');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-stale-publication-'));
  const verifiedAt = new Date('2026-11-01T11:00:00Z');
  try {
    const checkpoint = createRisSourceCheckpoint({ directory: folder });
    const directory = path.join(folder, 'published');
    const key = '0001-2021F1';
    const parentKey = '0001-2021';
    const relatedDocument = document(key).replace('<h3>Inhalt der Drucksache:',
      `<h4>Verwandte Drucksachen:</h4><a href="${ROOT}DS/${parentKey}">0001/2021 (Originalvorlage)</a><h3>Inhalt der Drucksache:`);
    const fresh = fixture({ years: { 2021: results([row(key)]) },
      documents: { ['DS/' + key]: relatedDocument, ['DS/' + parentKey]: document(parentKey) } });
    const collect = (now, requestText) => collectHannoverCatalogue({ ...options, to: '2021-12-31', now, checkpoint, requestText });
    const publish = (now, value) => refreshRisCatalogues({ directory, cities: ['hannover'], now,
      fetchPublished: async () => new Response(null, { status: 404 }), collect: async () => value });
    const original = await collect(verifiedAt, fresh.requestText);
    await publish(verifiedAt, original);
    const before = await readRisSnapshot(directory, 'hannover');
    expect(before.features.features.length).toBeGreaterThan(0);
    if (checkpointOnly) await fs.rm(directory, { recursive: true });
    for (const now of [NOW, new Date('2026-11-10T11:00:00Z')]) {
      const unavailable = fixture({ years: { 2021: results([row(key, 'Aktueller amtlicher Listentitel', '07.11.2026', 'Anfrage')]) } });
      const next = await collect(now, unavailable.requestText);
      expect(next.records.find(record => record.id === `hannover-sim:${key}`)).toMatchObject({ title: 'Aktueller amtlicher Listentitel', date: '2026-11-07', type: 'Anfrage',
        relatedTo: `hannover-sim:${parentKey}`, locationEvidence: original.records[0].locationEvidence, locationEvidenceUnavailable: true, detailVerifiedAt: verifiedAt.toISOString() });
      await publish(now, next);
      const after = await readRisSnapshot(directory, 'hannover');
      expect(after.manifest.generatedAt).toBe(verifiedAt.toISOString());
      expect(after.manifest.coverage.warnings.join(' ')).toMatch(/Detail.*verifiziert|verifiziert.*Detail/i);
      expect(after.features.features.map(item => item.geometry)).toEqual(before.features.features.map(item => item.geometry));
      expect(after.records[0].locationAssessment.reasons).toContain('document_text_unavailable');
    }
    const expiry = new Date('2026-11-15T11:00:00Z');
    const next = await collect(expiry, fixture({ years: { 2021: results([row(key, 'Aktueller amtlicher Listentitel')]) } }).requestText);
    await expect(publish(expiry, next)).resolves.toMatchObject([{ status: 'unavailable' }]);
    await expect(readRisSnapshot(directory, 'hannover')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});
