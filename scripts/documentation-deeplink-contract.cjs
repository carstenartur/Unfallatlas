'use strict';

const fs = require('fs');
const path = require('path');

const LIVE_ORIGIN = 'https://carstenartur.github.io';
const LIVE_PATH = '/Unfallatlas/werkbank_v2.html';

class DocumentationDeepLinkError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'DocumentationDeepLinkError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new DocumentationDeepLinkError(code, message, details);
}

function normalizeImagePath(sourceFile, imagePath) {
  return path.posix
    .normalize(path.posix.join(path.posix.dirname(sourceFile.replace(/\\/g, '/')), imagePath))
    .replace(/^\.\//, '');
}

function extractLinkedScreenshots(markdown, sourceFile) {
  const links = [];
  const pattern = /\[!\[([^\]]*)\]\(([^)]+\.png)\)\]\((https:\/\/carstenartur\.github\.io\/Unfallatlas\/werkbank_v2\.html[^)]*)\)/g;
  let match;
  while ((match = pattern.exec(String(markdown || '')))) {
    let url;
    try {
      url = new URL(match[3].replaceAll('&amp;', '&'));
    } catch (error) {
      fail('invalid_documentation_url', `Invalid screenshot URL in ${sourceFile}`, {
        value: match[3], cause: error.message,
      });
    }
    links.push(Object.freeze({
      sourceFile,
      altText: match[1],
      imagePath: normalizeImagePath(sourceFile, match[2]),
      url: url.href,
      index: match.index,
    }));
  }
  return Object.freeze(links);
}

function query(values) {
  return Object.freeze(Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, String(value)]),
  ));
}

const SCENARIOS = Object.freeze({
  'docs/screenshots/01-startansicht.png': Object.freeze({
    id: 'readme-start',
    description: 'Generische Startansicht Hannover mit Cluster und Heatmap',
    query: query({}),
    expected: Object.freeze({
      city: 'Hannover', involvementMode: 'or', showCluster: true, showHeatmap: true,
      minimumAllPoints: 1,
    }),
  }),
  'docs/screenshots/04-cluster-ansicht.png': Object.freeze({
    id: 'readme-cluster',
    description: 'Reine Clusteransicht Hannover ohne Heatmap und POI-Overlays',
    // The current README points to the generic URL. Keep the literal link under
    // test and declare only the exact known state discrepancy. Page/runtime/data
    // errors still fail hard. Issue #509 removes this waiver.
    query: query({}),
    knownMismatch: Object.freeze({
      issue: 509,
      reason: 'README cluster screenshot currently links to the generic cluster+heatmap start state',
      actual: Object.freeze({
        showCluster: true,
        showHeatmap: true,
        showSchools: true,
        showKindergartens: true,
        showArgumentation: true,
      }),
    }),
    expected: Object.freeze({
      city: 'Hannover', involvementMode: 'or', showCluster: true, showHeatmap: false,
      showSchools: false, showKindergartens: false, showArgumentation: false,
      minimumAllPoints: 1, minimumViewportPoints: 1,
    }),
  }),
  'docs/screenshots/07-export-modal.png': Object.freeze({
    id: 'readme-export',
    description: 'Automatisch geöffneter und fertig gerenderter Exportdialog',
    query: query({ export: 1 }),
    expected: Object.freeze({
      city: 'Hannover', exportOpen: true, exportReady: true, minimumAllPoints: 1,
    }),
  }),
  'docs/screenshots/12-poi-schulen-kitas.png': Object.freeze({
    id: 'readme-poi-school-route',
    description: 'Bonn Rad/Fuß 6–18 Uhr mit sichtbaren Schul-/Kita-POIs',
    query: query({
      city: 'Bonn', includeCyclist: 1, includePedestrian: 1, includeCar: 0,
      includeMotorcycle: 0, involvementMode: 'or', showCluster: 1,
      showHeatmap: 0, showOnlyAboveAverage: 0, severity: 'all', dayType: 'all',
      roadCondition: 'all', hourFrom: 6, hourTo: 18, centerLat: '50.7350',
      centerLon: '7.0950', zoom: 16,
    }),
    expected: Object.freeze({
      city: 'Bonn', involvementMode: 'or',
      filters: Object.freeze({ bike: true, pedestrian: true, car: false, motorcycle: false }),
      hourFrom: 6, hourTo: 18, showCluster: true, showHeatmap: false,
      center: Object.freeze({ lat: 50.7350, lon: 7.0950, tolerance: 0.0025 }),
      zoom: 16, minimumAllPoints: 1, minimumViewportPoints: 1,
      minimumPoiFeatures: 1, minimumVisiblePoiLayers: 1,
    }),
  }),
  'docs/screenshots/13-bonn-hbf-radunfaelle.png': Object.freeze({
    id: 'readme-bonn-hbf',
    description: 'Bonn Hbf Rad/Pkw UND, Heatmap und markierter Bereich',
    query: query({
      city: 'Bonn', includeCyclist: 1, includePedestrian: 0, includeCar: 1,
      includeMotorcycle: 0, involvementMode: 'and', showCluster: 0,
      showHeatmap: 1, showOnlyAboveAverage: 0, severity: 'all', dayType: 'all',
      roadCondition: 'all', hourFrom: 0, hourTo: 23, centerLat: '50.7326',
      centerLon: '7.0963', zoom: 16, selSouth: '50.7300', selWest: '7.0910',
      selNorth: '50.7355', selEast: '7.1010',
    }),
    expected: Object.freeze({
      city: 'Bonn', involvementMode: 'and',
      filters: Object.freeze({ bike: true, pedestrian: false, car: true, motorcycle: false }),
      hourFrom: 0, hourTo: 23, showCluster: false, showHeatmap: true,
      center: Object.freeze({ lat: 50.7326, lon: 7.0963, tolerance: 0.0025 }),
      zoom: 16,
      selection: Object.freeze({
        south: 50.7300, west: 7.0910, north: 50.7355, east: 7.1010,
        tolerance: 0.0001,
      }),
      minimumAllPoints: 1, minimumViewportPoints: 1, minimumSelectionPoints: 1,
    }),
  }),
});

