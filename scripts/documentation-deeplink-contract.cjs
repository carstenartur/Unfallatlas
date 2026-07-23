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
    links.push(Object.freeze({
      kind: 'screenshot', sourceFile, altText: match[1],
      imagePath: normalizeImagePath(sourceFile, match[2]),
      url: parseUrl(match[3], sourceFile), index: match.index,
    }));
  }
  return Object.freeze(links);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractNamedAction(markdown, sourceFile, label) {
  const pattern = new RegExp(`\\[${escapeRegExp(label)}\\]\\((https:\\/\\/carstenartur\\.github\\.io\\/Unfallatlas\\/werkbank_v2\\.html[^)]*)\\)`, 'g');
  const matches = [...String(markdown || '').matchAll(pattern)];
  if (matches.length !== 1) {
    fail('invalid_action_link_count', `Expected exactly one README action link: ${label}`, {
      sourceFile, label, count: matches.length,
    });
  }
  return Object.freeze({
    kind: 'action', sourceFile, label, imagePath: null,
    url: parseUrl(matches[0][1], sourceFile), index: matches[0].index,
  });
}

function parseUrl(raw, sourceFile) {
  try {
    return new URL(String(raw).replaceAll('&amp;', '&')).href;
  } catch (error) {
    fail('invalid_documentation_url', `Invalid live URL in ${sourceFile}`, {
      value: raw, cause: error.message,
    });
  }
}

function query(values) {
  return Object.freeze(Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, String(value)]),
  ));
}

const SCREENSHOT_SCENARIOS = Object.freeze({
  'docs/screenshots/04-cluster-ansicht.png': Object.freeze({
    id: 'readme-cluster',
    description: 'Reine Clusteransicht Hannover ohne Heatmap und POI-Overlays',
    query: query({
      city: 'Hannover', showCluster: 1, showHeatmap: 0,
      showSchools: 0, showKindergartens: 0, showArgumentation: 0,
    }),
    expected: Object.freeze({
      city: 'Hannover', involvementMode: 'or', showCluster: true, showHeatmap: false,
      showSchools: false, showKindergartens: false, showArgumentation: false,
      minimumAllPoints: 1, minimumViewportPoints: 1,
    }),
  }),
  'docs/screenshots/12-poi-schulen-kitas.png': Object.freeze({
    id: 'readme-poi-school-route',
    description: 'Bonn Rad/Fuß ganztägig mit sichtbaren Schul-/Kita-POIs',
    query: query({
      city: 'Bonn', includeCyclist: 1, includePedestrian: 1, includeCar: 0,
      includeMotorcycle: 0, involvementMode: 'or', showCluster: 1,
      showHeatmap: 0, showOnlyAboveAverage: 0, severity: 'all', dayType: 'all',
      roadCondition: 'all', hourFrom: 0, hourTo: 23, centerLat: '50.7350',
      centerLon: '7.0950', zoom: 16,
    }),
    expected: Object.freeze({
      city: 'Bonn', involvementMode: 'or',
      filters: Object.freeze({ bike: true, pedestrian: true, car: false, motorcycle: false }),
      hourFrom: 0, hourTo: 23, showCluster: true, showHeatmap: false,
      center: Object.freeze({ lat: 50.7350, lon: 7.0950, tolerance: 0.0025 }),
      zoom: 16, minimumAllPoints: 1, minimumViewportPoints: 1,
      minimumPoiFeatures: 1, minimumVisiblePoiLayers: 1,
    }),
  }),
});

const PUBLIC_START_QUERY = query({
  city: 'Hannover', severity: 'all', dayType: 'all', roadCondition: 'all',
  hourFrom: 0, hourTo: 23, maxPoints: 100000, viewportPaddingPct: 20,
  heatRadius: 25, includeCyclist: 1, includePedestrian: 1, includeCar: 1,
  includeMotorcycle: 0, includeGkfz: 0, includeSonstig: 0,
  involvementMode: 'or', showCluster: 1, showHeatmap: 0,
  showOnlyAboveAverage: 0, showSchools: 1, showKindergartens: 1,
  showArgumentation: 1, mapMode: 'standard', orthophotoOpacity: 92,
  centerLat: '52.3759', centerLon: '9.7320', zoom: 12,
});

