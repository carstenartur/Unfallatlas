'use strict';

function cityFixtureForCoordinate(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat >= 50.5 && lat <= 51.0 && lon >= 6.7 && lon <= 7.4) return 'bonn';
  if (lat >= 52.1 && lat <= 52.7 && lon >= 9.3 && lon <= 10.0) return 'hannover';
  return null;
}

function classifyNominatimFixture(rawUrl) {
  let url;
  try { url = new URL(rawUrl); }
  catch (_) { return null; }
  if (url.hostname !== 'nominatim.openstreetmap.org' || url.pathname !== '/reverse') return null;
  return cityFixtureForCoordinate(url.searchParams.get('lat'), url.searchParams.get('lon'));
}

function classifyOverpassFixture(rawUrl, postData) {
  let url;
  try { url = new URL(rawUrl); }
  catch (_) { return null; }
  if (url.hostname !== 'overpass-api.de' || url.pathname !== '/api/interpreter') return null;
  const body = Buffer.isBuffer(postData) ? postData.toString('utf8') : String(postData || '');
  let query = new URLSearchParams(body).get('data') || body;
  if (/%[0-9a-f]{2}/i.test(query)) {
    try { query = decodeURIComponent(query.replace(/^data=/, '')); }
    catch (_) { return null; }
  }
  const number = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?';
  const bboxPattern = new RegExp(`\\(\\s*(${number})\\s*,\\s*(${number})\\s*,\\s*(${number})\\s*,\\s*(${number})\\s*\\)`, 'ig');
  const cities = new Set();
  let match;
  while ((match = bboxPattern.exec(query))) {
    const centerLat = (Number(match[1]) + Number(match[3])) / 2;
    const centerLon = (Number(match[2]) + Number(match[4])) / 2;
    const city = cityFixtureForCoordinate(centerLat, centerLon);
    if (!city) return null;
    cities.add(city);
  }
  return cities.size === 1 ? [...cities][0] : null;
}

module.exports = { classifyNominatimFixture, classifyOverpassFixture };