function assertCanonicalUrl(link, scenario) {
  const url = new URL(link.url);
  if (url.origin !== LIVE_ORIGIN || url.pathname !== LIVE_PATH) {
    fail('unexpected_live_target', `${link.imagePath} does not target the canonical live application`, {
      sourceFile: link.sourceFile, url: link.url,
    });
  }
  for (const [key, value] of Object.entries(scenario.query)) {
    if (url.searchParams.get(key) !== value) {
      fail('documentation_query_mismatch', `${link.imagePath} has an incorrect ${key} parameter`, {
        sourceFile: link.sourceFile, expected: value,
        actual: url.searchParams.get(key), url: link.url,
      });
    }
  }
  const unexpected = [...url.searchParams.keys()].filter((key) => !(key in scenario.query));
  if (unexpected.length) {
    fail('unexpected_documentation_query', `${link.imagePath} contains undeclared parameters`, {
      sourceFile: link.sourceFile, unexpected, url: link.url,
    });
  }
}

function validateDocumentationLinks(rootDir = process.cwd()) {
  const sourceFile = 'README.md';
  const links = extractLinkedScreenshots(
    fs.readFileSync(path.join(rootDir, sourceFile), 'utf8'),
    sourceFile,
  );
  const relevant = links.filter((link) => SCENARIOS[link.imagePath]);
  const byImage = new Map();
  for (const link of relevant) {
    const scenario = SCENARIOS[link.imagePath];
    assertCanonicalUrl(link, scenario);
    if (!byImage.has(link.imagePath)) byImage.set(link.imagePath, []);
    byImage.get(link.imagePath).push(link);
  }

  const liveScenarios = Object.entries(SCENARIOS).map(([imagePath, scenario]) => {
    const imageLinks = byImage.get(imagePath) || [];
    if (!imageLinks.length) fail('missing_readme_screenshot_link', `${imagePath} is missing from README.md`);
    const targets = new Set(imageLinks.map((link) => link.url));
    if (targets.size !== 1) {
      fail('inconsistent_readme_targets', `${imagePath} links to multiple live states`, { links: imageLinks });
    }
    return Object.freeze({
      imagePath,
      ...scenario,
      url: imageLinks[0].url,
      references: Object.freeze(imageLinks.map((link) => Object.freeze({
        sourceFile: link.sourceFile, altText: link.altText, url: link.url,
      }))),
    });
  });

  return Object.freeze({ links, relevant, liveScenarios: Object.freeze(liveScenarios) });
}

module.exports = Object.freeze({
  LIVE_ORIGIN,
  LIVE_PATH,
  SCENARIOS,
  DocumentationDeepLinkError,
  normalizeImagePath,
  extractLinkedScreenshots,
  assertCanonicalUrl,
  validateDocumentationLinks,
});
