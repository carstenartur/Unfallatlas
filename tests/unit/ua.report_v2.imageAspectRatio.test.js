/**
 * Layout-PR „Bildverzerrung beheben" — Regression-Tests für
 * aspektrate-erhaltende Bildskalierung im DOCX/PDF-Export.
 *
 * Vorher: DOCX-Export setzte ImageRun-`transformation` hart auf
 * `{width:600, height:400}`, unabhängig von der Originalgröße der von
 * leaflet-image gelieferten PNGs. Karten wurden gestreckt/gestaucht;
 * Kreise wurden zu Ellipsen, Straßen wirkten verzerrt. Das war ein
 * kritischer Fehler (QA-Befund), kein kosmetisches Feature.
 *
 * Nachher: zentrale Helpers `UA.readPngDimensions` /
 * `UA.fitWithAspectRatio` / `UA.fitImageToMax` lesen die Originalgröße
 * aus dem PNG-IHDR-Chunk und berechnen einen einheitlichen Skalierungs-
 * faktor `min(maxW/origW, maxH/origH)` — width/height werden niemals
 * unabhängig gesetzt. Beide Ausgabeformate nutzen dieselbe Skalierungs-
 * logik und teilen sich einheitliche Max-Boxen (`UA.DOCX_MAP_MAX` und
 * `UA.PDF_MAP_MAX`).
 *
 * Akzeptanz-Schwelle (Spec-Item 7):
 *   abs((after.w / after.h) - (orig.w / orig.h)) < 0.01
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------
// Synthetic PNG generator: produces a valid PNG with a given (width,
// height) IHDR header. The pixel data itself is a single transparent
// pixel — what we test is the header round-trip, not the rendering.
// ---------------------------------------------------------------------
function syntheticPng(width, height) {
  // Build a real PNG: signature + IHDR + IDAT + IEND. We generate a
  // tiny 1×1 image and patch the IHDR width/height fields, leaving the
  // CRC of IHDR re-computed for safety. (The export code only reads
  // IHDR width/height; IDAT contents don't matter for our test.)
  const pngOnePixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
  const buf = Buffer.from(pngOnePixel);
  // IHDR width is at byte offset 16-19, height 20-23 (big-endian uint32).
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  // Re-compute CRC32 over the IHDR chunk (type "IHDR" + 13 data bytes).
  // CRC location: bytes 29-32 (4 bytes after the 13-byte data + 4-byte type).
  const crcInput = buf.subarray(12, 29); // type+data
  buf.writeUInt32BE(crc32(crcInput), 29);
  return 'data:image/png;base64,' + buf.toString('base64');
}

function crc32(buf) {
  let c;
  const table = crc32._table || (crc32._table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

describe('UA.readPngDimensions / UA.fitWithAspectRatio / UA.fitImageToMax', () => {
  let UA;
  beforeEach(() => {
    const win = { UA: {}, location: { href: 'http://localhost/' } };
    const utilsPath = path.resolve(__dirname, '../../js/ua.utils.js');
    (function (window) { eval(fs.readFileSync(utilsPath, 'utf8')); })(win);
    const reportPath = path.resolve(__dirname, '../../js/ua.report_v2.js');
    (function (window) { eval(fs.readFileSync(reportPath, 'utf8')); })(win);
    UA = win.UA;
  });

  test('exposes helpers and constants on UA', () => {
    expect(typeof UA.readPngDimensions).toBe('function');
    expect(typeof UA.fitWithAspectRatio).toBe('function');
    expect(typeof UA.fitImageToMax).toBe('function');
    expect(UA.DOCX_MAP_MAX).toEqual({ width: 600, height: 400 });
    expect(UA.PDF_MAP_MAX).toEqual({ width: 475, height: 340 });
  });

  test('readPngDimensions parses IHDR width/height correctly', () => {
    expect(UA.readPngDimensions(syntheticPng(800, 600))).toEqual({ width: 800, height: 600 });
    expect(UA.readPngDimensions(syntheticPng(1024, 512))).toEqual({ width: 1024, height: 512 });
    // Accepts data URL or raw base64.
    const raw = syntheticPng(120, 80).replace(/^data:image\/png;base64,/, '');
    expect(UA.readPngDimensions(raw)).toEqual({ width: 120, height: 80 });
  });

  test('readPngDimensions throws on non-PNG / empty / short input', () => {
    expect(() => UA.readPngDimensions('')).toThrow();
    expect(() => UA.readPngDimensions(null)).toThrow();
    // 'Hello' base64-encoded is "SGVsbG8=" — clearly not a PNG.
    expect(() => UA.readPngDimensions('SGVsbG8=')).toThrow();
  });

  test('fitWithAspectRatio uses the SAME scale on both axes', () => {
    // Wider-than-tall original bound by width.
    const r1 = UA.fitWithAspectRatio({ width: 1000, height: 500 }, { width: 600, height: 400 });
    expect(r1.width).toBe(600);
    expect(r1.height).toBe(300); // 500 * (600/1000) = 300
    // Taller-than-wide original bound by height.
    const r2 = UA.fitWithAspectRatio({ width: 500, height: 1000 }, { width: 600, height: 400 });
    expect(r2.height).toBe(400);
    expect(r2.width).toBe(200);  // 500 * (400/1000) = 200
    // Square fits diagonally to the smaller of (maxW, maxH).
    const r3 = UA.fitWithAspectRatio({ width: 1000, height: 1000 }, { width: 600, height: 400 });
    expect(r3.width).toBe(400);
    expect(r3.height).toBe(400);
  });

  test('fitWithAspectRatio: aspect ratio preserved within tolerance', () => {
    const cases = [
      { orig: { width: 800, height: 600 } },
      { orig: { width: 1024, height: 512 } },
      { orig: { width: 1280, height: 720 } },
      { orig: { width: 640, height: 480 } },
      { orig: { width: 500, height: 1000 } },
      { orig: { width: 1000, height: 333 } }
    ];
    for (const { orig } of cases) {
      const out = UA.fitWithAspectRatio(orig, UA.DOCX_MAP_MAX);
      const before = orig.width / orig.height;
      const after  = out.width / out.height;
      // Spec-Item 7: |after - before| < 0.01.
      expect(Math.abs(after - before)).toBeLessThan(UA.ASPECT_TOLERANCE);
    }
  });

  test('fitImageToMax falls back to max-box ratio (not raw dimensions) when PNG header cannot be parsed', () => {
    // The new semantically-correct behaviour: the fallback uses
    // fitWithAspectRatio({ratio*1000, 1000}, max) rather than returning
    // {max.width, max.height} directly.  For DOCX_MAP_MAX (600×400, ratio
    // 1.5) and PDF_MAP_MAX (475×340, ratio ≈1.397) the result is
    // mathematically identical to the old literal {max.width, max.height}
    // because fitting a box at its own ratio into itself gives exactly the
    // box dimensions.  The test therefore continues to expect the same
    // numeric values — but the underlying logic is now ratio-based and
    // will correctly preserve aspect ratio for arbitrary max boxes.
    expect(UA.fitImageToMax('SGVsbG8=', UA.DOCX_MAP_MAX)).toEqual({ width: 600, height: 400 });
    expect(UA.fitImageToMax('', UA.PDF_MAP_MAX)).toEqual({ width: 475, height: 340 });
  });

  test('fitImageToMax with strict:true throws when PNG header cannot be parsed', () => {
    expect(() => UA.fitImageToMax('SGVsbG8=', UA.DOCX_MAP_MAX, { strict: true })).toThrow();
    expect(() => UA.fitImageToMax('', UA.PDF_MAP_MAX, { strict: true })).toThrow();
  });

  test('fitImageToMax with fallbackRatio: 16/9 produces correct ratio within tolerance', () => {
    const result = UA.fitImageToMax('SGVsbG8=', UA.DOCX_MAP_MAX, { fallbackRatio: 16 / 9 });
    const expectedRatio = 16 / 9;
    const actualRatio = result.width / result.height;
    expect(Math.abs(actualRatio - expectedRatio)).toBeLessThan(UA.ASPECT_TOLERANCE);
    // Both axes must fit within the max box.
    expect(result.width).toBeLessThanOrEqual(UA.DOCX_MAP_MAX.width);
    expect(result.height).toBeLessThanOrEqual(UA.DOCX_MAP_MAX.height);
  });
});

// ---------------------------------------------------------------------
// Integration: DOCX/PDF map sections preserve aspect ratio of stubbed
// PNGs and use the unified Max-Box across all map types.
// ---------------------------------------------------------------------
describe('DOCX/PDF export: aspect-ratio regression', () => {
  let UA;
  beforeEach(() => {
    const pdfMakeLib = require('pdfmake/build/pdfmake');
    const pdfFonts = require('pdfmake/build/vfs_fonts');
    pdfMakeLib.vfs = pdfFonts;
    window.UA = {};
    window.docx = require('docx');
    window.pdfMake = pdfMakeLib;
    window.saveAs = jest.fn();
    eval(fs.readFileSync(path.resolve(__dirname, '../../js/ua.report_v2.js'), 'utf8'));
    UA = window.UA;
  });
  afterEach(() => {
    delete window.UA;
    delete window.docx;
    delete window.pdfMake;
    delete window.saveAs;
    jest.restoreAllMocks();
  });

  function makeFixtureCtx() {
    const sb = {
      south: 52.36, west: 9.72, north: 52.38, east: 9.74,
      getSouth: () => 52.36, getWest: () => 9.72, getNorth: () => 52.38, getEast: () => 9.74,
      contains: () => true
    };
    return {
      CITY_RAW: 'Hannover',
      map: { getCenter: () => ({ lat: 52.37, lng: 9.73 }), getZoom: () => 14 },
      viewportPts: [],
      selectionBounds: sb
    };
  }
  const fixtureReport = {
    text: '',
    structured: {
      meta: { city: 'Hannover', date: '01.01.2026' },
      severity: { total: 0, bySev: {} }
    }
  };

  test('PDF: every map uses fit:[PDF_MAP_MAX.width, PDF_MAP_MAX.height]', async () => {
    const overviewPng = syntheticPng(1024, 512);
    const detailPng   = syntheticPng(800, 800);
    const clusterPng  = syntheticPng(640, 480);
    UA._captureExportMapImage = async () => overviewPng;
    UA.captureExportMapImage = UA._captureExportMapImage; // public alias
    UA._captureDetailMap = async () => detailPng;
    UA._captureClusterMaps = async () => [{
      image: clusterPng,
      bounds: { south: 52.36, west: 9.72, north: 52.38, east: 9.74 },
      total: 0, points: [], label: 'Cluster A', zoom: 18, lat: 52.37, lon: 9.73
    }];

    let captured;
    const realCreatePdf = window.pdfMake.createPdf.bind(window.pdfMake);
    jest.spyOn(window.pdfMake, 'createPdf').mockImplementation((def) => {
      captured = def;
      const doc = realCreatePdf(def);
      doc.download = jest.fn();
      return doc;
    });

    await UA.exportToPDF(makeFixtureCtx(), fixtureReport, { _skipQAGate: true, includeMap: true });

    // Walk the docDefinition tree and collect every `image` node.
    const images = [];
    (function walk(node) {
      if (!node) return;
      if (Array.isArray(node)) { for (const n of node) walk(n); return; }
      if (typeof node !== 'object') return;
      if (typeof node.image === 'string') images.push(node);
      if (Array.isArray(node.stack)) walk(node.stack);
      if (Array.isArray(node.columns)) walk(node.columns);
      if (node.table && Array.isArray(node.table.body)) {
        for (const row of node.table.body) for (const cell of row) walk(cell);
      }
    })(captured.content);

    // Drei Karten erwartet: Übersicht, Detail, Cluster.
    expect(images.length).toBe(3);
    for (const img of images) {
      expect(img.fit).toEqual([UA.PDF_MAP_MAX.width, UA.PDF_MAP_MAX.height]);
    }
  });

  test('PDF: image and caption rendered as unbreakable stack (block stays together)', async () => {
    UA._captureExportMapImage = async () => syntheticPng(1024, 512);
    UA.captureExportMapImage = UA._captureExportMapImage;
    UA._captureDetailMap = async () => syntheticPng(800, 800);
    UA._captureClusterMaps = async () => [];

    let captured;
    const realCreatePdf = window.pdfMake.createPdf.bind(window.pdfMake);
    jest.spyOn(window.pdfMake, 'createPdf').mockImplementation((def) => {
      captured = def;
      const doc = realCreatePdf(def);
      doc.download = jest.fn();
      return doc;
    });

    await UA.exportToPDF(makeFixtureCtx(), fixtureReport, { _skipQAGate: true, includeMap: true });

    const unbreakableStacks = captured.content.filter(
      n => n && typeof n === 'object' && n.unbreakable === true && Array.isArray(n.stack)
    );
    // Mindestens 2 — Übersicht + Detail; Cluster wäre zusätzlich, ist hier leer.
    expect(unbreakableStacks.length).toBeGreaterThanOrEqual(2);
    // Jeder Stack enthält Bild UND Caption.
    for (const s of unbreakableStacks) {
      const hasImage   = s.stack.some(n => n && typeof n.image === 'string');
      const hasCaption = s.stack.some(n => n && typeof n.text === 'string' && /Abbildung\s*\d+:/.test(n.text));
      expect(hasImage).toBe(true);
      expect(hasCaption).toBe(true);
    }
  });

  test('DOCX: ImageRun.transformation preserves PNG aspect ratio for all map types', async () => {
    const cases = [
      { name: 'overview', png: syntheticPng(1024, 512) },  // 2:1 wide
      { name: 'detail',   png: syntheticPng(800, 1000) },  // 4:5 tall
      { name: 'cluster',  png: syntheticPng(640, 480) }    // 4:3 standard
    ];
    UA._captureExportMapImage = async () => cases[0].png;
    UA.captureExportMapImage = UA._captureExportMapImage;
    UA._captureDetailMap = async () => cases[1].png;
    UA._captureClusterMaps = async () => [{
      image: cases[2].png,
      bounds: { south: 52.36, west: 9.72, north: 52.38, east: 9.74 },
      total: 0, points: [], label: 'Cluster A', zoom: 18, lat: 52.37, lon: 9.73
    }];

    // Capture the docx Document by intercepting Packer.toBlob — we
    // instead read the transformation values out of the constructor calls
    // by spying on docx.ImageRun.
    const docx = require('docx');
    const transformations = [];
    const OrigImageRun = docx.ImageRun;
    jest.spyOn(docx, 'ImageRun').mockImplementation(function (opts) {
      if (opts && opts.transformation) transformations.push(opts.transformation);
      return new OrigImageRun(opts);
    });

    await UA.exportToWord(makeFixtureCtx(), fixtureReport, { includeMap: true });

    expect(transformations.length).toBe(3);
    for (let i = 0; i < cases.length; i++) {
      const before = UA.readPngDimensions(cases[i].png);
      const after  = transformations[i];
      const beforeRatio = before.width / before.height;
      const afterRatio  = after.width  / after.height;
      // Spec-Item 7: |after - before| < ASPECT_TOLERANCE.
      expect(Math.abs(afterRatio - beforeRatio)).toBeLessThan(UA.ASPECT_TOLERANCE);
      // Both axes must be within the unified DOCX_MAP_MAX box.
      expect(after.width).toBeLessThanOrEqual(UA.DOCX_MAP_MAX.width);
      expect(after.height).toBeLessThanOrEqual(UA.DOCX_MAP_MAX.height);
      // At least one axis must hit the box (i.e. the image is scaled to fit).
      expect(
        after.width === UA.DOCX_MAP_MAX.width || after.height === UA.DOCX_MAP_MAX.height
      ).toBe(true);
    }
  });

  test('DOCX: image paragraph carries keepNext (Bild + Caption als Einheit)', async () => {
    UA._captureExportMapImage = async () => syntheticPng(1024, 512);
    UA.captureExportMapImage = UA._captureExportMapImage;
    UA._captureDetailMap = async () => syntheticPng(800, 800);
    UA._captureClusterMaps = async () => [];

    const docx = require('docx');
    const paragraphProps = [];
    const OrigParagraph = docx.Paragraph;
    jest.spyOn(docx, 'Paragraph').mockImplementation(function (opts) {
      paragraphProps.push(opts || {});
      return new OrigParagraph(opts);
    });

    await UA.exportToWord(makeFixtureCtx(), fixtureReport, { includeMap: true });

    // Find paragraphs that contain an ImageRun child — they must have
    // keepNext: true so the following caption is glued to the image.
    const imageParagraphs = paragraphProps.filter(p =>
      Array.isArray(p.children) && p.children.some(c => c && c.constructor && c.constructor.name === 'ImageRun')
    );
    expect(imageParagraphs.length).toBeGreaterThanOrEqual(2);
    for (const p of imageParagraphs) {
      expect(p.keepNext).toBe(true);
    }
  });
});
