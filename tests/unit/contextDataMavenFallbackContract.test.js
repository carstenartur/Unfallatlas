'use strict';

const fs = require('fs');
const path = require('path');
const { validatePublishedTree } = require('../../scripts/run-context-enrichment');

const ROOT = path.resolve(__dirname, '../..');

describe('Maven-owned context-data transient fallback', () => {
  test('the context-data-e2e profile tolerates only verified stale data after transient provider failures', () => {
    const pom = fs.readFileSync(path.join(ROOT, 'pom.xml'), 'utf8');
    const profile = /<profile>\s*<id>context-data-e2e<\/id>([\s\S]*?)<\/profile>/.exec(pom);

    expect(profile).not.toBeNull();
    expect(profile[1]).toContain(
      '<context.allowStaleOnTransient>true</context.allowStaleOnTransient>'
    );
    expect(profile[1]).toContain(
      '<CONTEXT_ALLOW_STALE_ON_TRANSIENT>${context.allowStaleOnTransient}</CONTEXT_ALLOW_STALE_ON_TRANSIENT>'
    );
  });

  test('checks temporary enrichment inputs only for cities refreshed in the current run', () => {
    const calls = [];
    const runner = (script, args = [], env = {}) => calls.push({ script, args, env });

    validatePublishedTree(['Bonn', 'Hannover'], ['Hannover'], runner);

    expect(calls[0]).toEqual({
      script: 'scripts/check-enrichment-inputs.js',
      args: ['--city', 'Hannover'],
      env: {},
    });
    expect(calls.map(call => call.script)).toEqual([
      'scripts/check-enrichment-inputs.js',
      'scripts/gzip-static-data.js',
      'scripts/check-context-datasets.js',
      'scripts/check-slope-plausibility.js',
      'scripts/check-data-paths.js',
    ]);
  });

  test('retained stale data skips only the absent temporary cache and keeps every public-data gate', () => {
    const calls = [];
    const runner = (script, args = [], env = {}) => calls.push({ script, args, env });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    validatePublishedTree(['Bonn'], [], runner);

    expect(calls.map(call => call.script)).toEqual([
      'scripts/gzip-static-data.js',
      'scripts/check-context-datasets.js',
      'scripts/check-slope-plausibility.js',
      'scripts/check-data-paths.js',
    ]);
    expect(calls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ script: 'scripts/check-enrichment-inputs.js' }),
    ]));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/every public-data validation gate/i));
  });
});