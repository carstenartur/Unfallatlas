'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const producer = require('../../scripts/producers/osm_structure_producer');

function dataset() {
  return {
    source: 'OpenStreetMap (Overpass)',
    producerVersion: '1.2.0',
    extractDate: '2026-07-28',
    coverage: 'full',
    ways: {
      '20': { highway: 'primary', bridge: 'stale', layer: '9' },
      '3': { highway: 'residential', tunnel: 'stale' },
      '11': { highway: 'secondary' },
    },
    wayGeometries: {
      '3': [{ lat: 52.3, lon: 9.7 }, { lat: 52.301, lon: 9.701 }],
      '11': [{ lat: 52.31, lon: 9.71 }, { lat: 52.311, lon: 9.711 }],
      '20': [{ lat: 52.32, lon: 9.72 }, { lat: 52.321, lon: 9.721 }],
    },
    index: [],
  };
}

function response(...elements) {
  return { version: 0.6, elements };
}

describe('OSM structure tag postprocessor', () => {
  const roots = [];

  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
  });

  test('builds a bundled ID query with tags-only output', () => {
    expect(producer.buildOverpassQuery(['3', '11', '20'], { timeoutMs: 61_000 }))
      .toBe('[out:json][timeout:61];\nway(id:3,11,20);\nout tags;');
    expect(() => producer.buildOverpassQuery(['3', '3']))
      .toThrow(/duplicate_way_id/);
    expect(() => producer.buildOverpassQuery(['3', 'abc']))
      .toThrow(/invalid_way_id/);
  });

  test('parses only the reviewed structure fields and preserves meaningful OSM values', () => {
    const records = producer.parseStructureResponse(response(
      { type: 'way', id: 3, tags: { bridge: 'viaduct', layer: '1', name: 'ignored' } },
      { type: 'way', id: 11, tags: { tunnel: 'culvert', layer: '-1', cutting: 'yes' } },
      { type: 'way', id: 20, tags: { bridge: 'no', embankment: 'yes' } },
    ), ['3', '11', '20']);

    expect(records.get('3')).toEqual({ bridge: 'viaduct', layer: '1' });
    expect(records.get('11')).toEqual({ tunnel: 'culvert', layer: '-1', cutting: 'yes' });
    expect(records.get('20')).toEqual({ bridge: 'no', embankment: 'yes' });
  });

  test('fails closed on missing, duplicate, unexpected or non-way response elements', () => {
    expect(() => producer.parseStructureResponse(response(
      { type: 'way', id: 3, tags: {} },
    ), ['3', '11'])).toThrow(/incomplete_way_coverage/);

    expect(() => producer.parseStructureResponse(response(
      { type: 'way', id: 3, tags: {} },
      { type: 'way', id: 3, tags: {} },
    ), ['3'])).toThrow(/duplicate_way_id/);

    expect(() => producer.parseStructureResponse(response(
      { type: 'way', id: 99, tags: {} },
    ), ['3'])).toThrow(/unexpected_way_id/);

    expect(() => producer.parseStructureResponse(response(
      { type: 'node', id: 3, tags: {} },
    ), ['3'])).toThrow(/unexpected_overpass_element/);
  });

  test('replaces stale structural fields and marks exact full coverage', () => {
    const records = new Map([
      ['3', Object.freeze({ tunnel: 'culvert', layer: '-1' })],
      ['11', Object.freeze({})],
      ['20', Object.freeze({ bridge: 'no', embankment: 'yes' })],
    ]);
    const enriched = producer.applyStructureTags(dataset(), records, {
      retrievedAt: '2026-07-28T22:00:00Z',
    });

    expect(enriched.ways['3']).toEqual({
      highway: 'residential',
      tunnel: 'culvert',
      layer: '-1',
    });
    expect(enriched.ways['11']).toEqual({ highway: 'secondary' });
    expect(enriched.ways['20']).toEqual({
      highway: 'primary',
      bridge: 'no',
      embankment: 'yes',
    });
    expect(enriched.structureTags).toEqual(expect.objectContaining({
      schemaVersion: 1,
      producerVersion: producer.PRODUCER_VERSION,
      coverage: 'full',
      wayCount: 3,
      fields: [...producer.STRUCTURE_FIELDS],
      retrievedAt: '2026-07-28T22:00:00.000Z',
      queryFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(dataset().ways['3'].tunnel).toBe('stale');
  });

  test('requires records to cover exactly the existing way table', () => {
    expect(() => producer.applyStructureTags(dataset(), new Map([
      ['3', {}],
      ['11', {}],
    ]))).toThrow(/coverage_mismatch/);
    expect(() => producer.applyStructureTags(dataset(), new Map([
      ['3', {}],
      ['11', {}],
      ['20', {}],
      ['99', {}],
    ]))).toThrow(/coverage_mismatch/);
  });

  test('enriches a file in deterministic batches and publishes it atomically', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-osm-structure-'));
    roots.push(root);
    const file = path.join(root, 'osm_hannover.json');
    fs.writeFileSync(file, JSON.stringify(dataset()));
    const originalHash = producer.sha256File(file);
    const queries = [];
    const sleeps = [];

    const result = await producer.enrichOsmStructureFile({
      inputFile: file,
      batchSize: 2,
      interBatchDelayMs: 7,
      retrievedAt: '2026-07-28T22:00:00Z',
      sleep: async (ms) => sleeps.push(ms),
      fetchOverpass: async (query) => {
        queries.push(query);
        const ids = query.match(/way\(id:([^)]+)\)/)[1].split(',');
        return response(...ids.map((id) => ({
          type: 'way',
          id: Number(id),
          tags: id === '3'
            ? { tunnel: 'yes', layer: '-1' }
            : id === '20'
              ? { bridge: 'viaduct', layer: '1' }
              : {},
        })));
      },
    });

    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain('way(id:3,11)');
    expect(queries[1]).toContain('way(id:20)');
    expect(sleeps).toEqual([7]);
    expect(result).toEqual(expect.objectContaining({
      skipped: false,
      inputFile: file,
      outputFile: file,
      inputSha256: originalHash,
      outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      wayCount: 3,
      batchCount: 2,
    }));
    expect(result.outputSha256).not.toBe(originalHash);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.ways['3']).toEqual({
      highway: 'residential',
      tunnel: 'yes',
      layer: '-1',
    });
    expect(written.ways['20']).toEqual({
      highway: 'primary',
      bridge: 'viaduct',
      layer: '1',
    });
    expect(written.structureTags.coverage).toBe('full');
    expect(fs.readdirSync(root).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  test('skips an already complete file unless force is requested', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-osm-structure-skip-'));
    roots.push(root);
    const file = path.join(root, 'osm_hannover.json');
    const value = dataset();
    value.structureTags = {
      producerVersion: producer.PRODUCER_VERSION,
      coverage: 'full',
    };
    fs.writeFileSync(file, JSON.stringify(value));
    const fetchOverpass = jest.fn();

    const result = await producer.enrichOsmStructureFile({
      inputFile: file,
      fetchOverpass,
    });
    expect(result).toEqual(expect.objectContaining({
      skipped: true,
      reason: 'already complete',
      wayCount: 3,
    }));
    expect(fetchOverpass).not.toHaveBeenCalled();
  });

  test('rejects symlink inputs and malformed way tables', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-osm-structure-safety-'));
    roots.push(root);
    const target = path.join(root, 'target.json');
    const link = path.join(root, 'link.json');
    fs.writeFileSync(target, JSON.stringify(dataset()));
    fs.symlinkSync(target, link);
    expect(() => producer.resolveRegularInput(link)).toThrow(/unsafe_input/);
    expect(() => producer.normalizeWayIds({ ways: { abc: {} } }))
      .toThrow(/invalid_way_id/);
  });
});
