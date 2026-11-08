/** @jest-environment node */
'use strict';

const ROOT = 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/';
const RAT = 'TM/20260625_Rat';
const ORIGINAL = 'DS/1047-2026';
const ANSWER = 'DS/1047-2026F1';
const TITLE = 'Radwegeausbau am Lindener Stichkanal und am Mittellandkanal';
const TODAY = new Date('2026-11-07T12:00:00Z');

function html(content, base = ROOT) {
  return `<!DOCTYPE html><html><head><base href="${base}"></head><body><main>${content}</main></body></html>`;
}

function archive(links, body = 'der Ratsversammlung') {
  return html(`<h2>Termine ${body}</h2><table>${links}</table>`);
}

function agenda(rows, body = 'Ratsversammlung', date = '25.06.2026', base) {
  return html(`<h2>${body} am ${date}</h2><table><tr><th>Gremium:</th><td>${body}</td></tr>`
    + `<tr><th>Sitzungsdatum:</th><td>${date}</td></tr></table><h3>Tagesordnung:</h3><table>${rows}</table>`, base);
}

function document(heading, title, meta = '', body = '') {
  return html(`<h2>${heading}:<br/>${title}</h2><article><h3>Informationen:</h3>${meta}</article>`
    + `<article><h3>Inhalt der Drucksache:</h3>${body}</article>`);
}

function feed(items) {
  return `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Ratsdrucksachen Hannover</title>${items}</channel></rss>`;
}

function feedItem(url, date, body) {
  return `<item><title>${TITLE}</title><pubDate>${date}</pubDate><description>Gremien: ${body}</description><link>${ROOT}${url}</link></item>`;
}

function transport(pages) {
  const calls = [];
  const requestText = async url => {
    calls.push(url);
    if (!url.startsWith(ROOT)) throw new Error('Unzulässige URL');
    const page = pages[url.slice(ROOT.length)];
    if (!page) return { url, status: 404, contentType: 'text/html', text: 'Nicht gefunden' };
    if (typeof page !== 'string') return { url, ...page };
    return { url, status: 200, contentType: page.startsWith('<?xml') ? 'text/xml' : 'text/html', text: page };
  };
  return { calls, requestText };
}

function collect(options) {
  return require('../../server/political-context/providers/hannoverSimCatalogue').collectHannoverCatalogue(options);
}

test.each(['<!-- ignored -->', '<script>ignored</script>'])('keeps tag fragments apart around %s', async ignored => {
  const { requestText, calls } = transport({
    'Termine.xsp': `<m${ignored}ain><h2>Termine</h2><a href="${RAT}">25.06.2026</a></main>`,
    [RAT]: agenda(`<tr><td><a href="${ORIGINAL}">${TITLE}</a></td></tr>`),
    [ORIGINAL]: document('Anfrage Nr. 1047/2026', TITLE),
  });

  await expect(collect({ now: TODAY, includeRss: false, requestText, strict: true }))
    .rejects.toThrow('Kein öffentlicher SIM-Seiteninhalt');
  expect(calls).toEqual([ROOT + 'Termine.xsp']);
});

