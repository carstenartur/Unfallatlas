'use strict';

const { sourceContext } = require('./hannoverAdditionalFormats');

function simSourceClock(catalogue, now) {
  const verifiedTime = value => {
    const time = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(time) && time <= now.getTime() ? time : NaN;
  };
  const catalogueTime = verifiedTime(catalogue.generatedAt);
  const detailTimes = catalogue.records.map(record => verifiedTime(record.detailVerifiedAt));
  // Composition and checkpoint recovery do not read the source. Without an
  // existing catalogue clock, every contributing detail needs a known clock.
  if (!Number.isFinite(catalogueTime) && (!detailTimes.length || detailTimes.some(time => !Number.isFinite(time)))) return null;
  const oldest = detailTimes.reduce((time, detail) => Number.isFinite(detail) ? Math.min(time, detail) : time,
    Number.isFinite(catalogueTime) ? catalogueTime : Infinity);
  return new Date(oldest).toISOString();
}

function composeHannoverCatalogue(cityCatalogue, additional, { now = new Date() } = {}) {
  if (!Array.isArray(cityCatalogue?.records) || !cityCatalogue.coverage || !Array.isArray(additional?.records) || !Array.isArray(additional.sourceStatuses)) {
    throw new TypeError('Invalid Hannover source catalogues');
  }
  const cityRecords = cityCatalogue.records.map(record => ({ ...record,
    sourceContext: record.sourceContext || { ...sourceContext('city', record.type || 'Sonstige',
      record.type === 'Antrag' || record.type === 'Anfrage' || record.type === 'Änderungsantrag' ? 'proposal'
        : record.type === 'Verwaltungsantwort' ? 'answer' : record.type === 'Protokoll' ? 'minutes' : 'other'), publisher: 'Landeshauptstadt Hannover' } }));
  const records = [...new Map([...cityRecords, ...additional.records].map(record => [record.id, record])).values()];
  const cityClock = simSourceClock(cityCatalogue, now);
  const cityStatus = { source: 'hannover-sim', status: cityCatalogue.coverage.complete ? 'available' : 'partial',
    url: cityCatalogue.sources[0], retrievedAt: cityClock, from: cityCatalogue.coverage.from, to: cityCatalogue.coverage.to,
    recordCount: cityRecords.length, message: 'Städtischer SIM-Katalog; Quellenabdeckung siehe eigenen Zeitraum und Sammlungsstatus.' };
  const sourceStatuses = [cityStatus, ...additional.sourceStatuses];
  // Only sources contributing records constrain data freshness. An old empty
  // failed checkpoint remains visible in sourceStatuses, without expiring SIM.
  const generatedAt = [cityClock, ...additional.sourceStatuses.filter(s => s.recordCount > 0).map(s => s.retrievedAt)]
    .filter(Boolean).sort()[0];
  return { ...cityCatalogue, records, generatedAt,
    sources: [...new Set([...cityCatalogue.sources, ...(additional.sources || sourceStatuses.map(s => s.url))])],
    sourceStatuses,
    coverage: { ...cityCatalogue.coverage, complete: false,
      bodies: [...new Set([...cityCatalogue.coverage.bodies, ...records.map(r => r.gremium).filter(Boolean), 'Regionsversammlung und Ausschüsse', 'Niedersächsischer Landtag'])],
      warnings: [...new Set([...cityCatalogue.coverage.warnings, ...additional.sourceStatuses.map(s => `${s.source}: ${s.message}`)])] },
    provenance: { ...cityCatalogue.provenance, rights: { status: 'not-specified', license: null,
      attribution: ['Landeshauptstadt Hannover', 'Region Hannover', 'Niedersächsischer Landtag: Drucksachen und Plenarprotokolle; amtliche Werke nach § 5 Abs. 2 UrhG, Änderungsverbot und Quellenangabe beachten.'] },
      collection: { ...cityCatalogue.provenance?.collection,
        // Existing counters describe SIM acquisition only; do not relabel them aggregate totals.
        pages: null, rawItems: null } } };
}

module.exports = { composeHannoverCatalogue };
