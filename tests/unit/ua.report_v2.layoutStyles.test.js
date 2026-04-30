/**
 * Layout-Pass — central typography styles + map-block dramaturgy (PDF).
 *
 * Akzeptanzkriterien dieses Tests (entsprechen den im Spec-Block
 * ausgeführten Punkten):
 *   - docDefinition.styles surfacen die kanonischen Stilnamen
 *     (title / sectionHeader / subsectionHeader / body / lead / caption /
 *     noteBox).
 *   - Die "Hinweis zur Zählweise"-Box rendert als echte Tabelle (noteBox)
 *     mit fillColor — nicht als loser kursiver Text.
 *   - Numbered figure captions verwenden den `caption`-Style.
 *   - Vor der Bilderfolge steht der erklärende Lead-in-Absatz
 *     ("Die folgenden Karten zeigen unterschiedliche Detailebenen…").
 *   - Detail- und Cluster-Captions enthalten den Subset-Cross-Reference-
 *     Satz ("Die N dargestellten Unfälle sind eine Teilmenge der M
 *     Unfälle aus Abbildung 1.").
 *
 * Wir reuse die pdfQA-Test-Bootstrap-Pattern (real pdfMake pipeline,
 * docDefinition als Wahrheitsquelle).
 */

const fs = require('fs');
const path = require('path');