test('finds 1047/2026 and its distinct answer via the public Rat agenda and related links', async () => {
  const { requestText, calls } = transport({
    'Termine.xsp': archive(`<tr><td><a href="${RAT}">25.06.2026</a></td></tr>`),
    [RAT]: agenda(`<tr><td><a href=${ORIGINAL}>${TITLE} (Drucks. Nr. 1047/2026)</a></td></tr>`
      + `<tr><td><a href="/lhhsimwebre.nsf/${ORIGINAL}?OpenDocument#top">Erneut verlinkt</a></td></tr>`),
    [ORIGINAL]: document('Anfrage Nr. 1047/2026', TITLE,
      `<h4>verwandte Drucksachen:</h4><table><tr><td><a href="${ANSWER}">&nbsp; &gt; 1. Antwort auf die Originalvorlage</a></td></tr></table>`
      + `<h4>Beratungsverlauf:</h4><ul><li><a href="${RAT}">25.06.2026: Ratsversammlung</a>: Beantwortet</li></ul>`,
      '<p>Inhalt bleibt bei der Stadt.</p><a href="DS/1234-2026">Nur im Volltext erwähnt</a>'),
    [ANSWER]: document('Drucksache Nr. 1047/2026 F1', TITLE,
      `<h4>verwandte Drucksachen:</h4><table><tr><td><a href="../${ORIGINAL}">1047/2026 (Originalvorlage)</a></td></tr></table>`
      + '<h4>Nachrichtlich:</h4><ul><li>Ratsversammlung</li></ul>'),
  });

  const { records, sources, coverage } = await collect({ now: TODAY, includeRss: false, requestText });

  expect(calls).toEqual([ROOT + 'Termine.xsp', ROOT + RAT, ROOT + ORIGINAL, ROOT + ANSWER]);
  expect(records).toEqual([
    { id: 'hannover-sim:1047-2026', title: TITLE, number: '1047/2026', type: 'Anfrage', date: null,
      gremium: 'Ratsversammlung', source: 'hannover-sim', url: ROOT + ORIGINAL },
    { id: 'hannover-sim:1047-2026F1', title: TITLE, number: '1047/2026 F1', type: 'Verwaltungsantwort', date: null,
      gremium: 'Ratsversammlung', source: 'hannover-sim', url: ROOT + ANSWER, relatedTo: 'hannover-sim:1047-2026' },
  ]);
  expect(sources).toEqual([ROOT + 'Termine.xsp']);
  expect(coverage).toMatchObject({ from: '2026-06-25', to: '2026-06-25', bodies: ['Ratsversammlung'], complete: false });
  expect(coverage.warnings).not.toHaveLength(0);
});

test('respects the calendar window and skips private and unsafe links without losing later public rows', async () => {
  const { requestText, calls } = transport({
    'Termine.xsp': archive(`<tr><td><a href="${RAT}">25.06.2026</a></td></tr>`
      + '<tr><td><a href="TM/20260624_Rat">24.06.2026</a></td></tr>'
      + '<tr><td><a href="https://elsewhere.example/lhhsimwebre.nsf/TM/20260625_Rat">25.06.2026</a></td></tr>'),
    [RAT]: agenda('<tr class="nichtoeffentlich"><td><a href="DS/1000-2026">Vertraulich</a></td></tr>'
      + '<tr><td><a href="TOPS/20260625_Rat_2">Nicht&ouml;ffentliche Tagesordnungspunkte</a></td></tr>'
      + '<tr><td><a href="https://e-government.hannover-stadt.de@elsewhere.example/lhhsimwebre.nsf/DS/2000-2026">Fremdlink</a></td></tr>'
      + '<tr><td><a href="http://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/3000-2026">Unsicherer Link</a></td></tr>'
      + '<tr><td><a href="DS/4000-2026?EditDocument">Bearbeitungslink</a></td></tr>'
      + `<tr><td><a href="../${ORIGINAL}">${TITLE}</a></td></tr>`,
    'Ratsversammlung', '25.06.2026', 'https://elsewhere.example/'),
    [ORIGINAL]: document('Anfrage Nr. 1047/2026', TITLE),
  });

  const { records } = await collect({ from: '2026-06-25', to: '2026-06-25', now: TODAY, requestText });
  expect(calls).toEqual([ROOT + 'Termine.xsp', ROOT + RAT, ROOT + ORIGINAL]);
  expect(records.map(record => record.number)).toEqual(['1047/2026']);
});

