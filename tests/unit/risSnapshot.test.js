/** @jest-environment node */
'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { gzipSync, gunzipSync } = require('node:zlib');
const { writeRisSnapshot, readRisSnapshot } = require('../../server/political-context/services/risSnapshot.js');
const source = 'https://www.bonn.sitzung-online.de/oparl/system';
const manifestName = 'bonn.json';
const coverage = {
  from: '2026-01-01', to: '2026-12-31', bodies: ['Rat der Stadt Bonn'],
  complete: false, warnings: ['Unvollständiges Archiv'],
};
const original = {
  id: 'bonn-paper-123', title: 'Sicherer Schulweg – Adenauerallee', type: 'Antrag',
  number: '260920-01 ST', date: '2026-04-05', gremium: 'Rat der Stadt Bonn',
  url: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=123', source: 'Bonn OParl',
};
const catalogue = records => ({ records, sources: [source], coverage });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const refreshFailure = {
  attemptedAt: '2026-11-07T10:00:00.000Z', reason: 'OParl HTTP 503', expiresAt: '2026-11-14T09:00:00.000Z',
};

let directory;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ua-ris-'));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

test('stores only citation metadata in the records and puts geospatial evidence in a separate addressed file', async () => {
  const geometry = { type: 'Point', coordinates: [7.108, 50.727] };
  const manifest = await writeRisSnapshot(directory, 'bonn', catalogue([{
    ...original, geometry, locationSource: 'official', locationLabel: '  Adenauerallee  ',
    fullText: 'Do not store the original document', mainFile: { confidential: 'not metadata' },
  }]), { now: new Date('2026-11-07T09:00:00Z') });

  const records = [original];
  const features = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry, properties: {
      recordId: original.id, accuracy: 'official', label: 'Adenauerallee',
    } }],
  };
  expect(JSON.parse(await fs.readFile(path.join(directory, manifestName), 'utf8'))).toEqual(manifest);
  expect(manifest).toMatchObject({
    schemaVersion: 1, city: 'bonn', generatedAt: '2026-11-07T09:00:00.000Z',
    sources: [source], coverage,
  });
  for (const [kind, payload] of [['records', records], ['map', features]]) {
    const reference = manifest[kind];
    const bytes = gunzipSync(await fs.readFile(path.join(directory, reference.path)));
    expect(reference).toEqual({
      path: `bonn.${hash(bytes)}.${kind}.json.gz`, sha256: hash(bytes), bytes: bytes.length, count: 1,
    });
    expect(JSON.parse(bytes.toString('utf8'))).toEqual(payload);
  }
  await expect(readRisSnapshot(directory, 'bonn')).resolves.toEqual({ manifest, records, features });
});

test('retains records with untrusted or malformed geometry and maps only supported WGS84 evidence', async () => {
  const rows = [
    { id: 'outside-range', geometry: { type: 'Point', coordinates: [7.108, 950] } },
    { id: 'other-coordinate-system', geometry: { type: 'Point', coordinates: [7, 50], crs: 'EPSG:25832' } },
    { id: 'unclosed-ring', geometry: { type: 'Polygon', coordinates: [[[7, 50], [8, 50], [8, 51], [7, 51]]] } },
    { id: 'not-a-geometry', geometry: { type: 'Feature', geometry: { type: 'Point', coordinates: [7, 50] } } },
    { id: 'not-proven', geometry: { type: 'Point', coordinates: [7, 50] }, locationSource: 'guessed' },
    { id: 'line', geometry: { type: 'LineString', coordinates: [[7, 50], [7.1, 50.1]] }, locationSource: 'derived' },
    { id: 'area', geometry: { type: 'Polygon', coordinates: [[[7, 50], [8, 50], [8, 51], [7, 50]]] } },
  ].map(row => ({ ...original, date: null, number: null, gremium: null, locationSource: 'official', ...row }));
  const manifest = await writeRisSnapshot(directory, 'bonn', catalogue(rows));
  const result = await readRisSnapshot(directory, 'bonn');
  expect(manifest.records.count).toBe(7);
  expect(manifest.map.count).toBe(2);
  expect(result.records.map(record => record.id)).toEqual([
    'outside-range', 'other-coordinate-system', 'unclosed-ring', 'not-a-geometry', 'not-proven', 'line', 'area',
  ]);
  expect(result.records[0]).toMatchObject({ date: null, number: null, gremium: null });
  expect(result.features.features.map(({ geometry, properties }) => [geometry.type, properties])).toEqual([
    ['LineString', { recordId: 'line', accuracy: 'derived' }],
    ['Polygon', { recordId: 'area', accuracy: 'official' }],
  ]);
});

test('keeps the original and reply distinct by stable source ID', async () => {
  const answer = { ...original, id: 'bonn-answer-123', number: '260920-01 ST F1', relatedTo: original.id };
  await writeRisSnapshot(directory, 'bonn', catalogue([original, answer]));
  const result = await readRisSnapshot(directory, 'bonn');
  expect(result.records).toEqual([original, answer]);
});

