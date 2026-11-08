/** @jest-environment node */
'use strict';

const { checkpointRetryFromEnv, validateCheckpointRetry } = require('../../scripts/ris-checkpoint-retry-options');
const { parseRefreshArguments } = require('../../scripts/refresh-ris-catalogues');
const KEY = 'ris-sources-v1-Linux-42502618892-1';

test('normal Pages mode keeps the existing refresh invocation', () => {
  expect(checkpointRetryFromEnv({})).toEqual([]);
  expect(checkpointRetryFromEnv({ PAGES_RIS_CHECKPOINT_RETRY: 'false', PAGES_RIS_MIN_RECORDS: '674' })).toEqual([]);
  expect(() => checkpointRetryFromEnv({ PAGES_RIS_CHECKPOINT_RETRY: '1' })).toThrow(/mode/i);
});

test('validates an exact cache hit and passes checkpoint retry as argument values', () => {
  const args = checkpointRetryFromEnv({ PAGES_RIS_CHECKPOINT_RETRY: 'true',
    PAGES_RIS_SOURCE_CACHE_KEY: KEY, PAGES_RIS_MIN_RECORDS: '674', PAGES_RIS_CACHE_HIT: 'true' });
  expect(parseRefreshArguments(args)).toEqual({ checkpointRetry: { city: 'hannover', sourceCacheKey: KEY, minimumRecords: 674 } });
});

test.each(['', 'false', 'TRUE'])('refuses a missing exact restored cache (%s)', cacheHit => {
  expect(() => checkpointRetryFromEnv({ PAGES_RIS_CHECKPOINT_RETRY: 'true',
    PAGES_RIS_SOURCE_CACHE_KEY: KEY, PAGES_RIS_MIN_RECORDS: '674', PAGES_RIS_CACHE_HIT: cacheHit })).toThrow(/exact.*cache/i);
});

test.each(['', 'prefix-', KEY + '\n', '$(touch /tmp/ris-retry-injection)', '../cache'])('rejects unsafe or non-exact cache key %j', sourceCacheKey => {
  expect(() => validateCheckpointRetry({ city: 'hannover', sourceCacheKey, minimumRecords: 674 })).toThrow(/cache key/i);
});

test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])('rejects invalid recovery minimum %s', minimumRecords => {
  expect(() => validateCheckpointRetry({ city: 'hannover', sourceCacheKey: KEY, minimumRecords })).toThrow(/minimum/i);
});

test('rejects another city, a nonzero work budget, and incomplete CLI recovery options', () => {
  expect(() => validateCheckpointRetry({ city: 'bonn', sourceCacheKey: KEY, minimumRecords: 674 })).toThrow(/Hannover/i);
  expect(() => parseRefreshArguments(['--checkpoint-retry', 'hannover', '--source-cache-key', KEY, '--min-records', '674', '--work-budget', '1'])).toThrow(/zero|0/);
  expect(() => parseRefreshArguments(['--checkpoint-retry', 'hannover'])).toThrow();
  expect(() => parseRefreshArguments(['--source-cache-key', KEY, '--min-records', '674'])).toThrow();
});