test('finds an original through an answer link relative to the requested document', async () => {
  const { requestText } = transport({
    'Termine.xsp': archive(`<tr><td><a href="${RAT}">25.06.2026</a></td></tr>`),
    [RAT]: agenda(`<tr><td><a href="${ANSWER}">Antwort zum Radwegeausbau</a></td></tr>`),
    [ANSWER]: document('Drucksache Nr. 1047/2026 F1', `Antwort der Verwaltung: ${TITLE}`,
      `<h4>verwandte Drucksachen:</h4><table><tr><td><a href="../${ORIGINAL}">1047/2026 (Originalvorlage)</a></td></tr></table>`),
    [ORIGINAL]: document('Anfrage Nr. 1047/2026', TITLE),
  });

  const { records } = await collect({ now: TODAY, includeRss: false, requestText, strict: true });
  expect(records.map(record => record.number)).toEqual(['1047/2026', '1047/2026 F1']);
  expect(records[1].relatedTo).toBe(records[0].id);
});

test('uses recent district and council RSS dates, deduplicates links, and does not import expired feed items', async () => {
  const district = 'DS/15-2102-2026';
  const current = 'DS/2085-2026';
  const { requestText, calls } = transport({
    'Termine.xsp': archive(`<tr><td><a href="${RAT}">25.06.2026</a></td></tr>`),
    'RSS_Drucksachen_Rat.xml': feed(feedItem(current, 'Fri, 6 Nov 2026 13:12:43 +0200', 'Ratsversammlung')
      + feedItem('DS/1500-2026', 'Mon, 19 Oct 2026 10:00:00 +0200', 'Ratsversammlung')),
    'RSS_Drucksachen_STBR.xml': feed(feedItem(district, 'Fri, 6 Nov 2026 13:12:43 +0200', 'Stadtbezirksrat Mitte, Ausschuss für Sport, Stadtbezirksrat Mitte')
      + feedItem(current, 'Fri, 6 Nov 2026 13:12:43 +0200', 'Ratsversammlung')),
    [current]: document('Beschlussdrucksache Nr. 2085/2026', 'Bildung des Verwaltungsausschusses'),
    [district]: document('Antrag Nr. 15-2102/2026', 'Verl&auml;ngerung des Fahrradstreifens in der Humboldtstra&szlig;e'),
  });

  const { records, sources, coverage } = await collect({ from: '2026-10-19', now: TODAY, requestText });
  expect(records).toEqual(expect.arrayContaining([
    expect.objectContaining({ number: '2085/2026', date: '2026-11-06', type: 'Beschluss', gremium: 'Ratsversammlung' }),
    expect.objectContaining({ number: '15-2102/2026', date: '2026-11-06', type: 'Antrag', gremium: 'Stadtbezirksrat Mitte, Ausschuss für Sport',
      title: 'Verlängerung des Fahrradstreifens in der Humboldtstraße' }),
  ]));
  expect(records).toHaveLength(2);
  expect(calls.filter(url => url === ROOT + current)).toHaveLength(1);
  expect(calls).not.toContain(ROOT + 'DS/1500-2026');
  expect(sources).toEqual([ROOT + 'Termine.xsp', ROOT + 'RSS_Drucksachen_Rat.xml', ROOT + 'RSS_Drucksachen_STBR.xml']);
  expect(coverage).toMatchObject({ from: '2026-11-06', to: '2026-11-06', bodies: ['Ausschuss für Sport', 'Ratsversammlung', 'Stadtbezirksrat Mitte'], complete: false });
  expect(coverage.warnings.join(' ')).toMatch(/14 Tagen/);
});

test('marks an HTTP failure and an unrelated success page as incomplete and rejects failures in strict mode', async () => {
  const { requestText } = transport({
    'Termine.xsp': archive(`<tr><td><a href="${RAT}">25.06.2026</a></td></tr>`
      + '<tr><td><a href="TM/20260528_Rat">28.05.2026</a></td></tr>'),
    [RAT]: agenda(`<tr><td><a href="${ORIGINAL}">${TITLE}</a></td></tr>`),
    [ORIGINAL]: document('Anfrage Nr. 1001/2026', 'Anderes Dokument'),
  });

  const options = { now: TODAY, includeRss: false, requestText };
  const { records, coverage } = await collect(options);
  expect(records).toEqual([]);
  expect(coverage.complete).toBe(false);
  expect(coverage.warnings.join(' ')).toMatch(/HTTP 404/);
  expect(coverage.warnings.join(' ')).toMatch(/Drucksachennummer/);
  await expect(collect({ ...options, strict: true })).rejects.toThrow(/HTTP 404/);
});

