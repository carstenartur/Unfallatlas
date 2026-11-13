'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const {buildMobilityDataSources} = require('../../scripts/lib/mobility-data-status');

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobility-data-status-'));
});
afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

function deliver(relativePath, json) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const data = JSON.stringify(json);
  fs.writeFileSync(file, file.endsWith('.gz') ? zlib.gzipSync(data) : data);
}

test('a configured source and a qualitative proxy do not contribute measured accident counts', () => {
  const metaPath = 'out/city.json.gz';
  deliver('out/data-manifest.json', {cities: {hamburg: {enrichment: {metaPath}}}});
  expect(buildMobilityDataSources(root)).toEqual([]);
  const meta = {
    counts: {features: 4400},
    sources: {trafficMatched: {
      source: {sourceId: 'traffic.count.bast-annual-dtv-2023', measurementType: 'count',
        datasetUrl: 'https://data.gov.de', publisher: 'BASt', temporalCoverage: '2023', retrievedAt: '2026-11-12T21:08:30Z',
        distributionUrl: 'https://example.org/bast.csv', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        unit: 'Kfz/24 h', licenseId: 'CC-BY-4.0'},
      coverage: {stationCount: 2000, matchedStations: 1},
    }},
    traffic: {numericValuesPresent: false, classifiedFeatures: 30},
  };
  deliver(metaPath, meta);
  expect(buildMobilityDataSources(root)).toEqual([]);
  meta.traffic = {numericValuesPresent: true, featureTypes: {count: 2, proxy: 30}};
  expect(buildMobilityDataSources(root, {cities: {hamburg: {enrichment: {metaPath}}}}, new Map([['hamburg', meta]]))).toEqual([expect.objectContaining({
    coverage: '2 von 4.400 Unfallpunkten · 2023 · Abruf 2026-11-12',
    description: expect.stringContaining('2.000 Zählstellen'),
    sources: expect.arrayContaining([expect.objectContaining({url: 'https://example.org/bast.csv'})]),
    license: 'CC-BY-4.0',
  })]);
});

test('station totals count distributed hourly directions including zero and keep missing values open', () => {
  const stationFile = 'data/mobility/duesseldorf-mannesmannufer-2024.json.gz';
  deliver(stationFile, {sources: {counts: {}}, hours: {}});
  expect(buildMobilityDataSources(root)).toEqual([]);
  const source = {datasetUrl: 'https://example.org/station', licenseId: 'DL-DE-BY-2.0',
    temporalCoverage: '2024'};
  deliver(stationFile, {
    hours: {'01-01-2024 00:00:00': [0, 3], '01-01-2024 01:00:00': [null, 2]},
    sources: {counts: source, station: {...source, licenseId: 'DL-DE-Zero-2.0'},
      osm: {...source, licenseId: 'ODbL-1.0'}},
  });
  expect(buildMobilityDataSources(root)).toEqual([expect.objectContaining({
    coverage: '2 Stunden mit 3 Richtungswerten · 2024',
    license: 'Stundenwerte DL-DE-BY-2.0, Standort DL-DE-Zero-2.0, Radweg ODbL-1.0',
  })]);
});
