'use strict';

const { sourceContext } = require('./hannoverAdditionalFormats');

function composeHannoverCatalogue(cityCatalogue, additional, { now = new Date() } = {}) {
  if (!Array.isArray(cityCatalogue?.records) || !cityCatalogue.coverage || !Array.isArray(additional?.records) || !Array.isArray(additional.sourceStatuses)) {
    throw new TypeError('Invalid Hannover source catalogues');
  }
  const cityRecords = cityCatalogue.records.map(record => ({ ...record,
    sourceContext: record.sourceContext || { ...sourceContext('city', record.type || 'Sonstige',
      record.type === 'Antrag' || record.type === 'Anfrage' || record.type === 'Änderungsantrag' ? 'proposal'
        : record.type === 'Verwaltungsantwort' ? 'answer' : record.type === 'Protokoll' ? 'minutes' : 'other'), publisher: 'Landeshauptstadt Hannover' } }));
  const records = [...new Map([...cityRecords, ...additional.records].map(record => [record.id, record])).values()];
  const cityClock = cityCatalogue.generatedAt || now.toISOString();
  const cityStatus = { source: 'hannover-sim', status: cityCatalogue.coverage.complete ? 'available' : 'partial',
    url: cityCatalogue.sources[0], retrievedAt: cityClock, from: cityCatalogue.coverage.from, to: cityCatalogue.coverage.to,
    recordCount: cityRecords.length, message: 'Städtischer SIM-Katalog; Quellenabdeckung siehe eigenen Zeitraum und Sammlungsstatus.' };
  const sourceStatuses = [cityStatus, ...additional.sourceStatuses];
  const generatedAt = [cityClock, ...sourceStatuses.map(s => s.retrievedAt)].filter(Boolean).sort()[0];
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