test('does not treat an empty agenda shell as a successful publication source', async () => {
  const { requestText } = transport({
    'Termine.xsp': archive(`<tr><td><a href="${RAT}">25.06.2026</a></td></tr>`),
    [RAT]: agenda(''),
  });

  const options = { now: TODAY, includeRss: false, requestText };
  const { coverage } = await collect(options);
  expect(coverage.from).toBeNull();
  expect(coverage.warnings.join(' ')).toMatch(/Keine lesbare öffentliche Tagesordnung/);
  await expect(collect({ ...options, strict: true })).rejects.toThrow(/Keine lesbare öffentliche Tagesordnung/);
});

test('keeps the date explicitly labeled on a document and never follows related private rows', async () => {
  const { requestText, calls } = transport({
    'Termine.xsp': archive(`<tr><td><a href="${RAT}">25.06.2026</a></td></tr>`),
    [RAT]: agenda(`<tr><td><a href="${ORIGINAL}">${TITLE}</a></td></tr>`),
    [ORIGINAL]: document('Anfrage Nr. 1047/2026', TITLE,
      '<table><tr><th>Veröffentlicht am:</th><td>15.06.2026</td></tr></table>'
      + `<h4>verwandte Drucksachen:</h4><table><tr data-public="false"><td><a href="${ANSWER}">Nicht veröffentlicht</a></td></tr></table>`),
    [ANSWER]: document('Drucksache Nr. 1047/2026 F1', TITLE),
  });

  const { records } = await collect({ now: TODAY, includeRss: false, requestText });
  expect(records).toEqual([expect.objectContaining({ number: '1047/2026', date: '2026-06-15' })]);
  expect(calls).not.toContain(ROOT + ANSWER);
});

test('rejects impossible RSS calendar dates instead of allowing JavaScript to roll them forward', async () => {
  const invalidDate = 'Sat, 31 Nov 2026 13:12:43 +0200';
  const { requestText } = transport({
    'Termine.xsp': archive(`<tr><td><a href="${RAT}">25.06.2026</a></td></tr>`),
    'RSS_Drucksachen_Rat.xml': feed(feedItem('DS/2085-2026', invalidDate, 'Ratsversammlung')),
    'RSS_Drucksachen_STBR.xml': feed(''),
  });

  await expect(collect({ from: '2026-11-01', now: new Date('2026-12-01T12:00:00Z'), strict: true, requestText }))
    .rejects.toThrow(/gültiges Veröffentlichungsdatum/);
});

test('reports and stops at a budget limit rather than probing beyond the linked documents', async () => {
  const { requestText, calls } = transport({
    'Termine.xsp': archive(`<tr><td><a href="${RAT}">25.06.2026</a></td></tr>`),
    [RAT]: agenda(`<tr><td><a href="${ORIGINAL}">${TITLE}</a></td></tr>`),
    [ORIGINAL]: document('Anfrage Nr. 1047/2026', TITLE,
      `<h4>verwandte Drucksachen:</h4><table><tr><td><a href="${ANSWER}">Antwort auf die Originalvorlage</a></td></tr></table>`),
    [ANSWER]: document('Drucksache Nr. 1047/2026 F1', TITLE),
  });

  const options = { now: TODAY, includeRss: false, requestText, maxDocuments: 1 };
  const { records, coverage } = await collect(options);
  expect(records.map(record => record.number)).toEqual(['1047/2026']);
  expect(calls).toEqual([ROOT + 'Termine.xsp', ROOT + RAT, ROOT + ORIGINAL]);
  expect(coverage.warnings.join(' ')).toMatch(/Drucksachenlimit/);
  await expect(collect({ ...options, strict: true })).rejects.toThrow(/Drucksachenlimit/);
});

