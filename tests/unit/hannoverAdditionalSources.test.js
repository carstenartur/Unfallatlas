/** @jest-environment node */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const formats = require('../../server/political-context/providers/hannoverAdditionalFormats');
const fixture = name => fs.readFileSync(path.join(__dirname, '../fixtures/political-sources', name), 'utf8');
const BASE = 'https://www.landtag-niedersachsen.de/dokumentensuche/';
const PDF = 'https://www.landtag-niedersachsen.de/drucksachen/drucksachen_19_10000/08501-09000/19-08980.pdf';
const NOTICE = 'https://bekanntmachungen.region-hannover.de/Regionsversammlung-und-Aussch%C3%BCsse/21.04.2026-Regionsversammlung';

test.each(['script', 'style'])('plain text extraction discards %s content through malformed closing attributes', kind => {
  expect(formats.text(`Vor<${kind}>hidden()</${kind}\t\n data-x="ignored">Nach`)).toBe('Vor Nach');
  expect(formats.text(`Vor<${kind}>unterminated`)).toBe('Vor');
});

test('plain text extraction never reconstructs markup from nested removal or decoded entities', () => {
  for (const value of ['<scr<!--comment-->ipt>alert(1)</script>', '&lt;img src=x onerror=alert(1)&gt;',
    '&#60;script&#62;alert(1)&#60;/script&#62;', '<!-- comment --!><script>hidden</script>']) {
    expect(formats.text(value)).not.toMatch(/[<>]/);
  }
  expect(formats.text('Rad<b title="a > b">weg</b> &amp; &Uuml;berweg')).toBe('Rad weg & Überweg');
});

test('catalogue keeps real document URL, answer status and unknown date roles for 19/8980', () => {
  const parsed = formats.parseLandtagCatalogue(fixture('landtag-catalogue.html'), BASE);
  expect(parsed.total).toBe(1);
  expect(parsed.nextUrl).toBeNull();
  expect(parsed.records).toHaveLength(1);
  expect(parsed.records[0]).toMatchObject({ number: '19/8980', url: PDF, originalPdfUrl: PDF,
    type: 'Verwaltungsantwort', date: null, source: 'niedersachsen-landtag',
    sourceContext: { level: 'state', publisher: 'Niedersächsischer Landtag', issuer: null,
      documentKind: 'Drucksache', status: 'answer', publicationDate: null, documentDate: null, meetingDate: null } });
  expect(formats.hasLocalTrafficEvidence(parsed.records[0])).toBe(true);
});

test('catalogue follows actual enabled next href while rejecting hostile continuation and unrecognised pages', () => {
  const page = fixture('landtag-catalogue.html').replace('Anzahl Ergebnisse: 1', 'Anzahl Ergebnisse: 11')
    .replace('page-next disable" aria-disabled="true', 'page-next')
    .replace('?tx_nltdocuments_documents%5BcurrentPage%5D=1', '?tx_nltdocuments_documents%5BcurrentPage%5D=2&amp;cHash=issued');
  expect(formats.parseLandtagCatalogue(page, BASE).nextUrl).toBe(BASE + '?tx_nltdocuments_documents%5BcurrentPage%5D=2&cHash=issued');
  expect(() => formats.parseLandtagCatalogue(page.replace('?tx_nltdocuments_documents%5BcurrentPage%5D=2&amp;cHash=issued', 'https://evil.example/next'), BASE)).toThrow(/official/i);
  expect(() => formats.parseLandtagCatalogue('<h1>Zugriff pruefen</h1>', BASE)).toThrow(/shape|protection/i);
});

