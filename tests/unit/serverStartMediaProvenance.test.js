'use strict';

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '../../server/start.js'), 'utf8');

function offset(token) {
  const value = source.indexOf(token);
  expect(value).toBeGreaterThanOrEqual(0);
  return value;
}

describe('production media provenance preload', () => {
  test('installs Playwright capture before the base video module is evaluated', () => {
    expect(offset('installVideoExportPlaywrightRuntime();'))
      .toBeLessThan(offset("require(videoExportModulePath);"));
  });

  test('redirects server/index.js to the provenanced video-export wrapper', () => {
    const baseLoad = offset("require(videoExportModulePath);");
    const wrapperLoad = offset("require('./video-export-with-provenance.js')");
    const cacheRedirect = offset('require.cache[videoExportModulePath].exports');
    const indexLoad = offset("require('./index.js');");

    expect(baseLoad).toBeLessThan(wrapperLoad);
    expect(wrapperLoad).toBeLessThan(cacheRedirect);
    expect(cacheRedirect).toBeLessThan(indexLoad);
  });

  test('registers the HTTP sidecar boundary synchronously when Express creates the app', () => {
    const appCreation = offset('const app = originalExpress(...args);');
    const mediaInstall = offset('installMediaExportProvenanceHttp(app);');
    const deferredContextRoutes = offset('setImmediate(() => {');

    expect(appCreation).toBeLessThan(mediaInstall);
    expect(mediaInstall).toBeLessThan(deferredContextRoutes);
  });
});
