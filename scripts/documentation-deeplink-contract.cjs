'use strict';

const fs = require('fs');
const path = require('path');

const LIVE_ORIGIN = 'https://carstenartur.github.io';
const LIVE_PATH = '/Unfallatlas/werkbank_v2.html';
const DOCUMENTATION_FILES = Object.freeze([
  'README.md',
  'docs/DOKUMENTATION.md',
]);

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

function parseUrl(raw, sourceFile) {
  try {
    return new URL(String(raw).replaceAll('&amp;', '&')).href;
  } catch (error) {
    fail('invalid_documentation_url', `Invalid live URL in ${sourceFile}`, {
      value: raw,
      cause: error.message,
    });
  }
}

function extractScreenshotMedia(markdown, sourceFile) {
  const links = [];
  const pattern = /\[!\[([^\]]*)\]\(([^)]+\.png)\)\]\(([^)]+)\)/gi;
  let match;
  while ((match = pattern.exec(String(markdown || '')))) {
    const imagePath = normalizeImagePath(sourceFile, match[2]);
    links.push(Object.freeze({
      kind: 'screenshot',
      sourceFile,
      altText: match[1],
      imagePath,
      rawTarget: match[3],
      index: match.index,
    }));
  }
  return Object.freeze(links);
}

function extractLinkedScreenshots(markdown, sourceFile) {
  return Object.freeze(extractScreenshotMedia(markdown, sourceFile)
    .filter((link) => {
      try {
        const target = new URL(String(link.rawTarget).replaceAll('&amp;', '&'));
        return target.origin === LIVE_ORIGIN && target.pathname === LIVE_PATH;
      } catch (_) {
        return false;
      }
    })
    .map((link) => Object.freeze({
      ...link,
      url: parseUrl(link.rawTarget, sourceFile),
    })));
}

function extractAllLiveLinks(markdown, sourceFile) {
  const links = [];
  const pattern = /\]\((https:\/\/carstenartur\.github\.io\/Unfallatlas\/werkbank_v2\.html[^)]*)\)/g;
  let match;
  while ((match = pattern.exec(String(markdown || '')))) {
    links.push(Object.freeze({
      sourceFile,
      url: parseUrl(match[1], sourceFile),
      index: match.index,
    }));
  }
  return Object.freeze(links);
}

function assertAllDocumentationMediaLinked(markdown, sourceFile = 'README.md') {
  const text = String(markdown || '');
  const pattern = /!\[([^\]]*)\]\(([^)]+\.(?:png|gif))\)/gi;
  let match;
  while ((match = pattern.exec(text))) {
    const before = match.index > 0 ? text[match.index - 1] : '';
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 2);
    if (before !== '[' || after !== '](') {
      fail('unlinked_documentation_media', `${sourceFile} media must be clickable: ${match[2]}`, {
        sourceFile,
        altText: match[1],
        imagePath: normalizeImagePath(sourceFile, match[2]),
        index: match.index,
      });
    }
  }
}

// Kept as a compatibility alias for callers and focused unit tests.
const assertAllReadmeMediaLinked = assertAllDocumentationMediaLinked;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractNamedAction(markdown, sourceFile, label) {
  const pattern = new RegExp(
    `\\[${escapeRegExp(label)}\\]\\((https:\\/\\/carstenartur\\.github\\.io\\/Unfallatlas\\/werkbank_v2\\.html[^)]*)\\)`,
    'g',
  );
  const matches = [...String(markdown || '').matchAll(pattern)];
  if (matches.length !== 1) {
    fail('invalid_action_link_count', `Expected exactly one documentation action link: ${label}`, {
      sourceFile,
      label,
      count: matches.length,
    });
  }
  return Object.freeze({
    kind: 'action',
    sourceFile,
    label,
    imagePath: null,
    url: parseUrl(matches[0][1], sourceFile),
    index: matches[0].index,
  });
}

