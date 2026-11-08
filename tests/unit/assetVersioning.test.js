'use strict';

const fs = require('fs');
const path = require('path');

describe('Werkbank deployment asset versions', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../werkbank_v2.html'), 'utf8');
  const bootstrap = fs.readFileSync(path.resolve(__dirname, '../../js/ua.bootstrap.js'), 'utf8');
  const version = '2026-07-19';

  test.each([
    'js/ua.core.js',
    'js/ua.utils.js',
    'js/ua.lifecycle.js',
    'js/ua.popup_context.js',
    'js/ua.app_v2.js',
    'js/ua.priorities.js',
  ])('%s uses the current cache buster', (asset) => {
    expect(html).toContain(`${asset}?v=${version}`);
  });

  test.each([
    'css/ua.css', 'js/ua.ui.js', 'js/ua.map_v2.js', 'js/ua.ris-layer.js',
  ])('%s invalidates the cache for mobile panel disclosure', asset => {
    expect(html).toContain(`${asset}?v=2026-11-08-mobile-panels"`);
  });

  test('the tour invalidates the cache for the political research UI', () => {
    expect(html).toContain('js/ua.tour.js?v=2026-11-07');
  });

  test.each([
    'js/ua.data_paths.js',
    'js/ua.ai_proposal.js',
    'js/ua.export_v2.js', 'js/ua.report_v2.js',
  ])('%s uses the verified RIS rollout version', asset => {
    expect(html).toContain(`${asset}?v=2026-11-07-ris`);
  });

  test.each([
    'js/ua.ris-catalogue.js', 'js/ua.political-context.js',
  ])('%s invalidates the cache for the common location assessment contract', asset => {
    expect(html).toContain(`${asset}?v=2026-11-08-ris-pruefung"`);
  });

  test('support metadata and runtime BUILD expose the same release timestamp', () => {
    const timestamp = `${version} 00:00 UTC`;
    expect(html).toContain(`<meta name="unfallwerkbank-build" content="${timestamp}"/>`);

    const bootstrapReference = html.indexOf('src="js/ua.bootstrap.js');
    const coreReference = html.indexOf('src="js/ua.core.js');
    expect(bootstrapReference).toBeGreaterThanOrEqual(0);
    expect(coreReference).toBeGreaterThan(bootstrapReference);

    const buildMatch = bootstrap.match(/window\.UA\s*=\s*\{\s*BUILD:\s*['"]([^'"]+)['"]\s*\}/);
    expect(buildMatch).not.toBeNull();
    expect(buildMatch[1]).toBe(timestamp);
  });
});
