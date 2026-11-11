/** @jest-environment node */

const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const pdfMake = require('../../scripts/pdfmake-node');

const area = 'Engelbosteler Damm / Haltenhoffstraße / Bodestraße';
const source = 'https://example.test/unfallwerkbank';
const ids = Array.from({ length: 53 }, (_, i) => `A${String(i + 1).padStart(3, '0')}`);

function reportData() {
  const rows = ids.map((displayId, i) => ({
    displayId,
    year: 2017 + i % 9,
    severity: i < 3 ? 2 : 3,
    severityLabel: i < 3 ? 'Schwerverletzt' : 'Leichtverletzt',
    involvementLabel: 'Rad + Sonstige',
    hour: 12,
    weekdayLabel: 'Donnerstag',
    roadConditionLabel: 'nass/feucht/schlüpfrig',
    lat: 52.39165,
    lon: 9.72027,
    discoveryMatch: i < 45,
    mapDeepLink: `${source}?evidenceAccident=${displayId}`,
    mapRef: 'E1',
  }));
  return {
    text: [
      `Betreff: Verkehrssicherheit im Bereich ${area}`,
      'Sachverhalt:',
      'Amtlich dokumentierte Unfälle im ausgewählten Gebiet.',
      'Bezugsdokumente:',
      '- Beispielquelle für eine sichere Querung',
      'Beteiligungskombination × Schweregrad:',
      'Kombination | Getötete | Schwerverletzt | Leichtverletzt | Summe',
      'Einzelunfälle im Bereich:',
      '1 | 2025 | Rad + Sonstige',
      'Beschlussvorschlag:',
      'Der Stadtbezirksrat Nord bittet die Verwaltung um Prüfung.',
      '1) Die sichere Querung untersuchen.',
      '2) Das Ergebnis im Gremium vorstellen.',
      'Begründung:',
      'Die Querungsbeziehungen erfordern eine örtliche Prüfung.',
      'Hinweis zur Datenquelle / Lizenz:',
      'Datenlizenz Deutschland – Namensnennung – Version 2.0.',
      'VOLLSTÄNDIGE NUMMERIERTE UNFALLBEWEISANLAGE',
      'ID | Jahr | Schwere | Beteiligte',
      ...rows.map(row => `${row.displayId} | ${row.year} | ${row.severityLabel} | ${row.involvementLabel}`),
    ].join('\n'),
    structured: {
      meta: { city: 'Hannover', areaName: area, link: source, gremium: { typ: 'Bezirksrat', gremium: 'Stadtbezirksrat Nord' }, filters: { severity: 'all' } },
      severity: { total: 45, bySev: { 1: 0, 2: 2, 3: 43 } },
      methodikScope: { title: 'Methodik – eindeutige Zählbereiche', lines: [
        'Die parallele Mustersuche bleibt explorativ: Die einzelnen Wilson-95-%-Intervalle und isSignificant sind unbereinigt, eine Mehrfachtestkorrektur wird nicht behauptet.',
        'Vollständiger Antragsbeleg: Die nummerierte completeEvidenceCohort umfasst alle Unfälle im Antragsgebiet; Suchfilter begrenzen diese Menge nicht, sondern kennzeichnen ausschließlich die explorative Teilmenge.',
      ] },
      deviations: { local: { total: 45 }, baseline: { total: 11333 }, focus: [
        { textLabel: 'Nur Radverkehr erfasst', locCnt: 26, locR: 26 / 45, baseR: 3149 / 11333, factor: 2.08, ciLow: .433, ciHigh: .71, isSignificant: true },
      ] },
      accidentEvidenceAppendix: { complete: true, total: 53, discoveryCount: 45, rows, numberedMapUrl: source + '?evidenceLabels=1' },
      politicalReferences: [{ title: 'Sichere Fußgängerquerung', number: '15-1865/2024', url: 'https://example.test/ris/1865', scope: 'export-area' }],
    },
  };
}

function loadReport() {
  const window = {
    UA: {},
    docx: require('docx'),
    pdfMake,
    saveAs: jest.fn(),
    location: new URL(source),
  };
  eval(fs.readFileSync(path.resolve(__dirname, '../../js/ua.report_v2.js'), 'utf8'));
  return window;
}

function visibleText(node) {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(visibleText).join('\n');
  if (!node || typeof node !== 'object') return '';
  return visibleText(node.text ?? node.stack ?? node.ol ?? node.ul ?? node.table?.body ?? '');
}

async function exportPdf(window, data) {
  let definition;
  let document;
  const realCreatePdf = pdfMake.createPdf.bind(pdfMake);
  const spy = jest.spyOn(pdfMake, 'createPdf').mockImplementation(value => {
    definition = value;
    document = realCreatePdf(value);
    document.download = jest.fn();
    return document;
  });
  try {
    await window.UA.exportToPDF({ CITY_RAW: 'Hannover' }, data, { includeReferences: true });
    expect((await document.getBuffer()).subarray(0, 4).toString()).toBe('%PDF');
    return definition;
  } finally {
    spy.mockRestore();
  }
}

