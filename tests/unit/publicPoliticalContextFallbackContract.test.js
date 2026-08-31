/** @jest-environment jsdom */
'use strict';

const fs = require('fs');
const path = require('path');

describe('public browser political-context transport contract', () => {
  const ROOT = path.resolve(__dirname, '../..');
  const PUBLIC_RUNTIME = path.join(ROOT, 'js', 'ua.public-preview.js');
  const REMOVED_DIRECT_FALLBACK = path.join(ROOT, 'js', 'ua.political-context-browser-fallback.js');
  const BOOTSTRAP = path.join(ROOT, 'js', 'ua.bootstrap.js');

  test('does not ship a mocked-CORS direct OParl fallback', () => {
    expect(fs.existsSync(REMOVED_DIRECT_FALLBACK)).toBe(false);
    const bootstrap = fs.readFileSync(BOOTSTRAP, 'utf8');
    expect(bootstrap).not.toContain('ua.political-context-browser-fallback.js');
  });

  test('suppresses the impossible Pages POST unless an HTTP backend is explicitly configured', () => {
    const source = fs.readFileSync(PUBLIC_RUNTIME, 'utf8');
    expect(source).toContain('configuredPoliticalContextEndpoint');
    expect(source).toContain('POLITICAL_CONTEXT_ENDPOINT');
    expect(source).toContain('API_BASE_URL');
    expect(source).toContain('POLITICAL_CONTEXT_BACKEND_REQUIRED');
    expect(source).toContain('__publicPagesTransportGuard');
    expect(source).toContain("method: 'POST'");
    expect(source).not.toContain('/oparl/bodies/1/papers');
  });

  test('keeps the public profile honest and provides official Bonn portal links', () => {
    const source = fs.readFileSync(PUBLIC_RUNTIME, 'utf8');
    expect(source).toContain('political-context-search');
    expect(source).toContain('Serverrecherche auf GitHub Pages nicht verfügbar');
    expect(source).toContain('Ratsinformationssystem öffnen');
    expect(source).toContain('https://www.bonn.sitzung-online.de/public/');
    expect(source).toContain('UA.resolvePublicPoliticalContextEndpoint');
  });
});