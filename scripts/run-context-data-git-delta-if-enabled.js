'use strict';

const { reviewContextDataGitDelta } = require('./review-context-data-git-delta');

function enabled(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || ''));
}

if (!enabled(process.env.CONTEXT_REVIEW_GIT_DELTA)) {
  console.log('[context-data-git-delta] skipped; automatic Git mutation is not enabled.');
} else {
  try {
    reviewContextDataGitDelta();
  } catch (error) {
    console.error('[context-data-git-delta] FAILED:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({ enabled });
