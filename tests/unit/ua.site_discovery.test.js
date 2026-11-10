const fs = require('node:fs');
const path = require('node:path');

require('../../js/ua.data_paths.js');
require('../../js/ua.spatial-grid.js');
require('../../js/ua.site_discovery.js');
const discovery = window.UA.SiteDiscovery;

function point(id, lat, lon, props = {}) {
  return {
    lat, lon,
    props: { id, year: 2023, ukategorie: '3', utyp1: '2', istrad: '1', istpkw: '1', ...props },
  };
}

describe('site discovery', () => {
  test('uses the same cells and local road segments when order, filters and map rendering change', () => {
    const site = {
      id: 'square', label: 'Platz',
      bounds: { south: 52.36595, west: 9.74995, north: 52.36605, east: 9.75005 },
      changes: [{ label: 'Belegt', url: 'https://www.hannover.de/', date: '2024-08-21', precision: 'documented-by' }],
    };
    const anchor = point('anchor', 52.366, 9.75, { matched_way_id: '80' });
    const nearA = point('nearA', 52.3662, 9.75, { matched_way_id: '80' });
    const nearB = point('nearB', 52.3663, 9.7501, { matched_way_id: '80', year: 2025 });
    const otherRoad = point('otherRoad', 52.3663, 9.7501, { matched_way_id: '81' });
    const far = point('far', 52.376, 9.75, { matched_way_id: '80' });
    const unmatched = point('unmatched', 52.3662, 9.75);
    const points = [anchor, nearA, nearB, otherRoad, far, unmatched];
    const rows = discovery.candidates(points, {}, [site]);
    expect(rows).toHaveLength(5);
    expect(rows.find(row => row.kind === 'site')).toMatchObject({
      id: 'square', label: 'Platz', bounds: site.bounds, changes: site.changes, points: [anchor],
    });
    const nearbySegment = rows.find(row => row.id.startsWith('segment:80:') && row.points.includes(nearB));
    expect(nearbySegment).toMatchObject({ kind: 'segment', count: 4 });
    expect(nearbySegment.points).toEqual(expect.arrayContaining([nearA, nearB, otherRoad, unmatched]));
    expect(rows.find(row => row.kind === 'cell')).toMatchObject({
      kind: 'cell', label: expect.stringContaining('Suchzelle'),
    });
    const scopedRows = discovery.candidates(points.slice().reverse(), {
      fromYear: 2025, zoom: 9, maxPoints: 1,
    }, [site]);
    expect(scopedRows.find(row => row.id === nearbySegment.id)).toEqual({
      ...nearbySegment, points: [nearB], count: 1, pattern: null,
    });
  });

  test('scopes inclusively by year, severity and the turning/crossing codes', () => {
    const oldest = point('old', 52.36, 9.75, { year: 2021, ukategorie: '1' });
    const start = point('start', 52.36, 9.75, { year: undefined, ujahr: '2022', ukategorie: '2', utyp1: 2 });
    const end = point('end', 52.36, 9.75, { year: '', UJAHR: 2024, ukategorie: '1', utyp1: '3' });
    const light = point('light', 52.36, 9.75, { year: 2023 });
    const otherType = point('other', 52.36, 9.75, { year: 2023, ukategorie: '2', utyp1: 4 });
    const undated = point('unknown', 52.36, 9.75, { year: '', ukategorie: '2' });
    const points = [oldest, start, end, light, otherType, undated];
    expect(discovery.filterPoints(points, { fromYear: '2022', toYear: 2024, severity: 'serious', type: 'turning' }))
      .toEqual([start, end]);
    expect(discovery.filterPoints(points, { severity: 2, type: 4 })).toEqual([otherType]);
    expect(discovery.filterPoints(points, { toYear: 2022 })).toEqual([oldest, start]);
    expect(discovery.filterPoints(points, { fromYear: 2025, toYear: 2020 })).toEqual([]);
    expect(discovery.candidates(points, { fromYear: 2022, toYear: 2024, type: 'turning' })[0])
      .toMatchObject({ count: 3, severeCount: 2 });
  });

  test('focuses the exact involvement and uses only its latest year', () => {
    const first = point('18', 52.36, 9.75, { year: undefined, ujahr: 2023, utyp1: '3' });
    const second = point('18', 52.36, 9.75, { year: undefined, UJAHR: 2025, utyp1: '2' });
    const third = point('19', 52.36, 9.75, { year: 2025, utyp1: '3' });
    const extraMode = point('extra', 52.36, 9.75, { year: 2025, istfuss: '1' });
    const newerOtherType = point('newer', 52.36, 9.75, { year: 2026, utyp1: '4' });
    const points = [first, second, third, extraMode, newerOtherType];
    expect(discovery.patternForPoints(points)).toMatchObject({
      key: 'turning:5', points: [first, second, third], recentYear: 2025, recentPoints: [second, third],
    });
    expect(discovery.patternForPoints(points, '4:5')).toMatchObject({
      points: [newerOtherType], recentYear: 2026, recentPoints: [newerOtherType],
    });
    expect(discovery.patternForPoints([first, second, extraMode, newerOtherType])).toBeNull();
    expect(discovery.patternForPoints([second, third, point('20', 52.36, 9.75, { year: 2025 })])).toBeNull();
  });

  test('filters for participation in the recorded crash independently of the map filters', () => {
    const bikeAndCar = point('rad', 52.36, 9.75);
    const foot = point('fuss', 52.36, 9.75, { istrad: '0', istfuss: '1' });
    const car = point('pkw', 52.36, 9.75, { istrad: '0' });
    const points = [bikeAndCar, foot, car];
    expect(discovery.filterPoints(points, { involvement: 'bike-foot' })).toEqual([bikeAndCar, foot]);
    expect(discovery.filterPoints(points, { involvement: 'foot' })).toEqual([foot]);
    expect(discovery.candidates(points, { involvement: 'bike' })[0].points).toEqual([bikeAndCar]);
  });

  test('pads coincident or close points without rounding their coordinates', () => {
    const lat = 52.368123456789;
    const lon = 9.740987654321;
    const bounds = discovery.boundsForPoints([{ lat, lon }, { lat, lng: lon }]);
    expect(bounds?.south).toBeLessThan(lat);
    expect(bounds.north).toBeGreaterThan(lat);
    expect(bounds.west).toBeLessThan(lon);
    expect(bounds.east).toBeGreaterThan(lon);
    expect((lat - bounds.south) * 111195).toBeCloseTo(16, 1);
    expect((bounds.east - lon) * 67890).toBeCloseTo(16, 1);
    expect(discovery.boundsForPoints([{ lat, lon }], { paddingMeters: 0 })).toEqual({
      south: lat, west: lon, north: lat, east: lon,
    });
  });

  test('rejects oversized or invalid cluster geometry', () => {
    expect(discovery.boundsForPoints([{ lat: 52.36, lon: 9.75 }, { lat: 52.365, lon: 9.75 }])).toBeNull();
    expect(discovery.boundsForPoints([{ lat: 52.36, lon: 9.75 }, { lat: 52.361, lon: 9.75 }], {
      paddingMeters: 16, maxSpanMeters: 100,
    })).toBeNull();
    expect(discovery.boundsForPoints([{ lat: 52.36, lon: 9.75 }, { lat: Infinity, lon: 9.75 }])).toBeNull();
    expect(discovery.boundsForPoints([])).toBeNull();
  });

  test('loads the verified Hannover bounds and dated source records only for the supported city', async () => {
    const load = window.fetch;
    window.fetch = jest.fn(async url => ({
      ok: true,
      json: async () => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../..', url), 'utf8')),
    }));
    try {
      await expect(discovery.loadSites('Bonn')).resolves.toEqual([]);
      const sites = await discovery.loadSites(' HANNOVER ');
      expect(sites).toHaveLength(3);
      expect(sites[2]).toMatchObject({ label: 'Brühlstraße / Escherstraße', networkSite: {
        id: 'j:60655478', coordinates: [52.3757176, 9.7267899],
      } });
      expect(sites[2].changes.map(change => change.kind)).toContain('council-decision');
      expect(sites[0]).toMatchObject({
        label: expect.stringContaining('Osterstraße'),
        bounds: { south: 52.36770600225075, west: 9.739235043525698, north: 52.3688753291183, east: 9.741144776344301 },
        changes: [{ date: '2024-08-21', precision: 'documented-by', url: expect.stringMatching(/^https:/) }],
      });
      expect(sites[1].changes).toMatchObject([
        { date: '2024-03-01', precision: 'documented-by' },
        { date: '2026-03', precision: 'month' },
      ]);
      window.fetch.mockRejectedValue(new Error('offline'));
      await expect(discovery.loadSites('Hannover')).resolves.toEqual([]);
    } finally {
      window.fetch = load;
    }
  });
});
