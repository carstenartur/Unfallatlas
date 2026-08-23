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

function imagePathFor(sourceFile, repositoryPath) {
  return sourceFile === 'README.md'
    ? repositoryPath
    : path.posix.relative(path.posix.dirname(sourceFile), repositoryPath);
}

function canonicalDocuments() {
  const documents = new Map(contract.DOCUMENTATION_FILES.map((sourceFile) => [sourceFile, []]));
  const screenshots = Object.entries(contract.SCREENSHOT_SCENARIOS);
  screenshots.forEach(([repositoryPath, scenario], index) => {
    const sourceFile = index % 2 === 0 ? 'README.md' : 'docs/DOKUMENTATION.md';
    documents.get(sourceFile).push(
      `[![${scenario.id}](${imagePathFor(sourceFile, repositoryPath)})](${scenarioUrl(scenario)})`,
    );
  });
  for (const scenario of contract.ACTION_SCENARIOS) {
    documents.get(scenario.sourceFile || 'README.md')
      .push(`[${scenario.label}](${scenarioUrl(scenario)})`);
  }
  return documents;
}

function writeDocuments(directory, documents = canonicalDocuments()) {
  for (const [sourceFile, content] of documents) {
    const target = path.join(directory, sourceFile);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${content.join('\n')}\n`);
  }
}

describe('documentation live-link contract', () => {
  test('normalizes README and nested documentation image paths', () => {
    expect(contract.normalizeImagePath('README.md', 'docs/screenshots/04-cluster-ansicht.png'))
      .toBe('docs/screenshots/04-cluster-ansicht.png');
    expect(contract.normalizeImagePath('docs/DOKUMENTATION.md', 'screenshots/04-cluster-ansicht.png'))
      .toBe('docs/screenshots/04-cluster-ansicht.png');
  });

  test('extracts screenshot media separately from live-linked screenshots', () => {
    const markdown = [
      '[![Live](docs/screenshots/12-poi-schulen-kitas.png)]' +
        '(https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn)',
      '[![Static](docs/screenshots/static.png)](docs/screenshots/static.png)',
    ].join('\n');
    expect(contract.extractScreenshotMedia(markdown, 'README.md')).toHaveLength(2);
    const links = contract.extractLinkedScreenshots(markdown, 'README.md');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      altText: 'Live',
      imagePath: 'docs/screenshots/12-poi-schulen-kitas.png',
    });
  });

  test('requires PNG and GIF media in both user-facing documents to be clickable', () => {
    expect(() => contract.assertAllDocumentationMediaLinked(
      '![Nicht verlinkt](docs/screenshots/example.png)',
      'README.md',
    )).toThrow(/unlinked_documentation_media/);

    expect(() => contract.assertAllDocumentationMediaLinked(
      '[![Verlinkt](screenshots/example.png)](https://example.invalid/)',
      'docs/DOKUMENTATION.md',
    )).not.toThrow();

    expect(contract.assertAllReadmeMediaLinked)
      .toBe(contract.assertAllDocumentationMediaLinked);
  });

  test('extracts one explicitly named action link', () => {
    const scenario = contract.ACTION_SCENARIOS[0];
    const link = contract.extractNamedAction(
      `[${scenario.label}](${scenarioUrl(scenario)})`,
      scenario.sourceFile,
      scenario.label,
    );
    expect(link).toMatchObject({
      kind: 'action',
      label: scenario.label,
      url: scenarioUrl(scenario),
    });
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

  test('rejects a map center outside the documented selection', () => {
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

  test('loads a two-document fixture and deduplicates live screenshot checks', () => {
    const directory = tempDir();
    try {
      writeDocuments(directory);
      const result = contract.validateDocumentationLinks(directory);
      expect(new Set(result.liveScenarios.map((scenario) => scenario.id))).toEqual(new Set([
        'docs-cluster-hannover',
        'docs-selection-bonn',
        'docs-poi-bonn',
        'readme-start',
        'readme-export',
        'readme-bonn-hbf',
      ]));
      expect(result.liveScenarios).toHaveLength(Object.keys(contract.SCENARIOS).length);
      expect(result.links.length).toBeGreaterThan(result.liveScenarios.length);
      expect(result.documents).toEqual(contract.DOCUMENTATION_FILES);
      expect(result.liveScenarios.find((scenario) => scenario.id === 'readme-export'))
        .toMatchObject({ expected: { publicPreview: true, hourFrom: 6, hourTo: 18 } });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects a screenshot that is linked only to its PNG file', () => {
    const directory = tempDir();
    try {
      const documents = canonicalDocuments();
      const sourceFile = 'README.md';
      const lines = documents.get(sourceFile);
      const index = lines.findIndex((line) => line.includes('04-cluster-ansicht.png'));
      lines[index] = '[![Cluster](docs/screenshots/04-cluster-ansicht.png)]' +
        '(docs/screenshots/04-cluster-ansicht.png)';
      writeDocuments(directory, documents);
      expect(() => contract.validateDocumentationLinks(directory))
        .toThrow(/invalid_documentation_url|unexpected_live_target/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects an undocumented screenshot scenario', () => {
    const directory = tempDir();
    try {
      const documents = canonicalDocuments();
      documents.get('docs/DOKUMENTATION.md').push(
        '[![Unbekannt](screenshots/99-unknown.png)]' +
        '(https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn)',
      );
      writeDocuments(directory, documents);
      expect(() => contract.validateDocumentationLinks(directory))
        .toThrow(/undocumented_screenshot_scenario/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('fails closed when a documentation file or required screenshot disappears', () => {
    const directory = tempDir();
    try {
      writeDocuments(directory);
      fs.unlinkSync(path.join(directory, 'docs/DOKUMENTATION.md'));
      expect(() => contract.validateDocumentationLinks(directory)).toThrow();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }

    const secondDirectory = tempDir();
    try {
      const documents = canonicalDocuments();
      for (const lines of documents.values()) {
        const index = lines.findIndex((line) => line.includes('24-mapmode-analysis.png'));
        if (index >= 0) lines.splice(index, 1);
      }
      writeDocuments(secondDirectory, documents);
      expect(() => contract.validateDocumentationLinks(secondDirectory))
        .toThrow(/missing_documented_screenshot/);
    } finally {
      fs.rmSync(secondDirectory, { recursive: true, force: true });
    }
  });
});