describe('UA.report_v2 – Layout-Pass (canonical styles + map dramaturgy)', () => {
  let UA;

  beforeEach(() => {
    const pdfMakeLib = require('pdfmake/build/pdfmake');
    const pdfFonts = require('pdfmake/build/vfs_fonts');
    pdfMakeLib.vfs = pdfFonts;

    window.UA = {};
    window.docx = require('docx');
    window.pdfMake = pdfMakeLib;
    window.saveAs = jest.fn();

    const filePath = path.resolve(__dirname, '../../js/ua.report_v2.js');
    eval(fs.readFileSync(filePath, 'utf8'));
    UA = window.UA;
  });

  afterEach(() => {
    delete window.UA;
    delete window.docx;
    delete window.pdfMake;
    delete window.saveAs;
    jest.restoreAllMocks();
  });

  async function runPdfExport(ctx, reportData, options) {
    let capturedDef;
    const realCreatePdf = window.pdfMake.createPdf.bind(window.pdfMake);
    jest.spyOn(window.pdfMake, 'createPdf').mockImplementation((def) => {
      capturedDef = def;
      const doc = realCreatePdf(def);
      doc.download = jest.fn();
      return doc;
    });
    await UA.exportToPDF(ctx, reportData, options || {});
    return capturedDef;
  }

  function collectTexts(node, out) {
    out = out || [];
    if (node == null) return out;
    if (Array.isArray(node)) { for (const i of node) collectTexts(i, out); return out; }
    if (typeof node === 'string') { out.push(node); return out; }
    if (typeof node !== 'object') return out;
    if (typeof node.text === 'string') out.push(node.text);
    else if (Array.isArray(node.text)) collectTexts(node.text, out);
    if (Array.isArray(node.stack))   collectTexts(node.stack, out);
    if (Array.isArray(node.columns)) collectTexts(node.columns, out);
    if (node.table && Array.isArray(node.table.body)) {
      for (const row of node.table.body) for (const cell of row) collectTexts(cell, out);
    }
    return out;
  }

  function collectStyledNodes(node, out) {
    out = out || [];
    if (node == null) return out;
    if (Array.isArray(node)) { for (const i of node) collectStyledNodes(i, out); return out; }
    if (typeof node !== 'object') return out;
    if (node.style) out.push(node);
    if (Array.isArray(node.stack))   collectStyledNodes(node.stack, out);
    if (Array.isArray(node.columns)) collectStyledNodes(node.columns, out);
    if (Array.isArray(node.text))    collectStyledNodes(node.text, out);
    if (node.table && Array.isArray(node.table.body)) {
      for (const row of node.table.body) for (const cell of row) collectStyledNodes(cell, out);
    }
    return out;
  }

  function collectFillColorCells(node, out) {
    out = out || [];
    if (node == null) return out;
    if (Array.isArray(node)) { for (const i of node) collectFillColorCells(i, out); return out; }
    if (typeof node !== 'object') return out;
    if (node.fillColor) out.push(node);
    if (Array.isArray(node.stack))   collectFillColorCells(node.stack, out);
    if (Array.isArray(node.columns)) collectFillColorCells(node.columns, out);
    if (node.table && Array.isArray(node.table.body)) {
      for (const row of node.table.body) for (const cell of row) collectFillColorCells(cell, out);
    }
    return out;
  }

  // Minimal fixture without map capture — sufficient for style/structural checks
  // around the Hinweis box, Methodik scope, and (when includeMap:true with stubs)
  // the figure captions + lead-in.
  function makeCtx(extra) {
    return Object.assign({ CITY_RAW: 'Hannover' }, extra || {});
  }
  function makeReportData() {
    return {
      text: 'Stadt: Hannover\n\nSachverhalt:\nKurzer Sachverhalt.\n\n',
      structured: {
        meta: { gremium: { typ: 'BV' } },
        totalAccidents: 262,
        accidentDetails: { total: 262 },
        severity: { total: 262, bySev: { "1": 2, "2": 30, "3": 230 } }
      }
    };
  }

  test('docDefinition.styles exposes the canonical style names', async () => {
    const def = await runPdfExport(makeCtx(), makeReportData(), { includeMap: false });
    const s = def.styles;
    expect(s).toBeDefined();
    for (const name of [
      'title', 'sectionHeader', 'subsectionHeader',
      'body', 'lead', 'caption', 'noteBox'
    ]) {
      expect(s[name]).toBeDefined();
      expect(typeof s[name].fontSize).toBe('number');
    }
    // Specific shape requirements from the spec.
    expect(s.title.bold).toBe(true);
    expect(s.sectionHeader.bold).toBe(true);
    expect(s.subsectionHeader.bold).toBe(true);
    expect(s.lead.bold).toBe(true);
    expect(s.caption.italics).toBe(true);
  });

  test('Hinweis-zur-Zählweise renders as a noteBox table with light-gray fill', async () => {
    const def = await runPdfExport(makeCtx(), makeReportData(), { includeMap: false });
    const cells = collectFillColorCells(def.content);
    const hinweisCell = cells.find(c => /Hinweis zur Zählweise:/.test(JSON.stringify(c)));
    expect(hinweisCell).toBeDefined();
    // Light-gray background per spec.
    expect(hinweisCell.fillColor).toMatch(/^#[A-Fa-f0-9]{6}$/);
    expect(hinweisCell.fillColor.toUpperCase()).not.toBe('#FFFFFF');
    // Padding via cell margin (spec: 6–8).
    expect(Array.isArray(hinweisCell.margin)).toBe(true);
  });

  test('numbered figure captions use the canonical "caption" style', async () => {
    // Stub the map capture helpers so includeMap:true succeeds without a real map.
    const PNG_DATAURL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
    UA.captureExportMapImage = jest.fn(async () => PNG_DATAURL);
    UA._captureClusterMaps = jest.fn(async () => []);
    const ctx = makeCtx({
      map: {
        getCenter: () => ({ lat: 52.37, lng: 9.73 }),
        getZoom: () => 14,
        setView: () => {}
      }
    });

    const def = await runPdfExport(ctx, makeReportData(), { includeMap: true });
    const styled = collectStyledNodes(def.content);
    const captionNodes = styled.filter(n => n.style === 'caption');
    expect(captionNodes.length).toBeGreaterThanOrEqual(1);
    // Every caption node carries an "Abbildung N: " text payload.
    for (const c of captionNodes) {
      const txt = typeof c.text === 'string' ? c.text : JSON.stringify(c.text);
      expect(txt).toMatch(/^Abbildung \d+: /);
    }
  });

  test('explanatory lead-in paragraph appears before the first figure caption', async () => {
    const PNG_DATAURL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
    UA.captureExportMapImage = jest.fn(async () => PNG_DATAURL);
    UA._captureClusterMaps = jest.fn(async () => []);
    const ctx = makeCtx({
      map: { getCenter: () => ({ lat: 52.37, lng: 9.73 }), getZoom: () => 14, setView: () => {} }
    });
    const def = await runPdfExport(ctx, makeReportData(), { includeMap: true });
    const texts = collectTexts(def.content).map(String);
    const leadIdx = texts.findIndex(t => /Detail- und Clusteransichten sind Teilmengen der Gesamtansicht/.test(t));
    const firstCaptionIdx = texts.findIndex(t => /^Abbildung 1: /.test(t));
    expect(leadIdx).toBeGreaterThan(-1);
    expect(firstCaptionIdx).toBeGreaterThan(-1);
    expect(leadIdx).toBeLessThan(firstCaptionIdx);
  });

  test('detail and cluster captions reference the parent count from Abbildung 1', async () => {
    const PNG_DATAURL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
    UA.captureExportMapImage = jest.fn(async () => PNG_DATAURL);
    UA._captureDetailMap = jest.fn(async () => PNG_DATAURL);
    UA._captureClusterMaps = jest.fn(async () => [{
      label: 'Hauptcluster',
      image: PNG_DATAURL,
      total: 5,
      lat: 52.37, lon: 9.73, zoom: 18,
      bounds: { south: 52.365, west: 9.725, north: 52.375, east: 9.735 },
      points: [
        { lat: 52.37, lon: 9.73 }, { lat: 52.371, lon: 9.731 },
        { lat: 52.372, lon: 9.732 }, { lat: 52.373, lon: 9.733 },
        { lat: 52.374, lon: 9.734 }
      ]
    }]);
    // Provide a fake selectionBounds to trigger the detail-map branch.
    const sw = { lat: 52.36, lng: 9.72 };
    const ne = { lat: 52.38, lng: 9.74 };
    const selectionBounds = {
      getSouth: () => sw.lat, getWest: () => sw.lng,
      getNorth: () => ne.lat, getEast: () => ne.lng,
      getSouthWest: () => sw,
      getNorthEast: () => ne,
      getCenter: () => ({ lat: 52.37, lng: 9.73 }),
      contains: () => true
    };
    const viewportPts = Array.from({ length: 32 }, (_, i) => ({
      lat: 52.37 + i * 0.00001, lon: 9.73 + i * 0.00001
    }));

    const ctx = makeCtx({
      map: { getCenter: () => ({ lat: 52.37, lng: 9.73 }), getZoom: () => 14, setView: () => {} },
      selectionBounds,
      viewportPts
    });
    const reportData = {
      text: 'Stadt: Hannover\n\n',
      structured: {
        meta: { gremium: { typ: 'BV' } },
        totalAccidents: 262,
        accidentDetails: { total: 262 },
        severity: { total: 262, bySev: { "1": 2, "2": 30, "3": 230 } }
      }
    };

    const def = await runPdfExport(ctx, reportData, { includeMap: true });
    const texts = collectTexts(def.content).map(String);
    const captionTexts = texts.filter(t => /^Abbildung \d+: /.test(t));
    // Both detail (Abbildung 2) and cluster (Abbildung 3) captions should
    // carry the subset cross-reference to Abbildung 1's parent count (262).
    const subsetCaptions = captionTexts.filter(t => /Teilmenge der 262 Unfälle aus Abbildung 1\.$/.test(t));
    expect(subsetCaptions.length).toBeGreaterThanOrEqual(2);
    // And one of them must explicitly carry the detail count "Die 32 …".
    expect(subsetCaptions.some(t => /Die 32 dargestellten Unfälle/.test(t))).toBe(true);
    // And one must carry the cluster count "Die 5 …".
    expect(subsetCaptions.some(t => /Die 5 dargestellten Unfälle/.test(t))).toBe(true);
  });
});
