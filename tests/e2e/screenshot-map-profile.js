import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const SCREENSHOT_PROFILE = process.env.UA_SCREENSHOT_PROFILE === 'publication'
  ? 'publication'
  : 'regression';

const DETERMINISTIC_MAP_TILES = Object.freeze({
  standard: readFileSync(resolve(process.cwd(), 'tests/e2e/fixtures/map-tiles/standard.svg')),
  orthophoto: readFileSync(resolve(process.cwd(), 'tests/e2e/fixtures/map-tiles/orthophoto.svg')),
  labels: readFileSync(resolve(process.cwd(), 'tests/e2e/fixtures/map-tiles/labels.svg'))
});

const DETERMINISTIC_EXTERNAL_DATA = Object.freeze({
  nominatim: Object.freeze({
    bonn: readFileSync(resolve(process.cwd(), 'tests/e2e/fixtures/network/nominatim-reverse-bonn.json')),
    hannover: readFileSync(resolve(process.cwd(), 'tests/e2e/fixtures/network/nominatim-reverse-hannover.json'))
  }),
  overpass: Object.freeze({
    bonn: readFileSync(resolve(process.cwd(), 'tests/e2e/fixtures/network/overpass-bonn.json')),
    hannover: readFileSync(resolve(process.cwd(), 'tests/e2e/fixtures/network/overpass-hannover.json'))
  })
});

const SCREENSHOT_NETWORK = new WeakMap();

function classifyMapResource(rawUrl) {
  const url = new URL(rawUrl);
  if (/(^|\.)tile\.openstreetmap\.org$/i.test(url.hostname)) {
    return { kind: 'standard', provider: 'OpenStreetMap', officialForExport: true };
  }
  if (/(^|\.)basemaps\.cartocdn\.com$/i.test(url.hostname) &&
      url.pathname.startsWith('/light_only_labels/')) {
    return { kind: 'labels', provider: 'CARTO / OpenStreetMap', officialForExport: true };
  }
  if (url.hostname === 'www.bonn.de' &&
      url.pathname.startsWith('/stadtplan-wms/services/orthofoto/MapServer/WMSServer')) {
    return { kind: 'orthophoto', provider: 'Bundesstadt Bonn', officialForExport: true };
  }
  if (url.hostname === 'www.wms.nrw.de' && url.pathname.startsWith('/geobasis/wms_nw_dop')) {
    return { kind: 'orthophoto', provider: 'Geobasis NRW', officialForExport: true };
  }
  if (url.hostname === 'opendata.lgln.niedersachsen.de' &&
      url.pathname.startsWith('/doorman/noauth/dop_wms')) {
    return { kind: 'orthophoto', provider: 'LGLN Niedersachsen', officialForExport: true };
  }
  if (url.hostname === 'sg.geodatenzentrum.de' && url.pathname.startsWith('/wms_dop20')) {
    return { kind: 'orthophoto', provider: 'BKG', officialForExport: true };
  }
  if (url.hostname === 'server.arcgisonline.com' &&
      url.pathname.startsWith('/ArcGIS/rest/services/World_Imagery/MapServer/tile/')) {
    return { kind: 'orthophoto', provider: 'Esri', officialForExport: false };
  }
  return null;
}

function isAuthenticRaster(response) {
  return response && response.status >= 200 && response.status < 300 &&
    /^image\/(?:png|jpe?g|webp)(?:;|$)/i.test(String(response.contentType || '')) &&
    response.fixture !== true;
}

function summarizeResponses(page) {
  const state = SCREENSHOT_NETWORK.get(page) || { responses: [] };
  const grouped = new Map();
  for (const response of state.responses) {
    const key = [response.kind, response.provider, response.officialForExport,
      response.status, response.contentType, response.fixture].join('\t');
    const current = grouped.get(key) || { ...response, count: 0 };
    current.count += 1;
    grouped.set(key, current);
  }
  return Array.from(grouped.values()).sort((a, b) => {
    const left = [a.kind, a.provider, a.status].join('\t');
    const right = [b.kind, b.provider, b.status].join('\t');
    return left.localeCompare(right);
  });
}

