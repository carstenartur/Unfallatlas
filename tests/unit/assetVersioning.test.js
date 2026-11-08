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
    'js/ua.priorities.js',
  ])('%s uses the current cache buster', (asset) => {
    expect(html).toContain(`${asset}?v=${version}`);
  });

  test.each([
    'css/ua.css', 'js/ua.preview_map_renderer.js',
  ])('%s invalidates the cache for unified map controls', asset => {
    expect(html).toContain(`${asset}?v=2026-11-08-scalable-catalogue"`);
  });

  test.each(['js/ua.ui.js', 'js/ua.map_v2.js', 'js/ua.filters.js'])('%s refreshes typed traffic controls', asset => {
    expect(html).toContain(`${asset}?v=2026-11-08-context-review"`);
  });

  test.each(['js/ua.ris-partitions.js', 'js/ua.ris-catalogue.js', 'js/ua.ris-layer.js'])('%s invalidates the cache for regional records and consultation histories', asset => {
    expect(html).toContain(`${asset}?v=2026-11-08-regional-catalogue"`);
  });

  test('the tour invalidates the cache for the political research UI', () => {
    expect(html).toContain('js/ua.tour.js?v=2026-11-07');
  });

  test.each([
    'js/ua.ai_proposal.js',
    'js/ua.report_v2.js',
  ])('%s uses the verified RIS rollout version', asset => {
    expect(html).toContain(`${asset}?v=${asset === 'js/ua.report_v2.js' ? '2026-11-08-readable-direction' : '2026-11-07-ris'}`);
  });

  test.each(['js/ua.state.js', 'js/ua.app_v2.js'])('%s refreshes confirmed area scope', asset => {
    expect(html).toContain(`${asset}?v=2026-11-08-area-name"`);
  });

  test('both canonical template and export assets load the current defaults', () => {
    expect(html).toContain('js/ua.export_template_defaults.js?v=2026-11-08-method-limits"');
    expect(html).toContain('js/ua.export_v2.js?v=2026-11-08-typed-context-export"');
  });

  test.each(['js/ua.political-context.js', 'js/ua.area_name_control.js', 'js/ua.data_paths.js'])('%s refreshes confirmed research scope', asset => {
    expect(html).toContain(`${asset}?v=2026-11-08-area-research"`);
  });

  test('lazy AI political evidence refreshes the confirmed research context', () => {
    const paths = fs.readFileSync(path.resolve(__dirname, '../../js/ua.data_paths.js'), 'utf8');
    expect(paths).toContain('js/ua.ai_political_evidence.js?v=2026-11-08-area-research');
    expect(paths).toContain('js/ua.ai_political_reference_bridge.js?v=2026-11-08-method-limits');
  });

  test.each(['js/ua.ris-partitions.js', 'js/ua.ris-catalogue.js', 'js/ua.ris-layer.js'])('%s refreshes paged consultation history', asset => {
    expect(html).toContain(`${asset}?v=2026-11-08-regional-catalogue"`);
  });

  test('shared spatial budgets and partitions load before their consumers', () => {
    const scripts = [...html.matchAll(/<script[^>]+src="([^"?]+)/g)].map(match => match[1]);
    for (const shared of ['js/ua.spatial-grid.js', 'js/ua.data-budget.js']) {
      expect(scripts.indexOf(shared)).toBeGreaterThanOrEqual(0);
      for (const consumer of ['js/ua.context_layers.js', 'js/ua.accident_provider.js', 'js/ua.ris-partitions.js']) {
        expect(scripts.indexOf(shared)).toBeLessThan(scripts.indexOf(consumer));
      }
    }
    expect(scripts.indexOf('js/ua.ris-partitions.js')).toBeLessThan(scripts.indexOf('js/ua.ris-catalogue.js'));
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
  const version = name === 'ua.core' ? '2026-11-08-readable-direction' : '2026-11-08-context';
  expect(html.includes(`js/${name}.js?v=${version}`)).toBe(true);
});
test('dynamic export provenance invalidates the old accident-only implementation', () => {
  const core = fs.readFileSync(path.resolve(__dirname, '../../js/ua.core.js'), 'utf8');
  for (const name of ['ua.artifact_provenance', 'ua.export_provenance', 'ua.kml_export_provenance', 'ua.document_export_provenance']) {
    const version = name === 'ua.export_provenance' ? '2026-11-08-readable-direction' : name === 'ua.kml_export_provenance' ? '2026-11-08-typed-context-export' : '2026-11-08-source-note-links';
    expect(core).toContain(`${name}.js?v=${version}`);
  }
});
