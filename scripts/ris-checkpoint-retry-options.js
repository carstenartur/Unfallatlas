'use strict';

function validateCheckpointRetry(value) {
  if (!value || value.city !== 'hannover') throw new TypeError('Checkpoint recovery is limited to Hannover');
  const { sourceCacheKey, minimumRecords } = value;
  if (typeof sourceCacheKey !== 'string' || sourceCacheKey.length > 128 || /\s/.test(sourceCacheKey)
      || !/^ris-sources-v1-Linux-[1-9]\d*-[1-9]\d*$/.test(sourceCacheKey)) {
    throw new TypeError('Checkpoint recovery requires an exact RIS source cache key');
  }
  if (!Number.isSafeInteger(minimumRecords) || minimumRecords < 1) {
    throw new TypeError('Checkpoint recovery requires a positive safe integer minimum record count');
  }
  return { city: 'hannover', sourceCacheKey, minimumRecords };
}

function checkpointRetryFromEnv(env) {
  const enabled = env.PAGES_RIS_CHECKPOINT_RETRY;
  if (enabled === undefined || enabled === '' || enabled === 'false') return [];
  if (enabled !== 'true') throw new TypeError('Invalid Pages checkpoint recovery mode');
  if (env.PAGES_RIS_CACHE_HIT !== 'true') throw new Error('Checkpoint recovery requires an exact restored cache hit');
  const minimum = env.PAGES_RIS_MIN_RECORDS;
  if (typeof minimum !== 'string' || /\s/.test(minimum) || !/^[1-9]\d*$/.test(minimum)) {
    throw new TypeError('Invalid checkpoint recovery minimum record count');
  }
  const { sourceCacheKey, minimumRecords } = validateCheckpointRetry({ city: 'hannover',
    sourceCacheKey: env.PAGES_RIS_SOURCE_CACHE_KEY, minimumRecords: Number(minimum) });
  return ['--checkpoint-retry', 'hannover', '--source-cache-key', sourceCacheKey, '--min-records', String(minimumRecords)];
}

module.exports = { checkpointRetryFromEnv, validateCheckpointRetry };
