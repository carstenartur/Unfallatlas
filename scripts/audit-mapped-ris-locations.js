#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseArgs } = require('node:util');
const { createReader } = require('../js/ua.ris-partitions');
const { createCatalogue } = require('../js/ua.ris-catalogue');
const { partitionInternals } = require('../server/political-context/services/risSnapshot');

const digest = input => createHash('sha256').update(input).digest('hex');
const recordKey = row => JSON.stringify([row.city, row.id]);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function rankedSample(candidates, size, seed) {
  if (!Number.isSafeInteger(size) || size < 1 || !seed.trim()) throw Error('Stichprobengröße oder Seed ungültig.');
  const seen = new Set();
  const ranked = candidates.map(row => {
    const key = recordKey(row);
    if (seen.has(key)) throw Error('Ratsvorgang doppelt: ' + key);
    seen.add(key);
    return { row, key, rank: digest(JSON.stringify([seed, row.city, row.id])) };
  });
  return ranked.sort((a, b) => compare(a.rank, b.rank) || compare(a.key, b.key)).slice(0, size).map(item => item.row);
}

function summarizeReviews(sample, decisions) {
  if (!Array.isArray(decisions)) throw Error('Manuelle Beurteilungen müssen als Liste vorliegen.');
  const sampleKeys = new Set(sample.map(recordKey));
  const reviewed = new Set();
  const relevance = {yes: 0, no: 0, unclear: 0};
  const location = {correct: 0, incorrect: 0, unclear: 0};
  let correct = 0, judged = 0;
  for (const row of decisions) {
    const key = recordKey(row);
    if (!sampleKeys.has(key)) throw Error('Vorgang außerhalb der Stichprobe: ' + key);
    if (reviewed.has(key)) throw Error('Beurteilung doppelt: ' + key);
    const source = URL.canParse(row.sourceUrl) ? new URL(row.sourceUrl) : null;
    if (!Object.hasOwn(relevance, row.relevance) || !Object.hasOwn(location, row.location)
        || typeof row.note !== 'string' || !row.note.trim() || source?.protocol !== 'https:' || source.username || source.password) {
      throw Error('Beurteilung benötigt Themenbezug, Ortsurteil, Begründung und HTTPS-Fundstelle: ' + key);
    }
    reviewed.add(key);
    relevance[row.relevance]++;
    location[row.location]++;
    if (row.relevance === 'yes' && row.location !== 'unclear') {
      judged++;
      if (row.location === 'correct') correct++;
    }
  }
  return {sampleSize: sample.length, pending: sample.length - reviewed.size, relevance, location,
    relevantLocationPrecision: {correct, judged, share: judged ? correct / judged : null}};
}

async function allPages(reader, kind, key) {
  const items = [];
  let page = 0;
  do {
    const result = await reader.page(kind, key, page);
    items.push(...result.items);
    page = result.nextPage;
  } while (page !== null);
  return items;
}

async function readCity(file, size, seed) {
  const raw = await fs.readFile(file), manifest = JSON.parse(raw), city = manifest.city;
  if (manifest.schemaVersion !== 2 || path.basename(file) !== city + '.json') throw Error('Partitionierter Stadtkatalog erwartet: ' + file);
  const directory = path.dirname(file);
  const reader = createReader({manifest, load: ref => partitionInternals.readAsset(directory, ref, ref.kind)});
  const catalogue = createCatalogue({
    base: 'https://snapshot.invalid/', now: () => new Date(manifest.generatedAt),
    fetch: async url => {
      const name = path.basename(new URL(url).pathname);
      return new Response(name === city + '.json' ? raw : await fs.readFile(path.join(directory, name)));
    },
  });
  await catalogue.loadManifest(city);
  const seen = new Set(), candidates = [];
  const counts = {mapped: 0, partial: 0, unresolved: 0, unavailable: 0};
  await reader.walk('records', async (_ref, node) => {
    if (node.type !== 'leaf') return;
    for (const [id, record] of node.entries) {
      const status = record.locationAssessment?.status;
      if (seen.has(id) || !Object.hasOwn(counts, status)) throw Error('Unbekannter Status oder doppelter Vorgang: ' + id);
      seen.add(id);
      counts[status]++;
      if (status === 'mapped' || status === 'partial') candidates.push({city, id});
    }
  });
  if (seen.size !== manifest.recordCount || seen.size !== manifest.locationAssessment.attempted || candidates.length !== manifest.mappedRecordCount
      || Object.keys(counts).some(status => counts[status] !== manifest.locationAssessment[status])) throw Error('Katalog und Vorgangszahlen widersprechen sich.');
  const sample = [];
  for (const {id} of rankedSample(candidates, size, seed)) {
    const row = await reader.get('records', id), geometries = [];
    const locations = await allPages(reader, 'locations', id);
    if (locations.length !== row.locationCount) throw Error('Ortsbezüge fehlen: ' + id);
    for (const geometryId of await allPages(reader, 'links', 'record:' + id)) {
      const feature = await catalogue.loadGeometry(city, geometryId, {snapshot: manifest});
      const links = (await allPages(reader, 'links', geometryId)).filter(link => link.recordId === id);
      if (!feature || !links.length) throw Error('Kartenbezug unvollständig: ' + geometryId);
      geometries.push({geometryId, geometry: feature.geometry, bounds: feature.bounds,
        references: links.map(({label, accuracy, locationId}) => ({label, accuracy, locationId}))});
    }
    if (!geometries.length) throw Error('Vorgang ohne belegbare Kartengeometrie: ' + id);
    sample.push({city, id, title: row.title, source: row.source, url: row.url, originalPdfUrl: row.originalPdfUrl,
      date: row.date, assessment: row.locationAssessment, locations, geometries});
  }
  return {city, generation: manifest.generation, manifestSha256: digest(raw), generatedAt: manifest.generatedAt,
    coverage: manifest.coverage, recordCount: seen.size, mappedRecordCount: candidates.length, counts, sample};
}

async function audit(files, size, seed, reviews) {
  if (!files.length) throw Error('Mindestens ein Stadtmanifest angeben.');
  const cities = [];
  for (const file of files) cities.push(await readCity(file, size, seed));
  cities.sort((a, b) => compare(a.city, b.city));
  if (new Set(cities.map(c => c.city)).size !== cities.length) throw Error('Pro Stadt ein Manifest angeben.');
  const sampleId = digest(JSON.stringify([seed, size, ...cities.map(c => [c.city, c.manifestSha256, c.sample.map(r => r.id)])]));
  if (reviews && reviews.sampleId !== sampleId) throw Error('Beurteilungen gehören zu einer anderen Stichprobe.');
  const decisions = reviews ? reviews.decisions : [];
  summarizeReviews(cities.flatMap(c => c.sample), decisions);
  for (const city of cities) {
    const local = decisions.filter(row => row.city === city.city);
    city.review = summarizeReviews(city.sample, local);
    city.decisions = local;
  }
  return {sampleId, seed, sizePerCity: size, cities};
}

async function main() {
  const {values, positionals} = parseArgs({allowPositionals: true, options: {
    size: {type: 'string', default: '20'}, seed: {type: 'string', default: 'mapped-ris-1'}, reviews: {type: 'string'},
  }});
  const reviews = values.reviews ? JSON.parse(await fs.readFile(values.reviews, 'utf8')) : null;
  console.log(JSON.stringify(await audit(positionals, Number(values.size), values.seed, reviews), null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = {rankedSample, summarizeReviews, audit};