test('selects a named district meeting archive from official links', async () => {
  const districtArchive = 'Termine.xsp?view=TermineSTBR01';
  const districtMeeting = 'TM/20260622_STBR01';
  const { requestText, calls } = transport({
    'Termine.xsp': archive(`<tr><td><a href="${RAT}">25.06.2026</a></td></tr>`),
    'AuswahlStadtbezirke.xsp': html(`<h2>Stadtbezirksräte der Landeshauptstadt Hannover</h2><ul><li><a href="${districtArchive}">Stadtbezirksrat Mitte</a></li>`
      + '<li><a href="Termine.xsp?view=TermineSTBR10">Stadtbezirksrat Linden-Limmer</a></li></ul>'),
    [districtArchive]: archive(`<tr><td><a href="${districtMeeting}">22.06.2026</a></td></tr>`, 'Stadtbezirksrat Mitte'),
    [districtMeeting]: agenda('<tr><td><a href="DS/15-1267-2026">Sicherer Schulweg</a></td></tr>', 'Stadtbezirksrat Mitte', '22.06.2026'),
    'DS/15-1267-2026': document('Antrag Nr. 15-1267/2026', 'Sicherer Schulweg'),
  });

  const { records, sources, coverage } = await collect({ now: TODAY, from: '2026-06-22', to: '2026-06-22',
    includeRss: false, discoverArchives: ['districts'], archiveBodies: ['Stadtbezirksrat Mitte'], requestText, strict: true });
  expect(records).toEqual([expect.objectContaining({ number: '15-1267/2026', gremium: 'Stadtbezirksrat Mitte' })]);
  expect(sources).toContain(ROOT + districtArchive);
  expect(calls).not.toContain(ROOT + RAT);
  expect(calls).not.toContain(ROOT + 'Termine.xsp?view=TermineSTBR10');
  expect(coverage.bodies).toEqual(['Stadtbezirksrat Mitte']);
});

test('does not guess an archive URL when the named body is missing from the official selector', async () => {
  const { requestText, calls } = transport({
    'AuswahlStadtbezirke.xsp': html('<h2>Stadtbezirksräte der Landeshauptstadt Hannover</h2>'
      + '<a href="Termine.xsp?view=TermineSTBR01">Stadtbezirksrat Mitte</a>'),
  });

  await expect(collect({ now: TODAY, includeRss: false, discoverArchives: ['districts'],
    archiveBodies: ['Stadtbezirksrat Linden-Limmer'], requestText, strict: true })).rejects.toThrow(/Stadtbezirksrat Linden-Limmer/);
  expect(calls).toEqual([ROOT + 'AuswahlStadtbezirke.xsp']);
});

test('collects the operative public text for locating the measure, excluding deletions and reasoning', async () => {
  const { requestText } = transport({
    'Termine.xsp': archive(`<tr><td><a href="${RAT}">25.06.2026</a></td></tr>`),
    [RAT]: agenda(`<tr><td><a href="${ORIGINAL}">${TITLE}</a></td></tr>`),
    [ORIGINAL]: document('Antrag Nr. 1047/2026', 'Ampel an der Davenstedter Straße', '',
      '<h4>Antrag</h4><div class="row rt"><p>An der Kreuzung Davenstedter Straße/Südfeldstraße wird eine Ampel errichtet.</p>'
      + '<p><s>Auch an der Kreuzung Fössestraße / Blumenauer Straße wird eine Ampel errichtet.</s></p></div>'
      + '<h4>Begründung</h4><p>Die Kreuzung Limmerstraße / Kötnerholzweg ist ein Vergleichsfall.</p>'),
  });

  const { records } = await collect({ now: TODAY, includeRss: false, includeLocationEvidence: true, requestText });
  expect(records[0].locationEvidence).toEqual([
    'An der Kreuzung Davenstedter Straße/Südfeldstraße wird eine Ampel errichtet.',
  ]);
});

