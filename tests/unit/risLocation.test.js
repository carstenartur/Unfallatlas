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