function resolveApplicationUrl(canonicalUrl, applicationBaseUrl = process.env.DOCUMENTATION_APP_BASE_URL) {
  if (!applicationBaseUrl) return canonicalUrl;
  const canonical = new URL(canonicalUrl);
  const base = new URL(applicationBaseUrl.endsWith('/') ? applicationBaseUrl : `${applicationBaseUrl}/`);
  return new URL(`werkbank_v2.html${canonical.search}`, base).href;
}

function query(values) {
  return Object.freeze(Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, String(value)]),
  ));
}

function assertSpatiallyConsistent(canonicalUrl, sourceFile = 'README.md') {
  const url = new URL(canonicalUrl);
  const centerLat = Number(url.searchParams.get('centerLat'));
  const centerLon = Number(url.searchParams.get('centerLon'));
  const south = Number(url.searchParams.get('selSouth'));
  const west = Number(url.searchParams.get('selWest'));
  const north = Number(url.searchParams.get('selNorth'));
  const east = Number(url.searchParams.get('selEast'));
  const hasCenter = url.searchParams.has('centerLat') && url.searchParams.has('centerLon') &&
    Number.isFinite(centerLat) && Number.isFinite(centerLon);
  const hasSelection = ['selSouth', 'selWest', 'selNorth', 'selEast']
    .every((key) => url.searchParams.has(key)) &&
    [south, west, north, east].every(Number.isFinite) && south < north && west < east;

  if (hasCenter && hasSelection &&
      (centerLat < south || centerLat > north || centerLon < west || centerLon > east)) {
    fail(
      'spatially_inconsistent_documentation_url',
      'Map center lies outside the documented selection bounds',
      {
        sourceFile,
        url: canonicalUrl,
        center: { lat: centerLat, lon: centerLon },
        selection: { south, west, north, east },
      },
    );
  }
}

