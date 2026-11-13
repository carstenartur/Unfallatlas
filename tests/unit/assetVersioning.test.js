'use strict';

const fs = require('fs');
const path = require('path');

describe('Werkbank deployment asset versions', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../werkbank_v2.html'), 'utf8');
  const bootstrap = fs.readFileSync(path.resolve(__dirname, '../../js/ua.bootstrap.js'), 'utf8');
  const version = '2026-07-19';
  const patternComparisonVersion = '2026-11-12-stadtvergleich';

  test.each([
    'js/ua.utils.js',
    'js/ua.lifecycle.js',
    'js/ua.priorities.js',
  ])('%s uses the current cache buster', (asset) => {
    expect(html).toContain(`${asset}?v=${version}`);
  });

  test.each([
    'js/ua.preview_map_renderer.js',
  ])('%s invalidates the cache for unified map controls', asset => {
    expect(html).toContain(`${asset}?v=2026-11-08-scalable-catalogue"`);
  });

  test('uses the verified AI proposal rollout version', () => {
    expect(html).toContain('js/ua.ai_proposal.js?v=2026-11-07-ris"');
  });

  test.each([
    'js/ua.context_road_layer.js', 'js/ua.map_scene_url_codec.js', 'js/ua.tour.js',
  ])('%s refreshes the mobility layers and compact map controls', asset => {
    expect(html).toContain(`${asset}?v=2026-11-09-mobility"`);
  });

  test('refreshes the map registry with the verified LGLN imagery layer', () => {
    expect(html).toContain('js/ua.map_layer_registry.js?v=2026-11-11-kartenlesbarkeit"');
  });

  test('site discovery is available from the ordinary Werkbank entry point', () => {
    const scripts = [...html.matchAll(/<script[^>]+src="([^"?]+)/g)].map(match => match[1]);
    expect(html).toContain('id="btnDiscover"');
    expect(html).toContain('css/ua.site-discovery.css?v=2026-11-10-site-discovery');
    for (const script of ['js/ua.site_discovery.js', 'js/ua.facility_context.js', 'js/ua.site_discovery_ui.js']) {
      expect(scripts).toContain(script);
      expect(scripts.indexOf(script)).toBeLessThan(scripts.indexOf('js/ua.app_v2.js'));
    }
    expect(scripts.indexOf('js/ua.site_discovery.js')).toBeLessThan(scripts.indexOf('js/ua.report_v2.js'));
    expect(scripts.indexOf('js/ua.facility_context.js')).toBeLessThan(scripts.indexOf('js/ua.export_v2.js'));
  });

  test.each(['ua.site_discovery', 'ua.hannover_layers'])
  ('%s loads the local evidence and motion update', asset => {
    const version = asset === 'ua.hannover_layers' ? '2026-11-11-terrain-references' : '2026-11-10-site-evidence';
    expect(html).toContain('js/' + asset + '.js?v=' + version + '"');
  });

  test('loads the version that can recover an interrupted network selection', () => {
    expect(html).toContain('js/ua.review_network.js?v=2026-11-11-network-loading"');
  });

  test('loads the published OSM road context for applications', () => {
    expect(html).toContain('js/ua.context_layers.js?v=2026-11-13-road-risk-quality"');
  });

  test('loads the documented cost model and the source-checked renderers', () => {
    expect(html).toContain('js/ua.costs.js?v=2026-11-11-kostenmodell"');
    for (const asset of ['ua.stats', 'ua.export_v2', 'ua.report_v2']) {
      expect(html).toContain(`js/${asset}.js?v=${patternComparisonVersion}"`);
    }
  });

  test('loads the matching Word report, map capture and accident point renderers', () => {
    expect(html).toContain('js/ua.state.js?v=2026-11-11-evidence-links"');
    expect(html).toContain('js/ua.data_paths.js?v=2026-11-13-radzaehlung"');
    const paths = fs.readFileSync(path.resolve(__dirname, '../../js/ua.data_paths.js'), 'utf8');
    expect(paths).toContain('js/ua.evidence_cohort.js?v=2026-11-11-kartenlesbarkeit');
    expect(bootstrap).toContain('ua.map_capture_tile_integrity.js?v=2026-11-11-word-maps');
  });

  test('loads the semantic rules for source-checked report text', () => {
    expect(html).toContain('js/ua.bootstrap.js?v=2026-11-11-antragsbelege"');
    expect(bootstrap).toContain('ua.evidence_safe_semantics.js?v=2026-11-11-antragsbelege');
  });

  test('loads optional review-network support before site selection and document export', () => {
    const scripts = [...html.matchAll(/<script[^>]+src="([^"?]+)/g)].map(match => match[1]);
    const registry = scripts.indexOf('js/ua.review_network.js');
    expect(registry).toBeGreaterThan(scripts.indexOf('js/ua.data_paths.js'));
    expect(registry).toBeGreaterThan(scripts.indexOf('js/ua.site_discovery.js'));
    expect(registry).toBeLessThan(scripts.indexOf('js/ua.site_discovery_ui.js'));
    expect(registry).toBeLessThan(scripts.indexOf('js/ua.export_v2.js'));
  });

  test('loads the current discovery app and orthophoto fallback', () => {
    expect(html).toContain('js/ua.app_v2.js?v=2026-11-11-kartenlesbarkeit"');
    expect(html).toContain('js/ua.site_discovery_ui.js?v=2026-11-11-kartenlesbarkeit"');
    expect(html).toContain('js/ua.map_v2.js?v=2026-11-13-radzaehlung"');
  });

  test('loads the matching evidence map controls and marker styles', () => {
    expect(html).toContain('css/ua.css?v=2026-11-11-kartenlesbarkeit"');
    expect(html).toContain('js/ua.ui.js?v=2026-11-11-kartenlesbarkeit"');
  });

  test.each([
    'css/ris-record-view.css',
    'js/ua.filters.js', 'js/ua.map_scene.js', 'js/ua.map_store.js',
    'js/ua.political-context.js', 'js/ua.ris-catalogue.js',
    'js/ua.ris-details.js', 'js/ua.ris-layer.js', 'js/ua.ris-partitions.js', 'js/ua.ris-sources.js',
    'js/ua.video-export.js',
  ])('%s loads the same map and RIS repair version', asset => {
    expect(html).toContain(`${asset}?v=2026-11-10-ris-map"`);
  });

  test('refreshes the loader for versioned document provenance', () => {
    const legacy = fs.readFileSync(path.resolve(__dirname, '../../werkbank.html'), 'utf8');
    expect(html).toContain('js/ua.core.js?v=2026-11-13-dgm1-provenance"');
    expect(legacy).toContain('js/ua.core.js?v=2026-11-13-dgm1-provenance"');
  });

  test.each(['js/ua.context_measures.js', 'js/ua.osm_context.js'])
  ('%s refreshes application exports and local evidence', asset => {
    expect(html).toContain(`${asset}?v=2026-11-10-antrag-quality"`);
  });

  test('lazy analysis and capture use the current display and readiness contract', () => {
    const dataPaths = fs.readFileSync(path.resolve(__dirname, '../../js/ua.data_paths.js'), 'utf8');
    expect(dataPaths).toContain(`js/ua.analysis_scope.js?v=${patternComparisonVersion}'`);
    expect(dataPaths).toContain('js/ua.visible_tile_readiness.js?v=2026-11-10-ris-map');
  });

  test('the canonical template asset loads the current defaults', () => {
    expect(html).toContain(`js/ua.export_template_defaults.js?v=${patternComparisonVersion}"`);
  });

  test.each(['js/ua.area_name_control.js'])('%s refreshes confirmed research scope', asset => {
    expect(html).toContain(`${asset}?v=2026-11-08-area-research"`);
  });

  test('lazy AI political evidence refreshes the confirmed research context', () => {
    const paths = fs.readFileSync(path.resolve(__dirname, '../../js/ua.data_paths.js'), 'utf8');
    expect(paths).toContain('js/ua.ai_political_evidence.js?v=2026-11-08-area-research');
    expect(paths).toContain(`js/ua.ai_political_reference_bridge.js?v=${patternComparisonVersion}'`);
  });

  test('loads the RIS URL and document views with the traffic-situation contract', () => {
    expect(html).toContain('js/ua.ris_view_state.js?v=2026-11-09-ris-workspace"');
    expect(html).toContain('js/ua.ris-record-view.js?v=2026-11-09-ris-workspace"');
    expect(html).toContain('js/ua.traffic_situation.js?v=2026-11-08-ris-view"');
  });

  test('shared spatial budgets and partitions load before their consumers', () => {
    const scripts = [...html.matchAll(/<script[^>]+src="([^"?]+)/g)].map(match => match[1]);
    for (const shared of ['js/ua.spatial-grid.js', 'js/ua.data-budget.js']) {
      expect(scripts.indexOf(shared)).toBeGreaterThanOrEqual(0);
      for (const consumer of ['js/ua.context_layers.js', 'js/ua.accident_provider.js', 'js/ua.ris-partitions.js']) {
        expect(scripts.indexOf(shared)).toBeLessThan(scripts.indexOf(consumer));
      }
    }
    expect(scripts.indexOf('js/ua.ris-sources.js')).toBeGreaterThanOrEqual(0);
    expect(scripts.indexOf('js/ua.ris-sources.js')).toBeLessThan(scripts.indexOf('js/ua.ris-catalogue.js'));
    expect(scripts.indexOf('js/ua.ris-partitions.js')).toBeLessThan(scripts.indexOf('js/ua.ris-catalogue.js'));
    expect(scripts.indexOf('js/ua.political-context.js')).toBeLessThan(scripts.indexOf('js/ua.app_v2.js'));
    expect(html).toContain('js/ua.duesseldorf_bike_counts.js?v=2026-11-13-radzaehlung"');
    expect(scripts.indexOf('js/ua.duesseldorf_bike_counts.js')).toBeGreaterThan(scripts.indexOf('js/ua.data_paths.js'));
    expect(scripts.indexOf('js/ua.duesseldorf_bike_counts.js')).toBeLessThan(scripts.indexOf('js/ua.map_v2.js'));
    expect(scripts.indexOf('js/ua.hannover_layers.js')).toBeGreaterThan(scripts.indexOf('js/ua.data_paths.js'));
    expect(scripts.indexOf('js/ua.hannover_layers.js')).toBeLessThan(scripts.indexOf('js/ua.map_v2.js'));
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


test.each(['ua.popup_context',
  'ua.elevation_provider', 'ua.source_manifest', 'ua.traffic_provider'])('context semantics refreshes browser cache for %s', name => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../werkbank_v2.html'), 'utf8');
  const version = ['ua.elevation_provider', 'ua.popup_context'].includes(name) ? '2026-11-13-road-risk-quality' : '2026-11-08-context';
  expect(html.includes(`js/${name}.js?v=${version}`)).toBe(true);
});
test('dynamic export provenance invalidates the old accident-only implementation', () => {
  const core = fs.readFileSync(path.resolve(__dirname, '../../js/ua.core.js'), 'utf8');
  for (const name of ['ua.artifact_provenance', 'ua.export_provenance', 'ua.kml_export_provenance', 'ua.document_export_provenance']) {
    const version = name === 'ua.export_provenance' ? '2026-11-13-dgm1-reasons' : name === 'ua.document_export_provenance' ? '2026-11-10-antrag-quality' : name === 'ua.kml_export_provenance' ? '2026-11-08-typed-context-export' : '2026-11-08-source-note-links';
    expect(core).toContain(`${name}.js?v=${version}`);
  }
});
