'use strict';

const JSZip = require('jszip');
const zip = require('../../js/ua.zip');

describe('deterministic browser ZIP writer', () => {
  test('creates a standards-compliant UTF-8 stored archive', async () => {
    const bytes = zip.createStoredZip([
      { name: 'export.csv', content: 'lat,lon\n52.1,9.7\n' },
      { name: 'sources.json', content: '{"source":"Unfallatlas"}\n' },
      { name: 'README.txt', content: 'Quellen vollständig.\n' },
    ]);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const archive = await JSZip.loadAsync(bytes);
    expect(Object.keys(archive.files).sort()).toEqual([
      'README.txt',
      'export.csv',
      'sources.json',
    ]);
    expect(await archive.file('export.csv').async('string')).toContain('52.1,9.7');
    expect(await archive.file('README.txt').async('string')).toContain('vollständig');
  });

  test('is byte-for-byte deterministic for identical entries', () => {
    const entries = [
      { name: 'a.txt', content: 'alpha' },
      { name: 'b.txt', content: 'beta' },
    ];
    expect(zip.createStoredZip(entries)).toEqual(zip.createStoredZip(entries));
  });

  test.each(['../escape.txt', '/absolute.txt', 'dir\\file.txt', 'dir//file.txt'])(
    'rejects unsafe entry name %s',
    (name) => {
      expect(() => zip.createStoredZip([{ name, content: 'x' }])).toThrow(/unsafe_name/);
    },
  );

  test('rejects duplicate names and unsupported content', () => {
    expect(() =>
      zip.createStoredZip([
        { name: 'same.txt', content: 'a' },
        { name: 'same.txt', content: 'b' },
      ]),
    ).toThrow(/duplicate_entry/);
    expect(() => zip.createStoredZip([{ name: 'x.txt', content: { x: 1 } }])).toThrow(
      /invalid_content/,
    );
  });
});
