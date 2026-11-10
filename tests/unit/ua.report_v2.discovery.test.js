/** @jest-environment node */

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const evidenceCohort = require('../../js/ua.evidence_cohort');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
const bounds = { south: 52.36770600225075, west: 9.739235043525698, north: 52.3688753291183, east: 9.741144776344301 };
const focusBounds = { south: 52.36785, west: 9.7390, north: 52.36850, east: 9.7402 };
const patternLabel = 'Abbiegen und Einbiegen/Kreuzen (Typ 2/3) · Rad + Pkw';

function point(id, year, lon) {
  return { lat: 52.3681, lon, props: { id, year, ukategorie: '3', utyp1: '2', istrad: '1', istpkw: '1' } };
}

function fixture() {
  const patternPoints = [point('1', 2023, 9.7394), point('2', 2024, 9.7396), point('3', 2025, 9.7398)];
  const other = point('4', 2025, 9.7410);
  other.props.utyp1 = '6';
  const outOfScope = point('5', 2025, 9.7500);
  const points = [...patternPoints, other];
  // The provenance wrapper supplies new point objects to the renderer.
  const frozen = points.map(p => ({ ...p, props: { ...p.props } }));
  let center = { lat: 52.3683, lng: 9.7402 };
  let zoom = 18;
  const map = {
    getCenter: () => center,
    getZoom: () => zoom,
    fitBounds: ([[south, west], [north, east]], options) => {
      center = { lat: (south + north) / 2, lng: (west + east) / 2 };
      zoom = options.maxZoom ?? 19;
    },
    setView: (originalCenter, originalZoom) => { center = originalCenter; zoom = originalZoom; }
  };
  const ctx = {
    CITY_RAW: 'Hannover', map, selectionBounds: bounds, allPts: frozen,
    selectionPts: [outOfScope], viewportPts: [outOfScope],
    exportSourceManifest: { scenario: { bounds } }
  };
  const rows = points.map((p, i) => ({
    displayId: `A00${i + 1}`, mapRef: i < 2 ? 'E1' : 'E2',
    lat: p.lat, lon: p.lon, year: p.props.year, severity: 3
  }));
  const structured = {
    discoveryFocus: {
      key: 'turning:5', label: patternLabel,
      points: [...patternPoints, outOfScope],
      recentYear: 2025, recentPoints: [patternPoints[2], outOfScope],
      query: { fromYear: 2023, toYear: 2025, severity: 'all', type: 'turning', involvement: 'bike' }
    },
    evidenceCohorts: {
      bounds,
      completeEvidenceCohort: { rows },
      detailMapPartitions: [
        { mapRef: 'E1', bounds, accidentIds: ['A001', 'A002'] },
        { mapRef: 'E2', bounds, accidentIds: ['A003', 'A004'] }
      ]
    }
  };
  return { ctx, frozen, report: { text: '', structured } };
}

function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  return [value, ...nodes(value.stack), ...nodes(value.columns), ...nodes(value.text), ...nodes(value.table?.body)];
}

