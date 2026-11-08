/** @jest-environment node */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRisSourceCache } = require('../../server/political-context/services/risSourceCache');
const { createRisSourceCheckpoint } = require('../../server/political-context/services/risSourceCheckpoint');

const modulePath = path.resolve(__dirname, '../../server/political-context/providers/regionHannoverCatalogue.js');
const region = fs.existsSync(modulePath) ? require(modulePath) : {};
const BASE = 'https://ris.hannit.de';
const LIST = `${BASE}/public/vo040`;
const PROPOSAL = `${BASE}/public/vo020?VOLFDNR=2007454`;
const ANSWER_HTML = fs.readFileSync(path.join(__dirname, '../fixtures/region-hannover/proposal-answer.html'), 'utf8');
// Reduced from the observed public ALLRIS table. Pagination totals are local
// fixture values; no cookies, form tokens, or gate credentials are retained.
const ROW = `<tr class="even"><td class="vonr"><div>5438 (V) AaA</div></td>
  <td class="betreff"><div><a href="./vo020?VOLFDNR=2007454&amp;refresh=false">84 Nachtstunden weniger in Springe – wie belastbar ist die neue RTW-Vorhaltung? Anfrage</a></div></td>
  <td class="filterSelectAT"><div>Dezernat I</div></td><td><div>06.11.2026</div></td>
  <td><div>Antwort auf Anfragen</div></td></tr>`;
function listHtml(rows = ROW, count = 1) {
  return `<!doctype html><html lang="de"><head><title>Vorlagen</title></head><body><main>
    <h1>Vorlagen</h1><div>Zeige 1 bis ${count} von ${count}</div><table>
      <thead><tr><th>Nummer</th><th>Betreff</th><th>OE</th><th>Vorlage freigegeben</th><th>Art</th></tr></thead>
      <tbody>${rows}</tbody></table></main></body></html>`;
}
function api(name) {
  expect(region[name]).toEqual(expect.any(Function));
  return region[name];
}
const NEXT_CALLBACK = './vo040?0-1.0-form-tablePanel-content-dataTable-bottomToolbars-toolbars-3-span-navigator-next';
const SIZE_CALLBACK = './vo040?0-1.0-form-tablePanel-content-dataTable-bottomToolbars-toolbars-3-span-navigator-itemsPerPage-3-itemPerPageLink';
function ajaxList(html = listHtml(), { next = true, size = true } = {}) {
  const controls = `${next ? '<button class="next nav-item js-simple-tooltip" id="id23" title="Gehe zur nächsten Seite"><img alt="Gehe zur nächsten Seite"/></button>' : ''}
    ${size ? '<div id="objPerPage"><a class="parent"><span>25</span></a><a id="id19" href="javascript:;"><span>100</span></a></div>' : ''}`;
  const content = html.replace('</tbody>', '</tbody><tfoot><tr class="navigation"><td colspan="5">' + controls + '</td></tr></tfoot>');
  return `<?xml version="1.0"?><ajax-response><component id="id16"><![CDATA[${content}]]></component><evaluate><![CDATA[
    ${next ? `Wicket.Ajax.ajax({"u":"${NEXT_CALLBACK}","c":"id23","e":"click","pd":true});` : ''}
    ${size ? `Wicket.Ajax.ajax({"u":"${SIZE_CALLBACK}","c":"id19","e":"click"});` : ''}
  ]]></evaluate></ajax-response>`;
}