test('publishes Bonn and Hannover independently with the source links for each city', async () => {
  const bonn = await writeRisSnapshot(directory, 'bonn', catalogue([original]));
  const hannoverSource = 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/ds_suchformular';
  const motion = {
    ...original, id: 'hannover-1047-2026', title: 'Radverkehr in Hannover', number: '1047/2026',
    gremium: 'Rat der Landeshauptstadt Hannover', url: `${hannoverSource}/1047-2026`, source: 'Hannover SIM',
  };
  const hannover = await writeRisSnapshot(directory, 'hannover', {
    records: [motion], sources: [hannoverSource], coverage: { ...coverage, bodies: [motion.gremium] },
  });

  await expect(readRisSnapshot(directory, 'bonn')).resolves.toMatchObject({ manifest: bonn, records: [original] });
  await expect(readRisSnapshot(directory, 'hannover')).resolves.toMatchObject({ manifest: hannover, records: [motion] });
});

test('accepts the repository city key for a city whose name has spaces', async () => {
  const sourceUrl = 'https://ratsinfo.example.org/catalogue';
  const city = 'frankfurt_am_main';
  const record = { ...original, url: 'https://ratsinfo.example.org/paper/123' };
  const manifest = await writeRisSnapshot(directory, city, { records: [record], sources: [sourceUrl], coverage });
  await expect(readRisSnapshot(directory, city)).resolves.toMatchObject({ manifest, records: [record] });
});

test.each([
  ['empty catalogue', { records: [] }],
  ['invalid date', { records: [{ ...original, date: '2026-02-30' }] }],
  ['inverted coverage', { coverage: { ...coverage, from: '2027-01-01' } }],
  ['duplicate source ID', { records: [original, { ...original, number: 'different' }] }],
  ['script citation', { records: [{ ...original, url: 'javascript:alert(1)' }] }],
  ['HTTP citation', { records: [{ ...original, url: 'http://www.bonn.sitzung-online.de/123' }] }],
  ['credentialed citation', { records: [{ ...original, url: 'https://user:pass@www.bonn.sitzung-online.de/123' }] }],
  ['undeclared citation host', { records: [{ ...original, url: 'https://www2.bonn.de/123' }] }],
  ['unofficial source', { sources: ['https://www.bonn.sitzung-online.de.example.org/oparl/system'] }],
])('preserves the published catalogue on an update with %s', async (_name, override) => {
  const manifest = await writeRisSnapshot(directory, 'bonn', catalogue([original]));
  await expect(writeRisSnapshot(directory, 'bonn', { ...catalogue([original]), ...override })).rejects.toThrow();
  await expect(readRisSnapshot(directory, 'bonn')).resolves.toMatchObject({ manifest, records: [original] });
});

