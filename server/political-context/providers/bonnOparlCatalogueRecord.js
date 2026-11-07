'use strict';

const { inferType } = require('./_portalUtils.js');
const { officialBonnUrl } = require('./bonnOparlHttp.js');

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value) {
  return Array.isArray(value) ? value : (value ? [value] : []);
}

function officialUrl(value) {
  const href = officialBonnUrl(text(value));
  if (!href) return '';
  const url = new URL(href);
  return url.username || url.password || url.port ? '' : href;
}

function officialHttpsUrl(value) {
  const href = officialUrl(value);
  // Historical BoRIS web links are no longer valid evidence links. Preserve
  // the current Paper ID when Bonn still publishes an old web link.
  return href && ['https://www.bonn.sitzung-online.de', 'https://bonn.sitzung-online.de']
    .includes(new URL(href).origin) ? href : '';
}

function paperDate(paper) {
  const value = text(paper.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function position(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3
      || !value.every(Number.isFinite) || Math.abs(value[0]) > 180 || Math.abs(value[1]) > 90) return null;
  return value.slice();
}

function sequence(value, minimum, normalizeItem) {
  if (!Array.isArray(value) || value.length < minimum) return null;
  const items = value.map(normalizeItem);
  return items.every(Boolean) ? items : null;
}

const line = value => sequence(value, 2, position);

function ring(value) {
  const points = sequence(value, 4, position);
  if (!points) return null;
  const first = points[0];
  const last = points[points.length - 1];
  return first.length === last.length && first.every((coordinate, index) => coordinate === last[index])
    ? points : null;
}

const polygon = value => sequence(value, 1, ring);
const coordinateReaders = {
  Point: position,
  LineString: line,
  Polygon: polygon,
  MultiPoint: value => sequence(value, 1, position),
  MultiLineString: value => sequence(value, 1, line),
  MultiPolygon: value => sequence(value, 1, polygon),
};

function paperLocation(paper) {
  // The OParl Paper's own locations describe the subject of the document.
  // The location of a meeting or organization has a different meaning.
  for (const location of list(paper.location)) {
    if (!location || location.deleted === true || !location.geojson) continue;
    const geojson = location.geojson;
    const geometry = geojson.type === 'Feature' ? geojson.geometry : geojson;
    if (!geometry || Object.hasOwn(geojson, 'crs') || Object.hasOwn(geometry, 'crs')
        || !Object.hasOwn(coordinateReaders, geometry.type)) continue;
    const coordinates = coordinateReaders[geometry.type](geometry.coordinates);
    if (!coordinates) continue;
    const label = text(location.description) || text(location.streetAddress)
      || text(geojson.properties && geojson.properties.name) || text(location.locality);
    return {
      geometry: { type: geometry.type, coordinates },
      locationSource: 'official',
      ...(label ? { locationLabel: label } : {}),
    };
  }
  return {};
}

function paperGremium(paper) {
  const label = text(paper.gremium) || text(paper.organizationName);
  if (label) return label;
  for (const consultation of list(paper.consultation)) {
    for (const organization of list(consultation && consultation.organization)) {
      const name = text(organization && organization.name) || text(organization && organization.shortName);
      if (name) return name;
    }
  }
  return null;
}

function mapCataloguePaper(paper, url, source, date) {
  const id = officialUrl(paper.id);
  const title = text(paper.name);
  if (!id || !title || !url) return null;
  const rawType = text(paper.paperType);
  const isAnswer = /antwort|stellungnahme/i.test(rawType);
  const relatedTo = [...list(paper.superordinatedPaper), ...(isAnswer ? list(paper.relatedPaper) : [])]
    .map(value => officialUrl(value && typeof value === 'object' ? value.id : value))
    .find(value => value && value !== id);
  const explicitType = isAnswer ? 'Verwaltungsantwort' : inferType('', rawType);
  return {
    id,
    title,
    type: explicitType !== 'Sonstige' ? explicitType : inferType(title, rawType),
    number: text(paper.reference) || null,
    date,
    gremium: paperGremium(paper),
    url,
    source,
    ...(relatedTo ? { relatedTo } : {}),
    ...paperLocation(paper),
  };
}

module.exports = { officialHttpsUrl, paperDate, mapCataloguePaper };
