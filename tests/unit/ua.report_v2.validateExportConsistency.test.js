/**
 * Unit tests for UA.validateExportConsistency – Pre-Flight-Konsistenz-Gate
 * (Phase 2.2 des PDF/DOCX-Sanierungsplans).
 *
 * Invarianten:
 *   - structured.accidentDetails.total ≤ structured.totalAccidents
 *   - countPointsInBounds(ctx.viewportPts, exportBbox) === structured.totalAccidents
 *
 * Bei Mismatch muss die exakt vom Plan vorgeschriebene deutsche Meldung
 * geliefert werden: „Export abgebrochen: Tabelle (n=X) und Karte (n=Y)
 * inkonsistent."
 */

describe('UA.validateExportConsistency – Pre-Flight-Konsistenz-Gate', () => {
  let UA;

  beforeEach(() => {
    window.UA = {};
    window.leafletImage = () => {};
    window.docx = require('docx');
    const pdfMakeLib = require('pdfmake/build/pdfmake');
    const pdfFonts = require('pdfmake/build/vfs_fonts');
    pdfMakeLib.vfs = pdfFonts;
    window.pdfMake = pdfMakeLib;
    window.saveAs = jest.fn();

    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.resolve(__dirname, '../../js/ua.report_v2.js'), 'utf8');
    eval(src);
    UA = window.UA;
  });

  afterEach(() => {
    delete window.UA;
    delete window.leafletImage;
    delete window.docx;
    delete window.pdfMake;
    delete window.saveAs;
  });

  // ---- helpers --------------------------------------------------------
  function makeCtx(viewportPts, bbox) {
    return {
      viewportPts,
      selectionBounds: bbox && {
        getSouthWest: () => ({ lat: bbox.south, lng: bbox.west }),
        getNorthEast: () => ({ lat: bbox.north, lng: bbox.east })
      }
    };
  }

  // bbox ~ Bonn central
  const BBOX = { south: 50.7, west: 7.0, north: 50.8, east: 7.2 };
  const PT = (lat, lon) => ({ lat, lon });

  // ---- success path ---------------------------------------------------
  describe('green path', () => {
    test('returns ok:true when totalAccidents matches viewport points within bbox', () => {
      const pts = [PT(50.73, 7.10), PT(50.74, 7.11), PT(50.75, 7.12)];
      const ctx = makeCtx(pts, BBOX);
      const structured = {
        totalAccidents: 3,
        severity: { total: 3 },
        accidentDetails: { total: 3 }
      };
      expect(UA.validateExportConsistency(ctx, structured)).toEqual({ ok: true });
    });

    test('tolerates accidentDetails.total ≤ totalAccidents (mask-0 difference)', () => {
      // Realistisches Szenario: severityStats zählt 2 Punkte (inkl. mask=0),
      // accidentDetails listet aber nur den 1 involvement-gefilterten Punkt.
      // viewportPts ist ebenfalls involvement-gefiltert → 1 Punkt → matches
      // accidentDetails.total. Pre-Flight darf das nicht blockieren.
      const pts = [PT(50.73, 7.10)];
      const ctx = makeCtx(pts, BBOX);
      const structured = {
        totalAccidents: 2,
        accidentDetails: { total: 1 }
      };
      expect(UA.validateExportConsistency(ctx, structured)).toEqual({ ok: true });
    });

    test('falls back to severity.total when totalAccidents missing', () => {
      const pts = [PT(50.73, 7.10)];
      const ctx = makeCtx(pts, BBOX);
      const structured = { severity: { total: 1 }, accidentDetails: { total: 1 } };
      expect(UA.validateExportConsistency(ctx, structured)).toEqual({ ok: true });
    });

    test('returns ok:true when no bounds available (defensive)', () => {
      const ctx = { viewportPts: [PT(50.73, 7.10)] };
      const structured = { totalAccidents: 5, accidentDetails: { total: 5 } };
      // No bbox → invariant 2 is skipped, invariant 1 holds.
      expect(UA.validateExportConsistency(ctx, structured).ok).toBe(true);
    });

    test('returns ok:true when ctx.viewportPts missing (defensive)', () => {
      const ctx = {
        selectionBounds: {
          getSouthWest: () => ({ lat: BBOX.south, lng: BBOX.west }),
          getNorthEast: () => ({ lat: BBOX.north, lng: BBOX.east })
        }
      };
      const structured = { totalAccidents: 3, accidentDetails: { total: 3 } };
      expect(UA.validateExportConsistency(ctx, structured).ok).toBe(true);
    });

    test('returns ok:true for empty/null structured', () => {
      expect(UA.validateExportConsistency({}, null).ok).toBe(true);
      expect(UA.validateExportConsistency({}, undefined).ok).toBe(true);
      expect(UA.validateExportConsistency({}, {}).ok).toBe(true);
    });
  });

  // ---- failure path ---------------------------------------------------
  describe('failure path', () => {
    test('rejects when map shows fewer markers than table claims', () => {
      const pts = [PT(50.73, 7.10), PT(50.74, 7.11)]; // 2 markers
      const ctx = makeCtx(pts, BBOX);
      const structured = { totalAccidents: 5, accidentDetails: { total: 5 } };
      const r = UA.validateExportConsistency(ctx, structured);
      expect(r.ok).toBe(false);
      expect(r.kind).toBe('table_map_mismatch');
      expect(r.nTable).toBe(5);
      expect(r.nMap).toBe(2);
      expect(r.message).toBe(
        'Export abgebrochen: Tabelle (n=5) und Karte (n=2) inkonsistent.'
      );
    });

    test('rejects when map shows more markers than table claims', () => {
      const pts = [
        PT(50.73, 7.10), PT(50.74, 7.11), PT(50.75, 7.12), PT(50.76, 7.13)
      ];
      const ctx = makeCtx(pts, BBOX);
      const structured = { totalAccidents: 2, accidentDetails: { total: 2 } };
      const r = UA.validateExportConsistency(ctx, structured);
      expect(r.ok).toBe(false);
      expect(r.message).toBe(
        'Export abgebrochen: Tabelle (n=2) und Karte (n=4) inkonsistent.'
      );
    });

    test('rejects when accidentDetails.total exceeds totalAccidents', () => {
      // Pure invariant-1 check (no bbox needed).
      const ctx = { viewportPts: [] };
      const structured = { totalAccidents: 3, accidentDetails: { total: 7 } };
      const r = UA.validateExportConsistency(ctx, structured);
      expect(r.ok).toBe(false);
      expect(r.kind).toBe('table_exceeds_total');
      expect(r.nTable).toBe(7);
      expect(r.nMap).toBe(3);
      expect(r.message).toMatch(/^Export abgebrochen: Tabelle \(n=7\) und Karte \(n=3\) inkonsistent\.$/);
    });

    test('only counts viewportPts inside the export bbox', () => {
      // 3 in-bounds, 2 outside. accidentDetails.total=3 → must succeed.
      const pts = [
        PT(50.73, 7.10), PT(50.74, 7.11), PT(50.75, 7.12), // in
        PT(60.00, 7.10), PT(50.73, 9.00)                   // out
      ];
      const ctx = makeCtx(pts, BBOX);
      const structured = { totalAccidents: 3, accidentDetails: { total: 3 } };
      expect(UA.validateExportConsistency(ctx, structured)).toEqual({ ok: true });
    });

    test('uses accidentDetails.total as canonical map↔table comparator (Comments 1+2)', () => {
      // Realistic case: severityStats counts ALL non-involvement-filtered
      // points (incl. mask=0) → totalAccidents=5; accidentDetails lists
      // only the 3 involvement-filtered ones; viewportPts mirrors the
      // involvement filter → 3. Pre-Flight must compare against
      // accidentDetails (3==3), NOT totalAccidents (3 !== 5).
      const pts = [PT(50.73, 7.10), PT(50.74, 7.11), PT(50.75, 7.12)];
      const ctx = makeCtx(pts, BBOX);
      const structured = { totalAccidents: 5, accidentDetails: { total: 3 } };
      expect(UA.validateExportConsistency(ctx, structured)).toEqual({ ok: true });
    });

    test('falls back to totalAccidents when accidentDetails missing', () => {
      // Older reports without accidentDetails: keep legacy behaviour.
      const pts = [PT(50.73, 7.10), PT(50.74, 7.11)];
      const ctx = makeCtx(pts, BBOX);
      const structured = { totalAccidents: 2 };
      expect(UA.validateExportConsistency(ctx, structured)).toEqual({ ok: true });
    });
  });

  // ---- API surface ----------------------------------------------------
  test('UA.validateExportConsistency is exposed as a function', () => {
    expect(typeof UA.validateExportConsistency).toBe('function');
  });
});