const PUBLIC_START_QUERY = query({
  "city": "Hannover",
  "severity": "all",
  "dayType": "all",
  "roadCondition": "all",
  "hourFrom": "0",
  "hourTo": "23",
  "maxPoints": "100000",
  "viewportPaddingPct": "20",
  "heatRadius": "25",
  "includeCyclist": "1",
  "includePedestrian": "1",
  "includeCar": "1",
  "includeMotorcycle": "0",
  "includeGkfz": "0",
  "includeSonstig": "0",
  "involvementMode": "or",
  "showCluster": "1",
  "showHeatmap": "0",
  "showOnlyAboveAverage": "0",
  "showSchools": "1",
  "showKindergartens": "1",
  "showArgumentation": "1",
  "mapMode": "standard",
  "orthophotoOpacity": "92",
  "centerLat": "52.3759",
  "centerLon": "9.7320",
  "zoom": "12"
});
const CLUSTER_QUERY = query({
  "city": "Hannover",
  "showCluster": "1",
  "showHeatmap": "0",
  "showSchools": "0",
  "showKindergartens": "0",
  "showArgumentation": "0"
});
const HEATMAP_QUERY = query({
  "city": "Bonn",
  "showHeatmap": "1",
  "showCluster": "0"
});
const SELECTION_QUERY = query({
  "city": "Bonn",
  "includeCyclist": "1",
  "includePedestrian": "1",
  "includeCar": "1",
  "includeMotorcycle": "0",
  "involvementMode": "or",
  "showCluster": "1",
  "showHeatmap": "0",
  "showOnlyAboveAverage": "0",
  "severity": "all",
  "dayType": "all",
  "roadCondition": "all",
  "hourFrom": "0",
  "hourTo": "23",
  "centerLat": "50.7330",
  "centerLon": "7.0950",
  "zoom": "15",
  "selSouth": "50.7300",
  "selWest": "7.0900",
  "selNorth": "50.7360",
  "selEast": "7.1000"
});
const BIKE_CAR_QUERY = query({
  "city": "Bonn",
  "includeCyclist": "1",
  "includePedestrian": "0",
  "includeCar": "1",
  "includeMotorcycle": "0",
  "involvementMode": "and",
  "showCluster": "1",
  "showHeatmap": "0",
  "showOnlyAboveAverage": "0",
  "severity": "all",
  "dayType": "all",
  "roadCondition": "all",
  "hourFrom": "0",
  "hourTo": "23",
  "centerLat": "50.7350",
  "centerLon": "7.1000",
  "zoom": "14"
});
const BIKE_SOLO_QUERY = query({
  "city": "Bonn",
  "includeCyclist": "1",
  "includePedestrian": "0",
  "includeCar": "0",
  "includeMotorcycle": "0",
  "involvementMode": "solo",
  "showCluster": "1",
  "showHeatmap": "0",
  "showOnlyAboveAverage": "0",
  "severity": "all",
  "dayType": "all",
  "roadCondition": "all",
  "hourFrom": "0",
  "hourTo": "23",
  "centerLat": "50.7350",
  "centerLon": "7.1000",
  "zoom": "13"
});
const POI_QUERY = query({
  "city": "Bonn",
  "includeCyclist": "1",
  "includePedestrian": "1",
  "includeCar": "0",
  "includeMotorcycle": "0",
  "involvementMode": "or",
  "showCluster": "1",
  "showHeatmap": "0",
  "showOnlyAboveAverage": "0",
  "severity": "all",
  "dayType": "all",
  "roadCondition": "all",
  "hourFrom": "0",
  "hourTo": "23",
  "centerLat": "50.7350",
  "centerLon": "7.0950",
  "zoom": "16"
});
const HBF_HEATMAP_QUERY = query({
  "city": "Bonn",
  "includeCyclist": "1",
  "includePedestrian": "0",
  "includeCar": "1",
  "includeMotorcycle": "0",
  "involvementMode": "and",
  "showCluster": "0",
  "showHeatmap": "1",
  "showOnlyAboveAverage": "0",
  "severity": "all",
  "dayType": "all",
  "roadCondition": "all",
  "hourFrom": "0",
  "hourTo": "23",
  "centerLat": "50.7326",
  "centerLon": "7.0963",
  "zoom": "16",
  "selSouth": "50.7300",
  "selWest": "7.0910",
  "selNorth": "50.7355",
  "selEast": "7.1010"
});
const EXPORT_FILTER_QUERY = query({
  "city": "Bonn",
  "includeCyclist": "1",
  "includePedestrian": "0",
  "includeCar": "1",
  "includeMotorcycle": "0",
  "involvementMode": "and",
  "showCluster": "1",
  "showHeatmap": "0",
  "showOnlyAboveAverage": "0",
  "severity": "all",
  "dayType": "all",
  "roadCondition": "all",
  "hourFrom": "6",
  "hourTo": "18",
  "centerLat": "50.7330",
  "centerLon": "7.0950",
  "zoom": "15",
  "selSouth": "50.7300",
  "selWest": "7.0900",
  "selNorth": "50.7360",
  "selEast": "7.1000"
});
const EXPORT_PDF_QUERY = query({
  "city": "Bonn",
  "includeCyclist": "1",
  "includePedestrian": "0",
  "includeCar": "1",
  "includeMotorcycle": "0",
  "involvementMode": "and",
  "showCluster": "1",
  "showHeatmap": "0",
  "showOnlyAboveAverage": "0",
  "severity": "all",
  "dayType": "all",
  "roadCondition": "all",
  "hourFrom": "0",
  "hourTo": "23",
  "centerLat": "50.7330",
  "centerLon": "7.0950",
  "zoom": "15",
  "selSouth": "50.7300",
  "selWest": "7.0900",
  "selNorth": "50.7360",
  "selEast": "7.1000"
});
const MAP_STANDARD_QUERY = query({
  "city": "Bonn",
  "includeCyclist": "1",
  "includePedestrian": "1",
  "includeCar": "1",
  "includeMotorcycle": "0",
  "involvementMode": "or",
  "severity": "all",
  "dayType": "all",
  "roadCondition": "all",
  "hourFrom": "0",
  "hourTo": "23",
  "centerLat": "50.7330",
  "centerLon": "7.0950",
  "zoom": "15",
  "mapMode": "standard",
  "showCluster": "1",
  "showHeatmap": "0"
});
const MAP_ORTHOPHOTO_QUERY = query({
  "city": "Bonn",
  "includeCyclist": "1",
  "includePedestrian": "1",
  "includeCar": "1",
  "includeMotorcycle": "0",
  "involvementMode": "or",
  "severity": "all",
  "dayType": "all",
  "roadCondition": "all",
  "hourFrom": "0",
  "hourTo": "23",
  "centerLat": "50.7330",
  "centerLon": "7.0950",
  "zoom": "15",
  "mapMode": "orthophoto",
  "showCluster": "1",
  "showHeatmap": "0"
});
const MAP_HYBRID_QUERY = query({
  "city": "Bonn",
  "includeCyclist": "1",
  "includePedestrian": "1",
  "includeCar": "1",
  "includeMotorcycle": "0",
  "involvementMode": "or",
  "severity": "all",
  "dayType": "all",
  "roadCondition": "all",
  "hourFrom": "0",
  "hourTo": "23",
  "centerLat": "50.7330",
  "centerLon": "7.0950",
  "zoom": "15",
  "mapMode": "hybrid",
  "showCluster": "1",
  "showHeatmap": "0"
});
const MAP_ANALYSIS_QUERY = query({
  "city": "Bonn",
  "includeCyclist": "1",
  "includePedestrian": "1",
  "includeCar": "1",
  "includeMotorcycle": "0",
  "involvementMode": "or",
  "severity": "all",
  "dayType": "all",
  "roadCondition": "all",
  "hourFrom": "0",
  "hourTo": "23",
  "centerLat": "50.7330",
  "centerLon": "7.0950",
  "zoom": "15",
  "mapMode": "analysis",
  "showCluster": "0",
  "showHeatmap": "1",
  "orthophotoOpacity": "65"
});

