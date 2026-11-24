/** @jest-environment node */
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCatalogue, snapshotFormat } = require('../../js/ua.ris-catalogue');
const { writeRisSnapshot, readRisSnapshot } = require('../../server/political-context/services/risSnapshot');
const source = 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/';
const area = { id: 'hannover-sim:15-1375-2023', title: 'Einsatz des Ordnungsdienstes im Stadtbezirk Linden-Limmer',
  source: 'hannover-sim', url: source + '15-1375-2023', number: null, date: null, type: 'Antrag', gremium: null,
  locations: [], locationAssessment: { status: 'unresolved', sources: ['title'], reasons: ['no_specific_location'], truncated: false } };
function apply(records) {
  return require('../../server/political-context/services/ratsatlasLocations').applyRatsatlasLocations('hannover', records);
}

test('district geometry retains its scope, evidence and credit across native publication and readback', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ratsatlas-'));
  try {
    const [record] = apply([area]);
    expect(record.locations).toHaveLength(1);
    expect(record.locations[0]).toMatchObject({kind: 'area', evidence: { source: 'title', text: area.title },
      provenance: { provider: 'ratsatlas-hannover', accuracy: 'Nur Stadtbezirk bekannt', evidenceUrl: area.url,
        method: 'Amtliches Gebiet aus ausdrücklicher Titelangabe', sourceUrl: expect.stringContaining('hannover.de/'),
        attribution: expect.stringContaining('Geoinformation') }});
    expect(['Polygon', 'MultiPolygon']).toContain(record.locations[0].geometry.type);
    expect(snapshotFormat.validLocationGeometry({ type: 'Point', coordinates: [9, 52] }, 'area')).toBe(false);
    const now = '2026-11-08T17:02:48.611Z';
    await writeRisSnapshot(dir, 'hannover', { sources: [source], generatedAt: now, records: [record],
      coverage: { from: null, to: null, bodies: [], warnings: [], complete: false } }, { now, schemaVersion: 2 });
    const saved = await readRisSnapshot(dir, 'hannover');
    expect(saved.manifest).toMatchObject({generatedAt: now, recordCount: 1, mappedRecordCount: 1});
    expect(saved.records[0].locations[0].provenance).toEqual(record.locations[0].provenance);
    expect(saved.features.features[0].properties.label).toContain('Nur Stadtbezirk bekannt');
    const browser = createCatalogue({base: 'https://example.org/', now: () => new Date(now),
      fetch: async url => new Response(await fs.readFile(path.join(dir, path.basename(new URL(url).pathname))))});
    const loaded = await browser.loadRecord('hannover', area.id);
    const [citation] = await browser.resolveReferences('hannover', [loaded]);
    expect(citation.reason).toContain('Stadtbezirk Linden-Limmer (Nur Stadtbezirk bekannt)');
    expect(citation.locations[0].provenance.evidenceUrl).toBe(area.url);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('joins only stable same-source IDs and unchanged titles, retracts old imports and preserves native evidence', () => {
  const [enriched] = apply([area]);
  expect(apply([enriched])).toEqual([enriched]);
  for (const change of [{ title: 'Geänderter Gegenstand' }, { id: 'hannover-sim:0410-2006' }, { source: 'region-hannover-ris' }]) {
    const [updated] = apply([{ ...enriched, ...change }]);
    expect(updated.locations).toEqual([]);
    expect(updated.locationAssessment.status).toBe('unresolved');
  }
  const native = { ...area, locationSource: 'official', geometry: { type: 'Point', coordinates: [9.7, 52.4] } };
  expect(apply([native])).toEqual([native]);
});

test('gives an independently confirmed address alongside a matching newly mapped street, with no duplicate mention', () => {
  const address = { ...area, id: 'hannover-sim:0655-2018', title: 'Erweiterung und Umstrukturierung der 2-gruppigen Kita "Knirpse", Sven-Hedin-Str. 7' };
  const street = { kind: 'street', label: 'Sven-Hedin-Straße', evidence: { source: 'title', text: address.title },
    geometry: { type: 'LineString', coordinates: [[9.7, 52.4], [9.71, 52.4]] } };
  const mention = {kind: 'address', label: 'Sven-Hedin-Straße 7', evidence: street.evidence, mapped: false};
  const [enriched] = apply([{...address, locations: [street, mention]}]);
  expect(enriched.locations.map(item => item.kind)).toEqual(['street', 'address']);
  expect(enriched.locations[0]).toEqual(street);
  expect(enriched.locations[1]).toMatchObject({geometry: {type:'Point'}, provenance: {accuracy:'Hauskoordinate'}});
  const [revoked] = apply([{...enriched, title:'Geänderte Planung'}]);
  expect(revoked.locations).toEqual([street, mention]);
});
