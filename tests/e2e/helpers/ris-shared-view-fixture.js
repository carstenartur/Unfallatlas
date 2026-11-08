import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeRisSnapshot, enumerateSnapshotAssets } from '../../../server/political-context/services/risSnapshot.js';

const SOURCE = 'https://ris.hannit.de/public/';
const ID = 'region-hannover-ris:vo:2003037';
const TITLE = 'Radverkehr am Mittellandkanal und Stichkanal Linden';
const BASE_VIEW = 'city=Hannover&centerLat=52.376&centerLon=9.731&zoom=14&showCluster=0&showHeatmap=0';

async function fixture(testInfo, schemaVersion = 2) {
  const directory = testInfo.outputPath(`ris-${schemaVersion}`);
  const events = Array.from({ length: schemaVersion === 2 ? 70 : 2 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
    body: index === 69 ? 'Regionsversammlung' : `Verkehrsausschuss ${index + 1}`,
    outcome: index === 69 ? 'ungeändert beschlossen' : 'Beraten',
    url: `${SOURCE}to020?TOLFDNR=${1000 + index}`, evidence: `Öffentlicher Beratungsbeleg ${index + 1}`,
  }));
  const records = [{
    id: ID, title: TITLE, number: '2073 (V) BDs', type: 'Beschlussdrucksache',
    date: '2023-09-19', gremium: 'Regionsversammlung', source: 'region-hannover-ris',
    url: `${SOURCE}vo020?VOLFDNR=2003037`, events,
    relationships: [{ type: 'related', targetId: 'region-hannover-ris:vo:2003261',
      targetUrl: `${SOURCE}vo020?VOLFDNR=2003261`, targetRole: 'amendment', label: 'Änderungsantrag zum Radverkehr',
      evidence: 'Amtlicher Verweis auf den Änderungsantrag' }],
    sourceContext: { level: 'region', publisher: 'Region Hannover', issuer: null,
      documentKind: 'Beschlussdrucksache', status: 'proposal', publicationDate: null,
      documentDate: '2023-08-24', meetingDate: null },
  }, {
    id: 'region-hannover-ris:vo:2003261', title: 'Änderungsantrag zum Radverkehr', number: 'TEST-Ä/2026',
    type: 'Änderungsantrag', date: null, gremium: null, source: 'region-hannover-ris',
    url: `${SOURCE}vo020?VOLFDNR=2003261`, relatedTo: ID, events: [], relationships: [],
    geometry: { type: 'Point', coordinates: [9.731, 52.376] },
    locationSource: 'official', locationLabel: 'Amtlich verorteter Beispieldatensatz',
  }];
  const manifest = await writeRisSnapshot(directory, 'hannover', {
    sources: [SOURCE], records, coverage: { from: '2023-01-01', to: '2026-11-08',
      bodies: ['Regionsversammlung', 'Verkehrsausschuss'], complete: false, warnings: ['Testbestand'] },
  }, { schemaVersion });
  const assets = new Set(['hannover.json', ...(await enumerateSnapshotAssets(directory, manifest)).map(asset => asset.path)]);
  const install = async target => {
    const requests = [];
    await target.route('**/data/ris/*', async route => {
      const file = path.posix.basename(new URL(route.request().url()).pathname);
      requests.push(file);
      if (!assets.has(file)) return route.fulfill({ status: 404 });
      return route.fulfill({ body: await readFile(path.join(directory, file)),
        contentType: file.endsWith('.gz') ? 'application/gzip' : 'application/json' });
    });
    return requests;
  };
  return { install };
}

async function ready(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const ua = window.UA, ctx = ua?.getRuntimeContext?.();
    return ctx?.map && ctx.ui && !ua._hydrating && ua.PoliticalContext?._runSearch;
  }, null, { timeout: 60_000 });
  if (!await page.evaluate(() => Boolean(window.UA.PUBLIC_DISTRIBUTION_PROFILE))) {
    await page.addScriptTag({ url: 'js/ua.public-preview.js' });
  }
}

async function captureEvidence(page, testInfo, name) {
  const body = await page.screenshot();
  // The canonical runner uses separate Playwright invocations for browsers
  // and context-data QA. Their output directories are cleared between runs.
  const directory = path.resolve('out/qa/ris-view');
  const file = `${testInfo.project.name}-${name}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${file}.png`), body);
  await testInfo.attach(name, { body, contentType: 'image/png' });
}

export { ID, TITLE, BASE_VIEW, fixture, ready, captureEvidence };