describe('Region Hannover public proposal list', () => {
  test('retains the full title, exact number, and explicit publication date from the observed table', () => {
    const result = api('parseProposalListHtml')(listHtml(), LIST);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]).toMatchObject({
      id: 'region-hannover-ris:vo:2007454', url: PROPOSAL,
      number: '5438 (V) AaA',
      title: '84 Nachtstunden weniger in Springe – wie belastbar ist die neue RTW-Vorhaltung? Anfrage',
      type: 'Verwaltungsantwort', rawType: 'Antwort auf Anfragen', date: '2026-11-06',
      source: 'region-hannover-ris', locationEvidenceUnavailable: true,
      sourceContext: { level: 'region', publisher: 'Region Hannover', status: 'answer',
        publicationDate: '2026-11-06', documentDate: null, meetingDate: null },
    });
    expect(result).toMatchObject({ start: 1, end: 1, total: 1, next: null });
  });

  test('deduplicates the same proposal reached with different incidental query parameters', () => {
    const result = api('parseProposalListHtml')(listHtml(ROW + ROW.replace('refresh=false', 'refresh=true'), 2), LIST);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].url).toBe(PROPOSAL);
  });

  test('does not turn a proposed decision into a resolution', () => {
    const html = listHtml().replace('Antwort auf Anfragen', 'Beschlussvorlage');
    const record = api('parseProposalListHtml')(html, LIST).documents[0];
    expect(record.type).toBe('Sonstige');
    expect(record.sourceContext.status).toBe('proposal');
  });

  test('keeps an invalid release date unknown instead of normalizing it into another day', () => {
    const record = api('parseProposalListHtml')(listHtml().replace('06.11.2026', '31.02.2026'), LIST).documents[0];
    expect(record.date).toBeNull();
    expect(record.sourceContext.publicationDate).toBeNull();
  });

  test('keeps historical list entries whose official Art field is empty', () => {
    const record = api('parseProposalListHtml')(listHtml().replace('<div>Antwort auf Anfragen</div>', '<div></div>'), LIST).documents[0];
    expect(record).toMatchObject({ rawType: '', type: 'Sonstige', sourceContext: { documentKind: 'Vorlage', status: 'other' } });
  });

  test('rejects unrelated tables and incomplete result shapes', () => {
    const parse = api('parseProposalListHtml');
    expect(() => parse('<html><table><tr><td>Nothing here</td></tr></table></html>', LIST)).toThrow();
    expect(() => parse(listHtml().replace('Vorlage freigegeben', 'Sitzungsdatum'), LIST)).toThrow();
    expect(() => parse(listHtml().replace('Zeige 1 bis 1 von 1', 'Zeige 1 bis 100 von 100'), LIST)).toThrow(/row|count|range/i);
    expect(() => parse(listHtml(ROW + '<tr></tr>'.repeat(99), 100), LIST)).toThrow(/row|count|range/i);
  });

  test('extracts the observed automatic loader without requiring form tokens', () => {
    const html = '<html><head><script>Wicket.Timer.set("id6.0", function(){Wicket.Ajax.ajax({"u":"./vo040?0-1.0-"});}, 1000);</script></head><body><h1>Übersicht</h1><form><input name="sectoken" value="never-copy-this-token"/></form></body></html>';
    const result = api('parseProposalListHtml')(html, LIST);
    expect(result.loading).toEqual({ url: `${BASE}/public/vo040?0-1.0-`, ajax: true });
    expect(result.documents).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('never-copy-this-token');
  });

  test('reads Wicket component HTML and binds next and 100-row controls to their observed callback IDs', () => {
    const html = ajaxList(listHtml().replace('Zeige 1 bis 1 von 1', 'Zeige 1 bis 1 von 2'));
    const result = api('parseProposalListHtml')(html, LIST);
    expect(result.documents).toHaveLength(1);
    expect(result).toMatchObject({ start: 1, end: 1, total: 2,
      next: { url: `${BASE}/public/${NEXT_CALLBACK.slice(2)}`, ajax: true },
      pageSizeRequest: { url: `${BASE}/public/${SIZE_CALLBACK.slice(2)}`, ajax: true },
    });
  });

  test('reports an unavailable continuation instead of claiming a truncated list is complete', () => {
    const html = ajaxList(listHtml().replace('Zeige 1 bis 1 von 1', 'Zeige 1 bis 1 von 2'), { next: false, size: false });
    expect(api('parseProposalListHtml')(html, LIST)).toMatchObject({ total: 2, end: 1, next: null, paginationUnavailable: true });
  });

  test('rejects callback destinations outside the observed public list route', () => {
    const html = ajaxList(listHtml().replace('Zeige 1 bis 1 von 1', 'Zeige 1 bis 1 von 2')).replace(NEXT_CALLBACK, 'https://example.org/steal');
    expect(() => api('parseProposalListHtml')(html, LIST)).toThrow(/URL|origin|source|callback/i);
  });
});

