'use strict';

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '../../js/ua.core.js'), 'utf8');

function executeBootstrap() {
  const fakeDocument = {
    currentScript: { src: 'https://example.test/js/ua.core.js' },
    readyState: 'complete',
    querySelectorAll: () => [],
    createElement: () => {
      const handlers = {};
      return {
        src: '',
        async: true,
        dataset: {},
        addEventListener(type, handler) { handlers[type] = handler; },
        _handlers: handlers,
      };
    },
    head: {
      appendChild(script) {
        queueMicrotask(() => script._handlers.load());
      },
    },
  };
  const original = {
    exportToCSV: jest.fn(),
    exportToGeoJSON: jest.fn(),
    exportToKML: jest.fn(),
    exportToWord: jest.fn(),
    exportToPDF: jest.fn(),
  };
  const fakeWindow = {
    location: { href: 'https://example.test/werkbank_v2.html' },
    UA: { ...original, showToast: jest.fn() },
  };
  const fakeHistory = { replaceState: jest.fn() };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'history', source)(fakeWindow, fakeDocument, fakeHistory);
  return { fakeWindow, original };
}

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
    expect(source).toContain('blockedExportFor(name)');
    expect(source).toContain('current.apply(UA, args)');
    expect(source).toContain('Export ist gesperrt, bis die Quellenprovenienz geladen wurde.');
    expect(source).not.toMatch(/catch\(\(error\) =>[\s\S]{0,300}throw error/);
  });

  test('an exporter captured during startup delegates to the installed implementation', async () => {
    const { fakeWindow, original } = executeBootstrap();
    const earlyBoundWordHandler = fakeWindow.UA.exportToWord;

    expect(earlyBoundWordHandler).not.toBe(original.exportToWord);
    expect(fakeWindow.UA.__documentProvenanceOriginals.exportToWord)
      .toBe(original.exportToWord);

    const installed = jest.fn(async (...args) => ({ delegated: args }));
    fakeWindow.UA.exportToWord = installed;

    await expect(earlyBoundWordHandler('ctx', 'report', { includeMap: true }))
      .resolves.toEqual({ delegated: ['ctx', 'report', { includeMap: true }] });
    expect(installed).toHaveBeenCalledTimes(1);
  });
});
