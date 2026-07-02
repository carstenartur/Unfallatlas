const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

describe('Export QA – map modes and attribution', () => {
  let UA;
  let realCreatePdf;
  let capturedPdfDefinitions;

  const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  beforeEach(() => {
    const pdfMakeLib = require('pdfmake/build/pdfmake');
    const pdfFonts = require('pdfmake/build/vfs_fonts');
    pdfMakeLib.vfs = pdfFonts;

    Object.assign(window, {
      UA: {},
      docx: require('docx'),
      pdfMake: pdfMakeLib,
      saveAs: jest.fn(),
      leafletImage: jest.fn((_map, callback) => {
        setTimeout(() => callback(null, {
          toDataURL: () => PNG_DATA_URL
        }), 5);
      })
    });

    realCreatePdf = pdfMakeLib.createPdf.bind(pdfMakeLib);
    capturedPdfDefinitions = [];
    jest.spyOn(window.pdfMake, 'createPdf').mockImplementation((def) => {
      capturedPdfDefinitions.push(def);
      const doc = realCreatePdf(def);
      doc.download = jest.fn();
      return doc;
    });

    const src = fs.readFileSync(path.resolve(__dirname, '../../js/ua.report_v2.js'), 'utf8');
    eval(src);
    UA = window.UA;
    UA.getActiveMapLayerInfo = jest.fn((ctx) => (ctx && ctx._activeMapLayerInfo) || null);
  });

  afterEach(() => {
    delete window.UA;
    delete window.docx;
    delete window.pdfMake;
    delete window.saveAs;
    delete window.leafletImage;
    jest.restoreAllMocks();
  });

  function makePoints(city) {
    const base = city === 'Bonn'
      ? { lat: 50.7374, lon: 7.0982 }
      : { lat: 52.3759, lon: 9.7320 };
    return [
      { lat: base.lat, lon: base.lon, props: { year: 2023, severity: 3, Unfalltyp: '1', UJAHR: 2023 } },
      { lat: base.lat + 0.0008, lon: base.lon + 0.0009, props: { year: 2022, severity: 2, Unfalltyp: '2', UJAHR: 2022 } },
      { lat: base.lat - 0.0007, lon: base.lon - 0.0005, props: { year: 2021, severity: 3, Unfalltyp: '3', UJAHR: 2021 } },
      { lat: base.lat + 0.0012, lon: base.lon - 0.0011, props: { year: 2020, severity: 1, Unfalltyp: '4', UJAHR: 2020 } }
    ];
  }

  function makeCtx(city, mode, mapInfo) {
    const center = city === 'Bonn'
      ? { lat: 50.7374, lng: 7.0982 }
      : { lat: 52.3759, lng: 9.7320 };
    const bounds = city === 'Bonn'
      ? { south: 50.734, west: 7.092, north: 50.741, east: 7.104 }
      : { south: 52.372, west: 9.726, north: 52.380, east: 9.739 };
    const viewportPts = makePoints(city);
    return {
      CITY_RAW: city,
      mapMode: mode,
      viewportPts,
      allPts: viewportPts,
      map: {
        getCenter: () => center,
        getZoom: () => 16,
        eachLayer: () => {},
        fitBounds: jest.fn(),
        setView: jest.fn(),
        getBounds: () => ({
          getSouth: () => bounds.south,
          getWest: () => bounds.west,
          getNorth: () => bounds.north,
          getEast: () => bounds.east
        })
      },
      selectionBounds: {
        getSouth: () => bounds.south,
        getWest: () => bounds.west,
        getNorth: () => bounds.north,
        getEast: () => bounds.east,
        contains: ([lat, lon]) => lat >= bounds.south && lat <= bounds.north && lon >= bounds.west && lon <= bounds.east
      },
      _activeMapLayerInfo: mapInfo
    };
  }

  function makeReportData(city, total) {
    return {
      text: [
        'Sachverhalt:',
        `Im markierten Kartenausschnitt ${city} wurden ${total} Unfälle ausgewertet.`,
        'Die Karte dient der Begutachtung eines großen Knotenpunkts mit Luftbild-/Basiskartenkontext.',
        '',
        'Beschlussvorschlag:',
        'Der Bezirksrat bittet die Verwaltung um Prüfung der Unfalllage.'
      ].join('\n'),
      structured: {
        meta: {
          city,
          areaName: city === 'Bonn' ? 'Bad Godesberg / Koblenzer Straße' : 'Aegidientorplatz / Friedrichswall',
          date: '01.07.2026',
          gremium: { typ: 'Bezirksrat', gremium: `Bezirksrat ${city}` }
        },
        severity: { total, bySev: { '1': 1, '2': 1, '3': 2 } },
        accidentDetails: {
          total,
          rows: [
            { idx: 1, year: 2023, date: '01.02.2023', severity: 'Leichtverletzt', type: 'Abbiegeunfall', participants: 'Rad + PKW', roadCondition: 'trocken', coords: 'A' },
            { idx: 2, year: 2022, date: '12.05.2022', severity: 'Schwerverletzt', type: 'Einbiegen/Kreuzen', participants: 'Fuß + PKW', roadCondition: 'nass', coords: 'B' },
            { idx: 3, year: 2021, date: '19.08.2021', severity: 'Leichtverletzt', type: 'Längsverkehr', participants: 'PKW', roadCondition: 'trocken', coords: 'C' },
            { idx: 4, year: 2020, date: '03.11.2020', severity: 'Getötet', type: 'Sonstiger Unfall', participants: 'Rad', roadCondition: 'trocken', coords: 'D' }
          ],
          groups: []
        }
      }
    };
  }

  async function unzipDocxFromSaveAs() {
    expect(window.saveAs).toHaveBeenCalled();
    const [blob] = window.saveAs.mock.calls.at(-1);
    expect(blob.size).toBeGreaterThan(2000);
    const buffer = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(blob);
    });
    return JSZip.loadAsync(buffer);
  }

  async function collectDocxText(zip) {
    const xml = await zip.file('word/document.xml').async('string');
    return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('\n');
  }

  function flattenPdfText(node, acc = []) {
    if (!node) return acc;
    if (Array.isArray(node)) {
      node.forEach((entry) => flattenPdfText(entry, acc));
      return acc;
    }
    if (typeof node === 'string') {
      acc.push(node);
      return acc;
    }
    if (typeof node !== 'object') return acc;
    if (typeof node.text === 'string') acc.push(node.text);
    else if (Array.isArray(node.text)) flattenPdfText(node.text, acc);
    flattenPdfText(node.stack, acc);
    flattenPdfText(node.columns, acc);
    return acc;
  }

  function hasPdfImage(node) {
    if (!node) return false;
    if (Array.isArray(node)) return node.some(hasPdfImage);
    if (typeof node !== 'object') return false;
    if (typeof node.image === 'string' && node.image.startsWith('data:image/png;base64,')) return true;
    return Object.keys(node).some((key) => hasPdfImage(node[key]));
  }

  async function getPdfBuffer(doc) {
    let buffer;
    try {
      const maybePromise = doc.getBuffer();
      if (maybePromise && typeof maybePromise.then === 'function') {
        buffer = await maybePromise;
      }
    } catch (_) {
      // Fallback for callback-based pdfmake versions.
    }
    if (!buffer) {
      buffer = await new Promise((resolve, reject) => {
        try {
          doc.getBuffer(resolve);
        } catch (err) {
          reject(err);
        }
      });
    }
    return buffer;
  }

  const scenarios = [
    {
      city: 'Bonn',
      mode: 'standard',
      mapInfo: {
        mode: 'standard',
        modeLabel: 'Standardkarte',
        requestedMode: 'standard',
        requestedModeLabel: 'Standardkarte',
        orthophoto: null,
        warning: ''
      },
      expectedSourceText: 'Basiskarte: OpenStreetMap.'
    },
    {
      city: 'Bonn',
      mode: 'orthophoto',
      mapInfo: {
        mode: 'orthophoto',
        modeLabel: 'Orthofoto',
        requestedMode: 'orthophoto',
        requestedModeLabel: 'Orthofoto',
        orthophoto: {
          displayName: 'Bonn Orthophoto',
          provider: 'Bundesstadt Bonn',
          attribution: 'Datenquelle: Bundesstadt Bonn',
          license: 'Datenlizenz Deutschland – Namensnennung – Version 2.0'
        },
        warning: ''
      },
      expectedSourceText: 'Orthofoto: Bonn Orthophoto (Bundesstadt Bonn).'
    },
    {
      city: 'Hannover',
      mode: 'hybrid',
      mapInfo: {
        mode: 'hybrid',
        modeLabel: 'Hybrid',
        requestedMode: 'hybrid',
        requestedModeLabel: 'Hybrid',
        orthophoto: {
          displayName: 'DOP20 Niedersachsen',
          provider: 'LGLN',
          attribution: 'Quelle: LGLN',
          license: 'Datenlizenz Deutschland – Zero – Version 2.0'
        },
        warning: ''
      },
      expectedSourceText: 'Orthofoto: DOP20 Niedersachsen (LGLN).'
    },
    {
      city: 'Hannover',
      mode: 'analysis',
      mapInfo: {
        mode: 'analysis',
        modeLabel: 'Analyseansicht',
        requestedMode: 'analysis',
        requestedModeLabel: 'Analyseansicht',
        orthophoto: {
          displayName: 'DOP20 Niedersachsen',
          provider: 'LGLN',
          attribution: 'Quelle: LGLN',
          license: 'Datenlizenz Deutschland – Zero – Version 2.0'
        },
        warning: 'Analyseansicht nutzt reduzierte Orthofoto-Deckkraft für sichtbare Marker.'
      },
      expectedSourceText: 'Orthofoto: DOP20 Niedersachsen (LGLN).'
    }
  ];

  test.each(scenarios)('generates attributable Word/PDF exports for $city in $mode mode', async ({ city, mode, mapInfo, expectedSourceText }) => {
    const ctx = makeCtx(city, mode, mapInfo);
    const reportData = makeReportData(city, ctx.viewportPts.length);
    const options = { includeMap: true, includePOIs: false, includeReferences: false };

    await UA.exportToWord(ctx, reportData, options);
    const zip = await unzipDocxFromSaveAs();
    const docxText = await collectDocxText(zip);
    const mediaEntries = Object.keys(zip.files).filter((name) => name.startsWith('word/media/'));

    expect(mediaEntries.length).toBeGreaterThan(0);
    expect(docxText).toContain(`Im markierten Kartenausschnitt ${city} wurden 4 Unfälle ausgewertet.`);
    expect(docxText).toContain('Die dargestellten Punkte entsprechen exakt den in der Tabelle aufgeführten Unfällen (n = 4).');
    expect(docxText).toContain(`Kartenmodus: ${mapInfo.modeLabel}.`);
    expect(docxText).toContain(expectedSourceText);
    expect(docxText).toContain('Legende: Darstellung entsprechend der aktuellen Kartendarstellung.');
    if (mapInfo.orthophoto) {
      expect(docxText).toContain('Quelle/Lizenz:');
    }

    await UA.exportToPDF(ctx, reportData, options);
    const pdfDefinition = capturedPdfDefinitions.at(-1);
    const pdfText = flattenPdfText(pdfDefinition.content).join(' ');

    expect(hasPdfImage(pdfDefinition.content)).toBe(true);
    const pdfBuffer = await getPdfBuffer(realCreatePdf(pdfDefinition));

    expect(pdfBuffer.length).toBeGreaterThan(1500);
    expect(pdfText).toContain(`Im markierten Kartenausschnitt ${city} wurden 4 Unfälle ausgewertet.`);
    expect(pdfText).toContain('Die dargestellten Punkte entsprechen exakt den in der Tabelle aufgeführten Unfällen (n = 4).');
    expect(pdfText).toContain(`Kartenmodus: ${mapInfo.modeLabel}.`);
    expect(pdfText).toContain(expectedSourceText);
    expect(pdfText).toContain('Punkte: rot = Getötete, orange = Schwerverletzte, gelb = Leichtverletzte (mit weißem Rand für Sichtbarkeit).');
    if (mapInfo.warning) {
      expect(pdfText).toContain(mapInfo.warning);
    }
  });

  test('states explicit standard fallback metadata when orthophoto export falls back', async () => {
    const mapInfo = {
      mode: 'standard',
      modeLabel: 'Standardkarte',
      requestedMode: 'orthophoto',
      requestedModeLabel: 'Orthofoto',
      orthophoto: null,
      warning: 'Orthofoto nicht verfügbar – Standardkarte aktiv.'
    };
    const ctx = makeCtx('Bonn', 'orthophoto', mapInfo);
    const reportData = makeReportData('Bonn', ctx.viewportPts.length);
    const options = { includeMap: true, includePOIs: false, includeReferences: false };

    await UA.exportToWord(ctx, reportData, options);
    const zip = await unzipDocxFromSaveAs();
    const docxText = await collectDocxText(zip);

    expect(docxText).toContain('Kartenmodus: Standardkarte (angefordert: Orthofoto).');
    expect(docxText).toContain('Basiskarte: OpenStreetMap.');
    expect(docxText).toContain('Fallback verwendet: Standardkarte (OpenStreetMap).');
    expect(docxText).toContain('Orthofoto nicht verfügbar – Standardkarte aktiv.');

    await UA.exportToPDF(ctx, reportData, options);
    const pdfDefinition = capturedPdfDefinitions.at(-1);
    const pdfText = flattenPdfText(pdfDefinition.content).join(' ');

    expect(pdfText).toContain('Kartenmodus: Standardkarte (angefordert: Orthofoto).');
    expect(pdfText).toContain('Basiskarte: OpenStreetMap.');
    expect(pdfText).toContain('Fallback verwendet: Standardkarte (OpenStreetMap).');
    expect(pdfText).toContain('Orthofoto nicht verfügbar – Standardkarte aktiv.');
  });
});
