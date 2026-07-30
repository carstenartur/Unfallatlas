'use strict';

const fs = require('fs');
const path = require('path');
const {
  CAPABILITY_DOCUMENT_PATH,
} = require('../../server/context-generation/routes');

describe('context-generation capability document', () => {
  test('ships a truthful static fallback at the same path used by browser and Docker alias', () => {
    expect(CAPABILITY_DOCUMENT_PATH).toBe('/data/context-generation-status.json');
    const file = path.resolve(__dirname, '../../data/context-generation-status.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(value).toEqual({
      schemaVersion: 1,
      available: false,
      execution: 'github-actions',
      requiresToken: false,
      city: null,
      slug: null,
      reason: 'static_site',
      reasonDetail: 'Die statische Browser-Version kann keine lokalen Producer starten.',
      activeJob: null,
      latestJob: null,
      workflowUrl: 'https://github.com/carstenartur/Unfallatlas/actions/workflows/generate-context-city.yml',
    });

    const browserSource = fs.readFileSync(
      path.resolve(__dirname, '../../js/ua.context_generation.js'),
      'utf8',
    );
    expect(browserSource).toContain(
      "const CAPABILITY_URL = '/data/context-generation-status.json';",
    );
  });
});
