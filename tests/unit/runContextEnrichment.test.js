'use strict';

const enrichment = require('../../scripts/run-context-enrichment');

describe('context enrichment transient-provider fallback policy', () => {
  test.each([
    ['Overpass HTTP 429', 'overpass-rate-limit'],
    ['Overpass HTTP 504', 'overpass-server-error'],
    ['request failed with ECONNRESET', 'network-reset'],
    ['UND_ERR_CONNECT_TIMEOUT while fetching provider', 'network-timeout'],
    ['getaddrinfo EAI_AGAIN overpass.example', 'dns-temporary'],
    ['503 Service Unavailable', 'provider-temporary'],
  ])('classifies %s as a transient provider failure', (message, id) => {
    expect(enrichment.classifyProviderFailure(message)).toEqual(expect.objectContaining({
      transient: true,
      id,
    }));
  });

  test.each([
    ['Invalid accident GeoJSON for Bonn; Overpass HTTP 504', 'invalid-accident-input'],
    ['Producer preflight failed: fingerprint mismatch', 'producer-contract'],
    ['Staged context validation failed: tile index missing', 'staged-validation'],
    ['ReferenceError: producer bug', 'programming-error'],
    ['ENOSPC while writing staging output', 'local-resource'],
  ])('fails closed for non-transient evidence even when a provider code is present: %s', (message, id) => {
    expect(enrichment.classifyProviderFailure(message)).toEqual(expect.objectContaining({
      transient: false,
      id,
    }));
  });

  test('permits a stale fallback only for a validated existing city and explicit policy', () => {
    const allowed = enrichment.fallbackDecision({
      allowStaleOnTransient: true,
      failureText: '[context-generation] FAILED: Overpass HTTP 504',
      existingCity: { slug: 'leipzig', ok: true, problems: [] },
    });
    expect(allowed).toEqual(expect.objectContaining({
      allowed: true,
      reason: 'verified-stale-context',
    }));
  });

  test('denies fallback when scheduled tolerance is disabled', () => {
    expect(enrichment.fallbackDecision({
      allowStaleOnTransient: false,
      failureText: 'Overpass HTTP 504',
      existingCity: { slug: 'leipzig', ok: true },
    })).toEqual(expect.objectContaining({
      allowed: false,
      reason: 'fallback-disabled',
    }));
  });

  test('denies fallback when the existing city dataset is absent or invalid', () => {
    for (const existingCity of [null, { slug: 'leipzig', ok: false, problems: ['missing tile'] }]) {
      expect(enrichment.fallbackDecision({
        allowStaleOnTransient: true,
        failureText: 'Overpass HTTP 504',
        existingCity,
      })).toEqual(expect.objectContaining({
        allowed: false,
        reason: 'existing-context-invalid',
      }));
    }
  });

  test('denies fallback for an unclassified process failure', () => {
    expect(enrichment.fallbackDecision({
      allowStaleOnTransient: true,
      failureText: 'child process exited with status 1',
      existingCity: { slug: 'leipzig', ok: true },
    })).toEqual(expect.objectContaining({
      allowed: false,
      reason: 'non-transient-failure',
      classification: expect.objectContaining({ id: 'unclassified' }),
    }));
  });

  test('normalizes German city names consistently with public context paths', () => {
    expect(enrichment.citySlug('Düsseldorf')).toBe('duesseldorf');
    expect(enrichment.citySlug('Frankfurt am Main')).toBe('frankfurt_am_main');
  });
});
