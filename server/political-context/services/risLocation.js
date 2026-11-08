'use strict';

const { streetJunction, streetSection } = require('./risStreetGeometry');
const { classifyTrafficRelevance } = require('./trafficRelevanceService');
const { MAX_LOCATIONS_PER_RECORD, validGeometry: validSourceGeometry, validLocationGeometry } =
  require('../../../js/ua.ris-catalogue.js').snapshotFormat;

const WORD = /[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'-]*/gu;
const WORD_CHAR = /^[\p{L}\p{M}\p{N}'-]/u;
const STREET_CUE = /(?:^|\s)(?:strasse|strassenzug|strassenname|fahrbahn|hochbahnsteig(?:e|en)?|haltestelle(?:n)?)\s*:?\s*$/u;
const ROADWAY_CUE = /(?:^|\s)(?:fahrbahn|rad(?:fahr)?(?:weg|streifen)|gehweg|strassenbelag|strassendecke)\s+(?:(?:auf|in|an|entlang)\s+(?:der|dem|den|die|des|das)\s+)?$/u;
const LOCATIVE_CUE = /(?:^|\s)(?:(?:an|auf|in|bei|zu|für|entlang)\s+(?:der|die|dem|des|den|das)|am|im|beim|zum|zur|der|des|für|entlang)\s*$/u;
const PREPOSITIONAL_NAME = /^(?:am|an|auf|aus|bei|hinter|im|in|neben|über|unter|vor|zum|zur)\s/u;
const ADJACENT_CUE = /(?:^|\s)(?:neben|vor|hinter|parallel zu[rm])\s+(?:(?:der|dem|den|die|das)\s+)?"?$/u;
const SPECIFIC_TAIL = /^\s*"?\s*(?:,|(?:nr\.?\s*)?\d|(?:nord|süd|ost|west)\b)/u;
const MULTIPLE_LOCATIONS = /[\/;&]|\b(?:und|oder|sowie|bzw)\b/u;
const LIMITED_SCOPE = /\b(?:sitzung(?:en|sort|sraum)?|einladung|tagesordnung|niederschrift|protokoll|zwischen|bis|bereich|\p{L}*abschnitt(?:e|en|es|s)?|kreuzung(?:en)?|einmündung|abzweig|ecke|höhe|gegenüber|hausnummern?|unterführung(?:en)?|fussgängerzone(?:n)?)\b/u;
const MEETING_CUE = /\b(?:sitzung(?:en|sort|sraum)?|einladung|tagesordnung|niederschrift|protokoll)\b/u;
const COMPARISON_CUE = /\b(?:wie (?:bereits|auch|etwa)|beispielsweise|zum beispiel|im vergleich zu|als vorbild)\b/u;
const JUNCTION_CUE = /\b(?:kreuzung(?:en)?|einmündung(?:en)?|ecke(?:n)?|knotenpunkt(?:e|en)?)\s+(?:(?:der|von)\s+)?$/u;
const ADDRESS_NUMBER = String.raw`\d{1,4}(?:[a-z]{1,2}|\s+[a-z](?!\p{L}))?`;
const ADDRESS_LIST = new RegExp(`^\\s+(?:(?:nr\\.?|hausnummern?)\\s+)?(${ADDRESS_NUMBER}(?:(?:\\s*,\\s*|\\s+und\\s+)${ADDRESS_NUMBER}){0,7})(?![\\p{L}\\p{N}/-])`, 'u');

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
    const textOnly = entry.kind === 'place' && entry.textOnly === true && entry.geometry == null;
    // Same normalized name at several sites stays ambiguous. Segments of a
    // single identified street must already be grouped in the gazetteer.
    if (byName.has(name) || typeof attribution !== 'string' || !attribution.trim()
      || (!textOnly && !validGeometry(entry.geometry, entry.kind))) {
      byName.set(name, null);
    } else {
      byName.set(name, { ...entry, attribution: attribution.trim() });
    }
    byFirstWord.set(firstWord, byName);
  }
  return byFirstWord;
}

