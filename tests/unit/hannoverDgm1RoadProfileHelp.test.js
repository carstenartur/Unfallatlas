/** @jest-environment node */
'use strict';

const producer = require('../../scripts/producers/hannover_dgm1_road_profile_producer');

const DOCUMENTED_FLAGS = Object.freeze([
  '--osm',
  '--dgm-root',
  '--dgm-manifest',
  '--dgm-manifest-sha256',
  '--output',
  '--generated-at',
  '--structure-retrieved-at',
  '--risk-derived-at',
  '--batch-size',
  '--delay',
  '--endpoint',
  '--retries',
  '--backoff',
  '--timeout',
  '--force-context',
  '--json',
]);

describe('Hannover DGM1 road-profile CLI help', () => {
  test('documents every accepted production flag', async () => {
    let output = '';
    const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await expect(producer.main(['--help'])).resolves.toBe(0);
    } finally {
      write.mockRestore();
    }
    for (const flag of DOCUMENTED_FLAGS) expect(output).toContain(flag);
  });

  test('keeps required input flags visible in the usage prefix', async () => {
    let output = '';
    const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await producer.main(['--help']);
    } finally {
      write.mockRestore();
    }
    expect(output).toMatch(/--osm <osm_hannover\.json>/);
    expect(output).toMatch(/--dgm-manifest-sha256 <sha256>/);
    expect(output).toMatch(/--output <profiles\.json>/);
  });
});
