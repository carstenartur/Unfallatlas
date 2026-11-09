/** @jest-environment node */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const JSZip = require('jszip');
const pdfMake = require('../../scripts/pdfmake-node');

/**
 * Integration coverage for PDF and DOCX document exports.
 *
 * The suite uses the real pdfmake/docx libraries. pdfMake content is inspected
 * recursively because final-page hardening deliberately nests headings, tables,
 * captions and images in stacks and columns.
 */
describe('Document Export - Integration Tests', () => {
  let UA;
  let mockCanvas;
  let window;

  function collectPdfText(item) {
    if (item == null) return '';
    if (typeof item === 'string') return item;
    if (Array.isArray(item)) return item.map(collectPdfText).filter(Boolean).join(' ');
    if (typeof item !== 'object') return '';

    const fragments = [];
    if (typeof item.text === 'string') fragments.push(item.text);
    else if (Array.isArray(item.text)) fragments.push(collectPdfText(item.text));
    if (Array.isArray(item.stack)) fragments.push(collectPdfText(item.stack));
    if (Array.isArray(item.columns)) fragments.push(collectPdfText(item.columns));
    if (item.table && Array.isArray(item.table.body)) {
      fragments.push(collectPdfText(item.table.body));
    }
    return fragments.filter(Boolean).join(' ');
  }

  function containsPng(node) {
    if (node == null) return false;
    if (Array.isArray(node)) return node.some(containsPng);
    if (typeof node !== 'object') return false;
    if (typeof node.image === 'string' && node.image.startsWith('data:image/png;base64,')) {
      return true;
    }
    return containsPng(node.stack) || containsPng(node.columns) ||
      Boolean(node.table && containsPng(node.table.body));
  }

  function makeCtx(city = 'Hannover') {
    return {
      CITY_RAW: city,
      map: {
        getCenter: jest.fn(() => ({ lat: 52.3759, lng: 9.732 })),
        getZoom: jest.fn(() => 12),
      },
    };
  }

  function baseStructured(overrides = {}) {
    return {
      meta: {
        city: 'Hannover',
        date: '01.01.2025',
        bounds: '52.0,9.5 – 53.0,10.5',
        areaName: 'Test',
        link: 'http://localhost/',
        filters: {},
      },
      severity: { total: 10, bySev: { '1': 1, '2': 4, '3': 5, other: 0 } },
      deviations: {
        focus: [
          {
            mask: 5,
            label: '[Rad]+[PKW]',
            locCnt: 5,
            baseCnt: 10,
            locR: 0.5,
            baseR: 0.2,
            factor: 2.5,
          },
        ],
        rows: [],
        local: { total: 10, byMask: {} },
        baseline: { total: 50, byMask: {} },
      },
      yearTable: [
        { year: 2022, total: 5, classes: ['[Rad]+[PKW]=5'] },
        { year: 2021, total: 5, classes: ['[Rad]+[PKW]=5'] },
      ],
      poi: null,
      references: null,
      patterns: [],
      ...overrides,
    };
  }

  function basicReport(overrides = {}) {
    return {
      text: 'Sachverhalt:\nTest content\n\nBeschlussvorschlag:\nTest proposal',
      ...overrides,
    };
  }

  const refreshWarning = 'Aktualisierung fehlgeschlagen: <archiv> & Quelle.';
  const scopeWarning = 'Nur die veröffentlichten Vorlagen wurden erfasst.';
  const politicalReferences = [
    {
      title: 'Vorlage aus dem Teilbestand',
      source: 'Ratsinformationssystem',
      snapshot: {
        city: 'hannover', generatedAt: '2026-10-15T14:30:00Z', sha256: 'a'.repeat(64),
        complete: false, stale: true, warnings: [scopeWarning, refreshWarning],
      },
    },
    {
      title: 'Vorlage aus früherem Katalog',
      snapshot: { city: 'hannover', generatedAt: '2026-10-02T10:00:00Z', sha256: 'b'.repeat(64) },
    },
    { title: 'Manuell gewählte Vorlage' },
  ];

  function expectSnapshotDetails(text) {
    expect(text).toContain('Vorlage aus früherem Katalog');
    expect(text).toContain('Manuell gewählte Vorlage');
    const [beforeDatedReference, remaining] = text.split('Vorlage aus früherem Katalog');
    const [datedReference, manualReference] = remaining.split('Manuell gewählte Vorlage');
    expect(beforeDatedReference).toContain('Vorlage aus dem Teilbestand');
    expect(beforeDatedReference).toContain('Katalogstand: 2026-10-15');
    expect(beforeDatedReference).toMatch(/Katalogabdeckung: eingeschränkt/);
    expect(beforeDatedReference).toMatch(/Katalogstand ist veraltet/);
    expect(beforeDatedReference).toContain(scopeWarning);
    expect(beforeDatedReference).toContain(refreshWarning);
    expect(datedReference).toContain('Katalogstand: 2026-10-02');
    expect(datedReference).not.toMatch(/eingeschränkt|veraltet|Kataloghinweis/);
    expect(manualReference).not.toMatch(/Katalogstand|Katalogabdeckung|Kataloghinweis/);
  }

  async function readWordDocument(blob) {
    const archive = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await archive.file('word/document.xml').async('string');
    const dom = new JSDOM(xml, { contentType: 'application/xml' });
    try {
      return Array.from(dom.window.document.getElementsByTagName('w:t'), node => node.textContent).join(' ');
    } finally {
      dom.window.close();
    }
  }

  function readPdfText(buffer, pages = false) {
    const script = `
      import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const pdf = await getDocument({ data: new Uint8Array(Buffer.concat(chunks)) }).promise;
      for (let i = 1; i <= pdf.numPages; i++) {
        const text = await (await pdf.getPage(i)).getTextContent();
        process.stdout.write(text.items.map(item => item.str).join(' ') + '\\n');
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: path.resolve(__dirname, '../..'), input: Buffer.from(buffer), encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(`PDF inspection failed: ${result.stderr}`);
    return pages ? result.stdout.trim().split('\n') : result.stdout.replace(/\s+/g, ' ');
  }

  beforeEach(() => {
    mockCanvas = {
      toDataURL: jest.fn(() =>
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      ),
    };
    window = {
      UA: {},
      location: new URL('http://localhost/werkbank_v2.html'),
      leafletImage: jest.fn((_map, callback) => {
        setTimeout(() => callback(null, mockCanvas), 10);
      }),
      docx: require('docx'),
      pdfMake,
      saveAs: jest.fn(),
    };

    const realCreatePdf = pdfMake.createPdf.bind(pdfMake);
    jest.spyOn(window.pdfMake, 'createPdf').mockImplementation(definition => {
      const document = realCreatePdf(definition);
      document.download = jest.fn();
      return document;
    });

    const file = path.resolve(__dirname, '../../js/ua.report_v2.js');
    eval(fs.readFileSync(file, 'utf8'));
    UA = window.UA;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('should generate PDF with accident data', async () => {
    const report = basicReport({
      text: [
        'Sachverhalt:',
        'Im markierten Kartenausschnitt wurden 42 Unfälle ausgewertet.',
        'Davon waren 15 Radunfälle, 10 Fußgängerunfälle und 17 PKW-Unfälle.',
        '',
        'POI-Analyse',
        'Innerhalb des Ausschnitts: Grundschule Am Sandbach (200m)',
        '',
        'Bezugsdokumente:',
        'Die Ideale Kreuzung - Leitfaden für sichere Knotenpunkte',
        '',
        'Beschlussvorschlag:',
        'Der Bezirksrat bittet die Verwaltung, den markierten Bereich zu prüfen.',
      ].join('\n'),
      structured: { meta: { gremium: { typ: 'Bezirksrat' } } },
    });

    await UA.exportToPDF(makeCtx(), report, {
      includeMap: false,
      includePOIs: true,
      includeReferences: true,
    });

    const definition = window.pdfMake.createPdf.mock.calls[0][0];
    const text = collectPdfText(definition.content);
    expect(definition.content.length).toBeGreaterThan(0);
    expect(text).toContain('BEZIRKSRATSANTRAG');
    expect(text).toContain('SACHVERHALT');
    expect(text).toContain('BESCHLUSSVORSCHLAG');
  });

  test('should generate PDF with map image', async () => {
    await UA.exportToPDF(makeCtx(), basicReport(), {
      includeMap: true,
      includePOIs: false,
      includeReferences: false,
    });

    expect(window.leafletImage).toHaveBeenCalled();
    const definition = window.pdfMake.createPdf.mock.calls[0][0];
    expect(containsPng(definition.content)).toBe(true);
  });

  test('native PDF map links retain their URLs and use supported font glyphs', async () => {
    const samples=require('../../scripts/generate-sample-docx');
    const scenario=samples.resolveScenario();
    const ctx=samples.createContext(scenario);
    UA.captureExportMapImage=async()=>mockCanvas.toDataURL();
    UA._captureDetailMap=async()=>mockCanvas.toDataURL();
    UA._captureClusterMaps=async()=>[{image:mockCanvas.toDataURL(),bounds:{south:52.3,west:9.6,north:52.4,east:9.8},
      total:1,points:[{}],label:'Cluster',zoom:15,lat:52.35,lon:9.7}];
    await UA.exportToPDF(ctx,samples.createReportData(scenario),scenario.exportOptions);
    const definition=window.pdfMake.createPdf.mock.calls[0][0];
    const links=[];
    const walk=node=>{if(!node||typeof node!=='object')return;
      if(node.link&&typeof node.text==='string'&&node.text.includes('In Werkbank öffnen'))links.push(node);
      for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);};
    walk(definition.content);
    expect(links).toHaveLength(3);
    const font=require('fontkit').openSync(require('pdfmake/fonts/Roboto').Roboto.normal);
    expect(links.flatMap(link=>[...link.text].filter(char=>!font.hasGlyphForCodePoint(char.codePointAt(0))))).toEqual([]);
    const targets=links.map(link=>new URL(link.link));
    expect(targets.every(url=>url.protocol==='http:'||url.protocol==='https:')).toBe(true);
    expect(targets[0].searchParams.get('city')).toBe(ctx.CITY_RAW);
    expect(Number(targets[2].searchParams.get('selSouth'))).toBe(52.3);
    const pdf=window.pdfMake.createPdf.mock.results[0].value;
    expect(readPdfText(await pdf.getBuffer())).toContain('In Werkbank öffnen');
  });

  test('DOCX proposal heading keeps the first proposal paragraph with it', async () => {
    await UA.exportToWord(makeCtx(),basicReport(),{includeMap:false});
    const archive=await JSZip.loadAsync(await window.saveAs.mock.calls[0][0].arrayBuffer());
    const dom=new JSDOM(await archive.file('word/document.xml').async('string'),{contentType:'application/xml'});
    const paragraphs=[...dom.window.document.getElementsByTagName('w:p')];
    const index=paragraphs.findIndex(p=>p.textContent==='ANTRAG / BESCHLUSSVORSCHLAG');
    expect(paragraphs[index].getElementsByTagName('w:keepNext')).toHaveLength(1);
    expect(paragraphs[index+1].textContent).toContain('Test proposal');
    expect(paragraphs[index+1].getElementsByTagName('w:keepNext')).toHaveLength(0);
    dom.window.close();
  });

  test('native heatmap heading and column header share a page with the first data row at page boundaries', async () => {
    new Function('window',fs.readFileSync(path.resolve(__dirname,'../../js/ua.heatmap.js'),'utf8'))(window);
    const heatmap={total:1,max:1,colTotals:[1,0],matrix:Array.from({length:24},(_,hour)=>[hour===0?1:0,0])};
    await UA.exportToPDF(makeCtx(),basicReport({structured:baseStructured({heatmap})}),{includeMap:false});
    const definition=window.pdfMake.createPdf.mock.calls[0][0];
    const index=definition.content.findIndex(n=>n.text==='STUNDEN-HEATMAP (WERKTAG VS. WOCHENENDE)');
    expect(index).toBeGreaterThan(0);
    for(const remainingSpace of [55,70,85]) {
      const compact={...definition,pageSize:{width:595.28,height:240},pageMargins:[40,40,40,40],
        content:[{text:'Vorangehender Abschnitt',fontSize:10,margin:[0,0,0,160-12-remainingSpace]},
          ...JSON.parse(JSON.stringify(definition.content.slice(index,index+2)))]};
      const pdf=window.pdfMake.createPdf(compact);
      const pages=readPdfText(await pdf.getBuffer(),true);
      const headingPage=pages.find(p=>p.includes('STUNDEN-HEATMAP'));
      expect(headingPage).toContain('Stunde');
      expect(headingPage).toContain('00:00');
      expect(pages.join(' ')).toContain('23:00');
      expect(pages.length).toBeGreaterThan(1);
    }
  });

  test.each([['',false],['Betreff:\n\n',false],['Betreff:\n\nStadt: Bonn\n',false],['Betreff:\n\nBeschlussvorschlag: Bitte prüfen\n',false],['',true]])('document subject is neutral while intentional report text is preserved (%s, templates=%s)', async (prefix, loadTemplates) => {
    const canonical=fs.readFileSync(path.resolve(__dirname,'../../templates/intro.txt'),'utf8').split('\n').find(line=>line.startsWith('Betreff:')).slice('Betreff:'.length).trim();
    if(loadTemplates) new Function('window',fs.readFileSync(path.resolve(__dirname,'../../js/ua.export_template_defaults.js'),'utf8'))(window);
    const intentional='Eigener Prüftext: auffälliger Unfallschwerpunkt laut beigefügter Nutzerangabe.';
    const report=basicReport({text:prefix+'Sachverhalt:\n'+intentional+'\nBeschlussvorschlag:\nTest proposal'});
    await UA.exportToWord(makeCtx(),report,{includeMap:false});
    const word=await readWordDocument(window.saveAs.mock.calls[0][0]);
    await UA.exportToPDF(makeCtx(),report,{includeMap:false});
    const pdf=readPdfText(await window.pdfMake.createPdf.mock.results[0].value.getBuffer());
    for(const text of [word,pdf]) {
      const subject=text.slice(text.indexOf('Betreff:'),text.indexOf('Rahmendaten'));
      expect(subject).toContain(canonical);
      expect(subject).not.toMatch(/Unfallschwerpunkt/i);
      expect(text).toContain(intentional);
    }
  });

  test.each(['Betreff: Eigene ausdrücklich gewünschte Bezeichnung','Betreff:\nEigene ausdrücklich gewünschte Bezeichnung'])('explicit document subject is retained: %s', async subject => {
    const report=basicReport({text:subject+'\nSachverhalt:\nTest content'});
    await UA.exportToWord(makeCtx(),report,{includeMap:false});
    await UA.exportToPDF(makeCtx(),report,{includeMap:false});
    for(const text of [await readWordDocument(window.saveAs.mock.calls[0][0]),readPdfText(await window.pdfMake.createPdf.mock.results[0].value.getBuffer())]) {
      expect(text.slice(text.indexOf('Betreff:'),text.indexOf('Rahmendaten'))).toContain('Eigene ausdrücklich gewünschte Bezeichnung');
    }
  });

  test.each(['Betreff: Eigene Prüfung 🚲 + 🚗','Betreff:\nEigene Prüfung 🚲 + 🚗'])('explicit subject uses existing prose conversion in both actual formats: %s', async subject => {
    const report=basicReport({text:subject+'\nSachverhalt:\nTest content'});
    await UA.exportToWord(makeCtx(),report,{includeMap:false});
    await UA.exportToPDF(makeCtx(),report,{includeMap:false});
    for(const text of [await readWordDocument(window.saveAs.mock.calls[0][0]),readPdfText(await window.pdfMake.createPdf.mock.results[0].value.getBuffer())]) {
      const heading=text.slice(text.indexOf('Betreff:'),text.indexOf('Rahmendaten'));
      expect(heading).toContain('Eigene Prüfung Radverkehr + PKW');
      expect(heading).not.toMatch(/🚲|🚗/u);
    }
  });

  test('should generate Word document with accident data', async () => {
    await UA.exportToWord(makeCtx(), basicReport({
      text: [
        'Sachverhalt:',
        'Im markierten Kartenausschnitt wurden 42 Unfälle ausgewertet.',
        '',
        'POI-Analyse',
        'Grundschule Am Sandbach (150m entfernt)',
        '',
        'Beschlussvorschlag:',
        'Der Bezirksrat bittet die Verwaltung um Prüfung.',
      ].join('\n'),
    }), {
      includeMap: false,
      includePOIs: true,
      includeReferences: false,
    });

    const [blob, filename] = window.saveAs.mock.calls[0];
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toContain('application/vnd');
    expect(filename).toMatch(/Antrag.*Hannover.*\.docx/);
  });

  test('should generate Word document with map image', async () => {
    await UA.exportToWord(makeCtx('Berlin'), basicReport(), {
      includeMap: true,
      includePOIs: false,
      includeReferences: false,
    });

    expect(window.leafletImage).toHaveBeenCalled();
    const [blob] = window.saveAs.mock.calls[0];
    expect(blob.size).toBeGreaterThan(0);
  });

  test('should handle map capture failure gracefully', async () => {
    window.leafletImage = jest.fn((_map, callback) => {
      setTimeout(() => callback(new Error('Map capture failed'), null), 10);
    });

    await expect(UA.exportToWord(makeCtx('Hamburg'), basicReport(), {
      includeMap: true,
      includePOIs: false,
      includeReferences: false,
    })).resolves.not.toThrow();
    expect(window.saveAs).toHaveBeenCalled();
  });

  test('should include POI analysis in PDF', async () => {
    await UA.exportToPDF(makeCtx('München'), basicReport({
      text: [
        'Sachverhalt:',
        '42 Unfälle im Bereich',
        '',
        'POI-Analyse',
        'Innerhalb des Ausschnitts:',
        '- Grundschule Beispielstraße (100m)',
        '- Kindergarten Sonnenschein (150m)',
        '',
        'In der Nähe (bis 200m):',
        '- Kita Regenbogen (180m)',
        '',
        'Beschlussvorschlag:',
        'Prüfung erforderlich',
      ].join('\n'),
    }), { includeMap: false, includePOIs: true, includeReferences: false });

    const text = collectPdfText(window.pdfMake.createPdf.mock.calls[0][0].content);
    expect(text).toContain('SENSIBLE EINRICHTUNGEN');
    expect(text).toContain('Grundschule');
    expect(text).toContain('Kindergarten');
  });

  test('should include references in PDF', async () => {
    await UA.exportToPDF(makeCtx('Köln'), basicReport({
      text: [
        'Sachverhalt:',
        'Test content',
        '',
        'Bezugsdokumente:',
        '- Die Ideale Kreuzung (Region Hannover, 2023)',
        '- Verkehrssicherheitskonzept NRW',
        '',
        'Beschlussvorschlag:',
        'Maßnahmen erforderlich',
      ].join('\n'),
    }), { includeMap: false, includePOIs: false, includeReferences: true });

    const text = collectPdfText(window.pdfMake.createPdf.mock.calls[0][0].content);
    expect(text).toContain('FACHLICHE BEZÜGE');
    expect(text).toContain('Ideale Kreuzung');
  });

  test.each(['text', 'html'])('%s exports retain selected RIS dates and limitations', async format => {
    const dom = new JSDOM();
    const { document } = dom.window;
    const fetch = async () => ({ ok: false });
    window.fetch = fetch;
    try {
      for (const module of ['ua.utils.js', 'ua.export_v2.js']) {
        eval(fs.readFileSync(path.resolve(__dirname, '../../js', module), 'utf8'));
      }
      const report = await UA.computeExportReport({
        CITY_RAW: 'Hannover',
        allPts: [],
        selectionBounds: {
          contains: () => false,
          getSouthWest: () => ({ lat: 52.36, lng: 9.71 }),
          getNorthEast: () => ({ lat: 52.39, lng: 9.75 }),
        },
        exportOptions: { includeCosts: false, includeMeasures: false },
        politicalReferences,
      });
      if (format === 'html') {
        const output = document.createElement('div');
        output.innerHTML = report.html;
        expect(output.querySelector('archiv')).toBeNull();
        expectSnapshotDetails(output.textContent);
      } else {
        expectSnapshotDetails(report.text);
      }
    } finally {
      dom.window.close();
    }
  });

  test('Word export retains selected RIS dates and limitations in the document', async () => {
    const report = basicReport({ structured: baseStructured({ politicalReferences }) });
    await UA.exportToWord(makeCtx(), report, { includeReferences: true });
    const [blob] = window.saveAs.mock.calls[0];
    expectSnapshotDetails(await readWordDocument(blob));
  });

  test('direct PDF export retains selected RIS dates and limitations in the document', async () => {
    const report = basicReport({ structured: baseStructured({ politicalReferences }) });
    await UA.exportToPDF(makeCtx(), report, { includeReferences: true });
    const pdf = window.pdfMake.createPdf.mock.results[0].value;
    expectSnapshotDetails(readPdfText(await pdf.getBuffer()));
  });

  test('should generate complete PDF with all sections', async () => {
    await UA.exportToPDF(makeCtx('Düsseldorf'), basicReport({
      text: [
        'Sachverhalt:',
        'Im markierten Kartenausschnitt wurden 58 Unfälle ausgewertet.',
        'Davon 25 mit Radbeteiligung, 12 mit Fußgängerbeteiligung.',
        '',
        'POI-Analyse',
        'Innerhalb: Grundschule Musterstraße (80m)',
        'In der Nähe: Kindergarten Test (190m)',
        '',
        'Bezugsdokumente:',
        'Verkehrssicherheitskonzept Düsseldorf 2025',
        '',
        'Beschlussvorschlag:',
        'Der Bezirksrat bittet um umfassende Prüfung und Maßnahmen.',
      ].join('\n'),
      structured: { meta: { gremium: { typ: 'Bezirksrat' } } },
    }), { includeMap: true, includePOIs: true, includeReferences: true });

    const text = collectPdfText(window.pdfMake.createPdf.mock.calls[0][0].content);
    for (const heading of [
      'BEZIRKSRATSANTRAG',
      'SACHVERHALT',
      'SENSIBLE EINRICHTUNGEN',
      'FACHLICHE BEZÜGE',
      'BESCHLUSSVORSCHLAG',
      'DATENQUELLE',
    ]) {
      expect(text).toContain(heading);
    }
  });

  test('PDF should include STATISTIK section with severity table when structured data provided', async () => {
    await UA.exportToPDF(makeCtx(), basicReport({ structured: baseStructured() }), {
      includeMap: false,
      includePOIs: true,
      includeReferences: true,
    });

    const text = collectPdfText(window.pdfMake.createPdf.mock.calls[0][0].content);
    expect(text).toContain('STATISTIK');
    expect(text).toContain('Getötete');
    expect(text).toContain('Schwerverletzte');
    expect(text).toContain('Leichtverletzte');
    expect(text).toContain('Muster');
  });

  test('Word document should include STATISTIK section when structured data provided', async () => {
    await UA.exportToWord(makeCtx(), basicReport({
      structured: baseStructured({
        severity: { total: 5, bySev: { '1': 0, '2': 2, '3': 3, other: 0 } },
        deviations: {
          focus: [],
          rows: [],
          local: { total: 5, byMask: {} },
          baseline: { total: 20, byMask: {} },
        },
        yearTable: [{ year: 2022, total: 5, classes: [] }],
      }),
    }), { includeMap: false, includePOIs: false, includeReferences: false });

    const [blob] = window.saveAs.mock.calls[0];
    expect(blob.size).toBeGreaterThan(0);
  });

  test('PDF export should show POI table from structured data', async () => {
    await UA.exportToPDF(makeCtx(), basicReport({
      structured: baseStructured({
        severity: { total: 0, bySev: { '1': 0, '2': 0, '3': 0, other: 0 } },
        deviations: {
          focus: [],
          rows: [],
          local: { total: 0, byMask: {} },
          baseline: { total: 0, byMask: {} },
        },
        yearTable: [],
        poi: {
          totalWithin: 2,
          totalNear: 1,
          withinByType: { school: 1, kindergarten: 1 },
          nearByType: { childcare: 1 },
          withinArea: [],
          nearArea: [],
        },
      }),
    }), { includeMap: false, includePOIs: true, includeReferences: false });

    const text = collectPdfText(window.pdfMake.createPdf.mock.calls[0][0].content);
    expect(text).toContain('SENSIBLE EINRICHTUNGEN');
    expect(text).toContain('Typ');
    expect(text).toContain('Im Bereich');
    expect(text).toContain('Schulen');
    expect(text).toContain('Kindergärten');
  });

  test('PDF with structured references shows structured list', async () => {
    await UA.exportToPDF(makeCtx(), basicReport({
      structured: baseStructured({
        severity: { total: 0, bySev: { '1': 0, '2': 0, '3': 0, other: 0 } },
        deviations: {
          focus: [],
          rows: [],
          local: { total: 0, byMask: {} },
          baseline: { total: 0, byMask: {} },
        },
        yearTable: [],
        references: {
          documents: [
            {
              title: 'Die Ideale Kreuzung',
              author: 'Region Hannover',
              date: '2023',
              url: 'https://example.com/dok',
            },
          ],
        },
      }),
    }), { includeMap: false, includePOIs: false, includeReferences: true });

    const text = collectPdfText(window.pdfMake.createPdf.mock.calls[0][0].content);
    expect(text).toContain('FACHLICHE BEZÜGE');
    expect(text).toContain('Die Ideale Kreuzung');
  });
  test.each([['count',2024,'Gemessene Verkehrsbelastung'],['count18504',2024,'Gemessene Verkehrsbelastung'],['hourly',2024,'Gemessene Verkehrsbelastung'],['model',2025,'Verkehrsmodell'],['old',2019,'Älterer gemessener Verkehrswert'],['proxy',2026,'Verkehrsproxy'],['dgm',2026,'Straßenprofil']])('typed context %s reaches real DOCX XML and PDF bytes', async (kind, year, label) => {
    const api=require('../../js/ua.export_provenance');
    const typed=require('../fixtures/typed-traffic-evidence');
    const props=kind==='hourly' ? require('../fixtures/typed-hourly-traffic-evidence')() : kind==='proxy' ? {traffic_measurement_type:'proxy',traffic_proxy_class:'high'} : kind==='dgm'
      ? {road_slope_percent:-4.4,road_slope_source:'DGM1 Prüfquelle',road_slope_source_id:'test.dgm1',road_slope_resolution_m:1,road_slope_reliable_for_road:true,road_slope_uncertainty_percent:0.7}
      : typed(['old','count18504'].includes(kind)?'count':kind,kind==='count18504'?18504:0,year);
    const ctx={CITY_RAW:kind==='hourly'?'Düsseldorf':'Köln',allPts:[{lat:kind==='hourly'?51.22015:50.93,lon:kind==='hourly'?6.76712:6.95,props:{year:2024,...props}}],contextLayerState:{meta:{sources:{roadSlope:{sourceId:'test.dgm1',datasetUrl:'https://example.org/dgm1',retrievedAt:null}}}}};
    Object.assign(ctx, {map:makeCtx().map});
    UA.exportProvenance=api;
    UA.artifactProvenance=require('../../js/ua.artifact_provenance');
    UA.exportProvenanceRuntime={createManifest:context=>api.createManifest(context,{UA,root:window})};
    UA.__documentProvenanceOriginals={exportToWord:UA.exportToWord,exportToPDF:UA.exportToPDF};
    UA.ensureExportLibraries=async()=>{};
    require('../../js/ua.document_export_provenance').install(UA,window);
    const note=api.buildContextNote(UA,ctx);
    const report=basicReport({structured:baseStructured({meta:{...baseStructured().meta,city:ctx.CITY_RAW},enrichmentSourcesNote:note})});
    const wordResult=await UA.exportToWord(ctx,report,{includeMap:false,includePOIs:false,includeReferences:false});
    const blob=window.saveAs.mock.calls[0][0];
    const wordText=await readWordDocument(blob);
    expect(wordText).toContain(label);
    const archive=await JSZip.loadAsync(await blob.arrayBuffer());
    const relationships=await archive.file('word/_rels/document.xml.rels').async('string');
    expect(relationships).toContain(note.sources[0].url.replace(/&/g,'&amp;'));
    const trafficSource=wordResult.manifest.sources.find(source=>source.role==='traffic_count');
    if(trafficSource) {
      if(kind!=='hourly') expect(wordResult.manifest.transformations.find(item=>item.transformationId==='context-evidence').parameters.observations[0].direction).toBe('A → B');
      expect(relationships).toContain(trafficSource.licenseUrl.replace(/&/g,'&amp;'));
      expect(relationships).toContain(trafficSource.datasetUrl.replace(/&/g,'&amp;'));
    }
    await UA.exportToPDF(ctx,report,{includeMap:false,includePOIs:false,includeReferences:false});
    const pdf=window.pdfMake.createPdf.mock.results[0].value;
    const bytes=await pdf.getBuffer();
    const pdfText=readPdfText(bytes);
    expect(pdfText).toContain(label);
    const linkProbe=spawnSync(process.execPath,['--input-type=module','-e',`
      import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
      const chunks=[];for await(const c of process.stdin) chunks.push(c);
      const pdf=await getDocument({data:new Uint8Array(Buffer.concat(chunks))}).promise;
      const urls=[];for(let i=1;i<=pdf.numPages;i++)for(const a of await (await pdf.getPage(i)).getAnnotations())if(a.url||a.unsafeUrl)urls.push(a.url||a.unsafeUrl);
      process.stdout.write(JSON.stringify(urls));
    `],{cwd:path.resolve(__dirname,'../..'),input:Buffer.from(bytes),encoding:'utf8'});
    expect(linkProbe.status).toBe(0);
    const urls=JSON.parse(linkProbe.stdout);
    expect(urls).toContain(note.sources[0].url);
    if(trafficSource) {expect(urls).toContain(trafficSource.licenseUrl);expect(urls).toContain(trafficSource.datasetUrl);}
    if(kind==='hourly') {
      const stationUrl='https://opendata.duesseldorf.de/sites/default/files/Z%C3%A4hlstellen_2.csv';
      const stationHash='e436955bd45fc322d62cd96b9cbdcc353d5ea9256a950785fcee8d8cfaed32db';
      expect(relationships).toContain(stationUrl);
      expect(urls).toContain(stationUrl);
      expect(trafficSource.qualityNotes).toEqual(expect.arrayContaining(props.traffic_evidence.observation.source.qualityNotes));
      const metadata=await archive.file('docProps/custom.xml').async('string');
      expect(metadata).toContain(stationUrl);
      expect(metadata).toContain(stationHash);
      for(const text of [wordText,pdfText]) {
        expect(text).not.toContain(stationUrl);
        expect(text).not.toContain(stationHash);
        expect(text).toContain('Prüfcode (gekürzt)');
        expect(text).toContain('e436955bd45f');
        expect(text).toContain('DL-DE-Zero-2.0');
        expect(text).toContain('2022-03-31');
        expect(text).toContain('2026-11-08T19:45:55.431954+00:00');
      }
    }
    for(const text of [wordText,pdfText]) {
      if(['count','count18504','model','old'].includes(kind)) { expect(text).toContain('Kfz/24 h'); expect(text).toContain('DTVw'); expect(text).toContain('Matching'); expect(text).toContain('Qualität high'); }
      if(['count','count18504','model','old'].includes(kind)) expect(text).toContain('Richtung A nach B');
      if(kind==='count') expect(text).toContain('Originalwert: 0 Kfz/24 h');
      if(kind==='count18504') expect(text).toContain('Originalwert: 18.504 Kfz/24 h');
      if(kind==='hourly') {expect(text).toContain('Originalwert: 1 Fahrräder/Stunde');expect(text).toContain('Entfernung unbekannt');expect(text).toContain('01-01-2024 00:00:00');}
      if(kind==='dgm') {expect(text).toContain('Abruf unbekannt');expect(text).toContain('1 m');}
      expect(text).not.toContain('keine gemessene Verkehrsdichte');
    }
    if(process.env.TRAFFIC_EXPORT_QA_DIR) {
      fs.mkdirSync(process.env.TRAFFIC_EXPORT_QA_DIR,{recursive:true});
      fs.writeFileSync(path.join(process.env.TRAFFIC_EXPORT_QA_DIR,kind+'.docx'),Buffer.from(await blob.arrayBuffer()));
      fs.writeFileSync(path.join(process.env.TRAFFIC_EXPORT_QA_DIR,kind+'.pdf'),Buffer.from(bytes));
    }
  });

});
