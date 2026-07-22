'use strict';

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '../../js/ua.core.js'), 'utf8');

describe('runtime export provenance bootstrap', () => {
  test('loads the strict manifest, adapters and live integrations in order', () => {
    const modules = [
      'ua.source_manifest.js',
      'ua.artifact_provenance.js',
      'ua.zip.js',
      'ua.export_provenance.js',
      'ua.kml_export_provenance.js',
      'ua.document_export_provenance.js',
    ];
    const offsets = modules.map(moduleName => source.indexOf(moduleName));
    expect(offsets.every(offset => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
    expect(source).toContain('document.currentScript');
    expect(source).toContain('DOMContentLoaded');
  });

  test('blocks data and document exporters before asynchronous modules are loaded', () => {
    const expected = [
      '"exportToCSV"',
      '"exportToGeoJSON"',
      '"exportToKML"',
      '"exportToWord"',
      '"exportToPDF"',
    ];
    expected.forEach(name => expect(source).toContain(name));
    expect(source).toContain('UA.__exportProvenanceOriginals = originalsFor(dataExportNames)');
    expect(source).toContain('UA.__documentProvenanceOriginals = originalsFor(documentExportNames)');
    expect(source).toContain('for (const name of [...dataExportNames, ...documentExportNames])');
    expect(source).toContain('Export ist gesperrt, bis die Quellenprovenienz geladen wurde.');
    expect(source).not.toMatch(/catch\(\(error\) =>[\s\S]{0,300}throw error/);
  });
});