describe('Region Hannover source boundaries', () => {
  test.each([
    'https://example.org/public/vo020?VOLFDNR=2007454',
    'https://ris.hannit.de.example.org/public/vo020?VOLFDNR=2007454',
    'http://ris.hannit.de/public/vo020?VOLFDNR=2007454',
    'https://user@ris.hannit.de/public/vo020?VOLFDNR=2007454',
    'https://ris.hannit.de:444/public/vo020?VOLFDNR=2007454',
    `${BASE}/public/vo040?VOLFDNR=2007454`,
    `${BASE}/public/vo020?VOLFDNR=2007454&VOLFDNR=3`,
    `${BASE}/public/vo020?VOLFDNR=wrong`,
  ])('rejects a non-canonical source boundary %s', url => {
    const parse = api('parseProposalHtml');
    expect(() => parse('<h1>Vorlage</h1>', url)).toThrow();
  });

  test('rejects the access gate as source evidence', () => {
    const gate = '<html><head><title>Zugriff pruefen</title></head><body><altcha-widget challengeurl="/public/_gate/challenge"></altcha-widget></body></html>';
    expect(() => api('parseProposalHtml')(gate, PROPOSAL)).toThrow(/Zugriff|Schutz|gate/i);
    expect(() => api('parseProposalListHtml')(gate, LIST)).toThrow(/Zugriff|Schutz|gate/i);
  });
});

describe('Region Hannover public proposal details', () => {
  test('reads the observed definition lists without replacing the full subject by the short page heading', () => {
    const record = api('parseProposalHtml')(ANSWER_HTML, PROPOSAL);
    expect(record).toMatchObject({
      id: 'region-hannover-ris:vo:2007454', number: '5438 (V) AaA', url: PROPOSAL,
      title: '84 Nachtstunden weniger in Springe – wie belastbar ist die neue RTW-Vorhaltung? Anfrage des Regionsabgeordneten Bernward Schlossarek vom 8. Oktober 2026',
      type: 'Verwaltungsantwort', rawType: 'Antwort auf Anfragen', rawStatus: 'öffentlich (Vorlage abgeschlossen)',
      date: null, gremium: 'Regionsversammlung', source: 'region-hannover-ris',
      originalPdfUrl: `${BASE}/public/wicket/resource/org.apache.wicket.Application/doc2569878.pdf`,
      sourceContext: { level: 'region', publisher: 'Region Hannover', issuer: 'Dezernat I',
        documentKind: 'Antwort auf Anfragen', status: 'answer', publicationDate: null, documentDate: null, meetingDate: null },
    });
    expect(record.locationEvidence).toHaveLength(3);
    expect(record.locationEvidence[0]).toMatch(/^Der Rettungsmittelbedarfsplan der Region Hannover sieht für den Rettungsdienstbereich Springe/);
    expect(record.locationEvidence[1]).toContain('Als Begründung werden unter anderem steigende Einsatzzahlen');
    expect(record.events).toEqual([{
      date: null, body: 'Regionsversammlung', outcome: 'Information ohne Gremienberatung', url: PROPOSAL,
      evidence: '● Gestoppt Regionsversammlung Information ohne Gremienberatung',
    }]);
    expect(record.locationEvidenceUnavailable).not.toBe(true);
  });

  test('does not invent a document date from a consultation or dates mentioned in the subject and text', () => {
    const html = ANSWER_HTML.replace('<td><div> </div></td><td><div>Regionsversammlung', '<td><div>14.11.2026</div></td><td><div>Regionsversammlung');
    const record = api('parseProposalHtml')(html, PROPOSAL);
    expect(record.date).toBeNull();
    expect(record.sourceContext.documentDate).toBeNull();
    expect(record.sourceContext.publicationDate).toBeNull();
    expect(record.sourceContext.meetingDate).toBeNull();
    expect(record.events[0].date).toBe('2026-11-14');
  });

  test.each(['nicht öffentlich', 'nichtöffentlich', '', 'vertraulich'])('requires explicit public status, rejecting %s', status => {
    const html = ANSWER_HTML.replace('>öffentlich</span>', `>${status}</span>`);
    expect(() => api('parseProposalHtml')(html, PROPOSAL)).toThrow(/öffentlich|public/i);
  });

  test('excludes navigation, hidden or struck-out passages, and content outside the substantive document sections', () => {
    const html = ANSWER_HTML.replace('<main id="pageContent">', '<nav>Radweg in der Limmerstraße</nav><main id="pageContent">')
      .replace('<div id="htm2569879" class="docPart"><div>', '<div id="htm2569879" class="docPart"><div><p hidden>Geheimtext in der Limmerstraße</p><p style="display:none">Unsichtbarer Text</p><del>Verworfener Vorschlag</del>')
      .replace('</main>', '<h2>Anlagen</h2><div class="docPart"><p>Sitzungsort: Hildesheimer Straße 18, Hannover</p></div></main>');
    const record = api('parseProposalHtml')(html, PROPOSAL);
    expect(record.locationEvidence).toHaveLength(3);
    expect(record.locationEvidence.join(' ')).not.toMatch(/Limmerstraße|Geheimtext|Unsichtbarer|Verworfener|Sitzungsort/);
  });

  test('retains missing document text as an explicit limitation', () => {
    const html = ANSWER_HTML.replace(/<h2 class="expandedTitle">Sachverhalt<\/h2>[\s\S]*?(?=<\/main>)/, '');
    const record = api('parseProposalHtml')(html, PROPOSAL);
    expect(record.locationEvidence).toEqual([]);
    expect(record.locationEvidenceUnavailable).toBe(true);
  });
});

