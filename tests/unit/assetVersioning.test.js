'use strict';

const fs = require('fs');
const path = require('path');

describe('Werkbank deployment asset versions', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../werkbank_v2.html'), 'utf8');
  const bootstrap = fs.readFileSync(path.resolve(__dirname, '../../js/ua.bootstrap.js'), 'utf8');
  const version = '2026-07-19';

  test.each([
    'js/ua.utils.js',
    'js/ua.lifecycle.js',
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
  ])('%s invalidates the cache for RIS location evidence', asset => {
    expect(html).toContain(`${asset}?v=2026-11-07-ris-orte"`);
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


test.each(['ua.core', 'ua.context_layers', 'ua.context_road_layer', 'ua.popup_context',
  'ua.elevation_provider', 'ua.source_manifest', 'ua.traffic_provider'])('context semantics refreshes browser cache for %s', name => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../werkbank_v2.html'), 'utf8');
  expect(html.includes(`js/${name}.js?v=2026-11-08-context`)).toBe(true);
});
test('dynamic export provenance invalidates the old accident-only implementation', () => {
  const core = fs.readFileSync(path.resolve(__dirname, '../../js/ua.core.js'), 'utf8');
  expect(core.includes('ua.export_provenance.js?v=2026-11-08-context')).toBe(true);
});