const ACTION_SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'readme-start',
    label: '→ Öffentliche Kernvorschau öffnen',
    description: 'Explizite öffentliche Startansicht Hannover im reduzierten Pages-Profil',
    query: PUBLIC_START_QUERY,
    expected: Object.freeze({
      city: 'Hannover', involvementMode: 'or', showCluster: true, showHeatmap: false,
      showSchools: true, showKindergartens: true, showArgumentation: true,
      filters: Object.freeze({ bike: true, pedestrian: true, car: true, motorcycle: false }),
      hourFrom: 0, hourTo: 23,
      center: Object.freeze({ lat: 52.3759, lon: 9.7320, tolerance: 0.0025 }),
      zoom: 12, minimumAllPoints: 1, minimumViewportPoints: 1, publicPreview: true,
    }),
  }),
  Object.freeze({
    id: 'readme-export',
    label: '→ Öffentliche Exportansicht öffnen',
    description: 'Öffentlicher Exportdialog mit drei Datenexporten und erklärter Voll-Build-Grenze',
    query: query({ export: 1 }),
    expected: Object.freeze({
      city: 'Hannover', exportOpen: true, exportReady: true, minimumAllPoints: 1,
      publicPreview: true, verifyDownloads: true,
    }),
  }),
  Object.freeze({
    id: 'readme-bonn-hbf',
    label: '→ Bonn-Hbf-Analyse in der öffentlichen Vorschau öffnen',
    description: 'Bonn Hbf Rad/Pkw UND, Cluster und markierter Bereich',
    query: query({
      city: 'Bonn', includeCyclist: 1, includePedestrian: 0, includeCar: 1,
      includeMotorcycle: 0, involvementMode: 'and', showCluster: 1,
      showHeatmap: 0, showOnlyAboveAverage: 0, showSchools: 0,
      showKindergartens: 0, showArgumentation: 0, severity: 'all', dayType: 'all',
      roadCondition: 'all', hourFrom: 0, hourTo: 23, centerLat: '50.7326',
      centerLon: '7.0963', zoom: 16, selSouth: '50.7300', selWest: '7.0910',
      selNorth: '50.7355', selEast: '7.1010',
    }),
    expected: Object.freeze({
      city: 'Bonn', involvementMode: 'and',
      filters: Object.freeze({ bike: true, pedestrian: false, car: true, motorcycle: false }),
      hourFrom: 0, hourTo: 23, showCluster: true, showHeatmap: false,
      showSchools: false, showKindergartens: false, showArgumentation: false,
      center: Object.freeze({ lat: 50.7326, lon: 7.0963, tolerance: 0.0025 }),
      zoom: 16,
      selection: Object.freeze({
        south: 50.7300, west: 7.0910, north: 50.7355, east: 7.1010,
        tolerance: 0.0001,
      }),
      minimumAllPoints: 1, minimumViewportPoints: 1, minimumSelectionPoints: 1,
      publicPreview: true,
    }),
  }),
]);

const SCENARIOS = Object.freeze({
  ...SCREENSHOT_SCENARIOS,
  ...Object.fromEntries(ACTION_SCENARIOS.map((scenario) => [`action:${scenario.id}`, scenario])),
});

function assertCanonicalUrl(link, scenario) {
  const url = new URL(link.url);
  if (url.origin !== LIVE_ORIGIN || url.pathname !== LIVE_PATH) {
    fail('unexpected_live_target', `${scenario.id} does not target the canonical live application`, {
      sourceFile: link.sourceFile, url: link.url,
    });
  }
  for (const [key, value] of Object.entries(scenario.query)) {
    if (url.searchParams.get(key) !== value) {
      fail('documentation_query_mismatch', `${scenario.id} has an incorrect ${key} parameter`, {
        sourceFile: link.sourceFile, expected: value,
        actual: url.searchParams.get(key), url: link.url,
      });
    }
  }
  const unexpected = [...url.searchParams.keys()].filter((key) => !(key in scenario.query));
  if (unexpected.length) {
    fail('unexpected_documentation_query', `${scenario.id} contains undeclared parameters`, {
      sourceFile: link.sourceFile, unexpected, url: link.url,
    });
  }
}

function validateDocumentationLinks(rootDir = process.cwd()) {
  const sourceFile = 'README.md';
  const markdown = fs.readFileSync(path.join(rootDir, sourceFile), 'utf8');
  const screenshotLinks = extractLinkedScreenshots(markdown, sourceFile);
  const byImage = new Map();
  for (const link of screenshotLinks) {
    const scenario = SCREENSHOT_SCENARIOS[link.imagePath];
    if (!scenario) continue;
    assertCanonicalUrl(link, scenario);
    if (!byImage.has(link.imagePath)) byImage.set(link.imagePath, []);
    byImage.get(link.imagePath).push(link);
  }

  const liveScenarios = [];
  for (const [imagePath, scenario] of Object.entries(SCREENSHOT_SCENARIOS)) {
    const links = byImage.get(imagePath) || [];
    if (links.length !== 1) {
      fail('invalid_screenshot_link_count', `Expected exactly one linked README screenshot: ${imagePath}`, {
        imagePath, count: links.length,
      });
    }
    liveScenarios.push(Object.freeze({
      imagePath, ...scenario, url: links[0].url,
      references: Object.freeze([Object.freeze({
        sourceFile, altText: links[0].altText, url: links[0].url,
      })]),
    }));
  }

  for (const scenario of ACTION_SCENARIOS) {
    const link = extractNamedAction(markdown, sourceFile, scenario.label);
    assertCanonicalUrl(link, scenario);
    liveScenarios.push(Object.freeze({
      imagePath: null, ...scenario, url: link.url,
      references: Object.freeze([Object.freeze({ sourceFile, label: scenario.label, url: link.url })]),
    }));
  }

  return Object.freeze({
    links: Object.freeze([...screenshotLinks]),
    relevant: Object.freeze(liveScenarios.map((scenario) => scenario.references[0])),
    liveScenarios: Object.freeze(liveScenarios),
  });
}

module.exports = Object.freeze({
  LIVE_ORIGIN, LIVE_PATH, PUBLIC_START_QUERY,
  SCREENSHOT_SCENARIOS, ACTION_SCENARIOS, SCENARIOS,
  DocumentationDeepLinkError, normalizeImagePath, extractLinkedScreenshots,
  extractNamedAction, assertCanonicalUrl, validateDocumentationLinks,
});
