'use strict';

const WORD = /[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'-]*/gu;
const WORD_CHAR = /^[\p{L}\p{M}\p{N}'-]/u;
const STREET_CUE = /(?:^|\s)(?:strasse|strassenzug|strassenname|fahrbahn)\s*:?\s*$/u;
const LOCATIVE_CUE = /(?:^|\s)(?:(?:an|auf|in|bei|zu|für|entlang)\s+(?:der|die|dem|des|den|das)|am|im|beim|zum|zur|der|des|für|entlang)\s*$/u;
const PREPOSITIONAL_NAME = /^(?:am|an|auf|aus|bei|hinter|im|in|neben|über|unter|vor|zum|zur)\s/u;
const ADJACENT_CUE = /(?:^|\s)(?:neben|vor|hinter|parallel zu[rm])\s+(?:(?:der|dem|den|die|das)\s+)?"?$/u;
const SPECIFIC_TAIL = /^\s*"?\s*(?:,|(?:nr\.?\s*)?\d|(?:nord|süd|ost|west)\b)/u;
const MULTIPLE_LOCATIONS = /[\/;&]|\b(?:und|oder|sowie|bzw)\b/u;
const LIMITED_SCOPE = /\b(?:sitzung(?:en|sort|sraum)?|einladung|tagesordnung|niederschrift|protokoll|zwischen|bis|bereich|\p{L}*abschnitt(?:e|en|es|s)?|kreuzung(?:en)?|einmündung|abzweig|ecke|höhe|gegenüber|hausnummern?|unterführung(?:en)?|fussgängerzone(?:n)?)\b/u;

function normalize(text) {
  return typeof text === 'string' ? text.normalize('NFKC').toLowerCase().replace(/ß/g, 'ss')
    .replace(/[„“”«»]/g, '"').replace(/[‘’]/g, "'").replace(/[‐‑‒–—]/g, '-')
    .replace(/\s+/g, ' ').trim() : '';
}

function isPosition(coordinates) {
  return Array.isArray(coordinates) && coordinates.length === 2 && coordinates.every(Number.isFinite)
    && Math.abs(coordinates[0]) <= 180 && Math.abs(coordinates[1]) <= 90;
}

function samePosition(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function isLine(coordinates) {
  return Array.isArray(coordinates) && coordinates.length >= 2 && coordinates.every(isPosition)
    && coordinates.some(position => !samePosition(position, coordinates[0]));
}

function isPolygon(coordinates) {
  return Array.isArray(coordinates) && coordinates.length > 0 && coordinates.every(ring =>
    Array.isArray(ring) && ring.length >= 4 && isLine(ring) && samePosition(ring[0], ring.at(-1)));
}

function validGeometry(geometry, kind) {
  if (!geometry || typeof geometry !== 'object' || Array.isArray(geometry) || Object.hasOwn(geometry, 'crs')) return false;
  if (kind === 'street') {
    if (geometry.type === 'LineString') return isLine(geometry.coordinates);
    return geometry.type === 'MultiLineString' && Array.isArray(geometry.coordinates)
      && geometry.coordinates.length > 0 && geometry.coordinates.every(isLine);
  }
  if (kind === 'place') {
    if (geometry.type === 'Point') return isPosition(geometry.coordinates);
    if (geometry.type === 'Polygon') return isPolygon(geometry.coordinates);
    return geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)
      && geometry.coordinates.length > 0 && geometry.coordinates.every(isPolygon);
  }
  return false;
}

function indexGazetteer(gazetteer) {
  const byFirstWord = new Map();
  for (const entry of gazetteer.entries) {
    const name = normalize(entry?.name);
    const firstWord = name.match(WORD)?.[0];
    if (!firstWord || !name.startsWith(firstWord)) continue;
    const attribution = entry.attribution ?? gazetteer.attribution;
    const byName = byFirstWord.get(firstWord) ?? new Map();
    // Same normalized name at several sites stays ambiguous. Segments of a
    // single identified street must already be grouped in the gazetteer.
    if (byName.has(name) || typeof attribution !== 'string' || !attribution.trim()
      || !validGeometry(entry.geometry, entry.kind)) {
      byName.set(name, null);
    } else {
      byName.set(name, { ...entry, attribution: attribution.trim() });
    }
    byFirstWord.set(firstWord, byName);
  }
  return byFirstWord;
}

function matchTitle(title, byFirstWord) {
  const subject = normalize(title).replace(/^(?:anfrage|antrag|änderungsantrag|antwort|stellungnahme) (?:der|des) [^:]+:\s*/u, '');
  if (!subject || LIMITED_SCOPE.test(subject) || MULTIPLE_LOCATIONS.test(subject)) return null;

  let location = null;
  let explicit = false;
  for (const word of subject.matchAll(WORD)) {
    for (const [name, entry] of byFirstWord.get(word[0]) ?? []) {
      if (!subject.startsWith(name, word.index)) continue;
      const after = subject.slice(word.index + name.length);
      if (WORD_CHAR.test(after)) continue;
      if (!entry || (location && entry !== location)) return null;
      const before = subject.slice(0, word.index);
      if (ADJACENT_CUE.test(before) || SPECIFIC_TAIL.test(after)) return null;
      location = entry;
      const quoted = before.endsWith('"') && after.startsWith('"');
      const topic = !before && (!after || after.trimStart().startsWith(':'));
      explicit ||= quoted || (entry.kind === 'street' && STREET_CUE.test(before))
        || (!PREPOSITIONAL_NAME.test(name) && (topic || LOCATIVE_CUE.test(before)));
    }
  }
  return explicit ? location : null;
}

/**
 * Optional build-time join to verified public streets or bounded places in
 * one city. The gazetteer is { city, entries: [{ name, kind, geometry,
 * attribution }] }; attribution can also be supplied at the gazetteer level.
 * `extent: 'part'` labels a street line that covers only part of the street.
 * Accident-network tiles carry no street names or public access tags.
 * Geometry already supplied by the RIS and unresolved records pass through.
 */
function enrichRisLocations(records, { city, gazetteer } = {}) {
  if (!city || gazetteer?.city !== city || !Array.isArray(gazetteer.entries)) return records;
  const byFirstWord = indexGazetteer(gazetteer);
  return records.map(record => {
    if (record.geometry != null) return record;
    const entry = matchTitle(record.title, byFirstWord);
    if (!entry) return record;
    const scope = entry.kind === 'street'
      ? `${entry.extent === 'part' ? 'kartierter Teil des Straßenverlaufs' : 'Straßenverlauf'} als Orientierung`
      : 'benannter Ort';
    return {
      ...record,
      geometry: entry.geometry,
      locationSource: 'derived',
      locationLabel: `${entry.name} – Namensabgleich im Titel, ${scope} · ${entry.attribution}`,
    };
  });
}

module.exports = { enrichRisLocations };
