'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const traffic = require('../../js/ua.traffic_provider');
const source = require('./bast_annual_dtv_provider');
const {fetchDistribution} = require('./koeln_traffic_delivery');
const {applyRow} = require('../apply-matched-traffic');
const {readJsonArtifact, writeJsonArtifact} = require('../apply-qualitative-traffic-proxy');
const {slugify} = require('../lib/static-data-validation');
const {TRAFFIC_ROUTE_TAGS_VERSION, buildWayIndex, nearestWayIndexed} = require('../producers/osm_producer');

const MAX_STATION_DISTANCE_M = 12;
const AMBIGUOUS_ROUTE_DISTANCE_M = 25;
const MAX_LOCAL_CONTEXT_DISTANCE_M = 150;
const MAX_ACCIDENT_ROAD_DISTANCE_M = 10;
const MAIN_ROADS = new Set(['trunk', 'primary', 'secondary']);
const MOTOR_ROADS = new Set([...MAIN_ROADS, 'motorway', 'motorway_link', 'trunk_link', 'primary_link',
  'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service', 'track']);
const ACCESS = ['access', 'vehicle', 'motor_vehicle', 'motorcar'];
const MOTOR_DIRECTIONS = ['oneway', 'oneway:vehicle', 'oneway:motor_vehicle', 'oneway:motorcar'];
const distribution = {name: 'Jawe2023.csv', label: 'BASt annual DTV', url: source.DISTRIBUTION_URL,
  sha256: source.REVIEWED_DISTRIBUTION_SHA256, bytes: source.REVIEWED_DISTRIBUTION_BYTES};

function hasTrafficRouteTags(osm) {
  const tags = osm?.trafficRouteTags;
  return tags?.version === TRAFFIC_ROUTE_TAGS_VERSION && typeof tags.distributionUrl === 'string' && tags.ways &&
    typeof tags.ways === 'object' && !Array.isArray(tags.ways);
}

function shouldStageBastTraffic(slug, environment = process.env) {
  const configured = String(environment.CONTEXT_BAST_ANNUAL_COUNTS_CITY || '').trim();
  return Boolean(configured && slug !== 'koeln' && slugify(configured) === slug);
}

function roadCanRepresentCrossSection({highway, tags}, laneCount) {
  if (!MAIN_ROADS.has(highway)) return false;
  const forward = tags['lanes:forward'];
  const backward = tags['lanes:backward'];
  const laneEvidence = laneCount !== null && tags.lanes === String(laneCount) &&
    [forward, backward].every(value => /^[1-9]\d?$/.test(value)) && Number(forward) + Number(backward) === laneCount &&
    (!tags['lanes:both_ways'] || tags['lanes:both_ways'] === '0');
  return (tags.oneway === 'no' || laneEvidence) &&
    MOTOR_DIRECTIONS.every(key => !tags[`${key}:conditional`] && (!tags[key] || tags[key] === 'no')) &&
    ['lanes', 'lanes:forward', 'lanes:backward', 'lanes:both_ways'].every(key => !tags[`${key}:conditional`]) &&
    ACCESS.every(key => !tags[`${key}:conditional`] && (!tags[key] || ['yes', 'designated'].includes(tags[key]))) &&
    ['bridge', 'tunnel', 'area'].every(key => !tags[key] || tags[key] === 'no') &&
    (!tags.layer || tags.layer === '0') && !tags.junction;
}

function roadsByReference(osm) {
  const roads = new Map();
  for (const [wayId, tags] of Object.entries(osm.trafficRouteTags.ways)) {
    const highway = osm.ways[wayId]?.highway;
    const geometry = osm.wayGeometries[wayId];
    if (!MOTOR_ROADS.has(highway) || !Array.isArray(geometry) || geometry.length < 2) continue;
    const road = {wayId, highway, tags, coordinates: geometry.map(({lat, lon}) => [lon, lat])};
    for (const ref of new Set(tags.ref.split(';').map(ref => ref.trim().replace(/^B\s*(\d+)$/, 'B $1')))) {
      if (!roads.has(ref)) roads.set(ref, []);
      roads.get(ref).push(road);
    }
  }
  return roads;
}

