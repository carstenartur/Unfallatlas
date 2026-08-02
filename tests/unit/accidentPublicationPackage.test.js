'use strict';

const crypto = require('crypto');

const {
  isEphemeral,
  normalizePath,
  packageFingerprint,
  parsePorcelainZ,
} = require('../../scripts/accident-publication-package');

describe('accident publication package', () => {
  test('parses ordinary, untracked and renamed porcelain entries', () => {
    const result = parsePorcelainZ(Buffer.from(
      ' M out/output_all_years_bonn.csv.gz\0' +
      '?? data/accident-data-release.json\0' +
      'R  old-name\0new-name\0'
    ));
    expect(result).toEqual([
      { status: ' M', path: 'out/output_all_years_bonn.csv.gz' },
      { status: '??', path: 'data/accident-data-release.json' },
      { status: 'R ', sourcePath: 'old-name', path: 'new-name' },
    ]);
  });

  test('rejects paths that can escape the checkout', () => {
    expect(() => normalizePath('../outside')).toThrow(/invalid_repository_path/);
    expect(() => normalizePath('/absolute')).toThrow(/invalid_repository_path/);
  });

  test('only known build output roots are ephemeral', () => {
    expect(isEphemeral('.build/report.json')).toBe(true);
    expect(isEphemeral('out/qa/report.json')).toBe(true);
    expect(isEphemeral('target/test.txt')).toBe(true);
    expect(isEphemeral('README.md')).toBe(false);
    expect(isEphemeral('out/output_all_years_bonn.csv.gz')).toBe(false);
  });

  test('payload fingerprint binds base commit, path, status, size and digest', () => {
    const entry = {
      path: 'data/accident-data-release.json',
      status: ' M',
      deleted: false,
      bytes: 10,
      sha256: crypto.createHash('sha256').update('1234567890').digest('hex'),
    };
    const first = packageFingerprint('a'.repeat(40), [entry]);
    expect(packageFingerprint('a'.repeat(40), [entry])).toBe(first);
    expect(packageFingerprint('b'.repeat(40), [entry])).not.toBe(first);
    expect(packageFingerprint('a'.repeat(40), [{ ...entry, bytes: 11 }])).not.toBe(first);
  });
});
