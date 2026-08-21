#!/usr/bin/env node
'use strict';

/**
 * Production-near Bonn political-context smoke test.
 *
 * This is deliberately separate from deterministic unit tests: it verifies
 * that the official Bonn OParl endpoint can be traversed, that the structured
 * source is attempted before HTML fallbacks and that the public provider
 * returns direct, reproducible evidence links plus a query log.
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {
    output: 'out/qa/bonn-political-context-live.json',
    terms: ['Adenauerallee', 'Radverkehr'],
    attempts: 3,
    retryDelayMs: 2_000,
    requireResults: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output') out.output = argv[++i];
    else if (arg === '--terms') {
      out.terms = String(argv[++i] || '').split(',').map(value => value.trim()).filter(Boolean);
    } else if (arg === '--attempts') out.attempts = Number(argv[++i]);
    else if (arg === '--retry-delay-ms') out.retryDelayMs = Number(argv[++i]);
    else if (arg === '--allow-no-results') out.requireResults = false;
    else if (arg === '--require-results') out.requireResults = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'Usage: node scripts/qa-bonn-political-context-live.js [options]',
        '',
        '  --output FILE             Evidence JSON path',
        '  --terms A,B               Comma-separated search terms',
        '  --attempts N              Full-search attempts (default: 3)',
        '  --retry-delay-ms N        Base retry delay (default: 2000)',
        '  --require-results         Require at least one direct reference (default)',
        '  --allow-no-results        Accept a completed zero-result search',
        '',
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!out.terms.length) throw new Error('At least one search term is required.');
  if (!Number.isInteger(out.attempts) || out.attempts < 1 || out.attempts > 5) {
    throw new Error('--attempts must be an integer between 1 and 5.');
  }
  if (!Number.isFinite(out.retryDelayMs) || out.retryDelayMs < 0 || out.retryDelayMs > 30_000) {
    throw new Error('--retry-delay-ms must be between 0 and 30000.');
  }
  return out;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function absoluteHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch (_) {
    return '';
  }
}

function serializableError(error) {
  return {
    name: error && error.name || 'Error',
    code: error && error.code || null,
    message: String(error && error.message || error || 'Unknown error').slice(0, 500),
    attempts: Array.isArray(error && error.attempts) ? error.attempts : undefined,
  };
}

function assertLiveResult(result, options) {
  const meta = result && result.meta || {};
  const references = Array.isArray(result && result.references) ? result.references : [];
  const errors = [];

  if (meta.supported !== true) errors.push('Bonn provider is not reported as supported.');
  if (meta.providerKey !== 'bonn-allris') errors.push(`Unexpected providerKey: ${meta.providerKey}`);
  if (!['results-found', 'searched-no-results'].includes(meta.searchStatus)) {
    errors.push(`Search did not complete: ${meta.searchStatus || 'missing status'}`);
  }
  if (!Array.isArray(meta.queryLog) || meta.queryLog.length === 0) {
    errors.push('No reproducible queryLog was returned.');
  }
  const attempts = Array.isArray(meta.attempts) ? meta.attempts : [];
  const structuredAttempt = attempts.find(attempt => attempt && attempt.source === 'bonn-oparl');
  if (!structuredAttempt) {
    errors.push('The structured Bonn OParl source was not attempted.');
  } else if (!['results-found', 'searched-no-results', 'partial-results'].includes(structuredAttempt.status)) {
    errors.push(
      `The official Bonn OParl source did not yield a usable traversal: ${structuredAttempt.status || 'unknown'} `
      + `(${structuredAttempt.error?.message || 'no details'}).`
    );
  }
  if (options.requireResults && references.length === 0) {
    errors.push('The live terms returned no direct political references.');
  }
  const invalidReferences = references.filter(reference => {
    return !String(reference && reference.title || '').trim()
      || !absoluteHttpUrl(reference && reference.url);
  });
  if (invalidReferences.length) {
    errors.push(`${invalidReferences.length} reference(s) lack title or direct HTTP(S) URL.`);
  }
  if (references.length > 0 && !references.some(reference =>
    /bonn\.sitzung-online\.de/i.test(String(reference.url || ''))
  )) {
    errors.push('No result links back to the official Bonn council-information domain.');
  }

  return errors;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { search } = require('../server/political-context/services/portalSearchService.js');
  const evidence = {
    schemaVersion: 'unfallwerkbank.bonnPoliticalContextLiveQa.v1',
    startedAt: new Date().toISOString(),
    terms: options.terms,
    attempts: [],
    passed: false,
  };

  let lastError = null;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    const startedAt = new Date().toISOString();
    try {
      const result = await search({
        city: 'Bonn',
        searchTerms: options.terms,
        context: {
          location: 'Adenauerallee, Bonn',
          street: 'Adenauerallee',
        },
        maxResults: 20,
        expandVariants: false,
        useCache: false,
      });
      const validationErrors = assertLiveResult(result, options);
      evidence.attempts.push({
        attempt,
        startedAt,
        completedAt: new Date().toISOString(),
        result: {
          meta: result.meta,
          references: result.references.map(reference => ({
            title: reference.title,
            type: reference.type,
            date: reference.date,
            gremium: reference.gremium,
            number: reference.number,
            url: reference.url,
            source: reference.source,
            relevanceScore: reference.relevanceScore,
          })),
        },
        validationErrors,
      });
      if (validationErrors.length === 0) {
        evidence.passed = true;
        evidence.completedAt = new Date().toISOString();
        break;
      }
      lastError = new Error(validationErrors.join(' '));
    } catch (error) {
      lastError = error;
      evidence.attempts.push({
        attempt,
        startedAt,
        completedAt: new Date().toISOString(),
        error: serializableError(error),
      });
    }
    if (attempt < options.attempts) {
      await sleep(options.retryDelayMs * attempt);
    }
  }

  evidence.completedAt = evidence.completedAt || new Date().toISOString();
  if (!evidence.passed) evidence.finalError = serializableError(lastError);
  const output = path.resolve(options.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', 'utf8');

  if (!evidence.passed) {
    console.error(`[bonn-political-context-live] FAILED – evidence: ${output}`);
    console.error(evidence.finalError && evidence.finalError.message || 'Unknown failure');
    process.exitCode = 1;
    return;
  }

  const final = evidence.attempts[evidence.attempts.length - 1].result;
  console.log(
    `[bonn-political-context-live] PASS – ${final.references.length} direct reference(s), `
    + `${final.meta.pagesFetched || 0} structured page(s), source=${final.meta.sourceType || 'unknown'}`
  );
  console.log(`[bonn-political-context-live] evidence: ${output}`);
}

main().catch(error => {
  console.error('[bonn-political-context-live] fatal:', error);
  process.exitCode = 1;
});