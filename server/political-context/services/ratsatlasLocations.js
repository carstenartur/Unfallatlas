'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { snapshotFormat } = require('../../../js/ua.ris-catalogue');
const { validLocationGeometry } = snapshotFormat;
const provider = 'ratsatlas-hannover';
let register;

// Rebuild this provider's contribution from its complete current register on each
// run. Other providers' evidence survives a withdrawn match or changed title.
function nativeLocations(locations) {
  return locations.flatMap(location => {
    if (location.provenance?.provider !== provider) return [location];
    if (!location.provenance.retainedMention) return [];
    const { label, kind, evidence } = location;
    return [{ label, kind, evidence, mapped: false }];
  });
}

function isMapped(location) {
  return location.mapped === true || validLocationGeometry(location.geometry, location.kind);
}

function supplementsMappedSite(location, nativeMapped) {
  if (!nativeMapped.length) return true;
  // A point can refine a known street only if every mapped mention is that
  // same street. A broad polygon cannot improve a more specific location.
  return location.kind === 'address' && nativeMapped.every(site => site.kind === 'street'
    && location.label.startsWith(`${site.label} `));
}

function matchRecord(record, entry) {
  const previous = record.locations || [];
  const eligible = entry && record.source === 'hannover-sim' && entry.title === record.title && !record.geometry;
  if (!eligible && !previous.some(loc => loc.provenance?.provider === provider)) return record;
  const locations = nativeLocations(previous);
  const nativeMapped = locations.filter(isMapped);
  for (const loc of eligible ? entry.locations : []) {
    if (!supplementsMappedSite(loc, nativeMapped)) continue;
    const kind = loc.kind === 'crossing' ? 'junction' : loc.kind;
    const geometry = register.geometries[loc.geometryId];
    if (!validLocationGeometry(geometry, kind)) throw new Error(`Invalid Ratsatlas geometry for ${record.id}`);
    const evidence = { source: loc.evidence.source, text: loc.evidence.text };
    const mention = locations.findIndex(old => !isMapped(old) && old.kind === kind && old.label === loc.label
      && old.evidence.source === evidence.source && old.evidence.text === evidence.text);
    const provenance = { provider, revision: register.revision, accuracy: loc.accuracy, method: loc.method,
      sourceUrl: loc.sourceUrl, attribution: loc.attribution, evidenceUrl: loc.evidence.url,
      ...(loc.evidence.note ? { evidenceNote: loc.evidence.note } : {}), ...(loc.areaId ? { areaId: loc.areaId } : {}),
      ...(mention >= 0 ? { retainedMention: true } : {}) };
    const imported = { kind, label: loc.label, geometry, evidence, provenance,
      mapLabel: `${loc.label} — ${loc.accuracy} · ${loc.attribution}` };
    if (mention < 0) locations.push(imported);
    else locations[mention] = imported;
  }
  const assessment = record.locationAssessment;
  if (!assessment) return { ...record, locations };
  const unresolved = locations.filter(location => !isMapped(location));
  const mapped = record.locationSource === 'official' || locations.length > unresolved.length;
  const reasons = new Set(assessment.reasons);
  if (mapped) {
    reasons.delete('no_specific_location');
    reasons.delete('gazetteer_unavailable');
  }
  if (!unresolved.length) reasons.delete('unmapped_location');
  if (!unresolved.some(item => item.kind === 'address')) reasons.delete('non_traffic_address');
  if (unresolved.length) reasons.add('unmapped_location');
  if (!mapped && !reasons.size) reasons.add('no_specific_location');
  const status = mapped ? (reasons.size ? 'partial' : 'mapped') : (reasons.has('gazetteer_unavailable') ? 'unavailable' : 'unresolved');
  return { ...record, locations, locationAssessment: { ...assessment, status, reasons: [...reasons],
    sources: [...new Set([...assessment.sources, ...locations.map(location => location.evidence.source)])] } };
}

function applyRatsatlasLocations(city, records) {
  if (city !== 'hannover' || !records.length) return records;
  if (!register) {
    const file = path.join(__dirname, '../../../config/ris-locations/hannover-ratsatlas.json.gz');
    register = JSON.parse(gunzipSync(fs.readFileSync(file), { maxOutputLength: 32 * 1024 * 1024 }));
  }
  return records.map(record => matchRecord(record, register.records[record.id]));
}

module.exports = { applyRatsatlasLocations, nativeLocations };