test('uses the administrative reply section in preference to the question reproduced above it', async () => {
  const { requestText } = transport({
    'Termine.xsp': archive(`<tr><td><a href="${RAT}">25.06.2026</a></td></tr>`),
    [RAT]: agenda(`<tr><td><a href="${ANSWER}">Antwort</a></td></tr>`),
    [ANSWER]: document('Drucksache Nr. 1047/2026 F1', 'Antwort zu einer Querung', '',
      '<h4></h4><p>Ist eine Querung an der Kreuzung Davenstedter Straße/Südfeldstraße geplant?</p>'
      + '<h4>Text der Antwort</h4><div class="row rt">'
      + '<b><u>Frage 1:</u></b><b> Ist eine Querung an der Kreuzung Davenstedter Straße/Südfeldstraße geplant?</b>'
      + '<p>Eine Querung ist an der Kreuzung Fössestraße/Blumenauer Straße vorgesehen.</p></div>'),
  });

  const { records } = await collect({ now: TODAY, includeRss: false, includeLocationEvidence: true, requestText });
  expect(records[0].locationEvidence).toEqual([
    'Eine Querung ist an der Kreuzung Fössestraße/Blumenauer Straße vorgesehen.',
  ]);
});

test('keeps the complete official ID when a reply refers to a revised document', async () => {
  const revisionReply = 'DS/15-0773-2026N1S1';
  const { requestText } = transport({
    'Termine.xsp': archive(`<tr><td><a href="${RAT}">25.06.2026</a></td></tr>`),
    [RAT]: agenda(`<tr><td><a href="${revisionReply}">Entscheidung</a></td></tr>`),
    [revisionReply]: document('Drucksache Nr. 15-0773/2026 N1 S1', 'Fahrradabstellplätze in der Limmerstraße'),
  });
  const { records } = await collect({ now: TODAY, includeRss: false, requestText, strict: true });
  expect(records).toMatchObject([{ id: 'hannover-sim:15-0773-2026N1S1', number: '15-0773/2026 N1 S1' }]);
});

test('limits the published location evidence to the visible operative section', async () => {
  const { requestText } = transport({
    'Termine.xsp': archive(`<tr><td><a href="${RAT}">25.06.2026</a></td></tr>`),
    [RAT]: agenda(`<tr><td><a href="${ORIGINAL}">Querung</a></td></tr>`),
    [ORIGINAL]: document('Antrag Nr. 1047/2026', 'Ampel', '',
      '<h4>Antrag</h4><div><p>Öffentlicher Maßnahmenort.</p>'
      + '<div data-public="false"><p>Vertraulicher Ort.</p><div><p>Auch vertraulich.</p></div></div>'
      + '<p aria-hidden="true">Unsichtbare Zweitfassung.</p><p style="display: none">Verborgene Angabe.</p></div>'
      + '<h3>Anderer Abschnitt</h3><p>Kein Teil der Maßnahme.</p>'),
  });
  const { records } = await collect({ now: TODAY, includeRss: false, includeLocationEvidence: true, requestText });
  expect(records[0].locationEvidence).toEqual(['Öffentlicher Maßnahmenort.']);
});

test('does not collect an operative section inside a nonpublic parent', async () => {
  const { requestText } = transport({
    'Termine.xsp': archive(`<tr><td><a href="${RAT}">25.06.2026</a></td></tr>`),
    [RAT]: agenda(`<tr><td><a href="${ORIGINAL}">Querung</a></td></tr>`),
    [ORIGINAL]: html('<h2>Antrag Nr. 1047/2026: Öffentlicher Titel</h2>'
      + '<article data-public="false"><h3>Inhalt der Drucksache:</h3><h4>Antrag</h4><p>Vertraulicher Ort.</p></article>'),
  });
  const { records } = await collect({ now: TODAY, includeRss: false, includeLocationEvidence: true, requestText });
  expect(records[0].locationEvidence).toEqual([]);
});