function matchSections(provider, observations, osm, descriptor) {
  const roads = roadsByReference(osm);
  const matched = new Map();
  const ambiguousWays = new Set();
  let ambiguousStations = 0;
  for (const observation of observations) {
    const station = provider.crossSectionRoutes[observation.observationId];
    if (!station || !roads.has(station.ref)) continue;
    const {ref, laneCount} = station;
    const candidates = roads.get(ref).map(road => traffic.matchObservationToRoads(observation, [road],
      {maxDistanceMeters: AMBIGUOUS_ROUTE_DISTANCE_M})).filter(Boolean);
    if (candidates.length > 1) ambiguousStations++;
    if (candidates.length !== 1) continue;
    const {road, wayId, distanceMeters: stationToWayDistanceMeters} = candidates[0];
    if (stationToWayDistanceMeters > MAX_STATION_DISTANCE_M || !roadCanRepresentCrossSection(road, laneCount)) continue;
    if (matched.has(wayId)) ambiguousWays.add(wayId);
    const scoped = traffic.normalizeObservation({...observation, wayId, qualityNotes: [...observation.qualityNotes,
      `OSM-Straßenbezug ${ref}, Way ${wayId} (© OpenStreetMap contributors, ODbL 1.0); Querschnitt beider Richtungen.`,
      `Abstand zwischen Zählstelle und OSM-Way: ${stationToWayDistanceMeters.toFixed(1).replace('.', ',')} m.`,
      'Historischer Jahresmittelwert am Zählquerschnitt. Lokaler Straßenkontext im Unfalljahr, keine Messung am Unfallpunkt oder zur Unfallstunde.',
    ]}, descriptor, 0);
    matched.set(wayId, {observation: scoped, wayId, matchQuality: 'medium', matchMethod: 'bast-station-federal-road-cross-section'});
  }
  for (const wayId of ambiguousWays) matched.delete(wayId);
  return {matched, ambiguousStations, ambiguousWays: ambiguousWays.size};
}

function motorOnly(properties) {
  const yes = value => value === '1' || value === 1 || value === true;
  const no = value => value === '0' || value === 0 || value === false;
  return ['istpkw', 'istgkfz', 'istkrad'].some(key => yes(properties[key])) &&
    ['istrad', 'istfuss', 'istsonstig'].every(key => no(properties[key]));
}

function applyToFeatures(features, matched, osm, referenceYear) {
  if (matched.size === 0) return 0;
  const roadIndex = buildWayIndex(Object.entries(osm.wayGeometries)
    .filter(([id]) => MOTOR_ROADS.has(osm.ways[id]?.highway)).map(([id, geometry]) => ({id, geometry})));
  let applied = 0;
  for (const feature of features) {
    const row = feature?.properties;
    const match = matched.get(String(row?.matched_way_id));
    const observation = match?.observation;
    if (!observation || row.road_context_source !== 'osm' || !motorOnly(row) ||
        String(row.year) !== String(observation.year) || traffic.hasUsableTypedEvidence(row)) continue;
    if (feature.geometry?.type !== 'Point') continue;
    const [lon, lat] = feature.geometry.coordinates || [];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const {lon: stationLon, lat: stationLat} = observation.coordinate;
    const northing = (lat - stationLat) * 110540;
    const easting = (lon - stationLon) * 111320 * Math.cos(stationLat * Math.PI / 180);
    const stationDistanceMeters = Math.hypot(easting, northing);
    if (stationDistanceMeters > MAX_LOCAL_CONTEXT_DISTANCE_M) continue;
    const nearest = nearestWayIndexed(lat, lon, roadIndex, {maxDistanceM: MAX_ACCIDENT_ROAD_DISTANCE_M});
    if (nearest?.way_id !== observation.wayId || nearestWayIndexed(lat, lon, roadIndex,
      {maxDistanceM: MAX_ACCIDENT_ROAD_DISTANCE_M, excludeWayId: observation.wayId})) continue;
    const evidence = traffic.selectTrafficEvidence([{...match, distanceMeters: Math.round(stationDistanceMeters * 10) / 10}],
      {referenceYear, mode: 'motor_vehicle'});
    if (applyRow(row, {evidence, observations: [observation], referenceYear})) applied++;
  }
  return applied;
}