function matchSingleLocation(text, byFirstWord, fromDocument = false) {
  const subject = normalize(text).replace(/^(?:anfrage|antrag|änderungsantrag|antwort|stellungnahme) (?:der|des) [^:]+:\s*/u, '');
  if (!subject || LIMITED_SCOPE.test(subject) || MULTIPLE_LOCATIONS.test(subject)) return null;
  if (fromDocument && COMPARISON_CUE.test(subject)) return null;

  let entry = null;
  let explicit = false;
  let namesRoadway = false;
  for (const word of subject.matchAll(WORD)) {
    for (const [name, candidate] of byFirstWord.get(word[0]) ?? []) {
      if (!subject.startsWith(name, word.index)) continue;
      const after = subject.slice(word.index + name.length);
      if (WORD_CHAR.test(after)) continue;
      if (!candidate || (entry && entry !== candidate)) return null;
      const before = subject.slice(0, word.index);
      if (ADJACENT_CUE.test(before) || SPECIFIC_TAIL.test(after)) return null;
      entry = candidate;
      const quoted = before.endsWith('"') && after.startsWith('"');
      const topic = !before && (!after || after.trimStart().startsWith(':'));
      const streetCue = entry.kind === 'street' && STREET_CUE.test(before);
      const locative = !PREPOSITIONAL_NAME.test(name) && LOCATIVE_CUE.test(before);
      const roadway = entry.kind === 'street' && ROADWAY_CUE.test(before);
      namesRoadway ||= roadway;
      explicit ||= streetCue || locative || (fromDocument ? roadway : quoted || (topic && !PREPOSITIONAL_NAME.test(name)));
    }
  }
  if (!explicit) return null;
  // A street in a reply may locate a stop or a building. Its full line is
  // appropriate only if the roadway itself is the subject of the statement.
  const geometry = !fromDocument || entry.kind === 'place' || namesRoadway ? entry.geometry : undefined;
  return { entry, geometry };
}

function mentions(subject, byFirstWord, includeUnverified = false) {
  const matches = [];
  let end = 0;
  for (const word of subject.matchAll(WORD)) {
    if (word.index < end) continue;
    const entries = byFirstWord.get(word[0]);
    if (!entries) continue;
    let longest;
    for (const [name, entry] of entries) {
      if (subject.startsWith(name, word.index) && !WORD_CHAR.test(subject.slice(word.index + name.length))
          && (!longest || name.length > longest.name.length)) longest = { name, entry };
    }
    if (!longest) continue;
    end = word.index + longest.name.length;
    if (longest.entry || includeUnverified) matches.push({ entry: longest.entry, index: word.index, end });
  }
  return matches;
}

function location(kind, label, geometry, entries) {
  return {
    kind, label,
    ...(geometry ? { geometry, attribution: [...new Set(entries.map(entry => entry.attribution))].join(' · ') } : {}),
    ...(geometry && kind === 'street' && entries.some(entry => entry.extent === 'part') ? { extent: 'part' } : {}),
  };
}

function endpoint(street, fragment, byFirstWord, stopsOnly) {
  const hits = mentions(fragment, byFirstWord);
  const before = hits.length ? fragment.slice(0, hits[0].index) : '';
  if (!/^(?:(?:der|den|dem|die|zur|zum|kreuzung|einmündung|ecke|knotenpunkt|haltestelle|hochbahnsteig(?:en)?)\s+)*$/u.test(before)) return {};
  const candidates = hits.map(hit => hit.entry).filter(entry => entry !== street);
  const place = candidates.filter(entry => entry.kind === 'place' && entry.geometry?.type === 'Point');
  if (place.length === 1) {
    return { label: place[0].name, point: place[0].geometry.coordinates, entry: place[0] };
  }
  const label = candidates.map(entry => entry.name).join(' / ');
  if (stopsOnly || place.length) return { label };
  const crossings = candidates.filter(entry => entry.kind === 'street')
    .map(entry => [entry, streetJunction(street, entry)]).filter(([, point]) => point);
  if (!crossings.length || crossings.some(([, point]) => !samePosition(point, crossings[0][1]))) return { label };
  return { label, point: crossings[0][1], entry: crossings[0][0] };
}

function measureSections(subject, hits, byFirstWord, used) {
  const results = [];
  for (const hit of hits) {
    const { entry, index, end } = hit;
    if (used.has(hit) || entry.kind !== 'street') continue;
    const span = /^\s*[,(:]?\s*(?:(?:im|in dem) (?:abschnitt|bereich)\s+)?(zwischen|von)\s+([^;)]+)/u.exec(subject.slice(end));
    if (!span) continue;
    const divider = span[1] === 'von' ? 'bis' : 'und';
    const bounds = new RegExp(`^(.{1,250}?)\\s+${divider}\\s+(.{1,250})`, 'u').exec(span[2]);
    if (!bounds) continue;
    const stopsOnly = /\b(?:hochbahnsteig|haltestell)/u.test(bounds[1]);
    const from = endpoint(entry, bounds[1], byFirstWord, stopsOnly);
    const finalBound = bounds[2].split(',', 1)[0];
    const to = endpoint(entry, finalBound, byFirstWord, stopsOnly);
    const approach = [from.entry, to.entry].flatMap(anchor => {
      const link = anchor?.sectionLink;
      return link?.street === entry.name && link.geometry?.type === 'LineString' && isLine(link.geometry.coordinates)
        ? [link.geometry.coordinates] : [];
    });
    const extraBoundary = /\b(?:bis|zwischen|von)\s+/u.test(bounds[2]);
    const geometry = !extraBoundary && from.point && to.point ? streetSection(entry, from.point, to.point, approach) : null;
    const label = !extraBoundary && from.label && to.label ? `${entry.name}, ${from.label} bis ${to.label}` : entry.name;
    results.push(location('section', label, geometry, [entry, from.entry, to.entry].filter(Boolean)));
    // Anchor mentions belong to this section and are not separate measures.
    const sectionEnd = end + span[0].length - bounds[2].length + finalBound.length;
    for (const mention of hits) {
      if (mention.index >= index && mention.index < sectionEnd) used.add(mention);
    }
  }
  return results;
}