const PUBLIC_EXPORT_QUERY = EXPORT_FILTER_QUERY;

const SCREENSHOT_SCENARIOS = Object.freeze({
  'docs/screenshots/04-cluster-ansicht.png': Object.freeze({
    id: 'docs-cluster-hannover',
    description: 'Clusteransicht Hannover ohne Heatmap und Zusatzebenen',
    query: CLUSTER_QUERY,
    liveCheck: true,
    expected: Object.freeze({
      city: 'Hannover',
      involvementMode: 'or',
      showCluster: true,
      showHeatmap: false,
      showSchools: false,
      showKindergartens: false,
      showArgumentation: false,
      minimumAllPoints: 1,
      minimumViewportPoints: 1,
    }),
  }),
  'docs/screenshots/05-heatmap-ansicht.png': Object.freeze({
    id: 'docs-heatmap-bonn',
    description: 'Heatmapansicht Bonn ohne Cluster',
    query: HEATMAP_QUERY,
    liveCheck: false,
  }),
  'docs/screenshots/09-bereich-markieren.png': Object.freeze({
    id: 'docs-selection-bonn',
    description: 'Markierter Bereich in Bonn mit Clusteransicht',
    query: SELECTION_QUERY,
    liveCheck: true,
    expected: Object.freeze({
      city: 'Bonn',
      involvementMode: 'or',
      filters: Object.freeze({ bike: true, pedestrian: true, car: true, motorcycle: false }),
      hourFrom: 0,
      hourTo: 23,
      showCluster: true,
      showHeatmap: false,
      center: Object.freeze({ lat: 50.7330, lon: 7.0950, tolerance: 0.0025 }),
      zoom: 15,
      selection: Object.freeze({
        south: 50.7300,
        west: 7.0900,
        north: 50.7360,
        east: 7.1000,
        tolerance: 0.0001,
      }),
      minimumAllPoints: 1,
      minimumViewportPoints: 1,
      minimumSelectionPoints: 1,
    }),
  }),
  'docs/screenshots/10-auto-fahrrad-und.png': Object.freeze({
    id: 'docs-bike-car-and-bonn',
    description: 'Rad und Pkw im UND-Modus in Bonn',
    query: BIKE_CAR_QUERY,
    liveCheck: false,
  }),
  'docs/screenshots/11-fahrrad-alleinunfaelle.png': Object.freeze({
    id: 'docs-bike-solo-bonn',
    description: 'Fahrrad-Alleinunfälle in Bonn',
    query: BIKE_SOLO_QUERY,
    liveCheck: false,
  }),
  'docs/screenshots/12-poi-schulen-kitas.png': Object.freeze({
    id: 'docs-poi-bonn',
    description: 'Bonn mit Rad-/Fußfilter und sichtbaren Schul-/Kita-POIs',
    query: POI_QUERY,
    liveCheck: true,
    expected: Object.freeze({
      city: 'Bonn',
      involvementMode: 'or',
      filters: Object.freeze({ bike: true, pedestrian: true, car: false, motorcycle: false }),
      hourFrom: 0,
      hourTo: 23,
      showCluster: true,
      showHeatmap: false,
      center: Object.freeze({ lat: 50.7350, lon: 7.0950, tolerance: 0.0025 }),
      zoom: 16,
      minimumAllPoints: 1,
      minimumViewportPoints: 1,
      minimumPoiFeatures: 1,
      minimumVisiblePoiLayers: 1,
    }),
  }),
  'docs/screenshots/13-bonn-hbf-radunfaelle.png': Object.freeze({
    id: 'docs-bonn-hbf-heatmap',
    description: 'Bonn Hbf mit Rad/Pkw-UND-Filter, Heatmap und Auswahl',
    query: HBF_HEATMAP_QUERY,
    liveCheck: false,
  }),
  'docs/screenshots/14-export-filterkontext.png': Object.freeze({
    id: 'docs-export-filter-context',
    description: 'Exportgrundlage Bonn mit Rad/Pkw, Zeitfenster und Auswahl',
    query: EXPORT_FILTER_QUERY,
    liveCheck: false,
  }),
  'docs/screenshots/15-export-pdf-rendered.png': Object.freeze({
    id: 'docs-export-pdf-input',
    description: 'Analysezustand für die gerenderte PDF-Vorschau',
    query: EXPORT_PDF_QUERY,
    liveCheck: false,
  }),
  'docs/screenshots/16-antrag-inhalt.png': Object.freeze({
    id: 'docs-export-report-content',
    description: 'Analysezustand für den sichtbaren Antragsinhalt',
    query: EXPORT_FILTER_QUERY,
    liveCheck: false,
  }),
  'docs/screenshots/21-mapmode-standard.png': Object.freeze({
    id: 'docs-map-standard',
    description: 'Standardkartenmodus in Bonn',
    query: MAP_STANDARD_QUERY,
    liveCheck: false,
  }),
  'docs/screenshots/22-mapmode-orthophoto.png': Object.freeze({
    id: 'docs-map-orthophoto',
    description: 'Orthofotomodus in Bonn',
    query: MAP_ORTHOPHOTO_QUERY,
    liveCheck: false,
  }),
  'docs/screenshots/23-mapmode-hybrid.png': Object.freeze({
    id: 'docs-map-hybrid',
    description: 'Hybridkartenmodus in Bonn',
    query: MAP_HYBRID_QUERY,
    liveCheck: false,
  }),
  'docs/screenshots/24-mapmode-analysis.png': Object.freeze({
    id: 'docs-map-analysis',
    description: 'Analysemodus in Bonn mit Heatmap',
    query: MAP_ANALYSIS_QUERY,
    liveCheck: false,
  }),
});

