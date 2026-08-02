'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

describe('browser and server security headers', () => {
  test('the static entry page has no inline script and declares a restrictive CSP', () => {
    const html = read('werkbank_v2.html');
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("script-src 'self'");
    expect(html).toContain("object-src 'none'");
    expect(html).toContain('src="js/ua.bootstrap.js');
    expect(html).not.toMatch(/<script(?![^>]+\bsrc=)[^>]*>/i);
  });

  test('the production entry point removes framework disclosure and sets hardening headers', () => {
    const source = read('server/start.js');
    expect(source).toContain("app.disable('x-powered-by')");
    expect(source).toContain("response.setHeader('Content-Security-Policy'");
    expect(source).toContain("response.setHeader('X-Content-Type-Options', 'nosniff')");
    expect(source).toContain("response.setHeader('Referrer-Policy'");
    expect(source).toMatch(/response\.setHeader\(\s*['"]Permissions-Policy['"]/);
  });
});