function measureJunctions(subject, streets, used) {
  const results = [];
  let previousEnd = -1;
  for (let index = 0; index + 1 < streets.length; index++) {
    const first = streets[index];
    const second = streets[index + 1];
    const continuation = previousEnd >= 0 && /^\s*(?:,|und|sowie)\s*$/u.test(subject.slice(previousEnd, first.index));
    if (first.entry === second.entry || (!continuation && !JUNCTION_CUE.test(subject.slice(0, first.index)))
        || !/^(?:\s*\/\s*|\s+(?:mit|und|richtung)\s+(?:der\s+)?)$/u.test(subject.slice(first.end, second.index))) continue;
    const point = streetJunction(first.entry, second.entry);
    const label = `${first.entry.name} / ${second.entry.name}`;
    results.push(location('junction', label, point && { type: 'Point', coordinates: point }, [first.entry, second.entry]));
    used.add(first);
    used.add(second);
    previousEnd = second.end;
    index++;
  }
  return results;
}

function measureAddresses(subject, streets, gazetteer, used) {
  const results = [];
  for (const hit of streets) {
    const { entry, end } = hit;
    const numbers = ADDRESS_LIST.exec(subject.slice(end));
    if (!numbers || /^\s+(?:km|meter|minuten|bis)\b/u.test(subject.slice(end + numbers[0].length))) continue;
    used.add(hit);
    for (const number of numbers[1].split(/\s*,\s*|\s+und\s+/u)) {
      const key = number.replace(/\s+/gu, '').replace(/^0+(?=\d)/u, '');
      const label = `${entry.name} ${key.replace(/[a-z]+$/u, suffix => ` ${suffix.toUpperCase()}`)}`;
      const coordinates = gazetteer.addresses?.[entry.streetKey]?.[key];
      const geometry = isPosition(coordinates) ? { type: 'Point', coordinates } : null;
      results.push(location('address', label, geometry, [{ attribution: gazetteer.addressAttribution || entry.attribution }]));
    }
  }
  return results;
}

function measurePlaceList(subject, hits) {
  const list = new Set();
  const bounded = [];
  for (let index = 0; index + 1 < hits.length; index++) {
    const first = hits[index];
    const second = hits[index + 1];
    const before = subject.slice(0, first.index);
    if (!/^\s+(?:und|sowie|oder)\s+(?:(?:in|im|an|am|auf)\s+)?(?:(?:der|die|den)\s+)?$/u.test(subject.slice(first.end, second.index))) continue;
    if (/\bzwischen\s+(?:(?:der|den|dem)\s+)?$/u.test(before)) {
      bounded.push(location('place', `Bereich zwischen ${first.entry.name} und ${second.entry.name}`, null, []));
    } else if (!LIMITED_SCOPE.test(subject) && !/\([^()]*$/u.test(before)
        && /\b(?:an|am|im|in|auf|entlang|der|die|den)\s*$/u.test(before)) {
      list.add(first.entry);
      list.add(second.entry);
    }
  }
  return [...bounded, ...[...list].map(entry => location(entry.kind, entry.name, entry.geometry, [entry]))];
}

function parseMeasureLocations(text, byFirstWord, gazetteer) {
  const subject = normalize(text)
    .replace(/(\p{L})str(?:\.(?=\s|[/,;)]|$)|(?=\s+\d))/gu, '$1strasse')
    .replace(/([\p{L}\p{M}-]+)-\s+(und|sowie|oder)\s+((?:(?:die|der|den)\s+)?[\p{L}\p{M}-]+strasse)\b/gu,
      '$1strasse $2 $3');
  const hits = mentions(subject, byFirstWord);
  const used = new Set();
  const remainingStreets = () => hits.filter(hit => hit.entry.kind === 'street' && !used.has(hit));
  return [
    ...measureSections(subject, hits, byFirstWord, used),
    ...measureJunctions(subject, remainingStreets(), used),
    ...measureAddresses(subject, remainingStreets(), gazetteer, used),
    ...measurePlaceList(subject, hits.filter(hit => !used.has(hit))),
  ];
}

