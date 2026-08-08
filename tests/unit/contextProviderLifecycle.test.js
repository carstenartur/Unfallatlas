'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

describe('context provider production lifecycle', () => {
  test('Hannover DGM1 generation and application happen before traffic postprocessing and final gates', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts/run-context-enrichment.js'), 'utf8');
    const generation = source.indexOf("run('scripts/producers/hannover_dgm1_road_profile_producer.js'");
    const application = source.indexOf("run('scripts/apply-hannover-dgm1-road-profiles.js'");
    const traffic = source.indexOf("run('scripts/apply-qualitative-traffic-proxy.js'");
    const finalPreflight = source.indexOf("run('scripts/check-enrichment-inputs.js'");

    expect(generation).toBeGreaterThanOrEqual(0);
    expect(application).toBeGreaterThan(generation);
    expect(traffic).toBeGreaterThan(application);
    expect(finalPreflight).toBeGreaterThan(traffic);
  });

  test('production can require DGM1 and rejects incomplete pin configuration', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts/run-context-enrichment.js'), 'utf8');
    expect(source).toContain('CONTEXT_REQUIRE_HANNOVER_DGM1');
    expect(source).toContain('HANNOVER_DGM1_ROOT');
    expect(source).toContain('HANNOVER_DGM1_MANIFEST');
    expect(source).toContain('HANNOVER_DGM1_MANIFEST_SHA256');
    expect(source).toMatch(/Incomplete Hannover DGM1 configuration/);
    expect(source).toMatch(/Hannover DGM1 is required/);
  });

  test('precomputed verified profile artifacts use the same runtime adapter', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts/run-context-enrichment.js'), 'utf8');
    expect(source).toContain('HANNOVER_DGM1_PRECOMPUTED_PROFILES');
    const precomputedBranch = source.indexOf('if (precomputed)');
    const adapter = source.indexOf("run('scripts/apply-hannover-dgm1-road-profiles.js'", precomputedBranch);
    expect(precomputedBranch).toBeGreaterThanOrEqual(0);
    expect(adapter).toBeGreaterThan(precomputedBranch);
  });
});