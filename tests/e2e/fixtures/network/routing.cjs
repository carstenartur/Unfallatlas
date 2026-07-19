'use strict';

function cityFixtureForLatitude(latitude) {
  const value = Number(latitude);
  if (!Number.isFinite(value)) return null;
  if (value >= 50.5 && value <= 51.0) return 'bonn';
  if (value >= 52.1 && value <= 52.7) return 'hannover';
  return null;
}

function classifyNominatimFixture(rawUrl) {
  let url;
  try { url = new URL(rawUrl); }
  catch (_) { return null; }
  if (url.hostname !== 'nominatim.openstreetmap.org' || url.pathname !== '/reverse') return null;
  return cityFixtureForLatitude(url.searchParams.get('lat'));
}

function classifyOverpassFixture(rawUrl, postData) {
  let url;
  try { url = new URL(rawUrl); }
  catch (_) { return null; }
  if (url.hostname !== 'overpass-api.de' || url.pathname !== '/api/interpreter') return null;
  const body = String(postData || '');
  const query = new URLSearchParams(body).get('data') || body;
  const bbox = query.match(/\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/);
  return bbox ? cityFixtureForLatitude(bbox[1]) : null;
}

module.exports = { classifyNominatimFixture, classifyOverpassFixture };
