'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const producer = require('../../scripts/producers/osm_elevation_context_producer');
const riskProducer = require('../../scripts/producers/osm_elevation_risk_producer');

function rawDataset() {
  return {
    source: 'OpenStreetMap (Overpass)',
    producerVersion: '1.2.0',
    coverage: 'full',
    inputFingerprint: 'f'.repeat(64),
    ways: {
      '3': { highway: 'primary' },
      '11': { highway: 'secondary' },
      '20': { highway: 'residential' },
    },
    wayGeometries: {
      '3': [{ lat: 52.37, lon: 9.72 }, { lat: 52.371, lon: 9.721 }],
      '11': [{ lat: 52.38, lon: 9.73 }, { lat: 52.381, lon: 9.731 }],
      '20': [{ lat: 52.39, lon: 9.74 }, { lat: 52.391, lon: 9.741 }],
    },
    index: [],
  };
}

function writeDataset(root, value = rawDataset()) {
  const file = path.join(root, 'osm_hannover.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function idsFromQuery(query) {
  const match = String(query).match(/way\(id:([^)]+)\)/);
  if (!match) throw new Error(`Unexpected query: ${query}`);
  return match[1].split(',');
}

function successfulFetch(queries) {
  return async (query) => {
    queries.push(query);
    return {
      elements: idsFromQuery(query).map((id) => ({
        type: 'way',
        id: Number(id),
        tags: id === '3'
          ? { bridge: 'viaduct', layer: '1' }
          : id === '11'
            ? { tunnel: 'culvert', layer: '-1' }
            : { embankment: 'dyke', cutting: 'no' },
      })),
    };
  };
}

function transientFiles(root) {
  return fs.readdirSync(root).filter((name) =>
    name.includes('elevation-context-tmp') || name.includes('.backup-'));
}

