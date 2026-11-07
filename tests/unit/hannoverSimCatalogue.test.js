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