function measureLocations(record, byFirstWord, gazetteer, limit) {
  const document = (Array.isArray(record.locationEvidence) ? record.locationEvidence : [])
    .filter(paragraph => typeof paragraph === 'string' && paragraph.trim()).flatMap(paragraph =>
    paragraph.split(/(?<=[.!?])\s+(?=[\p{Lu}„])/u));
  const evidence = [...document.map(text => ({ source: 'document', text })), { source: 'title', text: record.title }];
  const locations = new Map();
  const reasons = new Set();
  const general = [];
  const keep = (found, proof) => {
    const key = `${found.kind}:${normalize(found.label)}`;
    const existing = locations.get(key);
    if (!existing || (!existing.geometry && found.geometry)) locations.set(key, { ...found, evidence: proof });
  };
  for (const proof of evidence) {
    const normalized = normalize(proof.text);
    if (MEETING_CUE.test(normalized) || COMPARISON_CUE.test(normalized)) continue;
    if (mentions(normalized, byFirstWord, true).some(hit => !hit.entry)) reasons.add('unverified_name');
    const specific = parseMeasureLocations(proof.text, byFirstWord, gazetteer);
    for (const found of specific) keep(found, proof);
    if (!specific.length) {
      const match = matchSingleLocation(proof.text, byFirstWord, proof.source === 'document');
      if (match) general.push({ ...match, proof });
    }
  }
  const specified = new Set([...locations.values()].flatMap(found =>
    mentions(normalize(found.label), byFirstWord).map(hit => hit.entry)));
  for (const { entry, geometry, proof } of general) {
    if (!specified.has(entry)) keep(location(entry.kind, entry.name, geometry, [entry]), proof);
  }
  let selected = [...locations.values()].slice(0, limit);
  const truncated = locations.size > limit;
  if (truncated) reasons.add('location_limit');
  if (selected.some(found => !validLocationGeometry(found.geometry, found.kind))) reasons.add('unmapped_location');
  // Exact residential address markers belong to the traffic analysis only
  // when the document has a traffic connection. Its text remains searchable.
  if (selected.some(found => found.kind === 'address' && found.geometry)
      && !classifyTrafficRelevance({ title: record.title, snippet: document.join(' '), gremium: record.gremium }).isTrafficRelevant) {
    reasons.add('non_traffic_address');
    selected = selected.map(found => found.kind === 'address'
      ? { kind: found.kind, label: found.label, evidence: found.evidence } : found);
  }
  return { locations: selected, truncated, reasons: [...reasons] };
}

/**
 * Optional build-time join to verified public streets or bounded places in
 * one city. The gazetteer is { city, entries: [{ name, kind, geometry,
 * attribution }] }; attribution can also be supplied at the gazetteer level.
 * `extent: 'part'` labels a street line that covers only part of the street.
 * Accident-network tiles carry no street names or public access tags.
 * Every record receives an explicit assessment. Official RIS geometries are
 * preserved; derived locations are replaced on each run, including no matches.
 */
function enrichRisLocations(records, { city, gazetteer } = {}) {
  const byFirstWord = city && gazetteer?.city === city && Array.isArray(gazetteer.entries) && gazetteer.entries.length
    ? indexGazetteer(gazetteer) : null;
  return records.map(record => {
    const official = record.locationSource === 'official' && validSourceGeometry(record.geometry);
    const sources = ['title'];
    if (Array.isArray(record.locationEvidence) && record.locationEvidence.some(text => typeof text === 'string' && text.trim())) {
      sources.push('document');
    }
    if (official) sources.push('official');
    const reasons = [];
    if (!byFirstWord) reasons.push('gazetteer_unavailable');
    if (record.locationEvidenceUnavailable === true) reasons.push('document_text_unavailable');
    if (record.locationEvidenceTruncated === true) reasons.push('evidence_truncated');
    // Reserve a feature for the official geometry without exceeding the shared
    // map limit; any omitted derived places are reported as a partial result.
    const result = byFirstWord ? measureLocations(record, byFirstWord, gazetteer, MAX_LOCATIONS_PER_RECORD - Number(official))
      : { locations: [], truncated: false, reasons: [] };
    reasons.push(...result.reasons);
    if (byFirstWord && !official && !result.locations.length && !reasons.includes('unverified_name')) reasons.push('no_specific_location');
    const mapped = official || result.locations.some(found => validLocationGeometry(found.geometry, found.kind));
    const status = mapped ? (reasons.length ? 'partial' : 'mapped') : (byFirstWord ? 'unresolved' : 'unavailable');
    const assessed = { ...record, locations: result.locations, locationAssessment: {
      status, sources, reasons: [...new Set(reasons)], truncated: record.locationEvidenceTruncated === true || result.truncated,
    } };
    if (!official) {
      delete assessed.geometry;
      delete assessed.locationSource;
      delete assessed.locationLabel;
    }
    return assessed;
  });
}

module.exports = { enrichRisLocations };
