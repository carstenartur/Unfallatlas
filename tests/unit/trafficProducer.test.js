'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const traffic = require('../../scripts/producers/traffic_producer.js');

function makeTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-prod-'));
}

describe('traffic_producer qualitative OSM fallback', () => {
  test('slugging matches the shared producer convention', () => {
    expect(traffic.slugCity('Bonn')).toBe('bonn');
    expect(traffic.slugCity('Düsseldorf')).toBe('duesseldorf');
  });

  test('maps road functions to qualitative classes without DTV values', () => {
    expect(traffic.proxyClassFromHighway('motorway')).toBe('very_high');
    expect(traffic.proxyClassFromHighway('primary')).toBe('high');
    expect(traffic.proxyClassFromHighway('tertiary')).toBe('medium');
    expect(traffic.proxyClassFromHighway('residential')).toBe('low');
    expect(traffic.proxyClassFromHighway('PRIMARY')).toBe('high');
    expect(traffic.proxyClassFromHighway('unknown')).toBeUndefined();
  });

  test('dataset explicitly identifies a proxy and forbids numeric traffic fields', () => {
    const dataset = traffic.buildTrafficDataset({
      '1': { highway: 'residential' },
      '2': { highway: 'primary' },
      '3': { highway: 'unknown_class' },
    }, { extractDate: '2026-05-07' });

    expect(dataset).toEqual(expect.objectContaining({
      schemaVersion: 2,
      measurementType: 'proxy',
      source: 'OSM-highway-class-proxy',
      datasetVersion: traffic.PRODUCER_VERSION,
      producerVersion: traffic.PRODUCER_VERSION,
      extractDate: '2026-05-07',
    }));
    expect(Object.keys(dataset.ways).sort()).toEqual(['1', '2']);
    expect(dataset.ways['1']).toEqual(expect.objectContaining({
      measurementType: 'proxy',
      proxyClass: 'low',
      highwayClass: 'residential',
      confidence: 'low',
    }));
    expect(dataset.ways['2'].proxyClass).toBe('high');
    for (const observation of Object.values(dataset.ways)) {
      expect(observation).not.toHaveProperty('value');
      expect(observation).not.toHaveProperty('unit');
      expect(observation).not.toHaveProperty('year');
      expect(observation.qualityNotes.join(' ')).toMatch(/kein gemessener|kein.*Verkehrswert/i);
    }
    expect(JSON.stringify(dataset)).not.toMatch(/"DTV"|vehicles\/day/i);
  });

  test('supports a licensed-provider pilot mapping without changing proxy semantics', () => {
    const dataset = traffic.buildTrafficDataset({ '1': { highway: 'residential' } }, {
      source: 'Fixture qualitative road exposure',
      datasetVersion: 'fixture-1',
      proxyClassLookup: () => 'medium',
      confidence: 'medium',
    });
    expect(dataset.source).toBe('Fixture qualitative road exposure');
    expect(dataset.datasetVersion).toBe('fixture-1');
    expect(dataset.producerVersion).toBe(traffic.PRODUCER_VERSION);
    expect(dataset.ways['1']).toEqual(expect.objectContaining({
      measurementType: 'proxy',
      proxyClass: 'medium',
      confidence: 'medium',
    }));
    expect(dataset.ways['1']).not.toHaveProperty('value');
  });

  test('readOsmWays handles valid, missing and invalid caches', () => {
    const root = makeTemp();
    try {
      fs.writeFileSync(path.join(root, 'osm_bonn.json'), JSON.stringify({
        ways: { '1': { highway: 'residential' } },
      }));
      expect(traffic.readOsmWays(root, 'bonn')).toEqual({ '1': { highway: 'residential' } });
      expect(traffic.readOsmWays(root, 'missing')).toBeNull();
      fs.writeFileSync(path.join(root, 'osm_invalid.json'), '{broken');
      expect(traffic.readOsmWays(root, 'invalid')).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('produceCity writes a typed qualitative dataset', () => {
    const root = makeTemp();
    const osmDir = path.join(root, 'osm');
    const outDir = path.join(root, 'traffic');
    fs.mkdirSync(osmDir, { recursive: true });
    fs.writeFileSync(path.join(osmDir, 'osm_bonn.json'), JSON.stringify({
      ways: {
        '100': { highway: 'residential' },
        '200': { highway: 'primary' },
      },
    }));
    try {
      const result = traffic.produceCity(root, 'bonn', { outDir, osmDir });
      expect(result.skipped).toBe(false);
      expect(result.counts).toEqual({ candidateWays: 2, taggedWays: 2 });
      const written = JSON.parse(fs.readFileSync(path.join(outDir, 'traffic_bonn.json'), 'utf8'));
      expect(written.ways['100'].proxyClass).toBe('low');
      expect(written.ways['200'].proxyClass).toBe('high');
      expect(written.ways['100']).not.toHaveProperty('value');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('resume skips and force replaces an existing city dataset', () => {
    const root = makeTemp();
    const osmDir = path.join(root, 'osm');
    const outDir = path.join(root, 'traffic');
    fs.mkdirSync(osmDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(osmDir, 'osm_bonn.json'), JSON.stringify({
      ways: { '100': { highway: 'residential' } },
    }));
    fs.writeFileSync(path.join(outDir, 'traffic_bonn.json'), '{"sentinel":true}');
    try {
      expect(traffic.produceCity(root, 'bonn', { outDir, osmDir }).skipped).toBe(true);
      const forced = traffic.produceCity(root, 'bonn', { outDir, osmDir, force: true });
      expect(forced.skipped).toBe(false);
      const written = JSON.parse(fs.readFileSync(path.join(outDir, 'traffic_bonn.json'), 'utf8'));
      expect(written.sentinel).toBeUndefined();
      expect(written.ways['100'].proxyClass).toBe('low');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('parseArgs keeps the CLI deterministic and has no numeric-year option', () => {
    const previousOut = process.env.ENRICH_TRAFFIC_DATA_DIR;
    const previousOsm = process.env.ENRICH_OSM_DATA_DIR;
    process.env.ENRICH_TRAFFIC_DATA_DIR = '/tmp/t';
    process.env.ENRICH_OSM_DATA_DIR = '/tmp/o';
    try {
      const options = traffic.parseArgs(['--city', 'Bonn', '--force']);
      expect(options.cities).toEqual(['Bonn']);
      expect(options.outDir).toBe('/tmp/t');
      expect(options.osmDir).toBe('/tmp/o');
      expect(options.force).toBe(true);
      expect(options).not.toHaveProperty('year');
    } finally {
      if (previousOut === undefined) delete process.env.ENRICH_TRAFFIC_DATA_DIR;
      else process.env.ENRICH_TRAFFIC_DATA_DIR = previousOut;
      if (previousOsm === undefined) delete process.env.ENRICH_OSM_DATA_DIR;
      else process.env.ENRICH_OSM_DATA_DIR = previousOsm;
    }
  });
});