test('Antrags-PDF trennt Beschluss, Begründung, alle nummerierten Fälle und Methodik', async () => {
  const definition = await exportPdf(loadReport(), reportData());
  const firstAnnexIndex = definition.content.findIndex(node => node.text === 'Anlage 1 – Vollständige Unfallliste');
  expect(firstAnnexIndex).toBeGreaterThan(0);
  expect(definition.content[firstAnnexIndex].pageBreak).toBe('before');
  const front = visibleText(definition.content.slice(0, firstAnnexIndex));
  expect(front).toContain(area);
  expect(front).toContain('Stadtbezirksrat Nord');
  expect(front).toMatch(/Beschlussvorschlag[\s\S]+Die sichere Querung untersuchen\.[\s\S]+Begründung[\s\S]+Die Querungsbeziehungen erfordern/);
  expect(front).toContain('53');
  expect(front).toContain('45');
  expect(front).toContain('15-1865/2024');
  expect(front).not.toMatch(/Rahmendaten|Aktive Filter|Datenlizenz|^A001$/m);

  const all = visibleText(definition.content);
  expect(all).toContain('Anlage 2 – Auswertung und Methodik');
  expect(all).toContain('2,08');
  expect(all).toContain('Beispielquelle für eine sichere Querung');
  expect(all).not.toMatch(/\b2,18\b|completeEvidenceCohort|isSignificant|\|\s*(Jahr|Getötete|2025)|A001\s*\|/);
  const evidenceTable = definition.content.find(node => node.table?.body[1]?.[0]?.text === 'A001').table;
  expect(evidenceTable.headerRows).toBe(1);
  expect(evidenceTable.dontBreakRows).toBe(true);
  expect(evidenceTable.body.slice(1).map(row => row[0].text)).toEqual(ids);
  expect(evidenceTable.body[1][0].link).toBe(source + '?evidenceAccident=A001');
  expect(visibleText(evidenceTable.body[1])).toMatch(/Donnerstag\s+12:00/);
  expect(visibleText(evidenceTable.body[53])).toContain('Nein');
});

test('Antrags-DOCX rendert den fachlichen Beschluss und verlinkte Unfallkennungen als Tabelle', async () => {
  const window = loadReport();
  const data = reportData();
  data.structured.motion = {
    intro: 'Die Verwaltung wird gebeten, innerhalb von drei Monaten zu berichten.',
    requests: ['Schienenquerungen und Sichtbeziehungen örtlich untersuchen.', 'Zeitplan und Wirkungskontrolle vorlegen.'],
    rationale: 'Die kodierten Unfallarten begründen eine Prüfung am Knoten.',
    priorWork: [{ label: 'Bezirksratsbeschluss zum Fußweg', number: '1/2023', date: '2023-12-04', url: 'https://example.test/ris/123' }],
  };
  await window.UA.exportToWord({ CITY_RAW: 'Hannover' }, data);
  const blob = window.saveAs.mock.calls[0][0];
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = await zip.file('word/document.xml').async('string');
  const rels = await zip.file('word/_rels/document.xml.rels').async('string');

  const firstAnnexIndex = xml.indexOf('Anlage 1 – Vollständige Unfallliste');
  expect(firstAnnexIndex).toBeGreaterThan(0);
  const front = xml.slice(0, firstAnnexIndex);
  expect(front).toMatch(/Beschlussvorschlag[\s\S]+Schienenquerungen und Sichtbeziehungen örtlich untersuchen\.[\s\S]+Begründung[\s\S]+Die kodierten Unfallarten/);
  expect(front).toContain('DS 1/2023 (04.12.2023)');
  expect(rels).toContain('Target="https://example.test/ris/123"');
  const pdf = await exportPdf(loadReport(), data);
  const pdfFront = pdf.content.slice(0, pdf.content.findIndex(node => node.text === 'Anlage 1 – Vollständige Unfallliste'));
  expect(pdfFront.flatMap(node => Array.isArray(node.text) ? node.text.map(run => run.link) : [])).toContain('https://example.test/ris/123');
  expect(visibleText(pdfFront)).toContain('04.12.2023');
  expect(front).toContain('53 Unfälle mit Personenschaden');
  expect(front).toContain('Suchfilter heben davon 45 hervor');
  expect(front).not.toMatch(/Die sichere Querung untersuchen|Rahmendaten|Aktive Filter|A001/);
  expect(xml).not.toMatch(/2,18|completeEvidenceCohort|isSignificant|ID \| Jahr|A001 \|/);

  const tables = [...xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].map(match => match[0]);
  const evidenceTable = tables.find(table => table.includes('>A001<'));
  expect(evidenceTable).toBeDefined();
  expect(evidenceTable).toMatch(/<w:tblHeader\s*\/>/);
  expect(evidenceTable.match(/<w:cantSplit\s*\/>/g)).toHaveLength(54);
  expect([...evidenceTable.matchAll(/>(A\d{3})</g)].map(match => match[1])).toEqual(ids);
  expect(rels).toContain('Target="' + source + '?evidenceAccident=A001"');
});

