'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, 'out', 'qa', 'bonn-official-catalogue-discovery.json');
const liveTest = process.env.BONN_OPARL_LIVE === '1' ? test : test.skip;

jest.setTimeout(180_000);

describe('official Bonn catalogue discovery for OParl', () => {
  liveTest('retains current catalogue and resource evidence', () => {
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'qa-bonn-oparl-catalogue-discovery.js'),
    ], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: 170_000,
    });

    const diagnostics = [result.stdout, result.stderr].filter(Boolean).join('\n');
    if (result.error || result.status !== 0) {
      throw new Error(
        `Bonn catalogue discovery failed (status=${result.status}): `
        + `${result.error?.message || ''}\n${diagnostics}`
      );
    }

    expect(fs.existsSync(OUTPUT)).toBe(true);
    const evidence = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
    expect(evidence.schemaVersion).toBe('unfallwerkbank.bonnOparlCatalogueDiscovery.v1');
    expect(Array.isArray(evidence.catalogueAttempts)).toBe(true);
    expect(evidence.catalogueAttempts.length).toBeGreaterThan(0);
    expect(diagnostics).toContain('[bonn-oparl-catalogue-discovery] evidence:');
  });
});
