/** @jest-environment node */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../js/ua.bootstrap.js'), 'utf8');

describe('issue #644 bootstrap loading order', () => {
  test('loads both semantic guards parser-blocking before the legacy stack', () => {
    const write = jest.fn();
    const fakeWindow = {};
    const fakeDocument = {
      currentScript: {
        src: 'https://example.test/Unfallatlas/js/ua.bootstrap.js?v=2026-08-01',
      },
      readyState: 'loading',
      write,
    };

    const execute = new Function('window', 'document', 'URL', 'Promise', SOURCE);
    execute(fakeWindow, fakeDocument, URL, Promise);

    expect(write).toHaveBeenCalledTimes(1);
    const markup = write.mock.calls[0][0];
    const semantics = markup.indexOf('ua.evidence_safe_semantics.js');
    const hardening = markup.indexOf('ua.evidence_safe_semantics_hardening.js');
    expect(semantics).toBeGreaterThanOrEqual(0);
    expect(hardening).toBeGreaterThan(semantics);
    expect(markup).toContain('v=2026-08-22');
    expect(fakeWindow.UA.BUILD).toBe('2026-07-19 00:00 UTC');
  });
});
