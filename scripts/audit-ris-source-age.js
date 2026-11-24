'use strict';

const path = require('node:path');
const { createRisSourceCheckpoint } = require('../server/political-context/services/risSourceCheckpoint');
const { RIS_FALLBACK_MAX_AGE_MS } = require('../server/political-context/services/risSnapshot');
const { SOURCE, REVISION, CHECKPOINT_SCOPE, validTimestamp, validStoredRecord, validStoredDetail } =
  require('../server/political-context/providers/regionHannoverCatalogue');

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const MISSING = 'Regional source checkpoints are missing.';
const INVALID = 'Regional source checkpoint partition is invalid.';

function ageDistribution() {
  return { under7Days: 0, from7ToUnder14Days: 0, atLeast14Days: 0, oldest: null, newest: null };
}

function countAge(distribution, timestamp, asOfMs) {
  const age = asOfMs - Date.parse(timestamp);
  if (age >= RIS_FALLBACK_MAX_AGE_MS) distribution.atLeast14Days++;
  else if (age >= SEVEN_DAYS) distribution.from7ToUnder14Days++;
  else distribution.under7Days++;
  if (!distribution.oldest || timestamp < distribution.oldest) distribution.oldest = timestamp;
  if (!distribution.newest || timestamp > distribution.newest) distribution.newest = timestamp;
  return age >= RIS_FALLBACK_MAX_AGE_MS;
}

async function summarizeRegionSourceAge(directory, now = new Date()) {
  const checkpoint = createRisSourceCheckpoint({ directory });
  const years = await checkpoint.years(SOURCE, CHECKPOINT_SCOPE);
  if (!years.length) throw new Error(MISSING);

  const summary = {
    asOf: now.toISOString(),
    scope: 'Region Hannover source checkpoints only. Hannover SIM, Bonn and snapshot-only retained records are outside this report.',
    partitions: years.length,
    duplicates: 0, invalidMetadataRows: 0, invalidMetadataClockRows: 0,
    withdrawn: 0, active: 0, noDetail: 0, invalidDetail: 0,
    metadata: ageDistribution(), detail: ageDistribution(), effective: ageDistribution(),
    expiredBy: { metadataOnly: 0, detailOnly: 0, both: 0 }
  };
  const entries = new Map();
  for (const year of years) {
    const work = await checkpoint.read(SOURCE, CHECKPOINT_SCOPE, year, REVISION);
    if (!Array.isArray(work?.records) || work.records.length > 50000) throw new Error(INVALID);
    for (const entry of work.records) {
      if (!validStoredRecord(entry?.metadata)) { summary.invalidMetadataRows++; continue; }
      if (!validTimestamp(entry.metadataVerifiedAt, now)) { summary.invalidMetadataClockRows++; continue; }
      const id = entry.metadata.id;
      const validDetail = validStoredDetail(entry.detail, now)
        && entry.detail.id === id && validTimestamp(entry.detailVerifiedAt, now);
      // Match the collector's ordered hydration even when a later partition supersedes an exclusion.
      if (entries.has(id)) summary.duplicates++;
      entries.set(id, {
        metadata: entry.metadataVerifiedAt, detail: validDetail ? entry.detailVerifiedAt : null,
        hasDetailFields: entry.detail != null || entry.detailVerifiedAt != null,
        withdrawn: entry.exclusionReason === 'not-public' && validTimestamp(entry.excludedAt, now)
      });
    }
  }

  for (const entry of entries.values()) {
    if (entry.withdrawn) { summary.withdrawn++; continue; }
    summary.active++;
    const metadataExpired = countAge(summary.metadata, entry.metadata, now.getTime());
    let detailExpired = false;
    if (entry.detail) detailExpired = countAge(summary.detail, entry.detail, now.getTime());
    else if (entry.hasDetailFields) summary.invalidDetail++;
    else summary.noDetail++;
    const oldest = entry.detail && entry.detail < entry.metadata ? entry.detail : entry.metadata;
    countAge(summary.effective, oldest, now.getTime());
    if (metadataExpired && detailExpired) summary.expiredBy.both++;
    else if (metadataExpired) summary.expiredBy.metadataOnly++;
    else if (detailExpired) summary.expiredBy.detailOnly++;
  }
  return summary;
}

if (require.main === module) {
  summarizeRegionSourceAge(path.join(__dirname, '..', '.cache', 'ris-sources'))
    .then(summary => console.log(JSON.stringify(summary, null, 2)))
    .catch(error => {
      console.error([MISSING, INVALID].includes(error.message) ? error.message : 'Could not read regional source checkpoints.');
      process.exitCode = 1;
    });
}

module.exports = { summarizeRegionSourceAge };