const PUBLIC_START_EXPECTED = Object.freeze({
  city: 'Hannover',
  involvementMode: 'or',
  showCluster: true,
  showHeatmap: false,
  showSchools: true,
  showKindergartens: true,
  showArgumentation: true,
  filters: Object.freeze({ bike: true, pedestrian: true, car: true, motorcycle: false }),
  hourFrom: 0,
  hourTo: 23,
  center: Object.freeze({ lat: 52.3759, lon: 9.7320, tolerance: 0.0025 }),
  zoom: 12,
  minimumAllPoints: 1,
  minimumViewportPoints: 1,
  publicPreview: true,
});

const HBF_HEATMAP_EXPECTED = Object.freeze({
  city: 'Bonn',
  involvementMode: 'and',
  filters: Object.freeze({ bike: true, pedestrian: false, car: true, motorcycle: false }),
  hourFrom: 0,
  hourTo: 23,
  showCluster: false,
  showHeatmap: true,
  center: Object.freeze({ lat: 50.7326, lon: 7.0963, tolerance: 0.0025 }),
  zoom: 16,
  selection: Object.freeze({
    south: 50.7300,
    west: 7.0910,
    north: 50.7355,
    east: 7.1010,
    tolerance: 0.0001,
  }),
  minimumAllPoints: 1,
  minimumViewportPoints: 1,
  minimumSelectionPoints: 1,
  publicPreview: true,
});

