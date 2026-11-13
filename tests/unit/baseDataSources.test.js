'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const { buildBaseDataSources } = require('../../scripts/lib/base-data-sources');

describe('base data source catalogue', () => {
  let site;
  beforeEach(() => {
    site = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-base-sources-'));
    fs.mkdirSync(path.join(site, 'out'));
  });
  afterEach(() => fs.rmSync(site, { recursive: true, force: true }));

  test('sums city records for each delivered family and identifies only OSM-derived traffic classes', () => {
    const cities = [
      { name: 'Alpha', slug: 'alpha', accidents: { present: true, features: 1050, years: [2017] }, poi: { present: true, features: 10 },
        roads: { present: true, source: 'OpenStreetMap (Overpass)' }, traffic: { present: true, source: 'OSM-highway-class-proxy' } },
      { name: 'Beta', slug: 'beta', accidents: { present: true, features: 700, years: [2025] },
        traffic: { present: true, source: 'other-proxy' } },
    ];
    const rows = buildBaseDataSources(site, cities, { cities: {} });
    expect(rows.map(row => row.coverage)).toEqual([
      '1.750 Unfälle · 2 von 2 Städten', '10 POI-Einträge · 1 von 2 Städten',
      '1 von 2 Städten', '1 von 2 Städten',
    ]);
  });

  test('uses shipped profile evidence and keeps the acquisition period separate from publication and retrieval', () => {
    const city = { name: 'Hannover', slug: 'hannover', slope: { present: true }, roads: { present: true } };
    const manifest = { cities: { hannover: { enrichment: { metaPath: 'out/profile.json.gz' } } } };
    const meta = {
      sources: {
        dem: { source: 'SRTM Local Tiles', resolutionM: 30 },
        roadSlope: {
          source: 'Digitales Geländemodell DGM1', sourceId: 'hannover.dgm1',
          datasetUrl: 'https://www.hannover.de/', acquisitionPeriod: 'Laserscannerbefliegung 2010',
          publicationDate: '2024-01-15', retrievedAt: '2026-11-11T09:31:38Z',
          requiredAttribution: 'Bereich Geoinformation – LH Hannover (2026)', windowsMeters: [20, 50],
        },
      },
      roadSlope: { runtimeWayRowsWithUsableGradient: 1234 },
    };
    const file = path.join(site, 'out', 'profile.json.gz');
    fs.writeFileSync(file, gzipSync(JSON.stringify(meta)));
    const rows = buildBaseDataSources(site, [city], manifest);
    expect(rows.map(row => row.label)).toEqual([
      'Geländehöhe und Neigung · Terrain Tiles (Skadi)',
      'Straßenlängsneigung · Digitales Geländemodell DGM1',
    ]);
    expect(rows[1].description).toMatch(/2010.*2024-01-15.*2026-11-11/);
    expect(rows[1].coverage).toContain('1.234');
    expect(rows[1].license).toBe(meta.sources.roadSlope.requiredAttribution);
    meta.roadSlope.runtimeWayRowsWithUsableGradient = 0;
    meta.sources.dem = { source: 'OpenMeteo SRTM', resolutionM: 90 };
    fs.writeFileSync(file, gzipSync(JSON.stringify(meta)));
    const fallback = buildBaseDataSources(site, [city], manifest);
    expect(fallback).toHaveLength(1);
    expect(fallback[0].description).toContain('Copernicus DEM 2021 GLO-90');
  });

  test('lists only active map providers and respects the deployed CARTO configuration', () => {
    const manifest = { cities: {} };
    const catalogue = () => buildBaseDataSources(site, [], manifest).map(row => row.label);
    expect(catalogue()).toEqual([]);
    fs.mkdirSync(path.join(site, 'js'));
    fs.copyFileSync(require.resolve('../../js/ua.map_layer_registry'), path.join(site, 'js', 'ua.map_layer_registry.js'));
    const htmlPath = path.join(site, 'werkbank_v2.html');
    fs.writeFileSync(htmlPath, '<script src="js/ua.map_layer_registry.js"></script>');
    expect(catalogue()).toContain('NRW Orthofoto (DOP)');
    expect(catalogue()).not.toContain('Bonn Orthofoto');
    expect(catalogue()).not.toContain('Beschriftungen & Straßennamen');
    fs.appendFileSync(htmlPath, '<meta name="unfallwerkbank-carto-basemaps-key" content="fixture" />');
    expect(catalogue()).toContain('Beschriftungen & Straßennamen');
  });
});
