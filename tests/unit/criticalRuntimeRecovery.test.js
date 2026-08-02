/** @jest-environment jsdom */

'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../../js/ua.critical-runtime-recovery.js'),
  'utf8',
);

describe('critical runtime recovery for legacy branch Pages', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    window.UA = {};
    Object.defineProperty(document, 'readyState', {
      configurable: true,
      get: () => 'loading',
    });
    jest.spyOn(document, 'write').mockImplementation(() => {});
    window.eval(SOURCE);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('retries a failed parser-loaded map module before app startup continues', () => {
    const script = document.createElement('script');
    script.src = 'https://example.test/Unfallatlas/js/ua.map_v2.js?v=2026-07-19';

    script.dispatchEvent(new Event('error'));

    expect(document.write).toHaveBeenCalledTimes(1);
    expect(document.write.mock.calls[0][0]).toContain('ua.map_v2.js');
    expect(document.write.mock.calls[0][0]).toContain('ua_runtime_retry=1');
    expect(window.UA.criticalRuntimeFailures).toHaveLength(1);
  });

  test('does not retry when the critical module is already available', () => {
    window.UA.initLeaflet = () => {};
    const script = document.createElement('script');
    script.src = 'https://example.test/Unfallatlas/js/ua.map_v2.js';

    script.dispatchEvent(new Event('error'));

    expect(document.write).not.toHaveBeenCalled();
  });

  test('limits parser-blocking retries', () => {
    const script = document.createElement('script');
    script.src = 'https://example.test/Unfallatlas/js/ua.map_v2.js';

    script.dispatchEvent(new Event('error'));
    script.dispatchEvent(new Event('error'));
    script.dispatchEvent(new Event('error'));

    expect(document.write).toHaveBeenCalledTimes(2);
    expect(window.UA.criticalRuntimeFailures).toHaveLength(3);
  });
});
