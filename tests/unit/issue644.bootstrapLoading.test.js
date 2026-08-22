/** @jest-environment jsdom */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../js/ua.bootstrap.js'), 'utf8');

describe('issue #644 bootstrap loading order', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    Object.defineProperty(document, 'readyState', {
      configurable: true,
      get: () => 'loading',
    });
    Object.defineProperty(document, 'currentScript', {
      configurable: true,
      get: () => ({ src: 'https://example.test/Unfallatlas/js/ua.bootstrap.js?v=2026-08-01' }),
    });
    jest.spyOn(document, 'write').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('loads both semantic guards parser-blocking before the legacy stack', () => {
    window.eval(SOURCE);

    expect(document.write).toHaveBeenCalledTimes(1);
    const markup = document.write.mock.calls[0][0];
    const semantics = markup.indexOf('ua.evidence_safe_semantics.js');
    const hardening = markup.indexOf('ua.evidence_safe_semantics_hardening.js');
    expect(semantics).toBeGreaterThanOrEqual(0);
    expect(hardening).toBeGreaterThan(semantics);
    expect(markup).toContain('v=2026-08-22');
    expect(window.UA.BUILD).toBe('2026-07-19 00:00 UTC');
  });
});
