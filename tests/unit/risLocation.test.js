'use strict';

const { enrichRisLocations } = require('../../server/political-context/services/risLocation');

const limmerstrasse = {
  kind: 'street', name: 'Limmerstraße', attribution: '© OpenStreetMap-Mitwirkende, ODbL',
  geometry: { type: 'LineString', coordinates: [[9.71, 52.37], [9.72, 52.37]] },
};
const lutherkirche = {
  kind: 'place', name: 'Lutherkirche', attribution: 'Landeshauptstadt Hannover',
  geometry: { type: 'Point', coordinates: [9.72, 52.38] },
};

function enrich(records, entries = [limmerstrasse, lutherkirche], city = 'hannover') {
  return enrichRisLocations(records, { city, gazetteer: { city: 'hannover', entries } });
}

test('derives a street line from an exact title reference and identifies the source and scale', () => {
  const paper = { id: 'A', title: 'Verkehrssicherheit in der Limmerstrasse' };
  const [mapped] = enrich([paper]);
  expect(mapped).toMatchObject({
    ...paper, geometry: { type: 'LineString', coordinates: [[9.71, 52.37], [9.72, 52.37]] },
    locationSource: 'derived',
    locationLabel: expect.stringMatching(/Limmerstraße.*Titel.*Straßenverlauf.*© OpenStreetMap-Mitwirkende/i),
  });
  expect(paper).not.toHaveProperty('geometry');
});

test('labels a supplied partial street line as a cartographic extract', () => {
  const [record] = enrich([{ title: 'Verkehrssicherheit in der Limmerstraße' }], [
    { ...limmerstrasse, extent: 'part' },
  ]);
  expect(record.locationLabel).toMatch(/kartierter Teil des Straßenverlaufs als Orientierung/iu);
});

test('accepts an explicitly named place at its supplied position', () => {
  const [mapped] = enrich([{ title: 'Sicherer Zugang zur Lutherkirche' }]);
  expect(mapped).toMatchObject({
    geometry: { type: 'Point', coordinates: [9.72, 52.38] }, locationSource: 'derived',
    locationLabel: expect.stringContaining('Landeshauptstadt Hannover'),
  });
});

test('preserves existing geometry, accuracy and label even when the title also matches', () => {
  const paper = {
    title: 'Verkehrssicherheit in der Limmerstraße', locationSource: 'official',
    geometry: { type: 'Point', coordinates: [9.715, 52.374] }, locationLabel: 'Lageplan der Vorlage',
  };
  expect(enrich([paper])[0]).toBe(paper);
});

test('does not attach data from a different city', () => {
  const paper = { title: 'Verkehrssicherheit in der Limmerstraße' };
  expect(enrich([paper], [limmerstrasse], 'bonn')[0]).toBe(paper);
});

test('leaves a repeated street name in different locations unresolved', () => {
  const otherStreet = { ...limmerstrasse, geometry: { type: 'LineString', coordinates: [[9.74, 52.4], [9.76, 52.4]] } };
  const paper = { title: 'Verkehrssicherheit in der Limmerstraße' };
  expect(enrich([paper], [limmerstrasse, otherStreet])[0]).toBe(paper);
});

test.each([
  'Verkehrssicherheit in der Altlimmerstraße',
  'Verkehrssicherheit in der Limmerstraße-West',
  'Verkehrssicherheit in der Limmerstraße 14',
  'Verkehrssicherheit in der Limmerstraße, Abschnitt Ost',
  'Sanierung der Limmerstraße Nord',
  'Radweg in der Limmerstraße zwischen zwei Haltestellen',
  'Radweg neben der Limmerstraße',
  'Bau einer Unterführung in der Limmerstraße',
  'Kreuzung Limmerstraße / Kötnerholzweg',
  'Verkehrssicherheit in der Limmerstraße und der Fössestraße',
  'Sicherer Weg von der Lutherkirche in die Limmerstraße',
  'Einladung zur Sitzung in der Limmerstraße',
  'Radwegeausbau am Lindener Stichkanal und am Mittellandkanal',
])('leaves an unclear or more specific location searchable only: %s', title => {
  const paper = { title, meetingLocation: 'Limmerstraße' };
  expect(enrich([paper])[0]).toBe(paper);
});

test('requires a street cue for a name that could be a description of a nearby location', () => {
  const street = { ...limmerstrasse, name: 'Am Hauptbahnhof' };
  const papers = [
    { title: 'Bau Straße Am Hauptbahnhof' },
    { title: 'Radständer am Hauptbahnhof' },
  ];
  const [mapped, ambiguous] = enrich(papers, [street]);
  expect(mapped).toHaveProperty('locationSource', 'derived');
  expect(ambiguous).toBe(papers[1]);
});

test('refuses a point in place of a street line, an invalid position or missing attribution', () => {
  const paper = { title: 'Verkehrssicherheit in der Limmerstraße' };
  for (const entry of [
    { ...limmerstrasse, geometry: { type: 'Point', coordinates: [9.72, 52.37] } },
    { ...limmerstrasse, geometry: { type: 'LineString', coordinates: [[9.71, 52.37], [9.72, 520.37]] } },
    { ...limmerstrasse, geometry: { ...limmerstrasse.geometry, crs: 'EPSG:4326' } },
    { ...limmerstrasse, attribution: '' },
  ]) {
    expect(enrich([paper], [entry])[0]).toBe(paper);
  }
});

test.each([
  ['bonn', '260920-01 ST', 'Bau Straße Am Hauptbahnhof', [7.09655, 50.73259]],
  ['hannover', '15-1570/2026', 'Aufforderung zur Bereitstellung weiterer Informationen zum geplanten Bau der Hochbahnsteige in der Limmerstraße', [9.71403, 52.37137]],
])('uses the verified %s gazetteer for public record %s', (city, number, title, knownPosition) => {
  const gazetteer = require(`../../config/ris-locations/${city}.json`);
  const [record] = enrichRisLocations([{ title, number }], { city, gazetteer });
  expect(record).toMatchObject({ locationSource: 'derived', geometry: { type: 'MultiLineString' } });
  expect(record.geometry.coordinates.flat(1)).toContainEqual(knownPosition);
  expect(record.locationLabel).toContain('Straßenverlauf als Orientierung');
  expect(record.locationLabel).toContain('© OpenStreetMap-Mitwirkende');
});