describe('document evidence for a conflict pattern', () => {
  let UA, window, definition, captures;

  beforeEach(() => {
    window = {
      UA: {
        SiteDiscovery: { boundsForPoints: () => focusBounds },
        EvidenceCohort: { ...evidenceCohort, annotateMapImage: async (_window, _ctx, image) => image }
      },
      pdfMake: {
        createPdf: (def) => { definition = def; return { download() {} }; }
      },
      docx: require('docx'),
      saveAs: jest.fn(),
      leafletImage() {},
      location: new URL('http://localhost:8000/')
    };
    eval(fs.readFileSync(path.join(__dirname, '../../js/ua.report_v2.js'), 'utf8'));
    UA = window.UA;
    captures = [];
    UA.captureExportMapImage = async (ctx, options) => {
      captures.push({ ...options, zoom: ctx.map.getZoom() });
      return PNG;
    };
  });

  test('captures the overview and the cropped pattern from frozen points while retaining every numbered case', async () => {
    const { ctx, frozen, report } = fixture();
    await UA.exportToPDF(ctx, report, { includeMap: true });

    expect(captures.map(c => c.exportPoints.length)).toEqual([4, 3, 2, 2]);
    expect(captures[0].exportPoints).toEqual(frozen);
    expect(captures[0].exportBounds).toEqual(bounds);
    expect(captures[1].exportPoints).toEqual(frozen.slice(0, 3));
    expect(captures[1].exportBounds).toEqual(focusBounds);
    expect(captures[1].zoom).toBeGreaterThan(captures[0].zoom);
    expect(captures[1].heatmapExportOpacity).toBe(0);

    const output = nodes(definition.content);
    const text = output.map(node => node.text).filter(value => typeof value === 'string').join('\n');
    expect(text).toMatch(/Abbildung 2:.*Abbiegen und Einbiegen\/Kreuzen/);
    expect(text).toMatch(/3 dargestellten Unfälle.*4 Unfälle aus Abbildung 1/);
    expect(text).toMatch(/2025.*1 Unfall/);
    expect(text).toContain('2023–2025, Unfalltypen 2/3, Radbeteiligung');
    expect(output.filter(node => node.linkToDestination?.startsWith('evidence-map')).map(node => node.linkToDestination))
      .toEqual(['evidence-map-E1', 'evidence-map-E1', 'evidence-map-E2', 'evidence-map-E2']);
    expect(output.filter(node => /^A00[1-4]$/.test(node.text)).map(node => node.text))
      .toEqual(['A001', 'A002', 'A003', 'A004']);
    const [overviewLink, focusLink] = output.filter(node => node.image && node.link)
      .map(node => new URL(node.link).searchParams);
    for (const params of [overviewLink, focusLink]) {
      expect(['selSouth', 'selWest', 'selNorth', 'selEast'].map(key => Number(params.get(key))))
        .toEqual([bounds.south, bounds.west, bounds.north, bounds.east]);
    }
    expect(overviewLink.has('siteFocus')).toBe(false);
    expect(['siteFocus', 'siteFrom', 'siteTo', 'siteSeverity', 'siteType', 'siteInvolvement', 'siteMapFilters'].map(key => focusLink.get(key)))
      .toEqual(['turning:5', '2023', '2025', 'all', 'turning', 'bike', '1']);
  });

  test('uses the automatic pattern on the frozen points for older reports', async () => {
    const { ctx, frozen, report } = fixture();
    const discovered = report.structured.discoveryFocus;
    delete report.structured.discoveryFocus;
    UA.SiteDiscovery.patternForPoints = points => points.every((p, i) => p === frozen[i]) ? discovered : null;

    await UA.exportToPDF(ctx, report, { includeMap: true });

    expect(captures.map(c => c.exportPoints.length)).toEqual([4, 3, 2, 2]);
  });

  test('suppresses the duplicate overview when no focus is selected', async () => {
    const { ctx, report } = fixture();
    report.structured.discoveryFocus = null;
    UA.SiteDiscovery.patternForPoints = () => { throw new Error('An explicit empty focus must be respected'); };

    await UA.exportToPDF(ctx, report, { includeMap: true });

    expect(captures.map(c => c.exportPoints.length)).toEqual([4, 2, 2]);
    expect(nodes(definition.content).filter(node => node.image)).toHaveLength(3);
  });

  test('states a pattern covering the whole scope without repeating its map', async () => {
    const { ctx, frozen, report } = fixture();
    report.structured.discoveryFocus.points = frozen;

    await UA.exportToPDF(ctx, report, { includeMap: true });

    expect(captures.map(c => c.exportPoints.length)).toEqual([4, 2, 2]);
    expect(nodes(definition.content).map(node => node.text)).toContain(
      `Unfallmuster im Auswertungsgebiet – ${patternLabel} (n = 4).`
    );
  });

  test('Word provides the same focus and preserves all numbered cases', async () => {
    const { ctx, report } = fixture();
    await UA.exportToWord(ctx, report, { includeMap: true });
    const [blob] = window.saveAs.mock.calls.at(-1);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await zip.file('word/document.xml').async('string');

    expect(captures.map(c => c.exportPoints.length)).toEqual([4, 3, 2, 2]);
    expect(xml).toContain(patternLabel);
    expect(xml).toMatch(/2025.*1 Unfall/);
    expect(xml).toMatch(/>A001<.*>A002<.*>A003<.*>A004</);
  });

  test('states the date limitation and names nearby facilities with linked sources without capturing maps', async () => {
    const { ctx, report } = fixture();
    report.structured.siteChanges = [
      { label: 'Veränderte Markierung', date: '2025-08-18', precision: 'documented-by', url: 'https://www.hannover.de/markierung' }
    ];
    report.structured.poi = {
      facilities: [{
        name: 'Schule am Wall', type: 'school', relation: 'im Umfeld', reason: 'Nur der Standort ist veröffentlicht.',
        source: { label: 'Städtischer Schulplan', url: 'https://www.hannover.de/schulplan', date: '2024-05-12' }
      }]
    };

    await UA.exportToPDF(ctx, report, { includeMap: false, includePOIs: true });

    expect(captures).toHaveLength(0);
    const output = nodes(definition.content);
    const text = output.map(node => node.text).filter(value => typeof value === 'string').join('\n');
    expect(text).toMatch(/Veränderte Markierung.*spätestens am 18\.08\.2025 dokumentiert/);
    expect(text).toMatch(/Vorher-Nachher-Vergleich.*fehlen/);
    expect(text).toMatch(/Schule am Wall.*im Umfeld/);
    expect(text).toContain('Nur der Standort ist veröffentlicht.');
    expect(text).toContain('12.05.2024');
    expect(output.map(node => node.link)).toEqual(expect.arrayContaining([
      'https://www.hannover.de/markierung', 'https://www.hannover.de/schulplan'
    ]));
  });
});
