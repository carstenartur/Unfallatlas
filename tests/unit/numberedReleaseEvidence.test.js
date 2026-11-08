/** @jest-environment node */
'use strict';

const qa = require('../../scripts/qa-numbered-appendix-rendered');
const word = (text, x, y) => ({
  text,
  xMin: x,
  yMin: y,
  xMax: x + text.length * 4,
  yMax: y + 10
});
const headers = ['ID', 'Jahr', 'Schwere', 'Beteiligte', 'Zeit', 'Zustand', 'Rolle', 'Karte'];
const row = {
  displayId: 'A001',
  year: 2020,
  severityLabel: 'Leichtverletzt',
  involvementLabel: 'Rad',
  hour: 12,
  roadConditionLabel: 'trocken',
  discoveryMatch: true,
  mapRef: 'E1'
};
function model() {
  return {
    pages: [{
      number: 1,
      words: [...headers.map((h, i) => word(h, 30 + i * 85, 30)), ...['A001', '2020', 'Leichtverletzt', 'Rad', '12:00', 'trocken', 'Suchmuster', 'E1'].map((h, i) => word(h, 30 + i * 85, 55))],
      tableRows: []
    }]
  };
}
test('reconstructs all eight final table cells and rejects lost or duplicate evidence rows', () => {
  expect(qa.reconstructAppendixTables(model(), [row], {
    requirePagination: false
  }).ids).toEqual(['A001']);
  const broken = model();
  broken.pages[0].words = broken.pages[0].words.filter(w => w.text !== '2020');
  expect(() => qa.reconstructAppendixTables(broken, [row], {
    requirePagination: false
  })).toThrow();
  const duplicated = model();
  duplicated.pages.push({
    ...duplicated.pages[0],
    number: 2
  });
  expect(() => qa.reconstructAppendixTables(duplicated, [row])).toThrow(/duplicate/i);
});
test('exact map, CSV and GeoJSON ID correspondence rejects omissions and extras', () => {
  const ids = ['A001', 'A002'];
  expect(qa.assertSameIds(ids, ['A002', 'A001'], 'CSV')).toBe(true);
  expect(() => qa.assertSameIds(ids, ['A001'], 'CSV')).toThrow(/CSV/);
  expect(() => qa.assertSameIds(ids, ['A001', 'A001'], 'map')).toThrow(/map/);
});
test('production PDF and Word appendix use a concise clickable map label, never raw URL parameters', async () => {
  const api = require('../../js/ua.evidence_cohort'),
    JSZip = require('jszip');
  const ctx = {
    allPts: [{
      lat: 50.73,
      lon: 7.09,
      props: {
        id: 'real-shape',
        year: 2020,
        ukategorie: '3',
        istrad: '1'
      }
    }],
    filteredAll: [],
    selectionBounds: {
      south: 50.72,
      west: 7.08,
      north: 50.74,
      east: 7.10
    },
    map: {
      fitBounds() {},
      getCenter: () => ({
        lat: 50.73,
        lng: 7.09
      }),
      getZoom: () => 16,
      setView() {}
    }
  };
  const root = {
    location: {
      href: 'https://example.test/werkbank_v2.html?selSouth=50.72'
    },
    setTimeout: fn => {
      fn();
    },
    atob: x => Buffer.from(x, 'base64').toString('binary'),
    docx: require('docx')
  };
  const cohorts = api.buildCohorts({}, ctx, {}, root);
  let definition, blob;
  const UA = {
    captureExportMapImage: async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  };
  root.pdfMake = {
    createPdf: d => {
      definition = d;
      return {
        download() {}
      };
    }
  };
  root.saveAs = b => {
    blob = b;
  };
  await api._internal.exportEvidencePdf(UA, root, ctx, {}, cohorts);
  const link = definition.content.find(x => x.link === cohorts.numberedMapUrl);
  expect(link.text).toBe('Nummerierte interaktive Karte öffnen');
  expect(definition.content.find(x => x.table).fontSize).toBe(9);
  await api._internal.exportEvidenceWord(UA, root, ctx, {}, cohorts);
  const zip = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()));
  const xml = await zip.file('word/document.xml').async('string');
  expect(xml).toContain('Nummerierte interaktive Karte öffnen');
  expect(xml).toContain('w:hyperlink');
  expect(xml).not.toContain('https://');
  expect(xml).toContain('<w:sz w:val="18"/>');
  expect(xml).not.toContain('<w:sz w:val="14"/>');
});
test('left-aligned unequal columns keep long involvement text in its real rendered column', () => {
  const m = model(),
    xs = [34, 82, 126, 200, 308, 359, 430, 524];
  m.pages[0].words = headers.map((h, i) => word(h, xs[i], 30));
  const actual = {
    ...row,
    involvementLabel: 'Güterkraftfahrzeug + Sonstige'
  };
  m.pages[0].words.push(...['A001', '2020', 'Leichtverletzt', 'Güterkraftfahrzeug', '12:00', 'trocken', 'Suchmuster', 'E1'].map((h, i) => word(h, xs[i], 55)), word('+', 260, 55), word('Sonstige', 270, 55));
  expect(qa.reconstructAppendixTables(m, [actual], {
    requirePagination: false
  }).ids).toEqual(['A001']);
});
test('final extracted image pixels must match each role receipt, not only its page image box', async () => {
  const fs = require('fs'),
    os = require('os'),
    path = require('path');
  const {
    createRoleMapFixture
  } = require('../../scripts/release-map-fixture');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-map-pixels-'));
  try {
    const map = createRoleMapFixture({
      role: 'overview',
      points: [{
        id: 'A001',
        lat: 50.73,
        lon: 7.09,
        severity: 3
      }],
      bounds: {
        south: 50.72,
        west: 7.08,
        north: 50.74,
        east: 7.10
      },
      snapshotHash: 'a'.repeat(64)
    });
    const file = path.join(dir, 'map.png');
    fs.writeFileSync(file, map.png);
    const model = {
      pages: [{
        number: 1,
        images: [{
          imageId: file
        }]
      }]
    };
    await expect(qa.verifyRenderedMapPixels(model, {
      expectedMaps: [map.receipt]
    })).resolves.toHaveLength(1);
    const wrong = {
      ...map.receipt,
      pixelSha256: 'b'.repeat(64)
    };
    await expect(qa.verifyRenderedMapPixels(model, {
      expectedMaps: [wrong]
    })).rejects.toThrow(/pixels/i);
  } finally {
    fs.rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});
test('embedded source content cannot pass merely by copying the expected hash property', async () => {
  const loaded = qa.loadRealContext(require('path').resolve(__dirname, '../..'));
  const api = require('../../js/ua.export_provenance'),
    art = require('../../js/ua.artifact_provenance');
  const manifest = await api.createManifest(loaded.ctx, {
    UA: {
      BUILD: 'test-release'
    },
    root: {}
  });
  const expected = await art.normalizeAndHash(manifest);
  await expect(qa.verifyEmbeddedManifest(expected.sha256, JSON.stringify(expected.manifest), expected.sha256, 'DOCX')).resolves.toBe(expected.sha256);
  const tampered = {
    ...expected.manifest,
    scenario: {
      ...expected.manifest.scenario,
      city: 'Hannover'
    }
  };
  await expect(qa.verifyEmbeddedManifest(expected.sha256, JSON.stringify(tampered), expected.sha256, 'DOCX')).rejects.toThrow(/content mismatch/);
});

test('reads one real local acquisition clock and leaves original upstream retrieval unknown', async () => {
  const clock = jest.fn(() => new Date('2027-02-03T04:05:06.789Z'));
  const loaded = qa.loadRealContext(require('path').resolve(__dirname, '../..'), { clock });
  expect(clock).toHaveBeenCalledTimes(1);
  expect(loaded.sourceAcquisition).toEqual({
    kind: 'local-file-read',
    acquiredAt: '2027-02-03T04:05:06.789Z',
    upstreamRetrievedAt: null
  });
  expect(loaded.ctx.dataRetrievedAt).toBe(loaded.sourceAcquisition.acquiredAt);
  const manifest = await require('../../js/ua.export_provenance').createManifest(loaded.ctx, { UA: {}, root: {} });
  expect(manifest.sources.find(s => s.sourceId === 'accidents.de.unfallatlas').retrievedAt)
    .toBe(loaded.sourceAcquisition.acquiredAt);
});

function captionFixture(format) {
  const maps = [
    { role: 'overview', markerCount: 2, accidentIds: ['A001', 'A002'] },
    { role: 'detail-e1', markerCount: 2, accidentIds: ['A001', 'A002'] }
  ];
  const captions = format === 'native-pdf' ? [
    'Abbildung 1: Übersicht – vollständiges Gebietskollektiv; dargestellt und nummeriert: 2 Unfälle.',
    'Abbildung 2: E1; Unfall-IDs: A001, A002.'
  ] : [
    'Abbildung 1: Übersicht – vollständiges Gebietskollektiv; Unfall-IDs: A001, A002.',
    'Abbildung 2: Detail E1 – A001 bis A002; Unfall-IDs: A001, A002.'
  ];
  return {
    contract: { expectedMaps: maps },
    model: { pages: captions.map((text, i) => ({
      number: i + 1,
      images: [{ imageId: `map-${i}`, xMin: 30, xMax: 650, yMin: 20, yMax: 100 }],
      words: text.split(' ').map((t, j) => word(t, 30 + (j % 9) * 60, 110 + Math.floor(j / 9) * 13))
    })) }
  };
}

test.each(['native-pdf', 'docx-pdf'])('independently checks visible %s caption roles, counts and exact IDs below each map', format => {
  const fixture = captionFixture(format);
  const bindings = qa.verifyRenderedMapCaptions(fixture.model, fixture.contract, format);
  expect(bindings).toHaveLength(2);
  expect(bindings[1]).toMatchObject({ role: 'detail-e1', page: 2, accidentIds: ['A001', 'A002'] });
  expect(bindings[1].text).toContain('Unfall-IDs: A001, A002.');
  for (const [pageIndex, from, to] of [[1, 'E1', 'E9'], [1, 'A002.', 'A099.'],
    ...(format === 'native-pdf' ? [[0, '2', '3']] : [[0, 'A002.', 'A099.']])]) {
    const broken = captionFixture(format);
    const token = broken.model.pages[pageIndex].words.find(w => w.text.includes(from));
    token.text = token.text.replace(from, to);
    expect(() => qa.verifyRenderedMapCaptions(broken.model, broken.contract, format)).toThrow(/caption/i);
  }
  const above = captionFixture(format);
  above.model.pages[1].words.forEach(w => { w.yMin -= 100; w.yMax -= 100; });
  expect(() => qa.verifyRenderedMapCaptions(above.model, above.contract, format)).toThrow(/caption/i);
});