async function applyBastAnnualDtv({slug, outputDir, workDir, osmFile, referenceYear = new Date().getUTCFullYear(), request}) {
  if (!Number.isInteger(referenceYear) || referenceYear < 1900 || referenceYear > 2100) throw new Error('Invalid BASt reference year');
  const osmBytes = fs.readFileSync(osmFile);
  const osm = JSON.parse(osmBytes);
  if (osm.coverage !== 'full' || !hasTrafficRouteTags(osm)) throw new Error('BASt requires the full current OSM network with route tags');
  fs.mkdirSync(workDir, {recursive: true});
  const retrievedAt = await fetchDistribution(workDir, distribution, request);
  const provider = source.createBastAnnualDtvProvider({allowedRoot: workDir, csvPath: distribution.name,
    expectedDistributionSha256: distribution.sha256, expectedBytes: distribution.bytes, retrievedAt});
  const registry = traffic.createRegistry();
  registry.register(provider);
  const observations = await registry.collect({country: 'DE', failOnProviderError: true});
  const descriptor = traffic.normalizeDescriptor({...provider.descriptor,
    changeNotice: 'Originale BASt-Jahres-DTV des Zählquerschnitts anhand der Bundesstraßennummer mit OSM-Straße und lokalen Kfz-Unfällen des Messjahrs verknüpft; keine Richtungssumme oder zeitliche Umrechnung.',
    qualityNotes: ['Amtlicher WGS84-Stationspunkt, plausibilisiert durch OSM-Straßenreferenz und räumliche Nähe. Die absolute Lagegenauigkeit ist unbekannt.'],
  });
  const {matched, ambiguousStations, ambiguousWays} = matchSections(provider, observations, osm, descriptor);
  const geojson = readJsonArtifact(path.join(outputDir, `output_all_years_${slug}.geojson`));
  const meta = readJsonArtifact(path.join(outputDir, `output_all_years_${slug}.enrichment.meta.json`));
  const appliedFeatures = applyToFeatures(geojson.value.features, matched, osm, referenceYear);
  const featureTypes = {};
  for (const feature of geojson.value.features) {
    const type = feature?.properties?.traffic_measurement_type;
    if (type) featureTypes[type] = (featureTypes[type] || 0) + 1;
  }
  const coverage = {...provider.coverage, eligibleFederalCrossSections: Object.keys(provider.crossSectionRoutes).length,
    matchedStations: matched.size, ambiguousStations, ambiguousWays, appliedFeatures};
  meta.value.sources = {...meta.value.sources, trafficMatched: {source: descriptor, coverage, referenceYear, mode: 'motor_vehicle',
    semantics: 'annual-cross-section-local-same-year-motor-accident-context',
    matchLimitsMeters: {stationToWay: MAX_STATION_DISTANCE_M, competingWaysAtStation: AMBIGUOUS_ROUTE_DISTANCE_M,
      stationToAccident: MAX_LOCAL_CONTEXT_DISTANCE_M, accidentToWay: MAX_ACCIDENT_ROAD_DISTANCE_M},
    osm: {publisher: 'OpenStreetMap contributors', datasetUrl: 'https://www.openstreetmap.org/copyright',
      distributionUrl: osm.trafficRouteTags.distributionUrl, licenseId: 'ODbL-1.0', licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
      requiredAttribution: '© OpenStreetMap contributors', extractDate: osm.extractDate,
      inputSha256: crypto.createHash('sha256').update(osmBytes).digest('hex')},
  }};
  const typedFeatures = (featureTypes.count || 0) + (featureTypes.model || 0);
  const classifiedFeatures = featureTypes.proxy || 0;
  meta.value.counts = {...meta.value.counts, withTrafficProxy: classifiedFeatures, withTypedTraffic: typedFeatures};
  meta.value.traffic = {...meta.value.traffic, measurementType: typedFeatures ? 'mixed' : 'proxy',
    numericValuesPresent: typedFeatures > 0, typedFeatures, classifiedFeatures, featureTypes};
  if (appliedFeatures) writeJsonArtifact(geojson);
  writeJsonArtifact(meta);
  return {...coverage, counts: meta.value.counts};
}

module.exports = {applyBastAnnualDtv, hasTrafficRouteTags, shouldStageBastTraffic};
