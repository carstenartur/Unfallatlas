'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const contract = require('../../scripts/documentation-deeplink-contract.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'unfallwerkbank-deeplinks-'));
}

describe('documentation screenshot deep-link contract', () => {
  test('normalizes README and nested documentation image paths', () => {
    expect(contract.normalizeImagePath('README.md', 'docs/screenshots/01-startansicht.png'))
      .toBe('docs/screenshots/01-startansicht.png');
    expect(contract.normalizeImagePath('docs/DOKUMENTATION.md', 'screenshots/01-startansicht.png'))
      .toBe('docs/screenshots/01-startansicht.png');
  });

  test('extracts linked screenshots without treating ordinary image links as scenarios', () => {
    const markdown = [
      '[![Bonn](docs/screenshots/13-bonn-hbf-radunfaelle.png)]' +
        '(https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn)',
      '[![Static](docs/screenshots/static.png)](docs/screenshots/static.png)',
    ].join('\n');
    const links = contract.extractLinkedScreenshots(markdown, 'README.md');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      altText: 'Bonn',
      imagePath: 'docs/screenshots/13-bonn-hbf-radunfaelle.png',
    });
  });

  test('rejects wrong, missing and undeclared query parameters', () => {
    const scenario = {
      query: { city: 'Bonn', showHeatmap: '1' },
    };
    const base = {
      sourceFile: 'README.md',
      imagePath: 'docs/screenshots/example.png',
    };
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

  test('loads the current README as five unique live scenarios', () => {
    const result = contract.validateDocumentationLinks(process.cwd());
    expect(result.liveScenarios.map((scenario) => scenario.id)).toEqual([
      'readme-start',
      'readme-cluster',
      'readme-export',
      'readme-poi-school-route',
      'readme-bonn-hbf',
    ]);
    expect(new Set(result.liveScenarios.map((scenario) => scenario.url)).size).toBe(4);
    expect(result.liveScenarios.find((scenario) => scenario.id === 'readme-cluster'))
      .toMatchObject({ knownMismatch: { issue: 509 } });
  });

  test('fails closed when a required screenshot link disappears', () => {
    const directory = tempDir();
    try {
      fs.writeFileSync(path.join(directory, 'README.md'), '# no linked screenshots\n');
      expect(() => contract.validateDocumentationLinks(directory))
        .toThrow(/missing_readme_screenshot_link/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
