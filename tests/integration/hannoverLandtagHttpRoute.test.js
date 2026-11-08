/** @jest-environment node */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const { createRisSourceCache } = require('../../server/political-context/services/risSourceCache');
const { parseLandtagCatalogue } = require('../../server/political-context/providers/hannoverAdditionalFormats');
const { buildCatalogueUrl } = require('../../server/political-context/providers/hannoverAdditionalSources');
const ROOT = path.resolve(__dirname, '../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms).unref());
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
let child, base, directory;
beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'landtag-http-'));
  const cache = createRisSourceCache({ directory });
  const url = buildCatalogueUrl({ number: '19/8980', year: 2025 });
  const html = await fs.readFile(path.join(ROOT, 'tests/fixtures/political-sources/landtag-catalogue.html'), 'utf8');
  await cache.getOrLoad(url, 'hannover-additional-v2', async () => parseLandtagCatalogue(html, url));
  base = `http://127.0.0.1:${await port()}`;
  child = spawn(process.execPath, ['server/start.js'], { cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', PORT: new URL(base).port, ANALYSIS_SERVICE_ENABLED: 'false', RIS_ADDITIONAL_SOURCE_DIRECTORY: directory }, stdio: 'ignore' });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Server exited ${child.exitCode}`);
    try { if ((await fetch(base + '/api/health')).ok) return; } catch { /* startup */ }
    await delay(100);
  }
  throw new Error('Server did not become ready');
}, 30000);
afterAll(async () => {
  if (child && child.exitCode === null) {
    const done = new Promise(resolve => child.once('exit', resolve));
    child.kill(); await Promise.race([done, delay(3000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await fs.rm(directory, { recursive: true, force: true });
});
async function query(context) {
  return fetch(base + '/api/political-context/search', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ city: 'Hannover', searchTerms: ['Eilenriede'], context }) });
}
test('public Hannover route honours exact bounded Landtag filters and retains source status/provenance', async () => {
  const response = await query({ landtagNumber: '19/8980', landtagYear: 2025 });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.references).toEqual([expect.objectContaining({ number: '19/8980', source: 'niedersachsen-landtag',
    sourceContext: expect.objectContaining({ level: 'state', status: 'answer' }) })]);
  expect(result.meta).toMatchObject({ searchStatus: 'partial-results', sourceType: 'landtag-catalogue-filtered', truncated: true });
  expect(result.meta.sourceStatuses).toHaveLength(1);
  expect(result.meta.sourceStatuses[0]).toMatchObject({ source: 'landtag-catalogue', status: 'partial' });
  expect(result.meta.queryLog[0].query).toContain('19/8980');
}, 15000);
test.each([{ landtagYear: 1981 }, { landtagYear: '2025' }, { landtagNumber: 'https://evil.example' }])('public route rejects invalid filter %j before source acquisition', async context => {
  const response = await query(context);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: 'LANDTAG_FILTER_INVALID' });
});