test('does not replace the manifest if a new asset cannot be installed, and leaves prior assets in place after a retry', async () => {
  const previous = await writeRisSnapshot(directory, 'bonn', catalogue([original]));
  const staging = path.join(directory, 'staging');
  const updated = { ...original, title: 'Neuer Titel', geometry: { type: 'Point', coordinates: [7, 50] }, locationSource: 'official' };
  const candidate = await writeRisSnapshot(staging, 'bonn', catalogue([updated]));
  const conflictingPath = path.join(directory, candidate.map.path);
  await fs.mkdir(conflictingPath);

  await expect(writeRisSnapshot(directory, 'bonn', catalogue([updated]))).rejects.toThrow();
  await expect(readRisSnapshot(directory, 'bonn')).resolves.toMatchObject({ manifest: previous, records: [original] });

  await fs.rmdir(conflictingPath);
  await writeRisSnapshot(directory, 'bonn', catalogue([updated]));
  await expect(readRisSnapshot(directory, 'bonn')).resolves.toMatchObject({ records: [{ title: 'Neuer Titel' }] });
  await fs.access(path.join(directory, previous.records.path));
  await fs.access(path.join(directory, previous.map.path));
  expect((await fs.readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

test.each([
  ['unsupported version', manifest => { manifest.schemaVersion = 2; }],
  ['incorrect city', manifest => { manifest.city = 'hannover'; }],
  ['parent directory asset path', manifest => { manifest.records.path = `../${manifest.records.path}`; }],
  ['incorrect uncompressed length', manifest => { manifest.records.bytes += 1; }],
  ['incorrect record count', manifest => { manifest.records.count += 1; }],
  ['incorrect map feature count', manifest => { manifest.map.count += 1; }],
])('rejects a manifest with %s', async (_name, mutate) => {
  const manifest = await writeRisSnapshot(directory, 'bonn', catalogue([original]));
  mutate(manifest);
  await fs.writeFile(path.join(directory, manifestName), JSON.stringify(manifest));
  await expect(readRisSnapshot(directory, 'bonn')).rejects.toThrow();
});

test('returns verified refresh failure metadata without rewriting the legacy generation timestamp or coverage', async () => {
  const manifest = await writeRisSnapshot(directory, 'bonn', catalogue([original]), { now: new Date('2026-10-31T09:00:00Z') });
  const fallback = { ...manifest, generatedAt: '2026-10-31T09:00:00Z', refreshFailure };
  await fs.writeFile(path.join(directory, manifestName), JSON.stringify(fallback));
  await expect(readRisSnapshot(directory, 'bonn')).resolves.toMatchObject({ manifest: fallback, records: [original] });
});

test.each([
  ['null metadata', null],
  ['noncanonical attempt timestamp', { ...refreshFailure, attemptedAt: '2026-11-07T10:00:00Z' }],
  ['invalid calendar day', { ...refreshFailure, attemptedAt: '2026-10-32T10:00:00.000Z' }],
  ['attempt before generation', { ...refreshFailure, attemptedAt: '2026-10-31T08:00:00.000Z' }],
  ['attempt at expiry', { ...refreshFailure, attemptedAt: refreshFailure.expiresAt }],
  ['extended expiry', { ...refreshFailure, expiresAt: '2026-11-15T09:00:00.000Z' }],
  ['empty reason', { ...refreshFailure, reason: '' }],
  ['unsafe reason', { ...refreshFailure, reason: 'Source error\n<script>alert(1)</script>' }],
  ['oversized reason', { ...refreshFailure, reason: 'a'.repeat(241) }],
])('rejects fallback metadata with %s', async (_name, failure) => {
  const manifest = await writeRisSnapshot(directory, 'bonn', catalogue([original]), { now: new Date('2026-10-31T09:00:00Z') });
  await fs.writeFile(path.join(directory, manifestName), JSON.stringify({ ...manifest, refreshFailure: failure }));
  await expect(readRisSnapshot(directory, 'bonn')).rejects.toThrow(/refresh failure/i);
});

test('rejects a same-length records asset with different decoded bytes', async () => {
  const manifest = await writeRisSnapshot(directory, 'bonn', catalogue([original]));
  const assetPath = path.join(directory, manifest.records.path);
  const raw = gunzipSync(await fs.readFile(assetPath));
  const edited = raw.toString('utf8').replace('Schulweg', 'Radroute');
  expect(Buffer.byteLength(edited)).toBe(raw.length);
  await fs.writeFile(assetPath, gzipSync(edited));
  await expect(readRisSnapshot(directory, 'bonn')).rejects.toThrow(/integrity|hash/i);
});

test('rejects an otherwise valid map asset that refers to a missing record', async () => {
  const manifest = await writeRisSnapshot(directory, 'bonn', catalogue([original]));
  const bytes = Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [{
    type: 'Feature', geometry: { type: 'Point', coordinates: [7, 50] },
    properties: { recordId: 'missing', accuracy: 'official' },
  }] }));
  const sha256 = hash(bytes);
  manifest.map = { path: `bonn.${sha256}.map.json.gz`, sha256, bytes: bytes.length, count: 1 };
  await fs.writeFile(path.join(directory, manifest.map.path), gzipSync(bytes));
  await fs.writeFile(path.join(directory, manifestName), JSON.stringify(manifest));
  await expect(readRisSnapshot(directory, 'bonn')).rejects.toThrow(/record/i);
});

test('rejects a traversal city slug before constructing paths', async () => {
  await expect(writeRisSnapshot(directory, '../bonn', catalogue([original]))).rejects.toThrow(/city/i);
  await expect(readRisSnapshot(directory, '../bonn')).rejects.toThrow(/city/i);
  expect(await fs.readdir(directory)).toEqual([]);
});

const symlinkTest = process.platform === 'win32' ? test.skip : test;
symlinkTest('rejects a symlink at a valid-looking asset path', async () => {
  const manifest = await writeRisSnapshot(directory, 'bonn', catalogue([original]));
  const assetPath = path.join(directory, manifest.records.path);
  const target = path.join(directory, 'redirected-asset');
  await fs.rename(assetPath, target);
  await fs.symlink(target, assetPath);
  await expect(readRisSnapshot(directory, 'bonn')).rejects.toThrow();
});

test('bounds the size of compressed and expanded assets before parsing', async () => {
  const manifest = await writeRisSnapshot(directory, 'bonn', catalogue([original]));
  const assetPath = path.join(directory, manifest.records.path);
  await fs.truncate(assetPath, 5 * 1024 * 1024 + 1);
  await expect(readRisSnapshot(directory, 'bonn')).rejects.toThrow(/size/i);

  await fs.writeFile(assetPath, gzipSync(Buffer.alloc(16 * 1024 * 1024 + 1, 32)));
  await expect(readRisSnapshot(directory, 'bonn')).rejects.toMatchObject({ cause: { code: 'ERR_BUFFER_TOO_LARGE' } });
});

test('rejects more than 50,000 records without publishing a manifest', async () => {
  const records = Array.from({ length: 50_001 }, (_, i) => ({ ...original, id: `record-${i}` }));
  await expect(writeRisSnapshot(directory, 'bonn', catalogue(records))).rejects.toThrow(/record count/i);
  expect(await fs.readdir(directory)).toEqual([]);
});