const EXPORT_FILTER_EXPECTED = Object.freeze({
  city: 'Bonn',
  involvementMode: 'and',
  filters: Object.freeze({ bike: true, pedestrian: false, car: true, motorcycle: false }),
  hourFrom: 6,
  hourTo: 18,
  showCluster: true,
  showHeatmap: false,
  center: Object.freeze({ lat: 50.7330, lon: 7.0950, tolerance: 0.0025 }),
  zoom: 15,
  selection: Object.freeze({
    south: 50.7300,
    west: 7.0900,
    north: 50.7360,
    east: 7.1000,
    tolerance: 0.0001,
  }),
  minimumAllPoints: 1,
  minimumViewportPoints: 1,
  minimumSelectionPoints: 1,
  publicPreview: true,
});

const ACTION_SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'readme-start',
    sourceFile: 'README.md',
    label: 'Öffentliche Browser-Version öffnen',
    description: 'Explizite öffentliche Startansicht Hannover',
    query: PUBLIC_START_QUERY,
    expected: PUBLIC_START_EXPECTED,
  }),
  Object.freeze({
    id: 'readme-export',
    sourceFile: 'README.md',
    label: '→ Öffentliche Werkbank für Export öffnen',
    description: 'Analysegrundlage für den Export mit Zeitfenster und Auswahl',
    query: EXPORT_FILTER_QUERY,
    expected: EXPORT_FILTER_EXPECTED,
  }),
  Object.freeze({
    id: 'readme-bonn-hbf',
    sourceFile: 'README.md',
    label: '→ Bonn-Hbf-Analyse in der öffentlichen Browser-Version öffnen',
    description: 'Bonn Hbf Rad/Pkw UND, Heatmap und markierter Bereich',
    query: HBF_HEATMAP_QUERY,
    expected: HBF_HEATMAP_EXPECTED,
  }),
]);

const LIVE_SCREENSHOT_SCENARIOS = Object.freeze(Object.fromEntries(
  Object.entries(SCREENSHOT_SCENARIOS).filter(([, scenario]) => scenario.liveCheck === true),
));

const SCENARIOS = Object.freeze({
  ...LIVE_SCREENSHOT_SCENARIOS,
  ...Object.fromEntries(ACTION_SCENARIOS.map((scenario) => [`action:${scenario.id}`, scenario])),
});

function assertCanonicalUrl(link, scenario) {
  const url = new URL(link.url);
  if (url.origin !== LIVE_ORIGIN || url.pathname !== LIVE_PATH) {
    fail('unexpected_live_target', `${scenario.id} does not target the canonical live application`, {
      sourceFile: link.sourceFile,
      url: link.url,
    });
  }
  for (const [key, value] of Object.entries(scenario.query)) {
    if (url.searchParams.get(key) !== value) {
      fail('documentation_query_mismatch', `${scenario.id} has an incorrect ${key} parameter`, {
        sourceFile: link.sourceFile,
        expected: value,
        actual: url.searchParams.get(key),
        url: link.url,
      });
    }
  }
  const unexpected = [...url.searchParams.keys()].filter((key) => !(key in scenario.query));
  if (unexpected.length) {
    fail('unexpected_documentation_query', `${scenario.id} contains undeclared parameters`, {
      sourceFile: link.sourceFile,
      unexpected,
      url: link.url,
    });
  }
  assertSpatiallyConsistent(link.url, link.sourceFile);
}

