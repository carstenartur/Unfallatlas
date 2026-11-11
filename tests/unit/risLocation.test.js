'use strict';

const { readFileSync } = require('node:fs');
const { gunzipSync } = require('node:zlib');
const path = require('node:path');
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

function hannoverFacilityGazetteer() {
  const { publicFacilities, streetAliases, regionalProjectAddresses } = require('../../config/ris-locations/hannover.json');
  return {
    ...JSON.parse(gunzipSync(readFileSync(path.join(__dirname, '../../config/ris-locations/hannover-atkis.json.gz')))),
    publicFacilities, streetAliases, regionalProjectAddresses,
  };
}

test.each([
  ['0839-2014', '2014-04-25', 'Neubau Feuer-und Rettungswache Weidendamm, zweiter Bauabschnitt'],
  ['1100-2013', '2013-05-11', 'Feuer- und Rettungswache Weidendamm, zweiter Bauabschnitt'],
])('places the actual Weidendamm fire station planning title %s at the verified public address', (number, date, title) => {
  const [record] = enrichRisLocations([{ id: `hannover-sim:${number}`, source: 'hannover-sim', title, date }],
    { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toEqual([expect.objectContaining({
    kind: 'place', label: 'Feuer- und Rettungswache 1 (Weidendamm 50)',
    geometry: { type: 'Point', coordinates: [9.725982, 52.38909] },
    attribution: expect.stringMatching(/Landeshauptstadt Hannover.*LGLN/u),
    evidence: { source: 'title', text: title },
  })]);
});

test('maps a publicly documented municipal site even when its measure is outside traffic policy', () => {
  const title = 'Neubau der Feuer- und Rettungswache 4';
  const text = 'Die Landeshauptstadt Hannover betreibt in der Nenndorfer Chaussee 5 im Stadtteil Hannover-Bornum eine Feuer- und Rettungswache (FRW 4).';
  const [record] = enrichRisLocations([{ id: 'hannover-sim:1289-2025', source: 'hannover-sim', title, date: '2025-06-06', locationEvidence: [text] }],
    { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toEqual([expect.objectContaining({
    kind: 'place', label: 'Feuer- und Rettungswache 4 (Nenndorfer Chaussee 5)',
    geometry: { type: 'Point', coordinates: [9.69729, 52.349] },
    evidence: { source: 'document', text },
  })]);
  expect(record.locationAssessment.reasons).not.toContain('non_traffic_address');
});

test.each([
  'Ampelschaltung der Feuerwehr an der Ausfahrt der Feuerwache 3 auf die Bemeroder Straße',
  'Neubau Feuerwache 3 in der Nenndorfer Chaussee',
  'Feuerwache 1, Weidendamm 50-52',
  'Feuerwache Weidendamm, Hausnummer 42',
  'Feuerwache Weidendamm (Hausnummer 42)',
  'Feuerwache Weidendamm 50, Nr. 42',
  'Querung gegenüber der Feuerwache am Weidendamm',
  'Fußgängerquerung vor der Einfahrt der Feuerwache am Weidendamm',
  'Fußgängerquerung an der Einfahrt Weidendamm 50, Feuerwache 1',
  'Feuerwache 1 ist vom Weidendamm aus erreichbar',
  'Sperrung der Lange-Feld-Straße. Die Feuerwache liegt in unmittelbarer Nähe.',
  'Feuerwache 2 Auf der Klappenburg',
  'Feuerwache 2 Auf der Klappenburg 2',
])('does not infer a public address from conflicting or insufficient evidence in %s', title => {
  const [record] = enrichRisLocations([{ title, source: 'hannover-sim', date: '2018-02-01' }],
    { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations.some(location => location.kind === 'place' && location.geometry?.type === 'Point')).toBe(false);
});

test('uses a verified facility address before a postal suffix', () => {
  const [record] = enrichRisLocations([{
    title: 'Feuerwache Weidendamm 50, 30167 Hannover', source: 'hannover-sim',
  }], { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toMatchObject([{
    kind: 'place', label: 'Feuer- und Rettungswache 1 (Weidendamm 50)',
    geometry: { type: 'Point', coordinates: [9.725982, 52.38909] },
  }]);
});

test('keeps independently evidenced street work beside a named facility point', () => {
  const gazetteer = hannoverFacilityGazetteer();
  const title = 'Neubau Feuerwache am Weidendamm';
  const text = 'Der Radweg auf dem Weidendamm wird erneuert.';
  const [record] = enrichRisLocations([{ title, source: 'hannover-sim', locationEvidence: [text] }],
    { city: 'hannover', gazetteer });
  expect(record.locations).toEqual([
    expect.objectContaining({ kind: 'place', label: 'Feuer- und Rettungswache 1 (Weidendamm 50)',
      evidence: { source: 'title', text: title }, geometry: { type: 'Point', coordinates: [9.725982, 52.38909] } }),
    expect.objectContaining({ kind: 'street', label: 'Weidendamm', evidence: { source: 'document', text },
      geometry: gazetteer.entries.find(entry => entry.name === 'Weidendamm').geometry }),
  ]);
});

test('keeps an explicit street-subject title beside facility evidence', () => {
  const gazetteer = hannoverFacilityGazetteer();
  const title = 'Umgestaltung der Straße Weidendamm';
  const text = 'Neubau Feuerwache am Weidendamm';
  const [record] = enrichRisLocations([{ title, source: 'hannover-sim', locationEvidence: [text] }],
    { city: 'hannover', gazetteer });
  expect(record.locations).toEqual([
    expect.objectContaining({ kind: 'place', label: 'Feuer- und Rettungswache 1 (Weidendamm 50)',
      evidence: { source: 'document', text }, geometry: { type: 'Point', coordinates: [9.725982, 52.38909] } }),
    expect.objectContaining({ kind: 'street', label: 'Weidendamm', evidence: { source: 'title', text: title },
      geometry: gazetteer.entries.find(entry => entry.name === 'Weidendamm').geometry }),
  ]);
});

test('assigns the current Klappenburg building number only for a sufficiently recent title', () => {
  const [record] = enrichRisLocations([{
    title: 'Feuerwache 2 Auf der Klappenburg', source: 'hannover-sim', date: '2026-01-10',
  }], { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toMatchObject([{
    kind: 'place', label: 'Feuer- und Rettungswache 2 (Auf der Klappenburg 3)',
    geometry: { type: 'Point', coordinates: [9.650174, 52.413112] },
  }]);
});

test('does not choose between multiple public facilities on the same street', () => {
  const gazetteer = hannoverFacilityGazetteer();
  const existing = gazetteer.publicFacilities.entries[0];
  gazetteer.publicFacilities = { ...gazetteer.publicFacilities,
    entries: [...gazetteer.publicFacilities.entries, { ...existing, name: 'Andere Feuerwache', houseNumber: '5' }] };
  const [record] = enrichRisLocations([{ title: 'Neubau der Feuerwache am Weidendamm', source: 'hannover-sim' }],
    { city: 'hannover', gazetteer });
  expect(record.locations.some(location => location.kind === 'place' && location.geometry?.type === 'Point')).toBe(false);
});

test('derives a street line from an exact title reference and retains its evidence and attribution', () => {
  const paper = { id: 'A', title: 'Verkehrssicherheit in der Limmerstrasse' };
  const [mapped] = enrich([paper]);
  expect(mapped).toMatchObject({
    ...paper, locations: [{ kind: 'street', label: 'Limmerstraße',
      geometry: { type: 'LineString', coordinates: [[9.71, 52.37], [9.72, 52.37]] },
      evidence: { source: 'title', text: paper.title }, attribution: '© OpenStreetMap-Mitwirkende, ODbL',
    }],
  });
  expect(paper).not.toHaveProperty('geometry');
});

test('labels a supplied partial street line as a cartographic extract', () => {
  const [record] = enrich([{ title: 'Verkehrssicherheit in der Limmerstraße' }], [
    { ...limmerstrasse, extent: 'part' },
  ]);
  expect(record.locations[0]).toMatchObject({ kind: 'street', extent: 'part', geometry: limmerstrasse.geometry });
});

test('accepts an explicitly named place at its supplied position', () => {
  const [mapped] = enrich([{ title: 'Sicherer Zugang zur Lutherkirche' }]);
  expect(mapped.locations).toMatchObject([{ kind: 'place',
    geometry: { type: 'Point', coordinates: [9.72, 52.38] }, attribution: 'Landeshauptstadt Hannover',
  }]);
});

test('preserves existing geometry, accuracy and label even when the title also matches', () => {
  const paper = {
    title: 'Verkehrssicherheit in der Limmerstraße', locationSource: 'official',
    geometry: { type: 'Point', coordinates: [9.715, 52.374] }, locationLabel: 'Lageplan der Vorlage',
  };
  expect(enrich([paper])[0]).toMatchObject(paper);
});

test('does not attach data from a different city', () => {
  const paper = { title: 'Verkehrssicherheit in der Limmerstraße' };
  expect(enrich([paper], [limmerstrasse], 'bonn')[0]).toMatchObject({
    ...paper, locations: [], locationAssessment: { status: 'unavailable' },
  });
});

test('leaves a repeated street name in different locations unresolved', () => {
  const otherStreet = { ...limmerstrasse, geometry: { type: 'LineString', coordinates: [[9.74, 52.4], [9.76, 52.4]] } };
  const paper = { title: 'Verkehrssicherheit in der Limmerstraße' };
  expect(enrich([paper], [limmerstrasse, otherStreet])[0]).toMatchObject({
    ...paper, locations: [], locationAssessment: { status: 'unresolved' },
  });
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
  const [record] = enrich([paper]);
  expect(record).toMatchObject({ ...paper, locationAssessment: { status: 'unresolved' } });
  expect(record.locations.every(location => !location.geometry)).toBe(true);
  expect(record.geometry).toBeUndefined();
});

test('requires a street cue for a name that could be a description of a nearby location', () => {
  const street = { ...limmerstrasse, name: 'Am Hauptbahnhof' };
  const papers = [
    { title: 'Bau Straße Am Hauptbahnhof' },
    { title: 'Radständer am Hauptbahnhof' },
  ];
  const [mapped, ambiguous] = enrich(papers, [street]);
  expect(mapped.locations).toMatchObject([{ label: 'Am Hauptbahnhof', geometry: street.geometry }]);
  expect(ambiguous).toMatchObject({ ...papers[1], locations: [], locationAssessment: { status: 'unresolved' } });
});

test('refuses a point in place of a street line, an invalid position or missing attribution', () => {
  const paper = { title: 'Verkehrssicherheit in der Limmerstraße' };
  for (const entry of [
    { ...limmerstrasse, geometry: { type: 'Point', coordinates: [9.72, 52.37] } },
    { ...limmerstrasse, geometry: { type: 'LineString', coordinates: [[9.71, 52.37], [9.72, 520.37]] } },
    { ...limmerstrasse, geometry: { ...limmerstrasse.geometry, crs: 'EPSG:4326' } },
    { ...limmerstrasse, attribution: '' },
  ]) {
    expect(enrich([paper], [entry])[0]).toMatchObject({ ...paper, locations: [], locationAssessment: { status: 'unresolved' } });
  }
});

test.each([
  ['bonn', '260920-01 ST', 'Bau Straße Am Hauptbahnhof', [7.09655, 50.73259]],
  ['hannover', '15-1570/2026', 'Aufforderung zur Bereitstellung weiterer Informationen zum geplanten Bau der Hochbahnsteige in der Limmerstraße', [9.71403, 52.37137]],
])('uses the verified %s gazetteer for public record %s', (city, number, title, knownPosition) => {
  const gazetteer = require(`../../config/ris-locations/${city}.json`);
  const [record] = enrichRisLocations([{ title, number }], { city, gazetteer });
  expect(record.locations).toMatchObject([{ kind: 'street', geometry: { type: 'MultiLineString' }, evidence: { source: 'title', text: title } }]);
  expect(record.locations[0].geometry.coordinates.flat(1)).toContainEqual(knownPosition);
  expect(record.locations[0].attribution).toContain('© OpenStreetMap-Mitwirkende');
});

const street = (name, coordinates) => ({
  name, kind: 'street', geometry: { type: 'LineString', coordinates }, attribution: 'LGLN',
});

test('uses the named crossing in the motion text instead of drawing the whole street from its title', () => {
  const evidence = 'An der Kreuzung Davenstedter Straße/Südfeldstraße wird eine Ampel errichtet.';
  const [record] = enrich([{
    title: 'Errichtung einer Ampel zur Querung der Davenstedter Straße', locationEvidence: [evidence],
  }], [
    street('Davenstedter Straße', [[9.68, 52.366], [9.69, 52.366], [9.70, 52.366]]),
    street('Südfeldstraße', [[9.69, 52.365], [9.69, 52.366], [9.69, 52.367]]),
  ]);
  expect(record.locations).toEqual([{
    kind: 'junction', label: 'Davenstedter Straße / Südfeldstraße', evidence: { source: 'document', text: evidence },
    geometry: { type: 'Point', coordinates: [9.69, 52.366] }, attribution: 'LGLN',
  }]);
  expect(record.geometry).toBeUndefined();
});

test('keeps a crossing and a separately named address in the same evidence sentence', () => {
  const evidence = 'An der Kreuzung Davenstedter Straße/Südfeldstraße entsteht eine Ampel und in der Stephanusstraße 12 werden Fahrradbügel aufgestellt.';
  const [record] = enrichRisLocations([{ title: 'Sicherer Radverkehr', locationEvidence: [evidence] }], {
    city: 'hannover', gazetteer: {
      city: 'hannover', entries: [
        street('Davenstedter Straße', [[9.68, 52.366], [9.69, 52.366], [9.70, 52.366]]),
        street('Südfeldstraße', [[9.69, 52.365], [9.69, 52.366], [9.69, 52.367]]),
        { ...street('Stephanusstraße', [[9.71, 52.36], [9.71, 52.37]]), streetKey: '0324100102697' },
      ], addresses: { '0324100102697': { '12': [9.712, 52.368] } },
    },
  });
  expect(record.locations.map(({ kind, label, geometry }) => [kind, label, geometry?.coordinates])).toEqual([
    ['junction', 'Davenstedter Straße / Südfeldstraße', [9.69, 52.366]],
    ['address', 'Stephanusstraße 12', [9.712, 52.368]],
  ]);
});

test('retains a street named only in the operative document and excludes a comparison', () => {
  const evidence = 'Die Fahrbahn in der Limmerstraße wird saniert.';
  const [record] = enrich([{
    title: 'Fahrbahnsanierung', locationEvidence: [evidence, 'Wie bereits in der Stephanusstraße soll der Belag erneuert werden.'],
  }], [limmerstrasse, street('Stephanusstraße', [[9.71, 52.36], [9.71, 52.37]])]);
  expect(record.locations).toEqual([{
    kind: 'street', label: 'Limmerstraße', geometry: limmerstrasse.geometry, attribution: limmerstrasse.attribution,
    evidence: { source: 'document', text: evidence },
  }]);
});

test('keeps the street of an unspecified stop as text without mapping the whole road', () => {
  const evidence = 'Die Haltestelle in der Limmerstraße wird barrierefrei ausgebaut.';
  const [record] = enrich([{ title: 'Barrierefreier Ausbau', locationEvidence: [evidence] }]);
  expect(record.locations).toEqual([{
    kind: 'street', label: 'Limmerstraße', evidence: { source: 'document', text: evidence },
  }]);
});

test('cuts the named street to the network path between two stated anchors', () => {
  const evidence = 'Tempo 30 auf der Wunstorfer Straße (von der Kreuzung Wunstorfer Straße / Zimmermannstraße bis zur Kanalbrücke über den Stichkanal Hannover-Linden).';
  const [record] = enrich([{ title: 'Tempo 30 auf der Wunstorfer Straße', locationEvidence: [evidence] }], [
    street('Wunstorfer Straße', [[9.67, 52.38], [9.68, 52.38], [9.69, 52.38], [9.70, 52.38], [9.71, 52.38]]),
    street('Zimmermannstraße', [[9.68, 52.379], [9.68, 52.38], [9.68, 52.381]]),
    { ...lutherkirche, name: 'Kanalbrücke über den Stichkanal Hannover-Linden', geometry: { type: 'Point', coordinates: [9.70, 52.38] } },
  ]);
  expect(record.locations).toEqual([expect.objectContaining({
    kind: 'section', label: expect.stringMatching(/Wunstorfer Straße.*Zimmermannstraße.*Kanalbrücke/),
    evidence: { source: 'document', text: evidence },
    geometry: { type: 'LineString', coordinates: [[9.68, 52.38], [9.69, 52.38], [9.70, 52.38]] },
  })]);
});

test('keeps both explicitly proposed streets when the first name omits its common ending', () => {
  const evidence = 'Für Anwendungsversuche würden sich im Stadtbezirk die Nedderfeld- und die Viktoriastraße anbieten.';
  const [record] = enrich([{ title: 'Kopfsteinpflaster abschleifen', locationEvidence: [evidence] }], [
    street('Nedderfeldstraße', [[9.68, 52.38], [9.69, 52.38]]),
    street('Viktoriastraße', [[9.70, 52.38], [9.71, 52.38]]),
  ]);
  expect(record.locations.map(({ kind, label, geometry }) => [kind, label, geometry.type])).toEqual([
    ['street', 'Nedderfeldstraße', 'LineString'], ['street', 'Viktoriastraße', 'LineString'],
  ]);
});

test('keeps unresolved addresses visible without replacing them with a whole street', () => {
  const [record] = enrich([{
    title: 'Entzerrung Rad-Fußverkehr Stephanusstr 10, 12 und 14', locationEvidence: [],
  }], [street('Stephanusstraße', [[9.71, 52.36], [9.71, 52.37]])]);
  expect(record.locations.map(({ kind, label, geometry }) => [kind, label, geometry])).toEqual([
    ['address', 'Stephanusstraße 10', undefined],
    ['address', 'Stephanusstraße 12', undefined],
    ['address', 'Stephanusstraße 14', undefined],
  ]);
  expect(record.geometry).toBeUndefined();
});

test('keeps the stated junction as a text reference when the named axes do not intersect', () => {
  const [record] = enrich([{ title: 'Ampel an der Kreuzung Straße A / Straße B', locationEvidence: [] }], [
    street('Straße A', [[9.68, 52.366], [9.70, 52.366]]),
    street('Straße B', [[9.68, 52.367], [9.70, 52.367]]),
  ]);
  expect(record.locations).toEqual([{
    kind: 'junction', label: 'Straße A / Straße B',
    evidence: { source: 'title', text: 'Ampel an der Kreuzung Straße A / Straße B' },
  }]);
});

test('maps a known house number to the address coordinate for its exact street key', () => {
  const [record] = enrichRisLocations([{
    title: 'Entzerrung Rad-Fußverkehr Stephanusstr 10, 12 und 14', locationEvidence: [],
  }], { city: 'hannover', gazetteer: {
    city: 'hannover',
    entries: [{ ...street('Stephanusstraße', [[9.71, 52.36], [9.71, 52.37]]), streetKey: '0324100102700' }],
    addresses: { '0324100102700': { '12': [9.712, 52.368] } },
    addressAttribution: 'ALKIS · LGLN',
  } });
  expect(record.locations[1]).toMatchObject({ kind: 'address', label: 'Stephanusstraße 12',
    geometry: { type: 'Point', coordinates: [9.712, 52.368] }, attribution: 'ALKIS · LGLN' });
  expect(record.locations[0].geometry).toBeUndefined();
});

test('lists named waterways without assigning the works to the entire waterways', () => {
  const [record] = enrich([{
    title: 'Radwegeausbau am Lindener Stichkanal und am Mittellandkanal', locationEvidence: [],
  }], ['Lindener Stichkanal', 'Mittellandkanal'].map(name => ({ name, kind: 'place', textOnly: true, attribution: 'SIM' })));
  expect(record.locations.map(({ kind, label, geometry }) => [kind, label, geometry])).toEqual([
    ['place', 'Lindener Stichkanal', undefined], ['place', 'Mittellandkanal', undefined],
  ]);
});

test('preserves a place bounded by two streets without highlighting either entire street', () => {
  const evidence = 'Der Baumring auf dem Platz zwischen Zimmermannstraße und Weidestraße soll rückbegrünt werden.';
  const [record] = enrich([{ title: 'Baumring', locationEvidence: [evidence] }], [
    street('Zimmermannstraße', [[9.67, 52.38], [9.68, 52.38]]),
    street('Weidestraße', [[9.70, 52.38], [9.71, 52.38]]),
  ]);
  expect(record.locations).toEqual([{
    kind: 'place', label: 'Bereich zwischen Zimmermannstraße und Weidestraße', evidence: { source: 'document', text: evidence },
  }]);
});

test('maps both individually named crossings when the document uses the plural', () => {
  const evidence = 'Die Querungen an den Kreuzungen Bauweg/Davenstedter Straße und Bauweg/Badenstedter Straße werden verbessert.';
  const [record] = enrich([{ title: 'Sichere Querungen', locationEvidence: [evidence] }], [
    street('Bauweg', [[9.67, 52.38], [9.68, 52.38], [9.70, 52.38], [9.71, 52.38]]),
    street('Davenstedter Straße', [[9.68, 52.37], [9.68, 52.38], [9.68, 52.39]]),
    street('Badenstedter Straße', [[9.70, 52.37], [9.70, 52.38], [9.70, 52.39]]),
  ]);
  expect(record.locations.map(({ kind, label, geometry }) => [kind, label, geometry?.coordinates])).toEqual([
    ['junction', 'Bauweg / Davenstedter Straße', [9.68, 52.38]],
    ['junction', 'Bauweg / Badenstedter Straße', [9.70, 52.38]],
  ]);
});

test('does not use the bounds of an existing section as the extent of a requested extension', () => {
  const evidence = 'Der Radstreifen auf der Humboldtstraße zwischen Kreuzung Gustav-Bratke-Allee und Calenberger Straße ist bis zur gezackten Linie zu verlängern.';
  const [record] = enrich([{ title: 'Verlängerung des Radstreifens in der Humboldtstraße', locationEvidence: [evidence] }], [
    street('Humboldtstraße', [[9.67, 52.38], [9.68, 52.38], [9.70, 52.38], [9.71, 52.38]]),
    street('Gustav-Bratke-Allee', [[9.68, 52.37], [9.68, 52.38], [9.68, 52.39]]),
    street('Calenberger Straße', [[9.70, 52.37], [9.70, 52.38], [9.70, 52.39]]),
  ]);
  expect(record.locations).toHaveLength(1);
  expect(record.locations[0]).toMatchObject({ kind: 'section', evidence: { source: 'document', text: evidence } });
  expect(record.locations[0].geometry).toBeUndefined();
});

test('does not use a street from the next clause to replace an unnamed end of a section', () => {
  const evidence = 'Arbeiten auf der Hauptstraße zwischen Nordstraße und der Schule; anschließend folgt die Querung der Südstraße.';
  const [record] = enrich([{ title: 'Baumaßnahmen', locationEvidence: [evidence] }], [
    street('Hauptstraße', [[9.67, 52.38], [9.68, 52.38], [9.70, 52.38], [9.71, 52.38]]),
    street('Nordstraße', [[9.68, 52.37], [9.68, 52.38], [9.68, 52.39]]),
    street('Südstraße', [[9.70, 52.37], [9.70, 52.38], [9.70, 52.39]]),
  ]);
  expect(record.locations[0]).toMatchObject({ kind: 'section' });
  expect(record.locations[0].geometry).toBeUndefined();
});

test('keeps the letter of a house number even when the SIM inserts a space', () => {
  const [record] = enrichRisLocations([{
    title: 'Radverkehr Am Spielfelde 13 A', locationEvidence: [],
  }], { city: 'hannover', gazetteer: {
    city: 'hannover',
    entries: [{ ...street('Am Spielfelde', [[9.71, 52.36], [9.71, 52.37]]), streetKey: '0324100100001' }],
    addresses: { '0324100100001': { '13': [9.712, 52.368], '13a': [9.713, 52.368] } },
  } });
  expect(record.locations[0]).toMatchObject({ label: 'Am Spielfelde 13 A', geometry: { coordinates: [9.713, 52.368] } });
});

test('keeps a crossing without a shared network vertex as a textual location', () => {
  const [record] = enrich([{ title: 'Querung an der Kreuzung Straße A / Straße B', locationEvidence: [] }], [
    street('Straße A', [[9.68, 52.366], [9.70, 52.366]]),
    street('Straße B', [[9.69, 52.365], [9.69, 52.367]]),
  ]);
  expect(record.locations[0]).toMatchObject({ label: 'Straße A / Straße B', kind: 'junction' });
  expect(record.locations[0].geometry).toBeUndefined();
});

test('keeps the address in a non-traffic matter as a search location without an exact marker', () => {
  const [record] = enrichRisLocations([{
    title: 'Ferienwohnung in der Stephanusstraße 12', locationEvidence: [],
  }], { city: 'hannover', gazetteer: {
    city: 'hannover',
    entries: [{ ...street('Stephanusstraße', [[9.71, 52.36], [9.71, 52.37]]), streetKey: '0324100102697' }],
    addresses: { '0324100102697': { '12': [9.712, 52.368] } },
  } });
  expect(record.locations[0]).toMatchObject({ kind: 'address', label: 'Stephanusstraße 12' });
  expect(record.locations[0].geometry).toBeUndefined();
});

test.each(['bonn', 'hannover'])('checks every %s title with the multi-location parser without requiring document text', city => {
  const [record] = enrichRisLocations([{ title: 'Radwege an der Limmerstraße und an der Lutherkirche' }], {
    city, gazetteer: { city, entries: [limmerstrasse, lutherkirche] },
  });
  expect(record.locations?.map(({ label }) => label)).toEqual(['Limmerstraße', 'Lutherkirche']);
  expect(record.locationAssessment).toEqual({ status: 'mapped', sources: ['title'], reasons: [], truncated: false });
});

test('records an unresolved result even when no specific location is found', () => {
  const [record] = enrich([{ title: 'Verkehrssicherheit im Stadtgebiet', locationEvidence: [] }]);
  expect(record.locations).toEqual([]);
  expect(record.locationAssessment).toEqual({
    status: 'unresolved', sources: ['title'], reasons: ['no_specific_location'], truncated: false,
  });
});

test('reports missing city geodata without borrowing another city or keeping an old derived point', () => {
  const [record] = enrich([{
    title: 'Verkehrssicherheit in der Limmerstraße',
    geometry: { type: 'Point', coordinates: [9.71, 52.37] }, locationSource: 'derived', locationLabel: 'Alter Punkt',
  }], [limmerstrasse], 'bonn');
  expect(record.geometry).toBeUndefined();
  expect(record.locations).toEqual([]);
  expect(record.locationAssessment).toEqual({
    status: 'unavailable', sources: ['title'], reasons: ['gazetteer_unavailable'], truncated: false,
  });
});

test('replaces obsolete derived locations when a new assessment no longer finds evidence', () => {
  const original = {
    title: 'Verkehrssicherheit im Stadtgebiet', locationEvidence: [],
    locations: [{ kind: 'street', label: 'Limmerstraße', geometry: limmerstrasse.geometry,
      evidence: { source: 'title', text: 'Ein inzwischen korrigierter Titel' } }],
  };
  const [record] = enrich([original]);
  expect(record.locations).toEqual([]);
  expect(record.locationAssessment.status).toBe('unresolved');
  expect(original.locations).toHaveLength(1);
});

test('retains a verified official geometry while also assessing other explicitly named locations', () => {
  const geometry = { type: 'Point', coordinates: [9.715, 52.374] };
  const [record] = enrich([{
    title: 'Sicherer Zugang zur Lutherkirche', geometry, locationSource: 'official', locationLabel: 'Amtlicher Lageplan',
  }]);
  expect(record).toMatchObject({ geometry, locationSource: 'official', locationLabel: 'Amtlicher Lageplan' });
  expect(record.locations).toMatchObject([{ label: 'Lutherkirche', geometry: lutherkirche.geometry }]);
  expect(record.locationAssessment).toEqual({
    status: 'mapped', sources: ['title', 'official'], reasons: [], truncated: false,
  });
});

test('does not count malformed official coordinates as mapped evidence', () => {
  const [record] = enrich([{
    title: 'Verkehrssicherheit im Stadtgebiet', locationSource: 'official',
    geometry: { type: 'Point', coordinates: [9.71, 520] },
  }]);
  expect(record.geometry).toBeUndefined();
  expect(record.locationAssessment.status).toBe('unresolved');
  expect(record.locationAssessment.sources).toEqual(['title']);
});

test('distinguishes partly mapped places from a wholly unresolved result', () => {
  const [record] = enrich([{
    title: 'Radverkehr verbessern',
    locationEvidence: ['Die Fahrbahn in der Limmerstraße wird saniert.', 'Fahrradbügel in der Limmerstraße 14.'],
  }]);
  // A specific address takes precedence over a general reference to that street.
  expect(record.locationAssessment.status).toBe('unresolved');
  const [partial] = enrich([{
    title: 'Radverkehr verbessern',
    locationEvidence: ['Sicherer Zugang zur Lutherkirche.', 'Fahrradbügel in der Limmerstraße 14.'],
  }]);
  expect(partial.locationAssessment).toEqual({
    status: 'partial', sources: ['title', 'document'], reasons: ['unmapped_location'], truncated: false,
  });
});

test('reports ambiguous names without converting them into a map marker', () => {
  const [record] = enrich([{ title: 'Verkehrssicherheit in der Limmerstraße' }], [
    limmerstrasse, { ...limmerstrasse, geometry: { type: 'LineString', coordinates: [[9.74, 52.4], [9.76, 52.4]] } },
  ]);
  expect(record.locations).toEqual([]);
  expect(record.locationAssessment.status).toBe('unresolved');
  expect(record.locationAssessment.reasons).toContain('unverified_name');
});

test('retains available evidence and reports a truncated or unavailable document fetch', () => {
  const [record] = enrich([{
    title: 'Verkehrssicherheit', locationEvidence: ['Die Fahrbahn in der Limmerstraße wird saniert.'],
    locationEvidenceTruncated: true, locationEvidenceUnavailable: true,
  }]);
  expect(record.locations[0].geometry).toEqual(limmerstrasse.geometry);
  expect(record.locationAssessment).toEqual({
    status: 'partial', sources: ['title', 'document'],
    reasons: ['document_text_unavailable', 'evidence_truncated'], truncated: true,
  });
});

test('does not claim a document was reviewed when its fetch was unavailable', () => {
  const [record] = enrich([{
    title: 'Verkehrssicherheit im Stadtgebiet', locationEvidence: [], locationEvidenceUnavailable: true,
  }]);
  expect(record.locationAssessment.sources).toEqual(['title']);
  expect(record.locationAssessment.reasons).toContain('document_text_unavailable');
  expect(record.locationAssessment.status).toBe('unresolved');
});

test('reports that more than eight identified places could not all be published', () => {
  const entries = Array.from({ length: 9 }, (_, i) => street(`Teststraße ${i + 1}`, [[9.7, 52.37], [9.71, 52.37]]));
  const [record] = enrich([{
    title: 'Fahrbahnsanierung', locationEvidence: entries.map(entry => `Die Fahrbahn in der ${entry.name} wird saniert.`),
  }], entries);
  expect(record.locations).toHaveLength(8);
  expect(record.locationAssessment).toEqual({
    status: 'partial', sources: ['title', 'document'], reasons: ['location_limit'], truncated: true,
  });
});

test('partitioned publication retains every identified place beyond the legacy eight-place limit', () => {
  const entries = Array.from({ length: 12 }, (_, i) => street(`Teststraße ${i + 1}`, [[9.7, 52.37], [9.71, 52.37]]));
  const [record] = enrichRisLocations([{
    title: 'Fahrbahnsanierung', locationEvidence: entries.map(entry => `Die Fahrbahn in der ${entry.name} wird saniert.`),
  }], { city: 'hannover', gazetteer: { city: 'hannover', entries }, maxLocationsPerRecord: Infinity });
  expect(record.locations).toHaveLength(12);
  expect(record.locationAssessment).toEqual({
    status: 'mapped', sources: ['title', 'document'], reasons: [], truncated: false,
  });
});

test.each([
  { title: 'Einladung zur Sitzung in der Limmerstraße 14', locationEvidence: [] },
  { title: 'Radverkehr verbessern', locationEvidence: ['Wie bereits in der Limmerstraße 14 sollen Fahrradbügel aufgestellt werden.'] },
])('does not treat meeting addresses or comparisons as the proposed measure location', paper => {
  const [record] = enrichRisLocations([paper], { city: 'hannover', gazetteer: {
    city: 'hannover', entries: [{ ...limmerstrasse, streetKey: 'example' }],
    addresses: { example: { '14': [9.715, 52.37] } },
  } });
  expect(record.locations).toEqual([]);
  expect(record.locationAssessment.status).toBe('unresolved');
});

test.each([
  'Radweg in der Hauptstraße in Garbsen',
  'Region Hannover: Radweg in der Hauptstraße',
  'Radweg in der Hauptstraße außerhalb der Landeshauptstadt Hannover',
  'Radweg in der Hauptstraße nicht in Hannover',
  'In Hannover wird über den Radweg in der Hauptstraße in Garbsen beraten',
  'In Hannover beschlossen: Sanierung der Hauptstraße',
  'Anders als in Hannover wird die Fahrbahn in der Hauptstraße saniert',
  'In Hannover wird beraten; Fahrradbügel in der Hauptstraße 12 werden beantragt',
  'Die Fahrbahn in der Hauptstraße in Hannover-Land wird saniert',
  'Radweg in der Hauptstraße in Hannover und in Lehrte',
  'Antragsteller in Hannover fordert einen Radweg in der Hauptstraße',
])('does not use Hannover city geometry for a Region title without reliable city scope: %s', title => {
  const paper = { source: 'region-hannover-ris', title, gremium: 'Regionsversammlung in Hannover',
    geometry: { type: 'Point', coordinates: [9.715, 52.37] }, locationSource: 'derived', locationLabel: 'Alter abgeleiteter Punkt' };
  const [record] = enrich([paper], [street('Hauptstraße', [[9.71, 52.37], [9.72, 52.37]])]);
  expect(record.locations).toEqual([]);
  expect(record.geometry).toBeUndefined();
  expect(record.locationSource).toBeUndefined();
  expect(record.locationLabel).toBeUndefined();
  expect(record.locationAssessment).toEqual({
    status: 'unavailable', sources: ['title'], reasons: ['gazetteer_unavailable'], truncated: false,
  });
  expect(record.title).toBe(title);
  expect(paper.locationSource).toBe('derived');
});

test.each(['in Hannover', 'in der Stadt Hannover', 'in der Landeshauptstadt Hannover'])('maps a Region street explicitly scoped to the city %s', scope => {
  const main = street('Hauptstraße', [[9.71, 52.37], [9.72, 52.37]]);
  const title = `Radweg in der Hauptstraße ${scope}`;
  const [record] = enrich([{ source: 'region-hannover-ris', title }], [main]);
  expect(record.locations).toEqual([{ kind: 'street', label: 'Hauptstraße', geometry: main.geometry,
    attribution: 'LGLN', evidence: { source: 'title', text: title } }]);
});

test('maps a Landtag street only when its city can be established', () => {
  const main = street('Hauptstraße', [[9.71, 52.37], [9.72, 52.37]]);
  const records = enrich([
    { source: 'niedersachsen-landtag', title: 'Radweg an der Hauptstraße in der Region Hannover' },
    { source: 'niedersachsen-landtag', title: 'Radweg an der Hauptstraße in der Stadt Hannover' },
  ], [main]);
  expect(records[0].locations).toEqual([]);
  expect(records[1].locations).toEqual([expect.objectContaining({ label: 'Hauptstraße', geometry: main.geometry })]);
});

test('requires city scope separately for every Region title and document sentence', () => {
  const main = street('Hauptstraße', [[9.71, 52.37], [9.72, 52.37]]);
  const evidence = 'Die Fahrbahn in der Hauptstraße in Hannover wird saniert.';
  const paper = { source: 'region-hannover-ris', title: 'Radweg in der Nordstraße in Garbsen', locationEvidence: [
    evidence,
    'In Hannover wurde das Bauprogramm vorgestellt. Die Fahrbahn in der Nordstraße in Garbsen wird saniert.',
    'Die Fahrbahn in der Südstraße wird saniert.',
  ] };
  const [record] = enrich([paper], [main,
    street('Nordstraße', [[9.71, 52.38], [9.72, 52.38]]), street('Südstraße', [[9.71, 52.36], [9.72, 52.36]]),
  ]);
  expect(record.locations).toEqual([{ kind: 'street', label: 'Hauptstraße', geometry: main.geometry,
    attribution: 'LGLN', evidence: { source: 'document', text: evidence } }]);
  expect(record.locationEvidence).toEqual(paper.locationEvidence);
  expect(record.title).toBe(paper.title);
  expect(record.locationAssessment.sources).toEqual(['title', 'document']);
});

test('does not propagate a Region title city scope to an unscoped document paragraph', () => {
  const [record] = enrich([{ source: 'region-hannover-ris', title: 'Sanierungsprogramm in Hannover',
    locationEvidence: ['Die Fahrbahn in der Hauptstraße wird saniert.'],
  }], [street('Hauptstraße', [[9.71, 52.37], [9.72, 52.37]])]);
  expect(record.locations).toEqual([]);
  expect(record.locationAssessment.sources).toEqual(['title', 'document']);
});

test.each([
  'Kontakt für Radverkehr in Hannover: Hauptstraße 12.',
  'Kontakt für Radverkehr: Hauptstraße 12 in Hannover.',
  'Die Radverkehrsunterlagen liegen im Regionshaus in Hannover, Hauptstraße 12.',
  'Sitzung des Verkehrsausschusses in Hannover, Hauptstraße 12.',
])('does not map a Region administrative address as a traffic measure: %s', evidence => {
  const [record] = enrichRisLocations([{ source: 'region-hannover-ris', title: 'Radverkehrsprogramm', locationEvidence: [evidence] }], {
    city: 'hannover', gazetteer: { city: 'hannover',
      entries: [{ ...street('Hauptstraße', [[9.71, 52.37], [9.72, 52.37]]), streetKey: 'main' }],
      addresses: { main: { '12': [9.715, 52.37] } },
    },
  });
  expect(record.locations).toEqual([]);
});

test('preserves official Region geometry and incomplete evidence flags without deriving a city street', () => {
  const geometry = { type: 'Point', coordinates: [9.6, 52.42] };
  const [record] = enrich([{ source: 'region-hannover-ris', title: 'Radweg in der Hauptstraße in Garbsen',
    geometry, locationSource: 'official', locationLabel: 'Amtlicher Lageplan',
    locationEvidence: ['Die Fahrbahn in der Hauptstraße in Garbsen wird saniert.'],
    locationEvidenceTruncated: true, locationEvidenceUnavailable: true,
  }], [street('Hauptstraße', [[9.71, 52.37], [9.72, 52.37]])]);
  expect(record).toMatchObject({ geometry, locationSource: 'official', locationLabel: 'Amtlicher Lageplan',
    locationEvidenceTruncated: true, locationEvidenceUnavailable: true });
  expect(record.locations).toEqual([]);
  expect(record.locationAssessment).toEqual({
    status: 'partial', sources: ['title', 'document', 'official'],
    reasons: ['gazetteer_unavailable', 'document_text_unavailable', 'evidence_truncated'], truncated: true,
  });
});

const addressGazetteer = {
  city: 'hannover', attribution: 'Verified address fixture', addressAttribution: 'Verified address fixture',
  entries: [{ ...limmerstrasse, streetKey: 'limmer' }],
  addresses: { limmer: { '12': [9.712, 52.37], '12a': [9.713, 52.37], '14': [9.714, 52.37] } },
};

test('retains the exact address in the unmodified published reply 15-1782/2019 F1', () => {
  const text = 'Das Team Immissionsschutz der Region Hannover hat Nachbarschaftsbeschwerden über Geruchsbelästigungen – verursacht durch die Gaststätte Kebapci Musa in der Gustav-Adolf-Straße 6 -bearbeitet. Es konnte erfolgreich auf den Einbau einer Abluftfilteranlage hingewirkt werden.';
  const context = 'Die Windrichtungsdaten sind für diesen Zeitraum stündlich gemessen worden. Nach Auswertung dieser Daten bleibt festzuhalten, dass für das Jahr 2017 die vorgenannte Grenze von 10% mit für das Kebapci Musa ermittelten 6, 78 % deutlich unterschritten wird.';
  const title = 'Antwort der Verwaltung auf die Anfrage Geruchsbelästigungen in der Nordstadt';
  const [record] = enrichRisLocations([{ id: 'hannover-sim:15-1782-2019F1', source: 'hannover-sim', title, locationEvidence: [text, context] }],
    { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toEqual([expect.objectContaining({ kind: 'address', label: 'Gustav-Adolf-Straße 6',
    geometry: { type: 'Point', coordinates: [9.726686, 52.381992] },
    evidence: { source: 'document', text: 'Das Team Immissionsschutz der Region Hannover hat Nachbarschaftsbeschwerden über Geruchsbelästigungen – verursacht durch die Gaststätte Kebapci Musa in der Gustav-Adolf-Straße 6 -bearbeitet.' } })]);
});

test.each([
  ['12 -geprüft.', 'Limmerstraße 12', [9.712, 52.37]],
  ['12 A –saniert.', 'Limmerstraße 12 A', [9.713, 52.37]],
  ['12-14 —überprüft.', 'Limmerstraße 12-14', undefined],
  ['12 -bislang geprüft.', 'Limmerstraße 12', [9.712, 52.37]],
  ['12 -geprüft seit 14 Tagen.', 'Limmerstraße 12', [9.712, 52.37]],
])('retains the complete address before a dash attached to prose in %s', (tail, label, coordinates) => {
  const text = `Die Verkehrsmaßnahme wird in der Limmerstraße ${tail}`;
  const [record] = enrichRisLocations([{ title: 'Radverkehr', locationEvidence: [text] }], { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations.map(place => [place.label, place.geometry?.coordinates])).toEqual([[label, coordinates]]);
  expect(record.locations[0].evidence).toEqual({ source: 'document', text });
});

test.each(['12 -', '12 -a', '12 -b', '12 -ab', '12 -a/b', '12 bis', '12 /', '12 - 14abc'])('does not truncate a partial address continuation %s at its first house number', tail => {
  const [record] = enrichRisLocations([{ title: `Radverkehr Limmerstraße ${tail}` }], { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations).toEqual([]);
});

test.each([
  '12 -bis 14', '12 -bis', '12 -bis 8/10', '12 -und 14', '12 -und', '12 -oder 14', '12 -sowie 14', '12 -bzw 14',
  '12 -beziehungsweise 14', '12 -beziehungsweise', '12 -respektive 14', '12 -respektive',
  '12 -alternativ 14', '12 -wahlweise 14', '12 -inklusive 14',
  '12 -alternativ,14', '12 -inklusive , 14',
])('does not treat a dashed address operator as prose in titles or documents: %s', tail => {
  const text = `Radverkehr in der Limmerstraße ${tail}`;
  const records = enrichRisLocations([{ title: text }, { title: 'Radverkehr', locationEvidence: [text] }],
    { city: 'hannover', gazetteer: addressGazetteer });
  expect(records.map(record => record.locations)).toEqual([[], []]);
});

test.each([
  ['12-14', '12-14'], ['12 bis 14', '12 bis 14'], ['12/14', '12/14'],
  ['12 A – 14 B', '12 A-14 B'], ['12 / 14', '12/14'], ['12 A -b', '12 A-B'],
])('retains the complete address compound %s without geocoding its first number', (tail, label) => {
  const title = `Radverkehr in der Limmerstraße ${tail}`;
  const [record] = enrichRisLocations([{ title }], { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations).toEqual([{ kind: 'address', label: `Limmerstraße ${label}`, evidence: { source: 'title', text: title } }]);
  expect(record.locationAssessment.reasons).toContain('unmapped_location');
});

test.each(['Nr.12', 'Nr. 12', 'Hausnr. 12', 'Hausnummer 12'])('maps an explicit address abbreviation %s to its exact key', tail => {
  const title = `Radverkehr in der Limmerstraße ${tail}`;
  const [record] = enrichRisLocations([{ title }], { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations).toEqual([{ kind: 'address', label: 'Limmerstraße 12',
    geometry: { type: 'Point', coordinates: [9.712, 52.37] }, attribution: 'Verified address fixture', evidence: { source: 'title', text: title } }]);
});

test('does not discard a range following an exact address in a mixed list', () => {
  const title = 'Radverkehr Limmerstraße 12 A, 12 bis 14 und 99';
  const [record] = enrichRisLocations([{ title }], { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations.map(place => [place.label, place.geometry?.coordinates])).toEqual([
    ['Limmerstraße 12 A', [9.713, 52.37]], ['Limmerstraße 12 bis 14', undefined], ['Limmerstraße 99', undefined],
  ]);
});

test.each(['12-foo', '12/Schule', '12 bis Schule', '12345', '12abc', '12 -', '12/14abc', '12 km'])('never maps an address prefix from malformed or non-address tail %s', tail => {
  const [record] = enrichRisLocations([{ title: `Radverkehr in der Limmerstraße ${tail}` }], { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations.some(place => place.geometry)).toBe(false);
});

test.each([
  ['12-14', ['Limmerstraße 12-14']], ['12 bis 14', ['Limmerstraße 12 bis 14']],
  ['12/14', ['Limmerstraße 12/14']], ['Nr.12', ['Limmerstraße 12']],
  ['Hausnr. 12', ['Limmerstraße 12']], ['12 A und 14', ['Limmerstraße 12 A', 'Limmerstraße 14']],
])('retains a regional address %s directly qualified by Hannover', (tail, labels) => {
  const title = `Radverkehr in der Limmerstraße ${tail} in Hannover`;
  const [record] = enrichRisLocations([{ source: 'region-hannover-ris', title }], { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations.map(place => place.label)).toEqual(labels);
  expect(record.locations.every(place => place.evidence.text === title)).toBe(true);
});

test.each([
  'Radverkehr Limmerstraße 12-14 in Garbsen',
  'Radverkehr Limmerstraße 12/14 in Hannover und in Garbsen',
  'Radverkehr Limmerstraße 12-14 in Hannover. In Garbsen werden andere Straßen geprüft.',
])('does not lend Hannover coordinates to another municipality in regional evidence: %s', title => {
  const [record] = enrichRisLocations([{ source: 'region-hannover-ris', title }], { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations.some(place => place.geometry)).toBe(false);
});

test('requires the regional address city qualifier in the same sentence', () => {
  const [record] = enrichRisLocations([{ source: 'region-hannover-ris', title: 'Radverkehr in Hannover',
    locationEvidence: ['Radweg in der Limmerstraße 12-14. Die Maßnahme liegt in Hannover.'],
  }], { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations).toEqual([]);
});

test.each([
  'Radverkehr Limmerstraße Nr.12 in Hannover / Garbsen',
  'Radverkehr Limmerstraße 12 in Hannover und Garbsen',
  'Radverkehr Limmerstraße 12 A-foo',
  'Radverkehr Limmerstraße 12 A bis Schule',
])('rejects ambiguous non-address continuations rather than mapping an address prefix: %s', title => {
  const [record] = enrichRisLocations([{ source: title.includes('Hannover') ? 'region-hannover-ris' : 'hannover-ris', title }],
    { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations.some(place => place.geometry)).toBe(false);
});

test.each(['12 A -', 'Hausnr.12-foo', 'Hausnr. 12/Schule'])('does not replace an invalid explicit address %s with the entire street', tail => {
  const [record] = enrichRisLocations([{ title: `Radverkehr in der Limmerstraße ${tail}` }], { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations.some(place => place.geometry)).toBe(false);
});

test('uses an address compound coordinate only when its complete authoritative key exists', () => {
  const [record] = enrichRisLocations([{ title: 'Radverkehr Limmerstraße 12-14' }], { city: 'hannover', gazetteer: {
    ...addressGazetteer, addresses: { limmer: { '12': [9.712, 52.37], '12-14': [9.716, 52.37] } },
  } });
  expect(record.locations).toMatchObject([{ kind: 'address', label: 'Limmerstraße 12-14',
    geometry: { type: 'Point', coordinates: [9.716, 52.37] } }]);
});

test('does not map only a numeric prefix of an address list beyond its parsing bound', () => {
  const [record] = enrichRisLocations([{ title: 'Radverkehr Limmerstraße 12, 14, 16, 18, 20, 22, 24, 26 und 28' }],
    { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations).toEqual([]);
});

test.each(['12', '12-14', '12 und 14', '12, 14'])('retains a directly qualified Region address with a comma before Hannover: %s', tail => {
  const title = `Radverkehr Limmerstraße ${tail}, in Hannover`;
  const [record] = enrichRisLocations([{ source: 'region-hannover-ris', title }], { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations.length).toBe(tail.includes('und') || tail === '12, 14' ? 2 : 1);
  expect(record.locations[0].label).toBe(tail === '12-14' ? 'Limmerstraße 12-14' : 'Limmerstraße 12');
});

test.each(['12', '12-14', '12 und 14', '12, 14'])('rejects a second comma-separated municipality after the Region city qualifier: %s', tail => {
  const title = `Radverkehr Limmerstraße ${tail} in Hannover, Garbsen`;
  const [record] = enrichRisLocations([{ source: 'region-hannover-ris', title }], { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations).toEqual([]);
});

test.each(['Hausnr. unbekannt', 'Hausnr.unbekannt', 'Nr. unbekannt', 'Hausnummer unbekannt'])('does not infer a whole-street location from the explicit unknown address marker %s', tail => {
  const title = `Radverkehr in der Limmerstraße ${tail}`;
  const [record] = enrichRisLocations([{ title }], { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations).toEqual([]);
  expect(record.title).toBe(title);
});

test.each(['Nr', 'Hausnr', 'Hausnummer', 'Hausnummern'])('does not map a whole street for the malformed attached numeric marker %s12-foo', prefix => {
  const [record] = enrichRisLocations([{ title: `Radverkehr in der Limmerstraße ${prefix}12-foo` }],
    { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations).toEqual([]);
});

test.each(['Nr', 'Hausnr', 'Hausnummer', 'Hausnummern'])('keeps the valid attached numeric marker %s12 mapped to its exact address', prefix => {
  const [record] = enrichRisLocations([{ title: `Radverkehr in der Limmerstraße ${prefix}12` }],
    { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations).toMatchObject([{ kind: 'address', label: 'Limmerstraße 12',
    geometry: { type: 'Point', coordinates: [9.712, 52.37] } }]);
});

test.each([
  ['hannover-sim:0576-2023', 'Vorhabenbezogener Bebauungsplan Nr. 1921 – Jordanstraße 28A – Einleitungsbeschluss', 'Jordanstraße 28 A'],
  ['hannover-sim:0579-2023', 'Bebauungsplan Nr. 650, Teilaufhebung als Maßnahme der Innenentwicklung – Eintrachtweg 1-15 – Aufstellungsbeschluss, Beschluss über die frühzeitige Beteiligung der Öffentlichkeit', 'Eintrachtweg 1-15'],
  ['hannover-sim:0001-2018', 'Einfacher Bebauungsplan der Innenentwicklung Nr. 1864, Hildesheimer Straße 9 - 15 (ungerade) Aufstellungsbeschluss', 'Hildesheimer Straße 9-15'],
])('retains the complete address before a prose separator in published record %s', (id, title, label) => {
  const { readFileSync } = require('node:fs');
  const { gunzipSync } = require('node:zlib');
  const path = require('node:path');
  const gazetteer = JSON.parse(gunzipSync(readFileSync(path.join(__dirname, '../../config/ris-locations/hannover-atkis.json.gz'))));
  const [record] = enrichRisLocations([{ id, source: 'hannover-sim', title }], { city: 'hannover', gazetteer });
  expect(record.locations).toMatchObject([{ kind: 'address', label, evidence: { source: 'title', text: title } }]);
  if (label.includes('-')) expect(record.locations[0].geometry).toBeUndefined();
});

test.each(['–', '—'])('retains an exact address and a text-only range before a spaced %s procedural separator', separator => {
  const title = `Radverkehr Limmerstraße 12 A ${separator} Einleitungsbeschluss`;
  const rangeTitle = `Radverkehr Limmerstraße 12-14 ${separator} Aufstellungsbeschluss`;
  const [exact, range] = enrichRisLocations([{ title }, { title: rangeTitle }], { city: 'hannover', gazetteer: addressGazetteer });
  expect(exact.locations).toMatchObject([{ kind: 'address', label: 'Limmerstraße 12 A',
    geometry: { type: 'Point', coordinates: [9.713, 52.37] }, evidence: { source: 'title', text: title } }]);
  expect(range.locations).toEqual([{ kind: 'address', label: 'Limmerstraße 12-14', evidence: { source: 'title', text: rangeTitle } }]);
});

test('retains the address before the postal city suffix in published record hannover-sim:0007-2019', () => {
  const { readFileSync } = require('node:fs');
  const { gunzipSync } = require('node:zlib');
  const path = require('node:path');
  const gazetteer = JSON.parse(gunzipSync(readFileSync(path.join(__dirname, '../../config/ris-locations/hannover-atkis.json.gz'))));
  const title = 'Umwandlung der finanziellen Förderung der Kindertagesstätte „Brockfeldzwerge“, Brockfeld 65, 30539 Hannover';
  const [record] = enrichRisLocations([{ id: 'hannover-sim:0007-2019', source: 'hannover-sim', title }], { city: 'hannover', gazetteer });
  expect(record.locations).toMatchObject([{ kind: 'address', label: 'Brockfeld 65', evidence: { source: 'title', text: title } }]);
});

test('distinguishes a five-digit postal code and the active city from a house-number list', () => {
  const title = 'Radverkehr Limmerstraße 12, 30539 Hannover';
  const [record] = enrichRisLocations([{ title }], { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations).toMatchObject([{ kind: 'address', label: 'Limmerstraße 12',
    geometry: { type: 'Point', coordinates: [9.712, 52.37] }, evidence: { source: 'title', text: title } }]);
});

test.each(['30539', '30539 Garbsen', '305390 Hannover', '30539 Hannover, Garbsen'])('does not mistake an invalid or ambiguous numeric continuation %s for a city suffix', suffix => {
  const [record] = enrichRisLocations([{ title: `Radverkehr Limmerstraße 12, ${suffix}` }], { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations).toEqual([]);
});

test('does not create a new postal-code city scope rule for regional addresses', () => {
  const [record] = enrichRisLocations([{ source: 'region-hannover-ris', title: 'Radverkehr Limmerstraße 12, 30539 Hannover' }],
    { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations).toEqual([]);
});

test.each(['12 - unbekannt', '12 - N.N.', '12 - ?', '12 – unbekannt', '12 – N.N.', '12 – ?', '12 - unbekannter Beschluss', '12 – Erneuerung'])('does not turn an unknown range endpoint %s into the first address point', tail => {
  const [record] = enrichRisLocations([{ title: `Verkehrssicherheit Limmerstraße ${tail}` }], { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations.some(place => place.geometry)).toBe(false);
});

test('keeps retained title quotations separate from document evidence and scopes each regional sentence independently', () => {
  const first = 'Radverkehr Limmerstraße 12 in Hannover';
  const second = 'Radverkehr Limmerstraße 14 in Hannover';
  const [record] = enrichRisLocations([{ source: 'region-hannover-ris', title: 'Regionales Programm',
    locationTitleEvidence: [first, second, first, 'Radverkehr Limmerstraße 12. Die Lage ist in Hannover.'],
  }], { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations.map(({ label, evidence }) => ({ label, evidence }))).toEqual([
    { label: 'Limmerstraße 12', evidence: { source: 'title', text: first } },
    { label: 'Limmerstraße 14', evidence: { source: 'title', text: second } },
  ]);
  expect(record.locationAssessment.sources).toEqual(['title']);
});

const observedRetainedAddressTitles = [
  [
    "hannover-sim:0235-2021",
    "Vorhabenbezogener Bebauungsplan Nr. 1879 - Bürohaus Hildesheimer Straße 114 - Modifizierter Einleitungsbeschluss",
    [
      "Hildesheimer Straße 114"
    ]
  ],
  [
    "hannover-sim:0245-2016",
    "Durchführungsvertrag zum vorhabenbezogenen Bebauungsplan der Innenentwicklung Nr. 1798 - Sodenstraße 3 -",
    [
      "Sodenstraße 3"
    ]
  ],
  [
    "hannover-sim:0271-2020",
    "Petition Nr. 02 / 1. Halbjahr 2019 Schriftliche Eingabe der Herren Gregor Bischoff und Gerd Reincke, Herrenhäuser Kirchweg 12, 30167 Hannover zum Thema „Entkopplung der Ampelschaltung am Industrieweg und die Entkopplung aller betreffenden Ampelschaltungen im Stadtgebiet“",
    [
      "Herrenhäuser Kirchweg 12"
    ]
  ],
  [
    "hannover-sim:0314-2018",
    "Gewährung einer Sonderfinanzierung Einrichtung „Große Haie“, Hildesheimer Straße 54, 30169 Hannover des Trägers Krabbe-l-ino e. V. für den Zeitraum 01.08.2016 bis 31.07.2017",
    [
      "Hildesheimer Straße 54"
    ]
  ],
  [
    "hannover-sim:0396-2021",
    "Einrichtung und Förderung der Kindertagesstätte \"Kita Holzwiesen\", Grünspechtwiese 1, 30657 Hannover-Bothfeld",
    [
      "Grünspechtwiese 1"
    ]
  ],
  [
    "hannover-sim:0396-2021N1",
    "Einrichtung und Förderung der Kindertagesstätte \"Kita Herzkamp\", Grünspechtwiese 1, 30657 Hannover-Bothfeld",
    [
      "Grünspechtwiese 1"
    ]
  ],
  [
    "hannover-sim:0565-2026",
    "Vorhabenbezogener Bebauungsplan der Innenentwicklung Nr. 1911 - Geschäftshaus Burgwedeler Straße 10 - Auslegungsbeschluss",
    [
      "Burgwedeler Straße 10"
    ]
  ],
  [
    "hannover-sim:0605-2018",
    "IGS Linden, Sekundarstufe II Beethovenstraße 5 - Dachsanierung",
    [
      "Beethovenstraße 5"
    ]
  ],
  [
    "hannover-sim:0771-2022",
    "Vorhabenbezogener Bebauungsplan der Innenentwicklung Nr. 1911 – Wohn- und Geschäftshaus Burgwedeler Straße 10 – Aufstellungs- und Einleitungsbeschluss, Beschluss über die frühzeitige Beteiligung der Öffentlichkeit",
    [
      "Burgwedeler Straße 10"
    ]
  ],
  [
    "hannover-sim:0895-2020",
    "Bebauungsplan der Innenentwicklung Nr. 580, 3. Änderung - Nenndorfer Chaussee 9 - vormals AS Solar - Beschluss zur frühzeitigen Beteiligung der Öffentlichkeit, Aufstellungsbeschluss",
    [
      "Nenndorfer Chaussee 9"
    ]
  ],
  [
    "hannover-sim:0895-2020N1",
    "Bebauungsplan der Innenentwicklung Nr. 580, 3. Änderung - Nenndorfer Chaussee 9 - vormals AS Solar - Beschluss zur frühzeitigen Beteiligung der Öffentlichkeit, Aufstellungsbeschluss",
    [
      "Nenndorfer Chaussee 9"
    ]
  ],
  [
    "hannover-sim:0912-2017",
    "Umstrukturierung der Kindertagesstätte \"Wigwam\", Rumpelstilzchenweg 5, 30179 Hannover-Sahlkamp",
    [
      "Rumpelstilzchenweg 5"
    ]
  ],
  [
    "hannover-sim:0916-2021",
    "Bebauungsplan Nr. 718, 1. Änderung – Kita Uferzeile 6 - - vereinfachtes Verfahren nach § 13 BauGB - Beschluss über Stellungnahmen, Satzungsbeschluss",
    [
      "Uferzeile 6"
    ]
  ],
  [
    "hannover-sim:0951-2025",
    "Schulstandort Göttinger Straße 14 – Entscheidung zur Belegung mit dem hochwachsenden Gymnasium Bemerode ab dem Schuljahr 2027/28",
    [
      "Göttinger Straße 14"
    ]
  ],
  [
    "hannover-sim:0951-2025N1",
    "Schulstandort Göttinger Straße 14 – Entscheidung zur Belegung mit dem hochwachsenden Gymnasium Bemerode ab dem Schuljahr 2027/28",
    [
      "Göttinger Straße 14"
    ]
  ],
  [
    "hannover-sim:0974-2016",
    "Vorhabenbezogener Bebauungsplan der Innenentwicklung Nr. 1833 - Böhmerstraße 8 - Beschluss zur frühzeitigen Beteiligung der Öffentlichkeit, Einleitungsbeschluss, Aufstellungsbeschluss",
    [
      "Böhmerstraße 8"
    ]
  ],
  [
    "hannover-sim:1481-2026",
    "IGS Linden Sporthallen, Am Spielfelde 13 A – Erneuerung Sportboden",
    [
      "Am Spielfelde 13 A"
    ]
  ],
  [
    "hannover-sim:15-0935-2014",
    "Zuwendung für die Unterstützung der Flüchtlingsarbeit im Bereich des Flüchtlingsheims Vahrenwald in der Büttnerstraße 19 – aus Mitteln des Integrationsbeirates Vahrenwald-List",
    [
      "Büttnerstraße 19"
    ]
  ],
  [
    "hannover-sim:15-2295-2019",
    "Vorhabenbezogener Bebauungsplan Nr. 1879 - Wohn- und Geschäftshaus Hildesheimer Straße 114 - Beschluss zur frühzeitigen Beteiligung der Öffentlichkeit",
    [
      "Hildesheimer Straße 114"
    ]
  ],
  [
    "hannover-sim:1519-2016",
    "Umstrukturierung in der Kindertagesstätte Ev.-luth. Familienzentrum Baldeniusstraße 33 b, 30419 Hannover-Stöcken",
    [
      "Baldeniusstraße 33 B"
    ]
  ],
  [
    "hannover-sim:1548-2024",
    "Unterkunft für Geflüchtete, Fuhsestraße 28, 30419 Hannover Ersatzneubau",
    [
      "Fuhsestraße 28"
    ]
  ],
  [
    "hannover-sim:1559-2024",
    "Unterkunft für Geflüchtete, Helmkestraße 28, 30419 Hannover 2. Bauabschnitt",
    [
      "Helmkestraße 28"
    ]
  ],
  [
    "hannover-sim:1567-2019",
    "Vorhabenbezogener Bebauungsplan Nr. 1879 - Geschäftshaus Hildesheimer Straße 114 - Einleitungsbeschluss",
    [
      "Hildesheimer Straße 114"
    ]
  ],
  [
    "hannover-sim:1567-2019N1",
    "Vorhabenbezogener Bebauungsplan Nr. 1879 - Wohn- und Geschäftshaus Hildesheimer Straße 114 - Einleitungsbeschluss",
    [
      "Hildesheimer Straße 114"
    ]
  ],
  [
    "hannover-sim:1639-2015",
    "Durchführungsvertrag zum vorhabenbezogenen Bebauungsplan Nr. 1815 - Velberstraße 4 -",
    [
      "Velberstraße 4"
    ]
  ],
  [
    "hannover-sim:1652-2020",
    "Durchführungsvertrag zum vorhabenbezogenen Bebauungsplan Nr. 1877 - Hildesheimer Straße 451 -",
    [
      "Hildesheimer Straße 451"
    ]
  ],
  [
    "hannover-sim:1749-2024",
    "Unterkunft für Geflüchtete, Am Heisterholze 20 A-F, 30559 Hannover Neubau",
    [
      "Am Heisterholze 20 A-F"
    ]
  ],
  [
    "hannover-sim:1795-2021",
    "Durchführungsvertrag zum vorhabenbezogenen Bebauungsplan Nr. 1879 - Bürohaus Hildesheimer Straße 114 -",
    [
      "Hildesheimer Straße 114"
    ]
  ],
  [
    "hannover-sim:1867-2015",
    "Vorhabenbezogener Bebauungsplan der Innenentwicklung Nr. 1798 - Sodenstraße 3 - Auslegungsbeschluss",
    [
      "Sodenstraße 3"
    ]
  ],
  [
    "hannover-sim:1867-2015E1",
    "Vorhabenbezogener Bebauungsplan der Innenentwicklung Nr. 1798 - Sodenstraße 3 - Auslegungsbeschluss",
    [
      "Sodenstraße 3"
    ]
  ],
  [
    "hannover-sim:2127-2025",
    "Erste Verlängerung der Geltungsdauer der Veränderungssperre Nr. 123 für den Geltungsbereich des Bebauungsplans Nr. 1926 - Hildesheimer Straße 230 -",
    [
      "Hildesheimer Straße 230"
    ]
  ],
  [
    "hannover-sim:2271-2018",
    "Bebauungsplan Nr. 1365, 1. textliche Änderung - Einzelhandelssonderstandort Davenstedter Straße 80 - Aufstellungsbeschluss",
    [
      "Davenstedter Straße 80"
    ]
  ],
  [
    "hannover-sim:2450-2025",
    "Änderungsantrag der Elternvertretung im Schul- und Bildungsausschuss (Frau Dr. Sonja Memenga-Niksch und Herr Ralf Popp) zu Drucks. Nr. 0951/2024: Schulstandort Göttinger Straße 14 – Entscheidung zur Belegung mit dem hochwachsenden Gymnasium Bemerode ab dem Schuljahr 2027/28",
    [
      "Göttinger Straße 14"
    ]
  ],
  [
    "hannover-sim:2653-2020",
    "Vorhabenbezogener Bebauungsplan der Innenentwicklung Nr. 1802 - Wohn- und Geschäftshaus Tiestestr. 14 c - Satzungsbeschluss",
    [
      "Tiestestraße 14 C"
    ]
  ],
  [
    "hannover-sim:2963-2018",
    "Vorhabenbezogener Bebauungsplan der Innenentwicklung Nr. 1802 - Wohn- und Geschäftshaus Tiestestraße 14 c - Aufstellungs- und Einleitungsbeschluss, Beschluss über die frühzeitige Beteiligung der Öffentlichkeit",
    [
      "Tiestestraße 14 C"
    ]
  ]
];

test.each(observedRetainedAddressTitles)('retains complete address evidence at the observed title boundary in %s', (id, title, labels) => {
  const { readFileSync } = require('node:fs');
  const { gunzipSync } = require('node:zlib');
  const path = require('node:path');
  const gazetteer = JSON.parse(gunzipSync(readFileSync(path.join(__dirname, '../../config/ris-locations/hannover-atkis.json.gz'))));
  const [record] = enrichRisLocations([{ id, source: 'hannover-sim', title }], { city: 'hannover', gazetteer });
  expect(record.locations.filter(location => location.kind === 'address').map(location => location.label)).toEqual(labels);
  expect(record.locations.every(location => location.evidence.source === 'title' && location.evidence.text === title)).toBe(true);
  if (id === 'hannover-sim:1749-2024') expect(record.locations[0].geometry).toBeUndefined();
});

test.each([
  ['20 A-F', '20 A-F'], ['20A-F', '20 A-F'], ['3A+B', '3 A+B'], ['3 A + B', '3 A+B'],
])('preserves a complete letter compound %s instead of mapping its numeric prefix', (tail, label) => {
  const title = `Radverkehr Limmerstraße ${tail}`;
  const [record] = enrichRisLocations([{ title }], { city: 'hannover', gazetteer: {
    ...addressGazetteer, addresses: { limmer: { '20': [9.712, 52.37], '20a': [9.713, 52.37], '3a': [9.714, 52.37] } },
  } });
  expect(record.locations).toEqual([{ kind: 'address', label: `Limmerstraße ${label}`, evidence: { source: 'title', text: title } }]);
});

test.each(['12 - unbekannt', '12 - N.N.', '12 - ?', '12 -', '12-F', '12A+foo', '12A+B+C', '12+Schule'])('rejects a genuinely unknown or incomplete endpoint %s after supporting title delimiters', tail => {
  const [record] = enrichRisLocations([{ title: `Radverkehr Limmerstraße ${tail}` }], { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations.some(location => location.geometry)).toBe(false);
});

test('uses a letter-compound point only for its complete verified key', () => {
  const [record] = enrichRisLocations([{ title: 'Radverkehr Limmerstraße 3A+B' }], { city: 'hannover', gazetteer: {
    ...addressGazetteer, addresses: { limmer: { '3a': [9.712, 52.37], '3a+b': [9.715, 52.37] } },
  } });
  expect(record.locations).toMatchObject([{ label: 'Limmerstraße 3 A+B', geometry: { type: 'Point', coordinates: [9.715, 52.37] } }]);
});

test('retains both full compounds in the actual Dunantstraße 3A+B planning title', () => {
  const { readFileSync } = require('node:fs');
  const { gunzipSync } = require('node:zlib');
  const path = require('node:path');
  const gazetteer = JSON.parse(gunzipSync(readFileSync(path.join(__dirname, '../../config/ris-locations/hannover-atkis.json.gz'))));
  const title = 'Kita und Verwaltungsgebäude Emmy-Lanzke-Haus Dunantstr. 3-5 Kita-Krippe Dunantstraße 3A+B, Sicherheit Brandschutztüren';
  const [record] = enrichRisLocations([{ title }], { city: 'hannover', gazetteer });
  expect(record.locations.map(location => location.label).sort()).toEqual(['Dunantstraße 3 A+B', 'Dunantstraße 3-5']);
  expect(record.locations.every(location => location.geometry === undefined && location.evidence.text === title)).toBe(true);
});

test('keeps the actual petitioners postal address textual rather than placing the petition measure there', () => {
  const { readFileSync } = require('node:fs');
  const { gunzipSync } = require('node:zlib');
  const path = require('node:path');
  const gazetteer = JSON.parse(gunzipSync(readFileSync(path.join(__dirname, '../../config/ris-locations/hannover-atkis.json.gz'))));
  const title = 'Petition Nr. 02 / 1. Halbjahr 2019 Schriftliche Eingabe der Herren Gregor Bischoff und Gerd Reincke, Herrenhäuser Kirchweg 12, 30167 Hannover zum Thema „Entkopplung der Ampelschaltung am Industrieweg und die Entkopplung aller betreffenden Ampelschaltungen im Stadtgebiet“';
  const [record] = enrichRisLocations([{ title }], { city: 'hannover', gazetteer });
  expect(record.locations).toEqual([{ kind: 'address', label: 'Herrenhäuser Kirchweg 12', evidence: { source: 'title', text: title } }]);
  expect(record.locationAssessment.reasons).toContain('non_traffic_address');
});

test('keeps a genuine house-address measure after the petition topic marker mapped', () => {
  const title = 'Petition Nr. 02 Schriftliche Eingabe der Herren Beispiel und Muster zum Thema Radverkehr in der Limmerstraße 12';
  const [record] = enrichRisLocations([{ title }], { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations).toMatchObject([{ kind: 'address', label: 'Limmerstraße 12',
    geometry: { type: 'Point', coordinates: [9.712, 52.37] }, evidence: { source: 'title', text: title } }]);
  expect(record.locationAssessment.reasons).not.toContain('non_traffic_address');
});

test.each([
  ['Kreisstraße', 'Juni 2023 haben die Hagedorn Hannover GmbH und das HWG ihre neuen Standorte in der Kreisstraße 20+20A bezogen.', 'Kreisstraße 20+20 A'],
  ['Siegmundstraße', 'Am 12.03.2026 um ca. 11.30 Uhr kam es zu starker Rauchentwicklung aus dem Schornstein der Firma Schwandt GmbH Bau- und Möbeltischlerei Siegmundstraße 1+2.', 'Siegmundstraße 1+2'],
  ['Georgstraße', 'Die nun vorliegende Interessensbekundung der F1rst Immobiliengesellschaft, die als Entwicklungsdienstleister für die Centrum Holding agiert und der Verwaltung bereits in diversen anderen Projekten die kompetente und qualitative Umsetzung komplexer Projekte und Entwicklungsvorhaben bewiesen hat (Kröpcke-Center, Karmarschstr. 20 – 22, Bahnhofstr. 8, Georgstr. 10 + 14), konnte aus der Akquisition gewonnen werden.', 'Georgstraße 10+14'],
  ['Arnswaldtstraße', 'Mit dieser Drucksache informiert die Verwaltung über den Ankauf des Grundstücks Marienstraße 37 - 41, Arnswaldtstraße 24 + 26.', 'Arnswaldtstraße 24+26'],
])('retains the entire numeric plus compound from the actual %s document quotation', (streetName, quote, label) => {
  const { readFileSync } = require('node:fs');
  const { gunzipSync } = require('node:zlib');
  const path = require('node:path');
  const gazetteer = JSON.parse(gunzipSync(readFileSync(path.join(__dirname, '../../config/ris-locations/hannover-atkis.json.gz'))));
  const [record] = enrichRisLocations([{ title: 'Dokument zur Verkehrssicherheit', locationEvidence: [quote] }], { city: 'hannover', gazetteer });
  const matches = record.locations.filter(location => location.label.startsWith(`${streetName} `));
  expect(matches).toEqual([{ kind: 'address', label, evidence: { source: 'document', text: quote } }]);
});

test('uses only the complete verified key for a numeric plus compound', () => {
  const [record] = enrichRisLocations([{ title: 'Radverkehr Limmerstraße 12+14' }], { city: 'hannover', gazetteer: {
    ...addressGazetteer, addresses: { limmer: { '12': [9.712, 52.37], '12+14': [9.716, 52.37] } },
  } });
  expect(record.locations).toMatchObject([{ label: 'Limmerstraße 12+14', geometry: { type: 'Point', coordinates: [9.716, 52.37] } }]);
});

test('does not use separately known house points for an unknown complete numeric plus key', () => {
  const title = 'Radverkehr Limmerstraße 12+14';
  const [record] = enrichRisLocations([{ title }], { city: 'hannover', gazetteer: addressGazetteer });
  expect(record.locations).toEqual([{ kind: 'address', label: 'Limmerstraße 12+14', evidence: { source: 'title', text: title } }]);
});

const sodenSection = 'die Sodenstraße zwischen Celler Straße und Angerstraße';
const eckerSection = 'die Eckerstraße zwischen Hallerstraße und Fridastraße';

test.each([
  `${sodenSection} sowie ${eckerSection}`,
  `${eckerSection} sowie ${sodenSection}`,
])('preserves the independent verified section in the published Soden/Ecker request: %s', sections => {
  const text = `${sections} werden in das vorgelegte Straßen Sanierungsprogramm der Stadt mit aufgenommen.`;
  const [record] = enrichRisLocations([{ source: 'hannover-sim', title: 'Straßensanierung Sodenstraße & Eckerstraße', locationEvidence: [text] }],
    { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toHaveLength(2);
  expect(record.locations.find(place => place.label.startsWith('Sodenstraße'))).toEqual({
    kind: 'section', label: 'Sodenstraße', evidence: { source: 'document', text },
  });
  expect(record.locations.find(place => place.label.startsWith('Eckerstraße'))).toMatchObject({
    kind: 'section', label: 'Eckerstraße, Hallerstraße bis Fridastraße', evidence: { source: 'document', text },
    geometry: { type: 'LineString', coordinates: [[9.741912, 52.382327], [9.742932, 52.38243], [9.743196, 52.382443], [9.744619, 52.382237], [9.744746, 52.382256]] },
  });
  expect(record.locationAssessment).toMatchObject({ status: 'partial', reasons: expect.arrayContaining(['unverified_name', 'unmapped_location']) });
});

test.each([
  'sind bis zur noch festzulegenden Grenze zu verlängern.',
  `sind ${'nach eingehender Abstimmung mit allen Beteiligten '.repeat(6)}bis zur noch festzulegenden Grenze zu verlängern.`,
  'werden nicht in das Sanierungsprogramm aufgenommen.',
])('keeps a shared trailing restriction on coordinated sections: %s', restriction => {
  const text = `${eckerSection} sowie ${sodenSection} ${restriction}`;
  const [record] = enrichRisLocations([{ title: 'Straßensanierung', locationEvidence: [text] }],
    { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toHaveLength(2);
  expect(record.locations.every(place => !place.geometry && place.kind === 'section')).toBe(true);
  expect(record.locations.map(place => place.evidence)).toEqual(Array(2).fill({ source: 'document', text }));
});

test('does not mistake an added endpoint for a coordinated independent section', () => {
  const text = 'Die Hauptstraße zwischen Nordstraße und Südstraße sowie Oststraße wird saniert.';
  const [record] = enrich([{ title: 'Straßensanierung', locationEvidence: [text] }], [
    street('Hauptstraße', [[9.67, 52.38], [9.68, 52.38], [9.70, 52.38], [9.71, 52.38]]),
    street('Nordstraße', [[9.68, 52.37], [9.68, 52.39]]),
    street('Südstraße', [[9.70, 52.37], [9.70, 52.39]]),
    street('Oststraße', [[9.71, 52.37], [9.71, 52.39]]),
  ]);
  expect(record.locations).toHaveLength(1);
  expect(record.locations[0]).toMatchObject({ kind: 'section', evidence: { source: 'document', text } });
  expect(record.locations[0].geometry).toBeUndefined();
});

test('retains independent textual streets after the quoted sentence in the published Clemens/Feuerwehr inquiry', () => {
  const first = 'In der Verwaltungsantwort heißt es mit Blick auf die geforderte Durchfahrtssperre für KfZ in der Clemensstraße: „Eine Umsetzung würde mit der Einrichtung der Bewohner*innenparkzone erfolgen.“';
  const second = 'Mit Blick auf den Modalfilter in der Feuerwehrstraße wurde auf die Entwicklung des (ehemaligen) Feuerwehrgeländes verwiesen.';
  const [record] = enrichRisLocations([{ source: 'hannover-sim', title: 'Zuständigkeit Wohnquartier Calenberger Neustadt', locationEvidence: [`${first} ${second}`] }],
    { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toEqual([
    { kind: 'street', label: 'Clemensstraße', evidence: { source: 'document', text: first } },
    { kind: 'street', label: 'Feuerwehrstraße', evidence: { source: 'document', text: second } },
  ]);
});

test.each(['“', '”', '»', '"'])('separates sentences after a closing quote %s while preserving the original evidence', quote => {
  const first = `Die Verwaltung sagt: „Die Fahrbahn in der Limmerstraße wird saniert.${quote}`;
  const second = 'Die Haltestelle in der Stephanusstraße wird umgebaut.';
  const [record] = enrich([{ title: 'Verkehrsmaßnahmen', locationEvidence: [`${first} ${second}`] }],
    [limmerstrasse, street('Stephanusstraße', [[9.71, 52.36], [9.72, 52.36]])]);
  expect(record.locations.map(place => [place.label, place.evidence.text, Boolean(place.geometry)])).toEqual([
    ['Limmerstraße', first, true], ['Stephanusstraße', second, false],
  ]);
});

test('does not separate a quoted phrase without sentence-ending punctuation', () => {
  const text = 'Die Haltestelle in der Limmerstraße „Alte Haltestelle“ Neben der Stephanusstraße soll verlegt werden.';
  const [record] = enrich([{ title: 'Haltestellenverlegung', locationEvidence: [text] }],
    [limmerstrasse, street('Stephanusstraße', [[9.71, 52.36], [9.72, 52.36]])]);
  expect(record.locations).toEqual([]);
});

test('retains the complete published alternative endpoint after bzw.', () => {
  const text = 'Die Verwaltung der Landeshauptstadt Hannover wird gebeten, in der Liepmannstraße im Abschnitt zwischen den Straßen Auf dem Brinke und Hufelandstraße bzw. Hurlebuschweg eine Querungshilfe zu errichten.';
  const [record] = enrichRisLocations([{ title: 'Querungshilfe Liepmannstraße', locationEvidence: [text] }],
    { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toHaveLength(1);
  expect(record.locations[0].geometry).toBeUndefined();
  expect(record.locations[0].evidence).toEqual({ source: 'document', text });
});

test('retains the complete sentence after the abbreviation Nr.', () => {
  const text = 'Die Fahrbahn in der Limmerstraße wird gemäß Nr. Vier saniert.';
  const [record] = enrich([{ title: 'Fahrbahnsanierung', locationEvidence: [text] }]);
  expect(record.locations).toHaveLength(1);
  expect(record.locations[0].evidence).toEqual({ source: 'document', text });
});

test.each(['title', 'document'])('does not borrow a Hannover qualifier across a quoted sentence in regional %s evidence', source => {
  const text = 'Die Fahrbahn in der Limmerstraße „wird saniert.“ Die Maßnahme liegt in Hannover.';
  const [record] = enrich([{ source: 'region-hannover-ris', title: source === 'title' ? text : 'Regionales Programm',
    ...(source === 'document' ? { locationEvidence: [text] } : {}),
  }]);
  expect(record.locations).toEqual([]);
});

test.each(['title', 'document'])('retains only the independently scoped street across quoted regional %s sentences', source => {
  const first = 'Die Fahrbahn in der Limmerstraße in Hannover wird saniert.“';
  const second = 'Die Fahrbahn in der Stephanusstraße wird saniert.';
  const text = `${first} ${second}`;
  const [record] = enrich([{ source: 'region-hannover-ris', title: source === 'title' ? text : 'Regionales Programm',
    ...(source === 'document' ? { locationEvidence: [text] } : {}),
  }], [limmerstrasse, street('Stephanusstraße', [[9.71, 52.36], [9.72, 52.36]])]);
  expect(record.locations).toHaveLength(1);
  expect(record.locations[0]).toMatchObject({ label: 'Limmerstraße', geometry: limmerstrasse.geometry,
    evidence: { source, text: first } });
});


test('does not split an incomplete first section at a later complete section', () => {
  const text = 'Die Hauptstraße zwischen Nordstraße sowie die Nebenstraße zwischen Weststraße und Oststraße werden saniert.';
  const [record] = enrich([{ title: 'Straßensanierung', locationEvidence: [text] }], [
    street('Hauptstraße', [[9.67, 52.38], [9.68, 52.38], [9.70, 52.38], [9.71, 52.38]]),
    street('Nebenstraße', [[9.67, 52.36], [9.68, 52.36], [9.70, 52.36], [9.71, 52.36]]),
    street('Nordstraße', [[9.68, 52.37], [9.68, 52.39]]),
    street('Weststraße', [[9.68, 52.35], [9.68, 52.37]]),
    street('Oststraße', [[9.70, 52.35], [9.70, 52.37]]),
  ]);
  expect(record.locations.every(place => !place.geometry)).toBe(true);
});

test('does not drop a negation belonging to the first coordinated section', () => {
  const text = `${eckerSection} werden nicht aufgenommen sowie ${sodenSection} werden geprüft.`;
  const [record] = enrichRisLocations([{ title: 'Straßensanierung', locationEvidence: [text] }],
    { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toHaveLength(2);
  expect(record.locations.every(place => !place.geometry)).toBe(true);
  expect(record.locations.map(place => place.evidence)).toEqual(Array(2).fill({ source: 'document', text }));
});

const coordinatedRoads = [
  street('Hauptstraße', [[9.67, 52.38], [9.68, 52.38], [9.70, 52.38], [9.71, 52.38]]),
  street('Nordstraße', [[9.68, 52.37], [9.68, 52.38], [9.68, 52.39]]),
  street('Südstraße', [[9.70, 52.37], [9.70, 52.38], [9.70, 52.39]]),
  street('Nebenstraße', [[9.67, 52.36], [9.68, 52.36], [9.70, 52.36], [9.71, 52.36]]),
  street('Weststraße', [[9.68, 52.35], [9.68, 52.36], [9.68, 52.37]]),
  street('Oststraße', [[9.70, 52.35], [9.70, 52.36], [9.70, 52.37]]),
  street('Drittstraße', [[9.67, 52.34], [9.68, 52.34], [9.70, 52.34], [9.71, 52.34]]),
  street('Oberstraße', [[9.68, 52.33], [9.68, 52.34], [9.68, 52.35]]),
  street('Unterstraße', [[9.70, 52.33], [9.70, 52.34], [9.70, 52.35]]),
];
const firstTwoSections = 'die Hauptstraße zwischen Nordstraße und Südstraße sowie die Nebenstraße zwischen Weststraße und Oststraße';

test.each(['werden nicht saniert', 'werden bis zur noch festzulegenden Grenze verlängert'])('retains a shared qualification before the third coordinated section: %s', qualification => {
  const text = `${firstTwoSections} ${qualification} und die Drittstraße zwischen Oberstraße und Unterstraße wird saniert.`;
  const [record] = enrich([{ title: 'Straßenarbeiten', locationEvidence: [text] }], coordinatedRoads);
  expect(record.locations).toHaveLength(3);
  expect(record.locations.slice(0, 2).every(place => !place.geometry)).toBe(true);
  expect(record.locations[2]).toMatchObject({ kind: 'section', label: 'Drittstraße, Oberstraße bis Unterstraße',
    geometry: { type: 'LineString', coordinates: [[9.68, 52.34], [9.70, 52.34]] } });
  expect(record.locations.map(place => place.evidence)).toEqual(Array(3).fill({ source: 'document', text }));
});

test.each(['Nicht saniert werden', 'Keine Sanierung erfolgt für'])('preserves a shared leading negation: %s', prefix => {
  const text = `${prefix} ${firstTwoSections}.`;
  const [record] = enrich([{ title: 'Straßenarbeiten', locationEvidence: [text] }], coordinatedRoads);
  expect(record.locations).toHaveLength(2);
  expect(record.locations.every(place => !place.geometry)).toBe(true);
  expect(record.locations.map(place => place.evidence)).toEqual(Array(2).fill({ source: 'document', text }));
});

test.each(['usw.', 'etc.'])('allows a new sentence after the potentially terminal abbreviation %s', abbreviation => {
  const first = `Die Fahrbahn in der Limmerstraße wird saniert ${abbreviation}`;
  const second = 'Die Haltestelle in der Stephanusstraße wird umgebaut.';
  const [record] = enrich([{ title: 'Straßenarbeiten', locationEvidence: [`${first} ${second}`] }],
    [limmerstrasse, street('Stephanusstraße', [[9.71, 52.36], [9.72, 52.36]])]);
  expect(record.locations.map(place => [place.label, place.evidence.text, Boolean(place.geometry)])).toEqual([
    ['Limmerstraße', first, true], ['Stephanusstraße', second, false],
  ]);
});

test.each(['usw.', 'etc.'])('does not carry regional scope past a sentence-ending %s', abbreviation => {
  const first = `Die Fahrbahn in der Limmerstraße in Hannover wird saniert ${abbreviation}`;
  const second = 'Die Haltestelle in der Stephanusstraße wird umgebaut.';
  const [record] = enrich([{ source: 'region-hannover-ris', title: `${first} ${second}` }],
    [limmerstrasse, street('Stephanusstraße', [[9.71, 52.36], [9.72, 52.36]])]);
  expect(record.locations).toHaveLength(1);
  expect(record.locations[0]).toMatchObject({ label: 'Limmerstraße', geometry: limmerstrasse.geometry,
    evidence: { source: 'title', text: first } });
});

test('retains the street in the unchanged published Wilkenburger path description without whole-road geometry', () => {
  const text = 'An der Wilkenburger Straße gibt es auf der einen Fahrbahnseite (Richtung Arnum rechte Seite) einen beidseitig benutzbaren Fuß- und Fahrradweg.';
  const [record] = enrichRisLocations([{ source: 'hannover-sim', title: 'Fuß- und Radverkehr', locationEvidence: [text] }],
    { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toEqual([{ kind: 'street', label: 'Wilkenburger Straße', evidence: { source: 'document', text } }]);
});

test.each(['Fuß- und Fahrradweg', 'Geh- und Radweg', 'Geh- und Fahrradwege', 'Fuß- und Radwegen', 'Geh- und Radweges', 'Fuß- und Fahrradwegs'])('ignores only the internal conjunction in the compound %s', compound => {
  const text = `An der Limmerstraße wird über den Zustand des ${compound} berichtet.`;
  const [record] = enrich([{ title: 'Verkehrswege', locationEvidence: [text] }]);
  expect(record.locations).toEqual([{ kind: 'street', label: 'Limmerstraße', evidence: { source: 'document', text } }]);
});

test.each(['und einen Parkplatz.', 'sowie einen Parkplatz.', 'oder einen Parkplatz.', '; an der Stephanusstraße.', '/ Stephanusstraße.', '& Stephanusstraße.'])('preserves independent conjunctions and separators outside a path compound: %s', continuation => {
  const text = `An der Limmerstraße gibt es einen Geh- und Radweg ${continuation}`;
  const [record] = enrich([{ title: 'Verkehrswege', locationEvidence: [text] }],
    [limmerstrasse, street('Stephanusstraße', [[9.71, 52.36], [9.72, 52.36]])]);
  expect(record.locations).toEqual([]);
});

test.each(['Fußweg und Fahrradweg', 'Geh- und Radwegweiser', 'Wander- und Radweg'])('does not relax the location-list guard for other coordination: %s', compound => {
  const text = `An der Limmerstraße wird über ${compound} berichtet.`;
  const [record] = enrich([{ title: 'Verkehrswege', locationEvidence: [text] }]);
  expect(record.locations).toEqual([]);
});

test('maps the verified house number before Abriss in the original published Bemeroder title', () => {
  const title = 'Bemeroder Straße 73 – Abriss Gärtnerhaus + Herstellung an dessen Stelle den in der Straße sonst üblichen getrennten Fuß- und Radweg';
  const [record] = enrichRisLocations([{ source: 'hannover-sim', title, locationEvidenceUnavailable: true }],
    { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toEqual([expect.objectContaining({ kind: 'address', label: 'Bemeroder Straße 73',
    geometry: { type: 'Point', coordinates: [9.815542, 52.346857] }, evidence: { source: 'title', text: title } })]);
  expect(record.locationAssessment).toMatchObject({ status: 'partial', reasons: ['document_text_unavailable'] });
});

test.each(['73–75 – Abriss Gärtnerhaus', '73 – 75 – Abriss Gärtnerhaus', '73-X', '73 – X', '73 – Abrissbirne', '73 – Abriss75'])('does not invent an exact point for an incomplete or compound demolition address: %s', tail => {
  const title = `Radverkehr Bemeroder Straße ${tail}`;
  const [record] = enrichRisLocations([{ source: 'hannover-sim', title }],
    { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations.every(place => !place.geometry)).toBe(true);
  if (tail.startsWith('73–75') || tail.startsWith('73 – 75')) {
    expect(record.locations.map(place => place.label)).toEqual(['Bemeroder Straße 73-75']);
  }
});

test.each(['des Verkehrsvereins e.V.', 'von Verkehrsvereinen u. a.'])('recognizes sentence-ending organization or list abbreviations after %s', ending => {
  const first = `Die Fahrbahn in der Limmerstraße wird saniert mit Unterstützung ${ending}`;
  const second = 'Die Haltestelle in der Stephanusstraße wird umgebaut.';
  const [record] = enrich([{ title: 'Straßenarbeiten', locationEvidence: [`${first} ${second}`] }],
    [limmerstrasse, street('Stephanusstraße', [[9.71, 52.36], [9.72, 52.36]])]);
  expect(record.locations.map(place => [place.label, place.evidence.text, Boolean(place.geometry)])).toEqual([
    ['Limmerstraße', first, true], ['Stephanusstraße', second, false],
  ]);
});

test.each(['des Verkehrsvereins e.V.', 'von Verkehrsvereinen u. a.'])('keeps regional sentence scope after the terminal abbreviation in %s', ending => {
  const first = `Die Fahrbahn in der Limmerstraße in Hannover wird saniert mit Unterstützung ${ending}`;
  const second = 'Die Haltestelle in der Stephanusstraße wird umgebaut.';
  const [record] = enrich([{ source: 'region-hannover-ris', title: `${first} ${second}` }],
    [limmerstrasse, street('Stephanusstraße', [[9.71, 52.36], [9.72, 52.36]])]);
  expect(record.locations).toHaveLength(1);
  expect(record.locations[0]).toMatchObject({ label: 'Limmerstraße', geometry: limmerstrasse.geometry,
    evidence: { source: 'title', text: first } });
});

test('retains a shared weder-noch negation on coordinated sections', () => {
  const text = `${firstTwoSections} werden weder saniert noch neu asphaltiert.`;
  const [record] = enrich([{ title: 'Straßenarbeiten', locationEvidence: [text] }], coordinatedRoads);
  expect(record.locations).toHaveLength(2);
  expect(record.locations.every(place => !place.geometry)).toBe(true);
  expect(record.locations.map(place => place.evidence)).toEqual(Array(2).fill({ source: 'document', text }));
});

test.each([
  [`${firstTwoSections} (beide Abschnitte)`, 'werden nicht saniert.'],
  [`${firstTwoSections} (beide Abschnitte)`, 'sind bis zur noch festzulegenden Grenze zu verlängern.'],
  [`(${firstTwoSections})`, 'werden nicht saniert.'],
  [`(${firstTwoSections})`, 'sind bis zur noch festzulegenden Grenze zu verlängern.'],
])('retains the shared qualification beyond a closing parenthesis: %s %s', (sections, qualification) => {
  const text = `${sections} ${qualification}`;
  const [record] = enrich([{ title: 'Straßenarbeiten', locationEvidence: [text] }], coordinatedRoads);
  expect(record.locations).toHaveLength(2);
  expect(record.locations.every(place => !place.geometry)).toBe(true);
  expect(record.locations.map(place => place.evidence)).toEqual(Array(2).fill({ source: 'document', text }));
});

test.each([false, true])('keeps a parenthesized group qualification inside its semicolon clause (negative group %s)', negative => {
  const text = `${firstTwoSections} (beide Abschnitte) werden ${negative ? 'nicht ' : ''}saniert; die Drittstraße zwischen Oberstraße und Unterstraße wird ${negative ? '' : 'nicht '}saniert.`;
  const [record] = enrich([{ title: 'Straßenarbeiten', locationEvidence: [text] }], coordinatedRoads);
  expect(record.locations).toHaveLength(3);
  expect(record.locations.slice(0, 2).map(place => Boolean(place.geometry))).toEqual([!negative, !negative]);
  // The independent positive third section must survive the negative group.
  // Existing handling of a single negative section is outside this change.
  if (negative) expect(record.locations[2].geometry?.type).toBe('LineString');
  expect(record.locations.map(place => place.evidence)).toEqual(Array(3).fill({ source: 'document', text }));
});

test('does not import a preceding clause negation into the shared section prefix', () => {
  const text = `Ein früherer Antrag wird nicht weiterverfolgt; ${firstTwoSections} werden saniert.`;
  const [record] = enrich([{ title: 'Straßenarbeiten', locationEvidence: [text] }], coordinatedRoads);
  expect(record.locations).toHaveLength(2);
  expect(record.locations.every(place => place.geometry?.type === 'LineString')).toBe(true);
});

test('does not interpret a neutral von-prefix as an additional spatial boundary', () => {
  const text = 'Auf Antrag von Anwohnern wird die Hauptstraße zwischen Nordstraße und Südstraße saniert, und die Nebenstraße zwischen Weststraße und Oststraße wird erneuert.';
  const [record] = enrich([{ title: 'Straßenarbeiten', locationEvidence: [text] }], coordinatedRoads);
  expect(record.locations).toHaveLength(2);
  expect(record.locations.every(place => place.geometry?.type === 'LineString')).toBe(true);
  expect(record.locations.map(place => place.evidence)).toEqual(Array(2).fill({ source: 'document', text }));
});

test('preserves a genuine sentence boundary after ggf.', () => {
  const first = 'Die Fahrbahn in der Limmerstraße saniert die Verwaltung ggf.';
  const second = 'Die Haltestelle in der Stephanusstraße wird umgebaut.';
  const [record] = enrich([{ title: 'Straßenarbeiten', locationEvidence: [`${first} ${second}`] }],
    [limmerstrasse, street('Stephanusstraße', [[9.71, 52.36], [9.72, 52.36]])]);
  expect(record.locations.map(place => [place.label, place.evidence.text, Boolean(place.geometry)])).toEqual([
    ['Limmerstraße', first, true], ['Stephanusstraße', second, false],
  ]);
});

test.each(['title', 'document'])('keeps regional scope within a sentence ending with ggf. in %s evidence', source => {
  const first = 'Die Fahrbahn in der Limmerstraße in Hannover saniert die Verwaltung ggf.';
  const second = 'Die Haltestelle in der Stephanusstraße wird umgebaut.';
  const text = `${first} ${second}`;
  const [record] = enrich([{ source: 'region-hannover-ris', title: source === 'title' ? text : 'Regionales Programm',
    ...(source === 'document' ? { locationEvidence: [text] } : {}),
  }], [limmerstrasse, street('Stephanusstraße', [[9.71, 52.36], [9.72, 52.36]])]);
  expect(record.locations).toHaveLength(1);
  expect(record.locations[0]).toMatchObject({ label: 'Limmerstraße', geometry: limmerstrasse.geometry,
    evidence: { source, text: first } });
});

test.each([[false, false], [false, true], [true, false]])('bounds a parenthesized group before an independent section clause (negative group %s, negative third %s)', (negativeGroup, negativeThird) => {
  const text = `${firstTwoSections} (beide Abschnitte) werden ${negativeGroup ? 'nicht ' : ''}saniert, und die Drittstraße zwischen Oberstraße und Unterstraße wird ${negativeThird ? 'nicht ' : ''}erneuert.`;
  const [record] = enrich([{ title: 'Straßenarbeiten', locationEvidence: [text] }], coordinatedRoads);
  expect(record.locations).toHaveLength(3);
  expect(record.locations.slice(0, 2).map(place => Boolean(place.geometry))).toEqual([!negativeGroup, !negativeGroup]);
  if (!negativeThird) expect(record.locations[2].geometry?.type).toBe('LineString');
  expect(record.locations.map(place => place.evidence)).toEqual(Array(3).fill({ source: 'document', text }));
});

const trafficAudit = require('../../docs/qa/ris-traffic-location-audit-2026-11-10.json');

test.each([
  ['hannover-sim:15-2140-2020F1', 'Hannoversche Straße / Grenzstraße / Louise-Schroeder-Straße', [9.827941, 52.384734]],
  ['hannover-sim:15-1619-2025', 'Weidetorstraße / Pinkenburger Straße', [9.807731, 52.397536]],
])('maps the complete audited intersection in the retained title of %s', (id, label, coordinates) => {
  const { title } = trafficAudit.records.find(record => record.id === id);
  const [record] = enrichRisLocations([{ id, source: 'hannover-sim', title, locationEvidenceUnavailable: true }],
    { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toEqual([expect.objectContaining({ kind: 'junction', label,
    geometry: { type: 'Point', coordinates }, evidence: { source: 'title', text: title } })]);
  expect(record.locationAssessment.reasons).toContain('document_text_unavailable');
});

test('requires the same vertex on every named arm, even when the first two streets intersect', () => {
  const evidence = 'Am Knotenpunkt Bauweg / Mittelweg / Kirchweg wird eine Ampel geprüft.';
  const [record] = enrich([{ title: 'Ampel', locationEvidence: [evidence] }], [
    street('Bauweg', [[9.70, 52.38], [9.71, 52.38]]),
    street('Mittelweg', [[9.70, 52.37], [9.70, 52.38]]),
    street('Kirchweg', [[9.71, 52.38], [9.71, 52.39]]),
  ]);
  expect(record.locations).toEqual([{ kind: 'junction', label: 'Bauweg / Mittelweg / Kirchweg',
    evidence: { source: 'document', text: evidence } }]);
});

test('does not drop an unknown arm to publish a two-street intersection', () => {
  const [record] = enrich([{ title: 'Ampel an der Kreuzung Bauweg / Mittelweg / Unbekanntstraße' }], [
    street('Bauweg', [[9.70, 52.38], [9.71, 52.38]]),
    street('Mittelweg', [[9.70, 52.37], [9.70, 52.38]]),
  ]);
  expect(record.locations).toEqual([expect.objectContaining({ kind: 'junction',
    label: 'Bauweg / Mittelweg (weiterer Bezug im Beleg)' })]);
  expect(record.locations[0].geometry).toBeUndefined();
});

test('keeps the parking places before the junction in SIM 2532/2003 as a text location', () => {
  const evidence = 'Die Verwaltung wird gebeten, die vorgesehenen 2 Parkplätze kurz vor der Einmündung Große Straße in die Sackmannstr. zugunsten der Fußwegbreite an dieser Stelle aus der Planung herauszunehmen.';
  const [record] = enrichRisLocations([{ id: 'hannover-sim:2532-2003', source: 'hannover-sim', title: 'Parkplätze', locationEvidence: [evidence] }],
    { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toEqual([{ kind: 'place', label: 'Vor der Einmündung Große Straße / Sackmannstraße',
    evidence: { source: 'document', text: evidence } }]);
  expect(record.locationAssessment.reasons).toContain('unmapped_location');
});

test.each([
  'Einladung zur Sitzung an der Kreuzung Hannoversche Straße/Grenzstraße/Louise-Schroeder-Straße',
  'Verkehrssituation vor einem Kindergarten an der Weidetorstraße',
  'Wie beispielsweise an der Weidetorstraße Ecke Pinkenburger Straße',
])('does not promote the meeting location, general road or comparison: %s', title => {
  const suffix = ' Sitzung des Stadtbezirksrates Mitte am 01.09.2020 TOP 8.3.7.';
  const [record] = enrichRisLocations([{ source: 'hannover-sim', title: title + suffix }],
    { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toEqual([]);
});

test('maps the full-length road in the mixed parking list of SIM 15-0533/2023 using its reviewed spelling', () => {
  const evidence = 'Dies betrifft insbesondere den Parkplatz am Olympiastützpunkt, den Ferdinand-Willhelm-Fricke-Weg in voller Länge, die Parkflächen neben und gegenüber der Jugendherberge, den Parkplatz am Landessportbund, den Parkplatz an der Ritter-Brüning-Straße, den Parkplatz an der Seufzeralle, die Straße „am Schützenplatz“ sowie den Parkplatz am Waterloo-Biergarten.';
  const gazetteer = hannoverFacilityGazetteer();
  const expected = gazetteer.entries.find(entry => entry.streetKey === '0324100100871');
  const [record] = enrichRisLocations([{ source: 'hannover-sim', title: 'Parkraumbewirtschaftung im Veranstaltungsbereich',
    locationEvidence: [evidence] }], { city: 'hannover', gazetteer });
  expect(record.locations).toEqual([expect.objectContaining({ kind: 'street', label: expected.name, geometry: expected.geometry,
    evidence: { source: 'document', text: evidence } })]);
});

test.each([
  'Dies betrifft insbesondere den Parkplatz am Park, nicht den Ferdinand-Willhelm-Fricke-Weg in voller Länge.',
  'Dies betrifft insbesondere den Parkplatz am Park, den Ferdinand-Willhelm-Fricke-Weg in voller Länge, ausgenommen den südlichen Abschnitt.',
  'Dies betrifft insbesondere den Parkplatz am Ferdinand-Willhelm-Fricke-Weg in voller Länge, die Parkflächen am Stadion.',
])('does not widen a qualified list item or a neighbouring parking site: %s', evidence => {
  const [record] = enrichRisLocations([{ source: 'hannover-sim', title: 'Parkraumbewirtschaftung',
    locationEvidence: [evidence] }], { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations.filter(location => location.geometry)).toEqual([]);
});

test.each([
  'Prüfung des Abschnitts zwischen der Kreuzung Hannoversche Straße/Grenzstraße/Louise-Schroeder-Straße und dem Bahnhof Sitzung des Stadtbezirksrates Mitte am 07.10.2020 TOP 3.1.3.',
  'Parkplätze im Umfeld der Weidetorstraße Ecke Pinkenburger Straße',
  'Der Gehweg zwischen Weidetorstraße Ecke Pinkenburger Straße und dem Bahnhof',
])('does not publish a crossing point for a wider area or an endpoint: %s', title => {
  const [record] = enrichRisLocations([{ source: 'hannover-sim', title }], { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations.filter(location => location.geometry)).toEqual([]);
});

test('preserves both independently named parking corners of SIM 15-0152/2007', () => {
  const title = 'Parkplätze in den Straßen Ostergrube/Ecke Gollstraße und Sehnder Straße/Ecke Gollstraße';
  const [record] = enrichRisLocations([{ source: 'hannover-sim', title }], { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations.map(location => [location.label, location.geometry?.coordinates])).toEqual([
    ['Gollstraße / Ostergrube', [9.858788, 52.361239]],
    ['Gollstraße / Sehnder Straße', [9.857634, 52.359558]],
  ]);
});

test('merges both street orders at the same documented corner in SIM 15-0533/2015', () => {
  const title = 'Anbringung von Fahrradbügeln oder Pollern auf dem Fußgängerweg Pfarrlandstraße / Ecke Elisenstraße';
  const evidence = 'Die Verwaltung wird aufgefordert, Fahrradbügel oder Poller auf dem Bürgersteig Ecke Pfarrlandstraße / Elisenstraße anzubringen.';
  const [record] = enrichRisLocations([{ source: 'hannover-sim', title, locationEvidence: [evidence] }],
    { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toEqual([expect.objectContaining({ label: 'Pfarrlandstraße / Elisenstraße',
    evidence: { source: 'document', text: evidence }, geometry: { type: 'Point', coordinates: [9.70634, 52.37472] } })]);
});

test('maps the turning restriction at the unique junction in the random audit of SIM 15-1328/2007 S1', () => {
  const evidence = 'der Oberbürgermeister wird gebeten zu veranlassen, dass das links Abbiegen aus der Uferzeile in die Hannoversche Straße nicht mehr gestattet wird.';
  const [record] = enrichRisLocations([{ source: 'hannover-sim', title: 'Linksabbiegen', locationEvidence: [evidence] }],
    { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toEqual([expect.objectContaining({ kind: 'junction', label: 'Uferzeile / Hannoversche Straße',
    geometry: { type: 'Point', coordinates: [9.834506, 52.386716] }, evidence: { source: 'document', text: evidence } })]);
});

test.each([
  'Verkehrsberuhigung im Umfeld der Einmündung Große Straße in die Sackmannstraße',
  'Parkplätze nahe der Einmündung Große Straße in die Sackmannstraße',
  'Parkplatz 100 Meter südlich der Weidetorstraße Ecke Pinkenburger Straße',
  'Gehwegsanierung von Weidetorstraße Ecke Pinkenburger Straße bis zum Stadtfriedhof',
  'Für den Bereich um die Weidetorstraße Ecke Pinkenburger Straße wird ein Parkkonzept erbeten',
])('keeps a qualified junction reference from substituting for the measure: %s', title => {
  const [record] = enrichRisLocations([{ source: 'hannover-sim', title }], { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations.filter(location => location.geometry)).toEqual([]);
});

test('keeps a house number following an inline corner for address lookup', () => {
  const title = 'Fahrradbügel in der Weidetorstraße Ecke Pinkenburger Straße 12';
  const [record] = enrichRisLocations([{ source: 'hannover-sim', title }], { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toEqual([expect.objectContaining({ kind: 'address', label: 'Pinkenburger Straße 12' })]);
});

test('an obsolete alias cannot mask the official entry now bearing that spelling', () => {
  const real = street('Mittelweg', [[9.70, 52.37], [9.70, 52.38]]);
  const original = { ...street('Bauweg', [[9.70, 52.38], [9.71, 52.38]]), streetKey: 'a' };
  const [record] = enrichRisLocations([{ title: 'Mittelweg' }], { city: 'hannover', gazetteer: {
    city: 'hannover', entries:[original,real], streetAliases:[{spelling:'Mittelweg',name:'Bauweg',streetKey:'a'}],
  } });
  expect(record.locations).toEqual([expect.objectContaining({ label:'Mittelweg', geometry:real.geometry })]);
});

test('keeps the document abbreviation directly before Ecke inside original junction evidence', () => {
  const text = 'Die Straßenlaterne an der Weidetorstr. Ecke Pinkenburger Str. wird saniert.';
  const [record] = enrichRisLocations([{ title: 'Straßenlaterne', locationEvidence: [text] }], {
    city: 'hannover', gazetteer: hannoverFacilityGazetteer(),
  });
  expect(record.locations).toEqual([expect.objectContaining({ kind: 'junction',
    geometry: { type: 'Point', coordinates: [9.807731, 52.397536] }, evidence: { source: 'document', text } })]);
});

const regionalWorkshop = 'Neubau Werkstattgebäude (WSG) Ohestrasse 3B, 30169 Hannover Änderung Entwurfsplanung / HU-Bau zu BDs Nr. 1343 (IV) vom 22.05.2018';
test('recognizes the complete audited Region project address while keeping the non-traffic address off the map', () => {
  const [record] = enrichRisLocations([{ source: 'region-hannover-ris', title: regionalWorkshop }],
    { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toEqual([{ kind: 'address', label: 'Ohestraße 3 B', evidence: { source: 'title', text: regionalWorkshop } }]);
  expect(record.locationAssessment.reasons).toContain('non_traffic_address');
  expect(record.locationAssessment.reasons).not.toContain('gazetteer_unavailable');
});
test.each([
  regionalWorkshop.replace('30169 Hannover', '30926 Seelze'),
  regionalWorkshop.replace('30169 Hannover', '30539 Hannover'),
  regionalWorkshop.replace('3B,', '3B–3C,'),
  'Kontaktadresse der Antragstellerin: ' + regionalWorkshop,
  regionalWorkshop + ' und in Garbsen',
])('rejects municipal scope for a mismatched project address: %s', title => {
  const [record] = enrichRisLocations([{ source: 'region-hannover-ris', title }], { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toEqual([]);
  expect(record.locationAssessment.reasons).toContain('gazetteer_unavailable');
});

test('maps the subject of Hannover hearing 15-0792/2025 to the reviewed public pool address', () => {
  const title = 'Anhörung zum Lister Bad';
  const [record] = enrichRisLocations([{ source: 'hannover-sim', title }],
    { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toEqual([expect.objectContaining({ kind: 'place', label: 'Lister Bad (Am Lister Bad 1)',
    geometry: { type: 'Point', coordinates: [9.748884, 52.406721] },
    attribution: expect.stringMatching(/Sport und Bäder.*LGLN/u), evidence: { source: 'title', text: title } })]);
});

test.each(['Schwimm-Express zum Lister Bad für Schülerinnen und Schüler', 'Anhörung im Lister Bad',
  'Anhörung zum Lister Bad in Garbsen', 'Umgestaltung des Fahrradabstellplatzes an der Westseite des Lister Bades',
  'Geplante Schließzeiten für das Nord-Ost-Bad und das Lister Bad', 'Radverkehr auf der Straße Am Lister Bad'])
('keeps pool destinations, venues, adjacent works and roads distinct: %s', title => {
  const [record] = enrichRisLocations([{ source: 'hannover-sim', title }],
    { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations.some(site => site.kind === 'place' && site.label.startsWith('Lister Bad'))).toBe(false);
});

test.each([
  ['1004573', 'Stadtbahnstrecke C-Ost: Barrierefreier Ausbau der Haltestelle Hannover Congress Centrum (HCC) - Einleitung des Planfeststellungsverfahrens', 'Hannover Congress Centrum (HCC)'],
  ['1006580', 'Stadtbahnstrecke C-Ost: Barrierefreier Ausbau der Haltestelle Hannover Congress Centrum - Realisierung und Finanzierung', 'Hannover Congress Centrum'],
  ['1001738', 'Stadtbahnstrecke B-Süd: Barrierefreier Ausbau der Haltestelle Rethen/Bahnhof - Realisierung und Finanzierung', 'Rethen/Bahnhof'],
])('keeps the named regional tram construction site in %s without assigning an unrelated street or platform point', (id, title, name) => {
  const [record] = enrichRisLocations([{ id, source: 'region-hannover-ris', title }],
    { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toEqual([{ kind: 'place', label: `Haltestelle ${name}`, evidence: { source: 'title', text: title } }]);
});

test.each(['Straßenbau neben der Haltestelle', 'Barrierefreier Ausbau neben der Haltestelle', 'Prüfung der Erreichbarkeit der Haltestelle',
  'Kein barrierefreier Ausbau der Haltestelle'])('does not turn a regional transport reference into a construction site: %s', subject => {
  const title = `Stadtbahnstrecke C-Ost: ${subject} Hannover Congress Centrum - Realisierung und Finanzierung`;
  const [record] = enrichRisLocations([{ source: 'region-hannover-ris', title }], { city: 'hannover', gazetteer: hannoverFacilityGazetteer() });
  expect(record.locations).toEqual([]);
});

test('uses the explicitly named street of the SIM parking proposal and decision 15-0301/2002', () => {
  const gazetteer = hannoverFacilityGazetteer();
  const street = gazetteer.entries.find(entry => entry.name === 'Husarenstraße');
  const topic = 'Entschärfung der Parksituation durch Umsetzung der Vorschläge des Verkehrsforums; hier: ';
  for (const prefix of ['', 'ENTSCHEIDUNG: ']) {
    const title = `${prefix}${topic}Husarenstraße`;
    const [record] = enrichRisLocations([{ source: 'hannover-sim', title }], { city: 'hannover', gazetteer });
    expect(record.locations).toEqual([expect.objectContaining({ kind: 'street', label: street.name,
      geometry: street.geometry, evidence: { source: 'title', text: title } })]);
  }
  const controls = ['Husarenstraße 6', 'Husarenstraße zwischen zwei Einmündungen', 'Husarenstraße und Bonifatiusplatz'];
  const results = enrichRisLocations(controls.map(tail => ({ source: 'hannover-sim', title: topic + tail })), { city: 'hannover', gazetteer });
  expect(results.flatMap(record => record.locations).some(site => site.kind === 'street' && site.geometry)).toBe(false);
});