test('RSS publication dates stay distinct from sitting dates and statewide cycling is not local Hannover evidence', () => {
  const records = formats.parseLandtagFeed(fixture('landtag-rss.xml'), 'https://www.landtag-niedersachsen.de/rss/stenoberichte.xml');
  expect(records).toHaveLength(2);
  expect(records[0].url).not.toContain('#');
  expect(records[0]).toMatchObject({ sourceContext: { publicationDate: '2026-10-28', meetingDate: '2026-10-08', documentDate: null, status: 'minutes' }, date: '2026-10-08' });
  expect(records[1].title).toBe('Niedersachsen tritt in die Pedale: Fahrradland Nummer 1 weiter stärken!');
  expect(formats.hasLocalTrafficEvidence(records[1])).toBe(false);
  expect(records[1].sourceContext.status).toBe('proposal');
  expect(() => formats.parseLandtagFeed('<rss><channel><item>', 'https://www.landtag-niedersachsen.de/rss/drucksachen.xml')).toThrow(/shape|RSS/i);
});

test('Region notices preserve agenda semantics and dates and only substantive local traffic items qualify', () => {
  const records = formats.parseRegionNotice(fixture('region-notice.html'), NOTICE);
  expect(records).toHaveLength(4);
  expect(records[2]).toMatchObject({ title: expect.stringContaining('zwischen Celle und Hannover'),
    date: '2026-04-21', gremium: 'Regionsversammlung', type: 'Sonstige',
    sourceContext: { level: 'region', publisher: 'Region Hannover', issuer: 'Der Regionspräsident', status: 'agenda', documentKind: 'Tagesordnung',
      publicationDate: '2026-04-09', meetingDate: '2026-04-21', documentDate: null } });
  expect(records[2].originalPdfUrl).toBe('https://bekanntmachungen.region-hannover.de/content/download/1062951/file/BM%20RV%2021.04.2026.pdf');
  expect(records.map(formats.hasLocalTrafficEvidence)).toEqual([false, false, true, false]);
  expect(formats.hasLocalTrafficEvidence({ title: 'Sitzung des Verkehrsausschusses', snippet: 'Treffpunkt ÜSTRA Hannoversche Verkehrsbetriebe, Am Hohen Ufer 6, 30159 Hannover. Hannover, den 09.04.2026' })).toBe(false);
});

test('Region index discovers only distinct official meeting notices without generic RIS or external URLs', () => {
  const html = '<h1>Regionsversammlung und Ausschüsse</h1><a href="/Regionsversammlung-und-Aussch%C3%BCsse/17.11.2026-Regionsversammlung">lesen</a>' +
    '<a href="https://evil.example/Regionsversammlung-und-Aussch%C3%BCsse/meeting">external</a><a href="https://ris.hannit.de/public/">RIS</a>';
  expect(formats.parseRegionIndex(html)).toEqual(['https://bekanntmachungen.region-hannover.de/Regionsversammlung-und-Aussch%C3%BCsse/17.11.2026-Regionsversammlung']);
});

test('actual current Region HTML entities decode before date and local-traffic checks', () => {
  const records = formats.parseRegionNotice(fixture('region-current-notice.html'), NOTICE.replace('21.04.2026', '17.11.2026'));
  expect(records).toHaveLength(60);
  expect(records[0].url).not.toContain('#');
  expect(records[0]).toMatchObject({ sourceContext: { meetingDate: '2026-11-17', publicationDate: '2026-11-05', issuer: 'Die Regionspräsidentin' } });
  expect(records.find(r => r.title.startsWith('ÜSTRA'))).toBeDefined();
  expect(records.filter(formats.hasLocalTrafficEvidence)).toEqual([]);
});

test('a meeting venue name does not suppress substantive traffic on the same Hannover street', () => {
  expect(formats.hasLocalTrafficEvidence({ title: 'Radverkehr auf der Hildesheimer Straße in Hannover', snippet: null })).toBe(true);
  expect(formats.hasLocalTrafficEvidence({ title: 'Verkehrsausschuss Niedersachsen', snippet: 'Sitzungssaal, Hildesheimer Straße 18, 30169 Hannover' })).toBe(false);
});
