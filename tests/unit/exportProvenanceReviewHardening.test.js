'use strict';

const fs = require('fs');
const path = require('path');

function loadRuntime() {
  jest.resetModules();
  window.UA = {
    exportToCSV: jest.fn(),
    exportToGeoJSON: jest.fn(),
    exportToKML: jest.fn(),
    matchesNonInvolvementFilters: jest.fn(() => true),
  };
  require('../../js/ua.source_manifest');
  require('../../js/ua.artifact_provenance');
  require('../../js/ua.zip');
  return require('../../js/ua.export_provenance');
}

describe('export provenance review hardening', () => {
  afterEach(() => {
    delete window.UA;
    jest.restoreAllMocks();
  });

  test('classifies missing bound UI state before invoking the legacy filter function', () => {
    const api = loadRuntime();
    expect(() => api.exportPoints(window.UA, { allPts: [] })).toThrow(/missing_filter_state/);
    expect(window.UA.matchesNonInvolvementFilters).not.toHaveBeenCalled();
  });

  test('precomputes stable sort keys instead of serializing inside the comparator', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../js/ua.export_provenance.js'),
      'utf8',
    );
    expect(source).toContain('return { value, key: sourceManifest.stableStringify(value) }');
    expect(source).toContain('.sort((left, right) => left.key.localeCompare(right.key))');
    expect(source).not.toMatch(/sort\([\s\S]{0,160}stableStringify\(left\)/);
  });
});
