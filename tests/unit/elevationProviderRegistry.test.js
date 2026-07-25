'use strict';

const fs = require('fs');
const path = require('path');
const {
  createRegistry,
  materializeSourceDescriptor,
  classifyGradientSemantics,
  normalizeCity,
  validateStaticDescriptor,
} = require('../../scripts/lib/elevation-provider-registry');

const ROOT = path.resolve(__dirname, '../..');
const CONFIG = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'config/elevation-providers.json'),
  'utf8',
));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

describe('ElevationProvider registry', () => {
  test('normalizes German city names without losing ae/oe/ue semantics', () => {
    expect(normalizeCity('Düsseldorf')).toBe('duesseldorf');
    expect(normalizeCity('Köln')).toBe('koeln');
    expect(normalizeCity('München')).toBe('muenchen');
    expect(normalizeCity('Gießen')).toBe('giessen');
    expect(normalizeCity('Bad  Dürkheim')).toBe('bad-duerkheim');
  });

  test('selects the official Hannover DGM1 and no undocumented fallback', () => {
    const registry = createRegistry(CONFIG);
    const provider = registry.select('Hannover');
    expect(provider).toMatchObject({
      id: 'hannover-dgm1',
      priority: 1,
      resolutionMeters: 1,
      modelType: 'DTM',
      horizontalCrs: 'EPSG:25832',
      licenseId: 'CC-BY-4.0',
    });
    expect(registry.select('Bonn')).toBeNull();
    expect(registry.coversCity('hannover-dgm1', 'Hannover')).toBe(true);
    expect(registry.coversCity('hannover-dgm1', 'Bonn')).toBe(false);
  });

  test('matches umlaut city coverage against the repository slug convention', () => {
    const provider = {
      ...clone(CONFIG.providers[0]),
      id: 'duesseldorf-dgm1',
      coverage: { type: 'city-list', cities: ['Düsseldorf'] },
    };
    const registry = createRegistry([provider]);
    expect(registry.select('Düsseldorf').id).toBe('duesseldorf-dgm1');
    expect(registry.select('Duesseldorf').id).toBe('duesseldorf-dgm1');
    expect(registry.select('Dusseldorf')).toBeNull();
  });

  test('ranks active providers deterministically by tier, resolution and id', () => {
    const base = clone(CONFIG.providers[0]);
    const registry = createRegistry([
      { ...base, id: 'coarse', priority: 2, resolutionMeters: 5 },
      { ...base, id: 'fine-b', priority: 1, resolutionMeters: 2 },
      { ...base, id: 'fine-a', priority: 1, resolutionMeters: 2 },
      { ...base, id: 'disabled', priority: 1, resolutionMeters: 1, status: 'disabled', disabledReason: 'license pending' },
    ]);
    expect(registry.select('Hannover').id).toBe('fine-a');
    expect(registry.select('Hannover', { maxResolutionMeters: 1 })).toBeNull();
    expect(registry.select('Hannover', { modelTypes: ['DSM'] })).toBeNull();
  });

  test('fails closed on incomplete source and license metadata', () => {
    const broken = clone(CONFIG.providers[0]);
    delete broken.licenseUrl;
    expect(() => validateStaticDescriptor(broken)).toThrow(/licenseUrl/);

    const insecure = clone(CONFIG.providers[0]);
    insecure.datasetUrl = 'http://example.invalid/dgm';
    expect(() => validateStaticDescriptor(insecure)).toThrow(/HTTPS/);

    const uncovered = clone(CONFIG.providers[0]);
    uncovered.coverage = { type: 'city-list', cities: [] };
    expect(() => validateStaticDescriptor(uncovered)).toThrow(/requires cities/);
  });

  test('materializes retrieval time only for a covered city', () => {
    const registry = createRegistry(CONFIG);
    const provider = registry.get('hannover-dgm1');
    const source = materializeSourceDescriptor(provider, {
      city: 'Hannover',
      retrievedAt: '2026-07-25T06:00:00+02:00',
    });
    expect(source.retrievedAt).toBe('2026-07-25T04:00:00.000Z');
    expect(source.requiredAttribution).toContain('Landeshauptstadt Hannover');
    expect(Object.isFrozen(source)).toBe(true);
    expect(() => materializeSourceDescriptor(provider, {
      city: 'Bonn', retrievedAt: '2026-07-25T04:00:00Z',
    })).toThrow(/does not cover/);
    expect(() => materializeSourceDescriptor(provider, {
      city: 'Hannover', retrievedAt: 'not-a-date',
    })).toThrow(/retrievedAt/);
  });

  test('permits a road-grade claim only for robust high-resolution road profiles', () => {
    const provider = createRegistry(CONFIG).get('hannover-dgm1');
    expect(classifyGradientSemantics(provider, {
      roadMatched: true,
      method: 'robust-linear-regression',
      windowMeters: 50,
      sampleCount: 41,
      risks: [],
    })).toMatchObject({
      label: 'Straßenlängsneigung',
      reliableForRoad: true,
      decimals: 1,
      quality: 'high',
      uncertaintyReasons: [],
    });

    const bridge = classifyGradientSemantics(provider, {
      roadMatched: true,
      method: 'robust-linear-regression',
      windowMeters: 50,
      sampleCount: 41,
      risks: ['bridge'],
    });
    expect(bridge).toMatchObject({
      label: 'Geländeneigung im Umfeld',
      reliableForRoad: false,
      decimals: 0,
      quality: 'limited',
    });
    expect(bridge.uncertaintyReasons).toContain('bridge');
  });

  test('coarse terrain sources can never be presented as precise road grades', () => {
    const coarse = {
      ...clone(CONFIG.providers[0]),
      id: 'coarse-global',
      resolutionMeters: 30,
      coverage: { type: 'global' },
    };
    const semantics = classifyGradientSemantics(coarse, {
      roadMatched: true,
      method: 'robust-linear-regression',
      windowMeters: 50,
      sampleCount: 9,
      risks: [],
    });
    expect(semantics.reliableForRoad).toBe(false);
    expect(semantics.label).toBe('Geländeneigung im Umfeld');
    expect(semantics.decimals).toBe(0);
    expect(semantics.uncertaintyReasons).toContain('source-resolution-30m');
  });
});