test.each([
  ['unrecognized section', '<h4>Sachverhalt</h4><p>Ein nicht erkannter Maßnahmenabschnitt.</p>'],
  ['empty section', '<h4>Antrag</h4><p></p><h4>Begründung</h4><p>Nur eine Begründung.</p>'],
  ['oversized paragraph', `<h4>Antrag</h4><p>${'x'.repeat(4001)}</p>`],
])('marks a content block without usable operative evidence as unavailable: %s', async (_, body) => {
  const { requestText } = transport({
    'Termine.xsp': archive(`<tr><td><a href="${RAT}">25.06.2026</a></td></tr>`),
    [RAT]: agenda(`<tr><td><a href="${ORIGINAL}">Radweg</a></td></tr>`),
    [ORIGINAL]: document('Antrag Nr. 1047/2026', 'Radweg an der Limmerstraße', '', body),
  });
  const { records } = await collect({ now: TODAY, includeRss: false, includeLocationEvidence: true, requestText });
  expect(records[0]).toMatchObject({ locationEvidence: [], locationEvidenceUnavailable: true });
  const { enrichRisLocations } = require('../../server/political-context/services/risLocation');
  const [mapped] = enrichRisLocations(records, { city: 'hannover', gazetteer: { city: 'hannover', entries: [{
    kind: 'street', name: 'Limmerstraße', attribution: 'Testgazetteer',
    geometry: { type: 'LineString', coordinates: [[9.71, 52.37], [9.72, 52.37]] },
  }] } });
  expect(mapped.locations).toHaveLength(1);
  expect(mapped.locationAssessment.status).toBe('partial');
  expect(mapped.locationAssessment.reasons).toContain('document_text_unavailable');
});

test('continues tolerant archive imports after a cached detail loader fails and retries the failed source', async () => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { createRisSourceCache } = require('../../server/political-context/services/risSourceCache');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-tolerant-cache-'));
  try {
    const sourceCache = createRisSourceCache({ directory: folder, now: () => TODAY.getTime() });
    const pages = {
      'Termine.xsp': archive(`<tr><td><a href="${RAT}">25.06.2026</a></td></tr>`),
      [RAT]: agenda(`<tr><td><a href="${ORIGINAL}">Erste Vorlage</a></td></tr>`
        + `<tr><td><a href="${ANSWER}">Zweite Vorlage</a></td></tr>`),
      [ANSWER]: document('Drucksache Nr. 1047/2026 F1', 'Zweite Vorlage'),
    };
    const { requestText, calls } = transport(pages);
    const options = { now: TODAY, includeRss: false, requestText, sourceCache, strict: false };
    const first = await collect(options);
    expect(first.records.map(record => record.id)).toEqual(['hannover-sim:1047-2026F1']);
    expect(first.coverage.warnings.filter(warning => warning.startsWith('Drucksachen:')))
      .toEqual([expect.stringMatching(/Drucksachen: 1 Abruf\(e\) fehlgeschlagen.*HTTP 404/)]);
    expect(sourceCache.stats.writes).toBe(1);
    await expect(collect({ ...options, strict: true })).rejects.toThrow(/Drucksachen:.*HTTP 404/);
    expect(sourceCache.stats.writes).toBe(1);
    pages[ORIGINAL] = document('Anfrage Nr. 1047/2026', 'Erste Vorlage');
    const recovered = await collect(options);
    expect(recovered.records.map(record => record.id)).toEqual(['hannover-sim:1047-2026', 'hannover-sim:1047-2026F1']);
    expect(recovered.coverage.warnings.some(warning => /fehlgeschlagen/.test(warning))).toBe(false);
    expect(calls.filter(url => url === ROOT + ORIGINAL)).toHaveLength(3);
    expect(calls.filter(url => url === ROOT + ANSWER)).toHaveLength(1);
    expect(sourceCache.stats.writes).toBe(2);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});
