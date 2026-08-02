'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const VALIDATOR = path.join(ROOT, 'scripts', 'validate-accident-runtime-contract.js');

describe('checked-in accident data browser compatibility', () => {
  test('all configured city datasets satisfy the actual browser extraction and filter contract', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-accident-runtime-'));
    const report = path.join(directory, 'report.json');
    try {
      const result = spawnSync(process.execPath, [
        '--max-old-space-size=4096',
        VALIDATOR,
        '--root', ROOT,
        '--report', report,
      ], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toMatch(/PASS: \d+ cities, latest year \d{4}/);

      const evidence = JSON.parse(fs.readFileSync(report, 'utf8'));
      expect(evidence.contract).toBe('unfallwerkbank-checked-in-accident-runtime/v1');
      expect(evidence.checkedCities).toBeGreaterThan(0);
      expect(evidence.latestYear).toBeGreaterThanOrEqual(2024);
      expect(evidence.cityReports).toHaveLength(evidence.checkedCities);
      expect(evidence.cityReports.every((city) => city.latestYear === evidence.latestYear)).toBe(true);
      expect(evidence.canonicalScenarios.map((scenario) => scenario.id)).toEqual([
        'hannover-default-or',
        'bonn-bike-car-and',
        'bonn-bike-solo',
      ]);
      expect(evidence.canonicalScenarios.every((scenario) => scenario.matches > 0)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 300000);
});
