'use strict';

const { enrichRisLocations } = require('../../server/political-context/services/risLocation');
const stops = require('../../config/ris-locations/hannover-stadtbahn.json');
const gazetteer = { city: 'hannover', entries: [{ name: 'Beispielstraße', kind: 'street', attribution: 'Straßenverzeichnis',
  geometry: { type: 'LineString', coordinates: [[9.7, 52.3], [9.71, 52.31]] } }], regionalTramStops: stops };
const record = { source: 'hannover-sim', id: 'hannover-sim:1801-2007', title: 'Sicherung des Conti-Turms' };
const proof = 'Die Verwaltung wird beauftragt, eine Kostenermittlung für den Erhalt des Conti-Turms zu veranlassen.';
const url = 'https://www.openstreetmap.org/node/9977384887/history/3';
const reviewedSites = { sites: { tower: { kind: 'place', label: 'Conti-Turm', geometry: { type: 'Point', coordinates: [9.6787824, 52.383073] }, attribution: '© OpenStreetMap-Mitwirkende, ODbL', sourceUrl: url } },
  records: { [record.id]: { title: record.title, source: record.source, sites: [{ site: 'tower', text: proof }] } } };
function locate(row, register = reviewedSites) {
  return enrichRisLocations([row], { city: 'hannover', gazetteer: { ...gazetteer, reviewedSites: register } })[0];
}
test('attaches a reviewed document quotation to its exact current record and geometry', () => {
  expect(locate(record).locations).toEqual([expect.objectContaining({ label: 'Conti-Turm', geometry: reviewedSites.sites.tower.geometry,
    evidence: { source: 'document', text: proof }, attribution: expect.stringContaining('OpenStreetMap') })]);
  for (const changed of [{ title: 'Neuer Gegenstand' }, { id: 'hannover-sim:9999-2007' }, { source: 'region-hannover-ris' }]) {
    expect(locate({ ...record, ...changed }).locations.some(site => site.geometry)).toBe(false);
  }
});
test('recognizes a regional Hochbahnsteig with the verified corridor and construction phase', () => {
  const row = { source: 'region-hannover-ris', id: 'region-hannover-ris:vo:1004967', title: 'Stadtbahnstrecke A-Nord: Hochbahnsteig Bothfeld - Einleitung des Planfeststellungsverfahrens' };
  expect(locate(row).locations).toContainEqual(expect.objectContaining({ label: 'Haltestelle Bothfeld', geometry: { type: 'Point', coordinates: [9.79558, 52.415211] } }));
  for (const title of [row.title.replace('A-Nord', 'B-Nord'), row.title.replace('Bothfeld', 'Bothfeld und Lahe')]) {
    expect(locate({ ...row, title }).locations.some(site => site.geometry)).toBe(false);
  }
});

test.each(['hannover', 'bonn'])('resolves every reviewed reference in the shipped %s register', city => {
  const register = require(`../../config/ris-locations/${city}-reviewed-sites.json`);
  const { validLocationGeometry } = require('../../js/ua.ris-catalogue.js').snapshotFormat;
  const referencedSites = new Set();
  for (const row of Object.values(register.records)) {
    expect(row.source.trim().length).toBeGreaterThan(0);
    expect(row.title.trim().length).toBeGreaterThan(0);
    expect(row.sites.length).toBeGreaterThan(0);
    for (const reference of row.sites) {
      const site = register.sites[reference.site];
      expect(site).toBeDefined();
      expect(validLocationGeometry(site.geometry, site.kind)).toBe(true);
      expect(new URL(site.sourceUrl).protocol).toBe('https:');
      expect(site.attribution.trim().length).toBeGreaterThan(0);
      expect(new URL(reference.documentUrl).protocol).toBe('https:');
      expect(reference.text.trim().length).toBeGreaterThan(0);
      referencedSites.add(reference.site);
    }
  }
  expect(referencedSites).toEqual(new Set(Object.keys(register.sites)));
});
