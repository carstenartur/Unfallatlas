/** @jest-environment jsdom */
'use strict';

const fs = require('fs');
const path = require('path');

describe('public browser political-context fallback contract', () => {
  const ROOT = path.resolve(__dirname, '../..');
  const FALLBACK = path.join(ROOT, 'js', 'ua.political-context-browser-fallback.js');
  const BOOTSTRAP = path.join(ROOT, 'js', 'ua.bootstrap.js');

  test('ships the Bonn fallback as an ordinary local site asset', () => {
    expect(fs.existsSync(FALLBACK)).toBe(true);
    const source = fs.readFileSync(FALLBACK, 'utf8');
    expect(source).toContain('unfallwerkbank.bonnPoliticalBrowserFallback.v1');
    expect(source).toContain('https://www.bonn.sitzung-online.de/oparl/bodies/1/papers');
    expect(source).toContain("searchStatus: 'partial-results'");
    expect(source).toContain("allowed: false");

    const buildSource = fs.readFileSync(path.join(ROOT, 'scripts', 'build-site.js'), 'utf8');
    expect(buildSource).toMatch(/STATIC_ENTRIES[\s\S]*['"]js['"]/);
  });

  test('loads the fallback exactly once through the strict-CSP bootstrap', () => {
    const bootstrap = fs.readFileSync(BOOTSTRAP, 'utf8');
    const matches = bootstrap.match(/ua\.political-context-browser-fallback\.js/g) || [];
    expect(matches).toHaveLength(1);
    expect(bootstrap).toContain('ua.political-context-browser-fallback.js?v=2026-08-30');
    expect(bootstrap).not.toMatch(/https?:\/\/[^'"`]*political-context-browser-fallback/);
  });

  test('keeps the public profile honest about the full server requirement', () => {
    const publicRuntime = fs.readFileSync(path.join(ROOT, 'js', 'ua.public-preview.js'), 'utf8');
    expect(publicRuntime).toContain('political-context-search');
    expect(publicRuntime).toContain('POLITICAL_CONTEXT_BACKEND_REQUIRED');
    expect(publicRuntime).toContain('Ratsinformationssystem öffnen');
  });
});