test('Word links cited council numbers in the motion and the selected RIS document at its title', async () => {
  const window = loadReport();
  const data = reportData();
  const decision = 'https://example.test/ris/2021-decision';
  const reply = 'https://example.test/ris/2023-reply';
  const selected = { title: 'Planung des Radwegs', number: '25-111/2025', url: 'https://example.test/ris/selected' };
  data.structured.politicalReferences = [selected];
  data.structured.motion = {
    intro: 'Die Verwaltung wird gebeten zu berichten.',
    requests: ['Zum Beschluss 15-1243/2021 und zur Antwort 15-2377/2023 F1 berichten.'],
    rationale: 'Siehe DS 25-111/2025. Für 15-1243/2021 S1 ist hier kein Direktlink belegt.',
    priorWork: [
      { number: '15-1243/2021', date: '2021-06-07', url: decision },
      { number: '15-2377/2023 F1', date: '2023-12-04', url: reply },
    ],
  };
  await window.UA.exportToWord({ CITY_RAW: 'Hannover' }, data, { includeReferences: true });
  const zip = await JSZip.loadAsync(await window.saveAs.mock.calls[0][0].arrayBuffer());
  const xml = await zip.file('word/document.xml').async('string');
  const rels = await zip.file('word/_rels/document.xml.rels').async('string');
  const paragraphs = xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g);
  const linksAt = (phrase) => {
    const paragraph = paragraphs.find(p => p.includes(phrase));
    expect(paragraph).toBeDefined();
    return [...paragraph.matchAll(/<w:hyperlink\b[^>]*r:id="([^"]+)"[^>]*>([\s\S]*?)<\/w:hyperlink>/g)]
      .map(([, relId, runs]) => {
        const relationship = (rels.match(/<Relationship\s[^>]*\/>/g) || []).find(r => r.includes('Id="' + relId + '"'));
        const text = [...runs.matchAll(/<w:t(?:\s[^>]*)?>(.*?)<\/w:t>/g)].map(m => m[1]).join('');
        expect(relationship).toContain('TargetMode="External"');
        return [text, relationship.match(/Target="([^"]+)"/)[1]];
      });
  };
  expect(linksAt('Zum Beschluss')).toEqual([['15-1243/2021', decision], ['15-2377/2023 F1', reply]]);
  expect(linksAt('Siehe ')).toEqual([['DS 25-111/2025', selected.url]]);
  expect(linksAt(selected.title)).toEqual([[selected.title, selected.url], ['DS 25-111/2025', selected.url]]);
  const front = xml.slice(0, xml.indexOf('Anlage 1 – Vollständige Unfallliste'));
  expect(front).toContain('Ratsvorgänge im Original');
});

describe('Word annex layout', () => {
  let xml;

  beforeAll(async () => {
    const window = loadReport();
    new Function('window', fs.readFileSync(path.resolve(__dirname, '../../js/ua.review_network.js'), 'utf8'))(window);
    const data = reportData();
    data.structured.crossTable = {
      rows: [{ mask: 1, textLabel: 'Unfall mit ausschließlich gesetzter Beteiligungskategorie Pkw', sev1: 0, sev2: 0, sev3: 1, total: 1 }],
      totals: { sev1: 0, sev2: 0, sev3: 1, total: 1 },
    };
    data.structured.siteNetwork = {
      status: 'available', kind: 'junction', label: area,
      site: { id: 'j:22', revision: 'testrevision' },
      bounds: { south: 52.37, west: 9.72, north: 52.38, east: 9.73 },
      query: {}, assignedCount: 4, queryCount: 3, mapCount: 2,
    };
    await window.UA.exportToWord({ CITY_RAW: 'Hannover' }, data);
    const zip = await JSZip.loadAsync(await window.saveAs.mock.calls[0][0].arrayBuffer());
    xml = await zip.file('word/document.xml').async('string');
  });

  test('allocates room for long involvement labels and keeps the count columns compact', () => {
    const table = [...xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].map(match => match[0])
      .find(tableXml => tableXml.includes('ausschließlich gesetzter Beteiligungskategorie Pkw'));
    expect(table).toBeDefined();
    const widths = [...table.matchAll(/<w:gridCol w:w="(\d+)"\s*\/>/g)].map(match => Number(match[1]));
    const [label, fatal, serious, slight, total] = widths;
    expect(widths).toHaveLength(5);
    expect(label).toBeGreaterThan(widths.reduce((sum, n) => sum + n, 0) * 0.44);
    expect(Math.min(serious, slight)).toBeGreaterThan(Math.max(fatal, total));
  });

  test('keeps the network heading and identifier with the first finding without binding the whole section', () => {
    const paragraphs = xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g);
    const index = paragraphs.findIndex(p => p.includes('Befund aus dem Netzregister'));
    expect(index).toBeGreaterThan(-1);
    expect(paragraphs[index]).toMatch(/<w:keepNext\s*\/>/);
    expect(paragraphs[index + 1]).toContain('Kennung j:22');
    expect(paragraphs[index + 1]).toMatch(/<w:keepNext\s*\/>/);
    expect(paragraphs[index + 2]).toContain('4 räumlich zugeordnete Fälle');
    expect(paragraphs[index + 2]).not.toMatch(/<w:keepNext\s*\/>/);
  });
});
