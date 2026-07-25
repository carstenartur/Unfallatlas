'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const contract = require('../../scripts/documentation-deeplink-contract.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'unfallwerkbank-deeplinks-'));
}

function scenarioUrl(scenario) {
  const url = new URL(`${contract.LIVE_ORIGIN}${contract.LIVE_PATH}`);
  for (const [key, value] of Object.entries(scenario.query)) url.searchParams.set(key, value);
  return url.href;
}

function canonicalScenarioMarkdown() {
  const screenshots = Object.entries(contract.SCREENSHOT_SCENARIOS)
    .map(([imagePath, scenario]) => `[![${scenario.id}](${imagePath})](${scenarioUrl(scenario)})`);
  const actions = contract.ACTION_SCENARIOS
    .map((scenario) => `[${scenario.label}](${scenarioUrl(scenario)})`);
  return [...screenshots, ...actions].join('\n');
}

describe('documentation live-link contract', () => {
  test('normalizes README and nested documentation image paths', () => {
    expect(contract.normalizeImagePath('README.md', 'docs/screenshots/01-startansicht.png'))
      .toBe('docs/screenshots/01-startansicht.png');
    expect(contract.normalizeImagePath('docs/DOKUMENTATION.md', 'screenshots/01-startansicht.png'))
      .toBe('docs/screenshots/01-startansicht.png');
  });

  test('extracts only screenshots that actually link to the live application', () => {
    const markdown = [
      '[![Bonn](docs/screenshots/12-poi-schulen-kitas.png)]' +
        '(https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn)',
      '[![Voll-Build](docs/screenshots/13-bonn-hbf-radunfaelle.png)]' +
        '(docs/screenshots/13-bonn-hbf-radunfaelle.png)',
      '[![Static](docs/screenshots/static.png)](docs/screenshots/static.png)',
    ].join('\n');
    const links = contract.extractLinkedScreenshots(markdown, 'README.md');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      altText: 'Bonn',
      imagePath: 'docs/screenshots/12-poi-schulen-kitas.png',
    });
  });

  test('requires every README PNG or GIF to be clickable', () => {
    expect(() => contract.assertAllReadmeMediaLinked(
      '![Nicht verlinkt](docs/screenshots/example.png)',
      'README.md',
    )).toThrow(/unlinked_documentation_media/);

    expect(() => contract.assertAllReadmeMediaLinked(
      '[![Vollbild](docs/screenshots/example.png)](docs/screenshots/example.png)',
      'README.md',
    )).not.toThrow();
  });

  test('extracts one explicitly named public action link', () => {
    const scenario = contract.ACTION_SCENARIOS[0];
    const link = contract.extractNamedAction(
      `[${scenario.label}](${scenarioUrl(scenario)})`,
      'README.md',
      scenario.label,
    );
    expect(link).toMatchObject({ kind: 'action', label: scenario.label, url: scenarioUrl(scenario) });
  });

  test('rejects wrong, missing and undeclared query parameters', () => {
    const scenario = { id: 'example', query: { city: 'Bonn', showHeatmap: '1' } };
    const base = { sourceFile: 'README.md' };
    expect(() => contract.assertCanonicalUrl({
      ...base,
      url: 'https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Hannover&showHeatmap=1',
    }, scenario)).toThrow(/documentation_query_mismatch/);
    expect(() => contract.assertCanonicalUrl({
      ...base,
      url: 'https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn',
    }, scenario)).toThrow(/documentation_query_mismatch/);
    expect(() => contract.assertCanonicalUrl({
      ...base,
      url: 'https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn&showHeatmap=1&extra=1',
    }, scenario)).toThrow(/unexpected_documentation_query/);
  });

  test('rejects a Hannover center combined with a Bonn selection', () => {
    const contradictory = new URL(`${contract.LIVE_ORIGIN}${contract.LIVE_PATH}`);
    contradictory.searchParams.set('city', 'Bonn');
    contradictory.searchParams.set('centerLat', '52.3759');
    contradictory.searchParams.set('centerLon', '9.7320');
    contradictory.searchParams.set('selSouth', '50.7300');
    contradictory.searchParams.set('selWest', '7.0910');
    contradictory.searchParams.set('selNorth', '50.7355');
    contradictory.searchParams.set('selEast', '7.1010');

    expect(() => contract.assertSpatiallyConsistent(contradictory.href, 'README.md'))
      .toThrow(/spatially_inconsistent_documentation_url/);
  });

  test('accepts a center inside its selected area', () => {
    const consistent = new URL(`${contract.LIVE_ORIGIN}${contract.LIVE_PATH}`);
    consistent.searchParams.set('city', 'Bonn');
    consistent.searchParams.set('centerLat', '50.7326');
    consistent.searchParams.set('centerLon', '7.0963');
    consistent.searchParams.set('selSouth', '50.7300');
    consistent.searchParams.set('selWest', '7.0910');
    consistent.searchParams.set('selNorth', '50.7355');
    consistent.searchParams.set('selEast', '7.1010');

    expect(() => contract.assertSpatiallyConsistent(consistent.href, 'README.md'))
      .not.toThrow();
  });

  test('loads an isolated two-screenshot plus three-action README fixture', () => {
    const directory = tempDir();
    try {
      fs.writeFileSync(path.join(directory, 'README.md'), canonicalScenarioMarkdown());
      const result = contract.validateDocumentationLinks(directory);
      expect(new Set(result.liveScenarios.map((scenario) => scenario.id))).toEqual(new Set([
        'readme-start',
        'readme-cluster',
        'readme-export',
        'readme-poi-school-route',
        'readme-bonn-hbf',
      ]));
      expect(new Set(result.liveScenarios.map((scenario) => scenario.url)).size).toBe(4);
      expect(result.liveScenarios.filter((scenario) => scenario.imagePath)).toHaveLength(2);
      expect(result.liveScenarios.find((scenario) => scenario.id === 'readme-export'))
        .toMatchObject({ expected: { publicPreview: true } });
      expect(result.liveScenarios.find((scenario) => scenario.id === 'readme-export').expected.verifyDownloads)
        .toBeUndefined();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('fails closed when a required linked screenshot or named action disappears', () => {
    const directory = tempDir();
    try {
      fs.writeFileSync(path.join(directory, 'README.md'), '# no canonical live links\n');
      expect(() => contract.validateDocumentationLinks(directory))
        .toThrow(/invalid_screenshot_link_count|invalid_action_link_count/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