function validateDocumentationLinks(rootDir = process.cwd()) {
  const documents = new Map();
  const allScreenshotLinks = [];
  const allLiveLinks = [];

  for (const sourceFile of DOCUMENTATION_FILES) {
    const absolute = path.join(rootDir, sourceFile);
    const markdown = fs.readFileSync(absolute, 'utf8');
    documents.set(sourceFile, markdown);
    assertAllDocumentationMediaLinked(markdown, sourceFile);

    for (const link of extractAllLiveLinks(markdown, sourceFile)) {
      assertSpatiallyConsistent(link.url, sourceFile);
      allLiveLinks.push(link);
    }

    for (const media of extractScreenshotMedia(markdown, sourceFile)) {
      if (!media.imagePath.startsWith('docs/screenshots/')) continue;
      const scenario = SCREENSHOT_SCENARIOS[media.imagePath];
      if (!scenario) {
        fail('undocumented_screenshot_scenario', `No canonical scenario for ${media.imagePath}`, {
          sourceFile,
          imagePath: media.imagePath,
        });
      }
      let target;
      try {
        target = parseUrl(media.rawTarget, sourceFile);
      } catch (error) {
        throw error;
      }
      const link = Object.freeze({ ...media, url: target });
      assertCanonicalUrl(link, scenario);
      allScreenshotLinks.push(link);
    }
  }

  const byImage = new Map();
  for (const link of allScreenshotLinks) {
    if (!byImage.has(link.imagePath)) byImage.set(link.imagePath, []);
    byImage.get(link.imagePath).push(link);
  }

  const liveScenarios = [];
  for (const [imagePath, scenario] of Object.entries(SCREENSHOT_SCENARIOS)) {
    const links = byImage.get(imagePath) || [];
    if (links.length === 0) {
      fail('missing_documented_screenshot', `Expected at least one linked documentation screenshot: ${imagePath}`, {
        imagePath,
      });
    }
    if (scenario.liveCheck === true) {
      liveScenarios.push(Object.freeze({
        imagePath,
        ...scenario,
        url: resolveApplicationUrl(links[0].url),
        canonicalUrl: links[0].url,
        references: Object.freeze(links.map((link) => Object.freeze({
          sourceFile: link.sourceFile,
          altText: link.altText,
          url: link.url,
        }))),
      }));
    }
  }

  for (const scenario of ACTION_SCENARIOS) {
    const sourceFile = scenario.sourceFile || 'README.md';
    const markdown = documents.get(sourceFile);
    const link = extractNamedAction(markdown, sourceFile, scenario.label);
    assertCanonicalUrl(link, scenario);
    liveScenarios.push(Object.freeze({
      imagePath: null,
      ...scenario,
      url: resolveApplicationUrl(link.url),
      canonicalUrl: link.url,
      references: Object.freeze([Object.freeze({
        sourceFile,
        label: scenario.label,
        url: link.url,
      })]),
    }));
  }

  return Object.freeze({
    links: Object.freeze(allScreenshotLinks),
    relevant: Object.freeze(liveScenarios.flatMap((scenario) => scenario.references)),
    liveScenarios: Object.freeze(liveScenarios),
    documents: DOCUMENTATION_FILES,
    allLiveLinks: Object.freeze(allLiveLinks),
  });
}

module.exports = Object.freeze({
  LIVE_ORIGIN,
  LIVE_PATH,
  DOCUMENTATION_FILES,
  PUBLIC_START_QUERY,
  PUBLIC_EXPORT_QUERY,
  SCREENSHOT_SCENARIOS,
  ACTION_SCENARIOS,
  LIVE_SCREENSHOT_SCENARIOS,
  SCENARIOS,
  DocumentationDeepLinkError,
  normalizeImagePath,
  extractScreenshotMedia,
  extractLinkedScreenshots,
  extractAllLiveLinks,
  assertAllDocumentationMediaLinked,
  assertAllReadmeMediaLinked,
  assertSpatiallyConsistent,
  extractNamedAction,
  assertCanonicalUrl,
  resolveApplicationUrl,
  validateDocumentationLinks,
});
