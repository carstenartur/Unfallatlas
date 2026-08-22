'use strict';

const baseProvider = require('./bonnAllrisProvider.js');
const { searchCachedOparl } = require('./bonnOparlCachedSearch.js');

/**
 * Production wrapper for Bonn. The existing provider keeps all structured
 * OParl → guarded modern portal → historical portal fallback semantics; only
 * its preferred OParl search function is replaced with the shared catalogue
 * snapshot implementation. Explicit test/custom injections still win.
 */
async function search(params = {}) {
  return baseProvider.search({
    ...params,
    searchOparlImpl: params.searchOparlImpl || searchCachedOparl,
  });
}

module.exports = {
  ...baseProvider,
  search,
  _baseProvider: baseProvider,
};