describe('Region Hannover resumable public collection', () => {
  const NOW = new Date('2026-11-08T12:00:00.000Z');
  let directory;
  beforeEach(async () => { directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'region-hannover-test-')); });
  afterEach(async () => { await fsp.rm(directory, { recursive: true, force: true }); });
  function collect(options = {}) {
    const now = options.now || NOW;
    return api('collectRegionHannoverCatalogue')({ now, maxDetails: 0,
      sourceCache: createRisSourceCache({ directory, now: () => now.getTime() }),
      checkpoint: createRisSourceCheckpoint({ directory }), ...options });
  }

  test('indexes publicly listed metadata and reports incomplete detail coverage honestly', async () => {
    const result = await collect({ fetchHtmlImpl: async url => {
      if (url !== LIST) throw new Error('Unexpected source request');
      return listHtml();
    } });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ id: 'region-hannover-ris:vo:2007454', date: '2026-11-06', locationEvidenceUnavailable: true });
    expect(result.collection).toMatchObject({ listComplete: true, discovered: 1, verifiedDetails: 0, pendingDetails: 1, total: 1 });
    expect(result.coverage).toMatchObject({ from: '2026-11-06', to: '2026-11-06', complete: false });
    expect(result.sourceStatus).toMatchObject({ source: 'region-hannover-ris', status: 'partial', recordCount: 1, retrievedAt: NOW.toISOString() });
    expect(result.generatedAt).toBe(NOW.toISOString());
  });

  test('resumes a bounded list scan from a new session without persisting Wicket callback URLs', async () => {
    const first = ajaxList(listHtml().replace('Zeige 1 bis 1 von 1', 'Zeige 1 bis 1 von 2'), { size: false });
    const second = ajaxList(listHtml(ROW.replaceAll('2007454', '2007455')).replace('Zeige 1 bis 1 von 1', 'Zeige 2 bis 2 von 2'), { next: false, size: false });
    const transport = async url => {
      if (url === LIST) return first;
      if (url === `${BASE}/public/${NEXT_CALLBACK.slice(2)}`) return second;
      throw new Error('Unexpected source request');
    };
    const partial = await collect({ maxPages: 1, fetchHtmlImpl: transport });
    expect(partial.records).toHaveLength(1);
    expect(partial.collection.listComplete).toBe(false);
    const resumed = await collect({ maxPages: 1, fetchHtmlImpl: transport });
    expect(resumed.records.map(record => record.id).sort()).toEqual(['region-hannover-ris:vo:2007454', 'region-hannover-ris:vo:2007455']);
    expect(resumed.collection.listComplete).toBe(true);
    const checkpointRoot = path.join(directory, 'checkpoints');
    for (const scope of await fsp.readdir(checkpointRoot)) {
      for (const file of await fsp.readdir(path.join(checkpointRoot, scope))) {
        expect(await fsp.readFile(path.join(checkpointRoot, scope, file), 'utf8')).not.toContain('navigator-next');
      }
    }
  });

  test('restores a checkpoint with zero network budget without renewing source clocks', async () => {
    await collect({ fetchHtmlImpl: async () => listHtml() });
    const later = new Date('2026-11-09T12:00:00.000Z');
    const result = await collect({ now: later, workBudget: 0, fetchHtmlImpl: async () => { throw new Error('No network budget'); } });
    expect(result.records).toHaveLength(1);
    expect(result.generatedAt).toBe('2026-11-08T12:00:00.000Z');
    expect(result.sourceStatus.retrievedAt).toBe('2026-11-08T12:00:00.000Z');
    expect(result.collection.pages).toBe(0);
  });

  test('does not invent retrieval evidence when no source has been read', async () => {
    const result = await collect({ workBudget: 0, fetchHtmlImpl: async () => { throw new Error('No network budget'); } });
    expect(result.records).toEqual([]);
    expect(result.generatedAt).toBeNull();
    expect(result.sourceStatus).toMatchObject({ status: 'partial', retrievedAt: null, recordCount: 0 });
    expect(result.history.pending).toBe(true);
  });

  test('honors the document cap without calling a truncated list complete', async () => {
    const result = await collect({ maxDocuments: 1, fetchHtmlImpl: async () => listHtml(ROW + ROW.replaceAll('2007454', '2007455'), 2) });
    expect(result.records).toHaveLength(1);
    expect(result.collection.listComplete).toBe(false);
    expect(result.history.pending).toBe(true);
  });

  test('prioritizes traffic details and then progresses to still missing documents on the next bounded run', async () => {
    const trafficRow = ROW.replaceAll('2007454', '2007455').replace('5438 (V) AaA', '5439 (V) AaA')
      .replace(/84 Nachtstunden[^<]+/, 'Radverkehr in Hannover verbessern');
    const trafficHtml = ANSWER_HTML.replaceAll('5438 (V) AaA', '5439 (V) AaA');
    const transport = async url => {
      if (url === LIST) return listHtml(ROW + trafficRow, 2);
      if (url === `${BASE}/public/vo020?VOLFDNR=2007455`) return trafficHtml;
      if (url === PROPOSAL) return ANSWER_HTML;
      throw new Error('Unexpected source request');
    };
    const first = await collect({ maxDetails: 1, concurrency: 1, fetchHtmlImpl: transport });
    expect(first.collection).toMatchObject({ verifiedDetails: 1, pendingDetails: 1 });
    expect(first.records.find(record => record.id.endsWith(':2007455')).detailVerifiedAt).toBe(NOW.toISOString());
    expect(first.records.find(record => record.id.endsWith(':2007454')).detailVerifiedAt).toBeUndefined();
    const later = new Date('2026-11-08T12:00:01.000Z');
    const second = await collect({ now: later, maxDetails: 1, concurrency: 1, fetchHtmlImpl: transport });
    expect(second.collection).toMatchObject({ verifiedDetails: 2, pendingDetails: 0 });
    expect(second.records.find(record => record.id.endsWith(':2007455')).detailVerifiedAt).toBe(NOW.toISOString());
    expect(second.records.find(record => record.id.endsWith(':2007454')).detailVerifiedAt).toBe(later.toISOString());
    expect(second.generatedAt).toBe(NOW.toISOString());
  });

  test('does not let a repeatedly failing traffic detail starve an unattempted public document', async () => {
    const trafficRow = ROW.replaceAll('2007454', '2007455').replace('5438 (V) AaA', '5439 (V) AaA')
      .replace(/84 Nachtstunden[^<]+/, 'Radverkehr in Hannover verbessern');
    const transport = async url => {
      if (url === LIST) return listHtml(ROW + trafficRow, 2);
      if (url === PROPOSAL) return ANSWER_HTML;
      throw new Error('Temporarily unreadable traffic document');
    };
    const first = await collect({ maxDetails: 1, concurrency: 1, fetchHtmlImpl: transport });
    expect(first.collection).toMatchObject({ verifiedDetails: 0, failedDetails: 1 });
    const second = await collect({ maxDetails: 1, concurrency: 1, fetchHtmlImpl: transport });
    expect(second.collection.verifiedDetails).toBe(1);
    expect(second.records.find(record => record.id.endsWith(':2007454')).locationEvidence).toHaveLength(3);
  });

  test('uses a small budget for existing missing details when fresh-session list navigation cannot advance', async () => {
    const firstPage = ajaxList(listHtml().replace('Zeige 1 bis 1 von 1', 'Zeige 1 bis 1 von 2'), { size: false });
    await collect({ maxPages: 1, fetchHtmlImpl: async () => firstPage });
    const calls = [];
    const result = await collect({ maxDetails: 1, workBudget: 1, concurrency: 1, fetchHtmlImpl: async url => {
      calls.push(url); if (url === PROPOSAL) return ANSWER_HTML;
      throw new Error('Budget cannot reach a new list page');
    } });
    expect(calls).toEqual([PROPOSAL]);
    expect(result.collection).toMatchObject({ listComplete: false, verifiedDetails: 1, pendingDetails: 0 });
    expect(result.coverage.warnings.join(' ')).toMatch(/Budget|Navigation/i);
  });

  test('counts neither a fresh detail cache hit nor a restored detail against the new network work limit', async () => {
    const earlier = new Date('2026-11-07T12:00:00.000Z');
    const sourceCache = createRisSourceCache({ directory, now: () => earlier.getTime() });
    await sourceCache.getOrLoadWithMetadata(PROPOSAL, region.REVISION, async () => api('parseProposalHtml')(ANSWER_HTML, PROPOSAL));
    const trafficRow = ROW.replaceAll('2007454', '2007455').replace('5438 (V) AaA', '5439 (V) AaA')
      .replace(/84 Nachtstunden[^<]+/, 'Radverkehr in Hannover verbessern');
    const result = await collect({ maxDetails: 1, concurrency: 1, workBudget: 2, fetchHtmlImpl: async url => {
      if (url === LIST) return listHtml(ROW + trafficRow, 2);
      if (url === `${BASE}/public/vo020?VOLFDNR=2007455`) return ANSWER_HTML.replaceAll('5438 (V) AaA', '5439 (V) AaA');
      throw new Error('Cached document must not be fetched again');
    } });
    expect(result.collection).toMatchObject({ verifiedDetails: 2, pendingDetails: 0 });
    expect(result.records.find(record => record.id.endsWith(':2007454')).detailVerifiedAt).toBe(earlier.toISOString());
    expect(result.generatedAt).toBe(earlier.toISOString());
  });

  test('preserves verified text and its original clock when a stale detail cannot be refreshed', async () => {
    const initial = await collect({ maxDetails: 1, fetchHtmlImpl: async url => url === LIST ? listHtml() : ANSWER_HTML });
    const later = new Date('2026-11-16T12:00:00.000Z');
    const retained = await collect({ now: later, maxDetails: 1, fetchHtmlImpl: async url => {
      if (url === LIST) return listHtml();
      throw new Error('Official detail temporarily unavailable');
    } });
    expect(retained.records[0].locationEvidence).toEqual(initial.records[0].locationEvidence);
    expect(retained.records[0].locationEvidenceUnavailable).toBe(true);
    expect(retained.records[0].detailVerifiedAt).toBe(NOW.toISOString());
    expect(retained.generatedAt).toBe(NOW.toISOString());
    expect(retained.collection.failedDetails).toBe(1);
    expect(retained.sourceStatus.status).toBe('partial');
  });

  test('preserves the actual capture time when replaying previously acquired public HTML', async () => {
    const captured = '2026-11-06T10:00:00.000Z';
    const result = await collect({ maxDetails: 1, fetchHtmlImpl: async url => url === LIST ? listHtml() : { html: ANSWER_HTML, retrievedAt: captured } });
    expect(result.records[0].detailVerifiedAt).toBe(captured);
    expect(result.generatedAt).toBe(captured);
    expect(result.records[0].date).toBe('2026-11-06');
    expect(result.records[0].sourceContext).toMatchObject({ publicationDate: '2026-11-06', documentDate: null, meetingDate: null });
  });

  test('does not publish a document whose fetched detail is explicitly not public', async () => {
    const result = await collect({ maxDetails: 1, fetchHtmlImpl: async url => url === LIST ? listHtml() : ANSWER_HTML.replace('>öffentlich</span>', '>nicht öffentlich</span>') });
    expect(result.records).toEqual([]);
    expect(result.collection.discovered).toBe(1);
    expect(result.exclusions).toEqual([{ id: 'region-hannover-ris:vo:2007454', url: PROPOSAL, verifiedAt: NOW.toISOString(), reason: 'not-public' }]);
  });

  test('retains public metadata when a detail page has no recognizable public-status field', async () => {
    const result = await collect({ maxDetails: 1, fetchHtmlImpl: async url => url === LIST ? listHtml() : ANSWER_HTML.replace('>öffentlich</span>', '></span>') });
    expect(result.records).toHaveLength(1);
    expect(result.exclusions).toEqual([]);
    expect(result.collection.failedDetails).toBe(1);
  });

  test('can restore parsed detail evidence from the cache with zero network budget', async () => {
    await collect({ fetchHtmlImpl: async () => listHtml() });
    const sourceCache = createRisSourceCache({ directory, now: () => NOW.getTime() });
    await sourceCache.getOrLoadWithMetadata(PROPOSAL, region.REVISION, async () => api('parseProposalHtml')(ANSWER_HTML, PROPOSAL));
    const result = await collect({ maxDetails: 0, workBudget: 0, fetchHtmlImpl: async () => { throw new Error('No network budget'); } });
    expect(result.records[0].locationEvidence).toHaveLength(3);
    expect(result.records[0].detailVerifiedAt).toBe(NOW.toISOString());
    expect(result.collection.pendingDetails).toBe(0);
  });

  test('does not turn an invalid cached source timestamp into a fresh verification', async () => {
    const sourceCache = createRisSourceCache({ directory, now: () => NOW.getTime() });
    await sourceCache.getOrLoadWithMetadata(PROPOSAL, region.REVISION, async () => ({
      ...api('parseProposalHtml')(ANSWER_HTML, PROPOSAL), detailVerifiedAt: '2026-12-01T12:00:00.000Z' }));
    const result = await collect({ maxDetails: 0, fetchHtmlImpl: async () => listHtml() });
    expect(result.records[0].detailVerifiedAt).toBeUndefined();
    expect(result.records[0].locationEvidenceUnavailable).toBe(true);
    expect(result.collection.failedDetails).toBe(1);
  });

  test.each([401, 403, 429])('stops new same-portal requests after an explicit HTTP %s denial', async status => {
    await collect({ fetchHtmlImpl: async () => listHtml() });
    const calls = [];
    const result = await collect({ now: new Date('2026-11-16T12:00:00.000Z'), maxDetails: 20, concurrency: 1,
      fetchHtmlImpl: async url => { calls.push(url); throw Object.assign(new Error('Portal declined access'), { details: { status } }); } });
    expect(calls).toEqual([LIST]);
    expect(result.records).toHaveLength(1);
    expect(result.exclusions).toEqual([]);
    expect(result.sourceStatus.status).toBe('blocked');
    expect(result.generatedAt).toBe(NOW.toISOString());
  });

  test('stops scheduling new document requests when a detail fetch is explicitly denied', async () => {
    const calls = [];
    const result = await collect({ maxDetails: 10, concurrency: 1, fetchHtmlImpl: async url => {
      calls.push(url);
      if (url === LIST) return listHtml(ROW + ROW.replaceAll('2007454', '2007455').replace('5438 (V) AaA', '5439 (V) AaA'), 2);
      throw Object.assign(new Error('Portal declined access'), { details: { status: 403 } });
    } });
    expect(calls).toHaveLength(2);
    expect(result.sourceStatus.status).toBe('blocked');
    expect(result.records).toHaveLength(2);
    expect(result.exclusions).toEqual([]);
  });
});