describe('atomic OSM elevation context producer chain', () => {
  const roots = [];

  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
  });

  test('runs structure coverage and risk derivation on staging before installing one validated file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-osm-elevation-chain-'));
    roots.push(root);
    const file = writeDataset(root);
    const originalSha256 = producer.sha256File(file);
    const queries = [];
    const sleeps = [];

    const result = await producer.prepareOsmElevationContext({
      inputFile: file,
      batchSize: 2,
      interBatchDelayMs: 7,
      retrievedAt: '2026-07-30T16:00:00Z',
      derivedAt: '2026-07-30T16:00:01Z',
      fetchOverpass: successfulFetch(queries),
      sleep: async (milliseconds) => sleeps.push(milliseconds),
    });

    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain('way(id:3,11)');
    expect(queries[1]).toContain('way(id:20)');
    expect(sleeps).toEqual([7]);
    expect(result).toEqual(expect.objectContaining({
      producerVersion: producer.PRODUCER_VERSION,
      skipped: false,
      inputFile: file,
      outputFile: file,
      inputSha256: originalSha256,
      outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      wayCount: 3,
      structureQueryFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceStructureFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      structure: expect.objectContaining({ skipped: false, batchCount: 2 }),
      risk: expect.objectContaining({ skipped: false }),
    }));
    expect(result.outputSha256).not.toBe(originalSha256);

    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.ways['3']).toEqual(expect.objectContaining({
      bridge: 'viaduct',
      elevationRiskTags: expect.objectContaining({ bridge: 'yes', layer: '1' }),
    }));
    expect(written.ways['11'].elevationRiskTags.tunnel).toBe('yes');
    expect(written.ways['20'].elevationRiskTags.embankment).toBe('yes');
    expect(() => riskProducer.validateElevationRiskContract(written)).not.toThrow();
    expect(transientFiles(root)).toEqual([]);
  });

  test('skips without any network access only when the complete per-way contract is current', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-osm-elevation-current-'));
    roots.push(root);
    const file = writeDataset(root);
    await producer.prepareOsmElevationContext({
      inputFile: file,
      retrievedAt: '2026-07-30T16:00:00Z',
      derivedAt: '2026-07-30T16:00:01Z',
      fetchOverpass: successfulFetch([]),
      interBatchDelayMs: 0,
    });
    const fetchOverpass = jest.fn();

    const result = await producer.prepareOsmElevationContext({
      inputFile: file,
      fetchOverpass,
    });

    expect(result).toEqual(expect.objectContaining({
      skipped: true,
      reason: 'already current',
      inputSha256: result.outputSha256,
      wayCount: 3,
    }));
    expect(fetchOverpass).not.toHaveBeenCalled();
    expect(transientFiles(root)).toEqual([]);
  });

  test('repairs tampered derived tags without refetching still-complete raw structure coverage', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-osm-elevation-repair-'));
    roots.push(root);
    const file = writeDataset(root);
    await producer.prepareOsmElevationContext({
      inputFile: file,
      retrievedAt: '2026-07-30T16:00:00Z',
      derivedAt: '2026-07-30T16:00:01Z',
      fetchOverpass: successfulFetch([]),
      interBatchDelayMs: 0,
    });
    const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
    tampered.ways['3'].elevationRiskTags.bridge = 'no';
    fs.writeFileSync(file, JSON.stringify(tampered));
    const fetchOverpass = jest.fn();

    const result = await producer.prepareOsmElevationContext({
      inputFile: file,
      derivedAt: '2026-07-30T16:05:00Z',
      fetchOverpass,
    });

    expect(result.skipped).toBe(false);
    expect(result.structure.skipped).toBe(true);
    expect(fetchOverpass).not.toHaveBeenCalled();
    const repaired = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(repaired.ways['3'].elevationRiskTags.bridge).toBe('yes');
    expect(() => riskProducer.validateElevationRiskContract(repaired)).not.toThrow();
  });

  test('force refreshes structure tags and risk derivation even for a current file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-osm-elevation-force-'));
    roots.push(root);
    const file = writeDataset(root);
    await producer.prepareOsmElevationContext({
      inputFile: file,
      retrievedAt: '2026-07-30T16:00:00Z',
      derivedAt: '2026-07-30T16:00:01Z',
      fetchOverpass: successfulFetch([]),
      interBatchDelayMs: 0,
    });
    const queries = [];

    const result = await producer.prepareOsmElevationContext({
      inputFile: file,
      force: true,
      retrievedAt: '2026-07-30T17:00:00Z',
      derivedAt: '2026-07-30T17:00:01Z',
      fetchOverpass: successfulFetch(queries),
      interBatchDelayMs: 0,
    });

    expect(result.skipped).toBe(false);
    expect(result.structure.skipped).toBe(false);
    expect(result.risk.skipped).toBe(false);
    expect(queries.length).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).structureTags.retrievedAt)
      .toBe('2026-07-30T17:00:00.000Z');
  });

  test('leaves the original byte-identical when structure coverage is incomplete', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-osm-elevation-partial-'));
    roots.push(root);
    const file = writeDataset(root);
    const before = fs.readFileSync(file);

    await expect(producer.prepareOsmElevationContext({
      inputFile: file,
      batchSize: 3,
      interBatchDelayMs: 0,
      fetchOverpass: async () => ({
        elements: [{ type: 'way', id: 3, tags: { bridge: 'yes' } }],
      }),
    })).rejects.toThrow(/incomplete_way_coverage/);

    expect(fs.readFileSync(file)).toEqual(before);
    expect(transientFiles(root)).toEqual([]);
  });

  test('leaves the original byte-identical when risk derivation rejects an invalid layer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-osm-elevation-layer-'));
    roots.push(root);
    const file = writeDataset(root);
    const before = fs.readFileSync(file);

    await expect(producer.prepareOsmElevationContext({
      inputFile: file,
      interBatchDelayMs: 0,
      fetchOverpass: async (query) => ({
        elements: idsFromQuery(query).map((id) => ({
          type: 'way',
          id: Number(id),
          tags: id === '3' ? { layer: 'ground' } : {},
        })),
      }),
    })).rejects.toThrow(/invalid_layer/);

    expect(fs.readFileSync(file)).toEqual(before);
    expect(transientFiles(root)).toEqual([]);
  });

  test('restores the original when installing the validated stage fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-osm-elevation-publish-'));
    roots.push(root);
    const file = writeDataset(root);
    const before = fs.readFileSync(file);
    let renameCalls = 0;

    await expect(producer.prepareOsmElevationContext({
      inputFile: file,
      interBatchDelayMs: 0,
      fetchOverpass: successfulFetch([]),
      publishHooks: {
        renameSync(source, destination) {
          renameCalls += 1;
          if (renameCalls === 2) throw new Error('synthetic install failure');
          fs.renameSync(source, destination);
        },
      },
    })).rejects.toThrow(/publish_failed/);

    expect(renameCalls).toBe(3);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(transientFiles(root)).toEqual([]);
  });

  test('preserves the original backup when both install and rollback renames fail', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-osm-elevation-rollback-'));
    roots.push(root);
    const target = writeDataset(root);
    const stage = path.join(root, 'stage.json');
    fs.writeFileSync(stage, '{"new":true}');
    const original = fs.readFileSync(target);
    let renameCalls = 0;

    expect(() => producer.publishStage(stage, target, {
      renameSync(source, destination) {
        renameCalls += 1;
        if (renameCalls >= 2) throw new Error(`synthetic rename failure ${renameCalls}`);
        fs.renameSync(source, destination);
      },
    })).toThrow(/rollback_failed/);

    expect(fs.existsSync(target)).toBe(false);
    const backups = fs.readdirSync(root).filter((name) => name.includes('.backup-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, backups[0]))).toEqual(original);
    expect(fs.existsSync(stage)).toBe(true);
  });

  test('rejects symlink input files before creating staging data', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-osm-elevation-symlink-'));
    roots.push(root);
    const target = writeDataset(root);
    const link = path.join(root, 'link.json');
    fs.symlinkSync(target, link);

    await expect(producer.prepareOsmElevationContext({ inputFile: link }))
      .rejects.toThrow(/unsafe_file/);
    expect(transientFiles(root)).toEqual([]);
  });
});
