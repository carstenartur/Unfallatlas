'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

function testBlock(source, title, nextTitle) {
  const start = source.indexOf(title);
  if (start < 0) throw new Error('Missing test block: ' + title);  const end = nextTitle ? source.indexOf(nextTitle, start + title.length) : source.length;
  if (end < 0) throw new Error('Missing next test block: ' + nextTitle);
  return source.slice(start, end);
}

describe('featured README media stays visibly informative', () => {
  const screenshotSpec = read('tests/e2e/screenshots.spec.js');
  const readme = read('README.md');
  const documentation = read('docs/DOKUMENTATION.md');
  const manifest = JSON.parse(read('docs/media-manifest.json'));

  test('Bonn Hbf combines a painted heatmap with visible numbered accident clusters', () => {
    const block = testBlock(
      screenshotSpec,
      "test('13 Bonn Hauptbahnhof",
      "test('14 Export mit Filterkontext'"
    );
    expect(block).toContain('setViewportSize({ width: 1280, height: 640 })');
    expect(block).toContain('showCluster=1&showHeatmap=1');
    expect(block).toContain("layers: ['cluster', 'heatmap']");
    expect(block).toContain('assertFeaturedAccidentSignal(page, { minimumClusters: 5 })');
    expect(readme).toContain('showCluster=1&showHeatmap=1');
    expect(documentation).toContain('showCluster=1&showHeatmap=1');
  });

  test('the report dialog retains visible map and accident context', () => {
    const block = testBlock(
      screenshotSpec,
      "test('14 Export mit Filterkontext'",
      "test('16 Antrag-Inhalt"
    );
    expect(block).toContain('setViewportSize({ width: 1774, height: 887 })');
    expect(block).toContain('outsideModal: true');
    expect(block).toContain('minimumClusters: 3');
  });

  test('the PDF documentation image selects a proposal page and a map page', () => {
    const block = testBlock(
      screenshotSpec,
      "test('15 PDF-Export",
      null
    );
    expect(block).toContain("expect(page.locator('#cbIncludeMap')).toBeChecked()");
    expect(block).not.toContain("page.locator('#cbIncludeMap').uncheck()");
    expect(block).toContain('id="pdf-spread"');
    expect(block).toContain("text.includes('ANTRAG / BESCHLUSSVORSCHLAG')");
    expect(block).toContain("text.includes('Abbildung 1: Übersichtskarte')");
    expect(block).toContain("text.includes('Abbildung 2: Auswahl-Karte')");
    expect(block).toContain('spreadPageNumbers = [proposalPageNumber, mapPageNumber]');
    expect(block).not.toContain('spreadPageNumbers = [1, 2]');
    expect(block).toContain("page.locator('#pdf-spread').screenshot");
  });

  test.each([
    ['docs/screenshots/13-bonn-hbf-radunfaelle.png', { width: 1280, height: 640 }],
    ['docs/screenshots/14-export-filterkontext.png', { width: 1774, height: 887 }],
    ['docs/screenshots/15-export-pdf-rendered.png', { width: 1774, height: 887 }],
  ])('%s uses its reviewed documentation viewport', (assetPath, target) => {
    const asset = manifest.assets.find((candidate) => candidate.path === assetPath);
    expect(asset).toBeDefined();
    expect(asset.target).toEqual(target);
  });

  test('selection fill remains transparent enough not to hide the heatmap', () => {
    expect(read('js/ua.ui.js')).toContain('fillOpacity:0.06');
  });
});