function assertAuthenticBasemap(basemap, requirement, screenshotPath) {
  const responses = basemap.responses || [];
  const standard = responses.some(response => response.kind === 'standard' && isAuthenticRaster(response));
  const labels = responses.some(response => response.kind === 'labels' && isAuthenticRaster(response));
  const officialOrthophoto = responses.some(response =>
    response.kind === 'orthophoto' && response.officialForExport === true && isAuthenticRaster(response));
  const orthophotoFailure = responses.some(response =>
    response.kind === 'orthophoto' && (response.status >= 400 || response.status === 0));
  const osmAttribution = /OpenStreetMap/i.test(String(basemap.attribution || ''));

  const valid = requirement === 'standard' ? standard && osmAttribution
    : requirement === 'orthophoto' ? officialOrthophoto
      : requirement === 'hybrid' ? officialOrthophoto && labels && osmAttribution
        : requirement === 'fallback' ? orthophotoFailure && standard && osmAttribution
          : false;
  if (!valid) {
    throw new Error(
      `Publication screenshot lacks authentic ${requirement} basemap evidence: ${screenshotPath}\n` +
      JSON.stringify(basemap, null, 2)
    );
  }
}

export async function setupScreenshotNetwork(page, classifyNominatimFixture,
  classifyOverpassFixture, options = {}) {
  const { orthophotoAvailable = true } = options;
  const state = { responses: [], unexpectedExternalRequests: [] };
  SCREENSHOT_NETWORK.set(page, state);

  page.on('response', response => {
    const mapResource = classifyMapResource(response.url());
    if (!mapResource) return;
    state.responses.push({
      ...mapResource,
      status: response.status(),
      contentType: response.headers()['content-type'] || '',
      fixture: SCREENSHOT_PROFILE === 'regression'
    });
  });

  await page.route(/^https:\/\//, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const mapResource = classifyMapResource(request.url());
    const nominatimFixture = classifyNominatimFixture(request.url());
    const overpassFixture = classifyOverpassFixture(
      request.url(), request.postDataBuffer() || request.postData());

    if (nominatimFixture) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: DETERMINISTIC_EXTERNAL_DATA.nominatim[nominatimFixture]
      });
      return;
    }
    if (overpassFixture) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: DETERMINISTIC_EXTERNAL_DATA.overpass[overpassFixture]
      });
      return;
    }
    if (url.hostname === 'pdfjs-test-cdn') {
      await route.fallback();
      return;
    }
    if (mapResource) {
      if (!orthophotoAvailable && mapResource.kind === 'orthophoto') {
        await route.fulfill({
          status: 503,
          contentType: 'text/plain; charset=utf-8',
          body: 'Orthophoto unavailable'
        });
        return;
      }
      if (SCREENSHOT_PROFILE === 'regression') {
        const body = mapResource.kind === 'standard' ? DETERMINISTIC_MAP_TILES.standard
          : mapResource.kind === 'labels' ? DETERMINISTIC_MAP_TILES.labels
            : DETERMINISTIC_MAP_TILES.orthophoto;
        await route.fulfill({ status: 200, contentType: 'image/svg+xml', body });
        return;
      }
      await route.continue();
      return;
    }

    state.unexpectedExternalRequests.push(
      `${request.method()} ${request.resourceType()} ${request.url()}`);
    await route.abort('blockedbyclient');
  });
}

export function assertNoUnexpectedScreenshotRequests(page) {
  const unexpected = (SCREENSHOT_NETWORK.get(page) || { unexpectedExternalRequests: [] })
    .unexpectedExternalRequests;
  if (unexpected.length > 0) {
    throw new Error(`Screenshot requested unapproved external resources:\n${unexpected.join('\n')}`);
  }
}

export async function collectBasemapCapture(page, requirement, screenshotPath) {
  const ui = await page.evaluate(() => ({
    attribution: (document.querySelector('.leaflet-control-attribution')?.textContent || '').trim(),
    mapLayerStatus: (document.querySelector('#mapLayerStatus')?.textContent || '').trim()
  }));
  const capture = {
    profile: SCREENSHOT_PROFILE,
    basemap: {
      requirement,
      authentic: false,
      ...ui,
      responses: summarizeResponses(page)
    }
  };
  if (SCREENSHOT_PROFILE === 'publication') {
    assertAuthenticBasemap(capture.basemap, requirement, screenshotPath);
    capture.basemap.authentic = true;
  }
  return capture;
}

export async function attachBasemapCapture(screenshotPath, capture) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const sidecarPath = path.resolve(
    process.cwd(),
    'out/qa/screenshot-readiness',
    `${path.basename(screenshotPath, path.extname(screenshotPath))}.json`
  );
  const sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
  sidecar.capture = capture;
  await fs.writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
}
