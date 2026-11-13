'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const { ROOTS } = require('../../js/ua.ris-partitions');
const { buildMunicipalDataSources } = require('../../scripts/lib/municipal-data-status');

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'municipal-data-status-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function write(name, data) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const json = JSON.stringify(data);
  fs.writeFileSync(file, name.endsWith('.gz') ? gzipSync(json) : json);
}

function row(label) {
  return buildMunicipalDataSources(root).find(item => item.label === label);
}

test('distinguishes documented sources from datasets present in the delivered directory', () => {
  expect(buildMunicipalDataSources(root).every(item => item.coverage.includes('nicht enthalten'))).toBe(true);
  write('data/mobility/hannover-speed30.json.gz', {
    ways: { '1': { kind: 'zone' }, '2': { kind: 'zone' } }, extractDate: '2025-10-01',
    sourceUrl: 'https://download.bbbike.org/osm/bbbike/Hannover/'
  });
  expect(row('Tempo 30 in Hannover')).toMatchObject({ coverage: '2 OSM-Wege', description: expect.stringContaining('2025-10-01') });
  expect(row('Ratsdokumente Bonn').license).toMatch(/CC0.*Angehängte und externe Dokumente/);
});

test('reports searchable, mapped and unresolved records from the delivered council catalogue', () => {
  const roots = {};
  for (const kind of ROOTS) {
    const name = 'hannover.' + 'a'.repeat(64) + '.' + kind + '.json.gz';
    roots[kind] = { path: name };
    write('data/ris/' + name, { entries: [] });
  }
  write('data/ris/hannover.json', {
    city: 'hannover', schemaVersion: 2, recordCount: 10, mappedRecordCount: 3, roots,
    levelCounts: { city: { records: 4, mapped: 2 }, region: { records: 5, mapped: 1 }, state: { records: 1, mapped: 0 } },
    refreshFailure: { attemptedAt: '2026-01-03T00:00:00.000Z' },
    locationRevision: 1, locationAssessment: { attempted: 8, unresolved: 4 },
    coverage: { from: '2019-01-01', to: '2025-12-31', complete: false },
    generatedAt: '2026-01-02T00:00:00Z',
    sourceStatuses: [{ source: 'region-hannover-ris', status: 'partial', recordCount: 5, url: 'https://ris.hannit.de/public/vo040' }]
  });
  const item = row('Rats- und Parlamentsdokumente Hannover · Stadt, Region und Land');
  expect(item.coverage).toBe('10 Vorgänge');
  expect(item.description).toMatch(/3 mit Kartenbezug, 7 ohne Kartenbezug/);
  expect(item.description).toContain('4 Vorgängen ohne eindeutige Zuordnung');
  expect(item.description).toContain('Ebene Region sind 5 Vorgänge erfasst, davon 1 mit Kartenbezug');
  expect(item.description).toContain('Aktualisierung am 2026-01-03 schlug fehl');
  expect(item.sources).toContainEqual(expect.objectContaining({ label: expect.stringContaining('Teilbestand, 5 Vorgänge') }));
  expect(item.sources).toContainEqual(expect.objectContaining({ label: 'LGLN · INSPIRE-Hauskoordinaten' }));
  fs.unlinkSync(path.join(root, 'data/ris', roots.records.path));
  expect(row(item.label).coverage).toBe('Katalog unvollständig');
});

test('requires matching review-network revision and all advertised parts', () => {
  write('data/mobility/review-network/catalog.json', { cities: { hannover: 'r01' } });
  write('data/mobility/review-network/hannover/index.json', {
    revision: 'r01', counts: { segment: 3, junction: 2, crossing: 1 }, parts: [1, 2]
  });
  write('data/mobility/review-network/hannover/1.json.gz', {});
  expect(row('Prüfnetz Hannover').coverage).toBe('Prüfnetz unvollständig');
  write('data/mobility/review-network/hannover/2.json.gz', {});
  expect(row('Prüfnetz Hannover').coverage).toBe('3 Abschnitte, 2 Knoten, 1 Querungen');
});
