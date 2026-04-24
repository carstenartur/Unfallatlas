'use strict';

/**
 * Unit-Tests für die neuen Betriebsreife-Helfer:
 *   - server/lib/capabilities.js
 *   - server/lib/errors.js
 *   - server/lib/keyValueStore.js
 *   - server/political-context/services/portalSearchCache.js
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ── capabilities ──────────────────────────────────────────────────────────────

describe('capabilities', () => {
  // Save & restore relevant env vars per test
  const ORIG = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    AI_PROVIDER:    process.env.AI_PROVIDER
  };
  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_PROVIDER;
    jest.resetModules();
  });
  afterAll(() => {
    if (ORIG.GEMINI_API_KEY !== undefined) process.env.GEMINI_API_KEY = ORIG.GEMINI_API_KEY;
    if (ORIG.AI_PROVIDER    !== undefined) process.env.AI_PROVIDER    = ORIG.AI_PROVIDER;
  });

  test('REASON_CODES sind eingefroren und enthalten erwartete Schlüssel', () => {
    const { REASON_CODES } = require('../../server/lib/capabilities.js');
    expect(Object.isFrozen(REASON_CODES)).toBe(true);
    expect(REASON_CODES.OK).toBe('ok');
    expect(REASON_CODES.MISSING_API_KEY).toBe('missing_api_key');
    expect(REASON_CODES.PROVIDER_DISABLED).toBe('provider_disabled');
    expect(REASON_CODES.SERVER_ONLY_FEATURE).toBe('server_only_feature');
    expect(REASON_CODES.NOT_CONFIGURED).toBe('not_configured');
  });

  test('aiAssessmentV1: ohne Key → unavailable + missing_api_key', () => {
    const { aiAssessmentV1 } = require('../../server/lib/capabilities.js');
    const cap = aiAssessmentV1();
    expect(cap.available).toBe(false);
    expect(cap.reasonCode).toBe('missing_api_key');
    expect(cap.reason).toMatch(/GEMINI_API_KEY/);
  });

  test('aiAssessmentV1: mit Key → available + ok', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const { aiAssessmentV1 } = require('../../server/lib/capabilities.js');
    const cap = aiAssessmentV1();
    expect(cap.available).toBe(true);
    expect(cap.reasonCode).toBe('ok');
  });

  test('aiAssessmentV2: ohne Key → available=true (Fallback) + reason=missing_api_key + aiCallEnabled=false', () => {
    const { aiAssessmentV2 } = require('../../server/lib/capabilities.js');
    const cap = aiAssessmentV2();
    expect(cap.available).toBe(true); // Fallback ist gültiger Output
    expect(cap.reasonCode).toBe('missing_api_key');
    expect(cap.details.aiCallEnabled).toBe(false);
    expect(cap.details.fallback).toBe(true);
  });

  test('aiAssessmentV2: mit Key → available + ok + aiCallEnabled=true', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const { aiAssessmentV2 } = require('../../server/lib/capabilities.js');
    const cap = aiAssessmentV2();
    expect(cap.available).toBe(true);
    expect(cap.reasonCode).toBe('ok');
    expect(cap.details.aiCallEnabled).toBe(true);
  });

  test('aiAssessmentV2: AI_PROVIDER=null deaktiviert KI-Calls (provider_disabled)', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.AI_PROVIDER    = 'null';
    const { aiAssessmentV2 } = require('../../server/lib/capabilities.js');
    const cap = aiAssessmentV2();
    expect(cap.available).toBe(true);
    expect(cap.reasonCode).toBe('provider_disabled');
    expect(cap.details.aiCallEnabled).toBe(false);
  });

  test('politicalContext: registry liefert Städteliste → ok', () => {
    const { politicalContext } = require('../../server/lib/capabilities.js');
    const cap = politicalContext();
    expect(cap.available).toBe(true);
    expect(cap.reasonCode).toBe('ok');
    expect(Array.isArray(cap.details.cities)).toBe(true);
    expect(cap.details.cities.length).toBeGreaterThan(0);
  });

  test('videoExport: server_only_feature, available=true', () => {
    const { videoExport } = require('../../server/lib/capabilities.js');
    const cap = videoExport();
    expect(cap.available).toBe(true);
    expect(cap.reasonCode).toBe('server_only_feature');
    expect(cap.details.dockerRecommended).toBe(true);
  });

  test('getCapabilities: aggregiert alle vier Features', () => {
    const { getCapabilities } = require('../../server/lib/capabilities.js');
    const out = getCapabilities();
    expect(out.capabilities).toEqual(expect.objectContaining({
      aiAssessmentV1:   expect.objectContaining({ available: expect.any(Boolean), reasonCode: expect.any(String) }),
      aiAssessmentV2:   expect.objectContaining({ available: expect.any(Boolean), reasonCode: expect.any(String) }),
      politicalContext: expect.objectContaining({ available: expect.any(Boolean), reasonCode: expect.any(String) }),
      videoExport:      expect.objectContaining({ available: expect.any(Boolean), reasonCode: expect.any(String) })
    }));
  });
});

// ── errors ────────────────────────────────────────────────────────────────────

describe('errors – buildErrorBody / sendError / attachFallbackInfo', () => {
  const { CATEGORIES, buildErrorBody, sendError, attachFallbackInfo, DEFAULT_STATUS } =
    require('../../server/lib/errors.js');

  test('CATEGORIES enthält erwartete Werte', () => {
    expect(CATEGORIES.FEATURE_UNAVAILABLE).toBe('feature_unavailable');
    expect(CATEGORIES.UPSTREAM_ERROR).toBe('upstream_error');
    expect(CATEGORIES.INVALID_REQUEST).toBe('invalid_request');
    expect(CATEGORIES.INTERNAL_ERROR).toBe('internal_error');
    expect(CATEGORIES.RATE_LIMITED).toBe('rate_limited');
    expect(CATEGORIES.FALLBACK_RETURNED).toBe('fallback_returned');
  });

  test('DEFAULT_STATUS empfiehlt sinnvolle HTTP-Codes', () => {
    expect(DEFAULT_STATUS[CATEGORIES.FEATURE_UNAVAILABLE]).toBe(503);
    expect(DEFAULT_STATUS[CATEGORIES.INVALID_REQUEST]).toBe(400);
    expect(DEFAULT_STATUS[CATEGORIES.RATE_LIMITED]).toBe(429);
    expect(DEFAULT_STATUS[CATEGORIES.UPSTREAM_ERROR]).toBe(502);
    expect(DEFAULT_STATUS[CATEGORIES.INTERNAL_ERROR]).toBe(500);
    expect(DEFAULT_STATUS[CATEGORIES.FALLBACK_RETURNED]).toBe(200);
  });

  test('buildErrorBody enthält error/code/category', () => {
    const body = buildErrorBody({
      category: CATEGORIES.FEATURE_UNAVAILABLE,
      code:     'AI_NOT_CONFIGURED',
      message:  'KI nicht verfügbar'
    });
    expect(body).toEqual({
      error:    'KI nicht verfügbar',
      code:     'AI_NOT_CONFIGURED',
      category: 'feature_unavailable'
    });
  });

  test('buildErrorBody fällt unbekannte category auf internal_error zurück', () => {
    const body = buildErrorBody({ category: 'made_up', code: 'X', message: 'Y' });
    expect(body.category).toBe('internal_error');
  });

  test('buildErrorBody hängt details an, wenn vorhanden', () => {
    const body = buildErrorBody({
      category: CATEGORIES.UPSTREAM_ERROR,
      code:     'TIMEOUT',
      message:  'Provider antwortet nicht',
      details:  { upstream: 'gemini', ms: 30000 }
    });
    expect(body.details).toEqual({ upstream: 'gemini', ms: 30000 });
  });

  test('sendError verwendet DEFAULT_STATUS, wenn status fehlt', () => {
    const sent = { status: null, body: null };
    const fakeRes = {
      status(c) { sent.status = c; return this; },
      json(b)  { sent.body   = b; return this; }
    };
    sendError(fakeRes, {
      category: CATEGORIES.FEATURE_UNAVAILABLE,
      code:     'AI_NOT_CONFIGURED',
      message:  'X'
    });
    expect(sent.status).toBe(503);
    expect(sent.body.code).toBe('AI_NOT_CONFIGURED');
    expect(sent.body.category).toBe('feature_unavailable');
  });

  test('sendError respektiert expliziten status', () => {
    const sent = { status: null, body: null };
    const fakeRes = {
      status(c) { sent.status = c; return this; },
      json(b)  { sent.body   = b; return this; }
    };
    sendError(fakeRes, { status: 418, category: 'invalid_request', code: 'TEAPOT', message: 'X' });
    expect(sent.status).toBe(418);
  });

  test('attachFallbackInfo ergänzt fallback-Block, lässt Originalfelder unverändert', () => {
    const payload = { mode: 'assessment', source: 'fallback', result: { x: 1 } };
    const out = attachFallbackInfo(payload, {
      code:    'AI_FALLBACK_USED',
      message: 'Kein API-Key',
      details: { aiCallEnabled: false }
    });
    expect(out.mode).toBe('assessment');
    expect(out.source).toBe('fallback');
    expect(out.result).toEqual({ x: 1 });
    expect(out.fallback).toEqual({
      code:     'AI_FALLBACK_USED',
      message:  'Kein API-Key',
      category: 'fallback_returned',
      details:  { aiCallEnabled: false }
    });
  });

  test('attachFallbackInfo ohne details erzeugt keinen leeren details-Block', () => {
    const out = attachFallbackInfo({ a: 1 }, { code: 'C', message: 'M' });
    expect(out.fallback.details).toBeUndefined();
  });
});

// ── KeyValueStore ─────────────────────────────────────────────────────────────

describe('KeyValueStore', () => {
  const { KeyValueStore } = require('../../server/lib/keyValueStore.js');

  test('get/set/has/delete/size grundlegende Operationen', () => {
    const kv = new KeyValueStore({ ttlMs: 1000 });
    expect(kv.size()).toBe(0);
    kv.set('a', 1);
    kv.set('b', { x: 2 });
    expect(kv.size()).toBe(2);
    expect(kv.has('a')).toBe(true);
    expect(kv.get('b')).toEqual({ x: 2 });
    expect(kv.delete('a')).toBe(true);
    expect(kv.has('a')).toBe(false);
    expect(kv.delete('a')).toBe(false);
  });

  test('TTL: abgelaufener Eintrag wird verworfen', () => {
    const kv = new KeyValueStore({ ttlMs: 1 });
    kv.set('a', 1);
    return new Promise(resolve => setTimeout(() => {
      expect(kv.get('a')).toBeUndefined();
      expect(kv.has('a')).toBe(false);
      resolve();
    }, 5));
  });

  test('Per-Eintrag-TTL überschreibt Default', () => {
    const kv = new KeyValueStore({ ttlMs: 100000 });
    kv.set('short', 1, 1);
    return new Promise(resolve => setTimeout(() => {
      expect(kv.get('short')).toBeUndefined();
      resolve();
    }, 5));
  });

  test('LRU: ältester Eintrag wird verdrängt', () => {
    const kv = new KeyValueStore({ ttlMs: 60_000, max: 2 });
    kv.set('a', 1);
    kv.set('b', 2);
    kv.set('c', 3);
    expect(kv.has('a')).toBe(false);
    expect(kv.has('b')).toBe(true);
    expect(kv.has('c')).toBe(true);
  });

  test('keys()/clear()', () => {
    const kv = new KeyValueStore({ ttlMs: 60_000 });
    kv.set('a', 1); kv.set('b', 2);
    expect(kv.keys().sort()).toEqual(['a', 'b']);
    kv.clear();
    expect(kv.size()).toBe(0);
  });

  test('Disk-Persistenz: schreibt und lädt wieder', () => {
    const tmp = path.join(os.tmpdir(), `kv-${Date.now()}-${Math.random()}.json`);
    try {
      const kv1 = new KeyValueStore({ ttlMs: 60_000, persistPath: tmp, persistDebounceMs: 0 });
      kv1.set('hello', 'world');
      kv1.flushSync();
      expect(fs.existsSync(tmp)).toBe(true);

      const kv2 = new KeyValueStore({ ttlMs: 60_000, persistPath: tmp });
      expect(kv2.get('hello')).toBe('world');
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
  });

  test('Disk-Persistenz: korrupte Datei führt nicht zum Crash', () => {
    const tmp = path.join(os.tmpdir(), `kv-bad-${Date.now()}.json`);
    fs.writeFileSync(tmp, 'not valid json');
    try {
      const kv = new KeyValueStore({ persistPath: tmp });
      expect(kv.size()).toBe(0); // ignored corrupt content, started empty
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
  });
});

// ── portalSearchCache ─────────────────────────────────────────────────────────

describe('portalSearchCache – buildKey', () => {
  const { buildKey } = require('../../server/political-context/services/portalSearchCache.js');

  test('gleiche Eingabe → gleicher Key', () => {
    const k1 = buildKey({ city: 'Hannover', searchTerms: ['Limmer'], context: { gremium: 'X' }, maxResults: 10 });
    const k2 = buildKey({ city: 'Hannover', searchTerms: ['Limmer'], context: { gremium: 'X' }, maxResults: 10 });
    expect(k1).toBe(k2);
  });

  test('Reihenfolge der Suchbegriffe ist egal', () => {
    const k1 = buildKey({ city: 'Hannover', searchTerms: ['a', 'b'], context: {}, maxResults: 10 });
    const k2 = buildKey({ city: 'Hannover', searchTerms: ['b', 'a'], context: {}, maxResults: 10 });
    expect(k1).toBe(k2);
  });

  test('case-insensitiv', () => {
    const k1 = buildKey({ city: 'Hannover', searchTerms: ['Limmer'], context: {}, maxResults: 10 });
    const k2 = buildKey({ city: 'HANNOVER', searchTerms: ['limmer'], context: {}, maxResults: 10 });
    expect(k1).toBe(k2);
  });

  test('unterschiedliche maxResults → unterschiedlicher Key', () => {
    const k1 = buildKey({ city: 'Hannover', searchTerms: ['a'], context: {}, maxResults: 10 });
    const k2 = buildKey({ city: 'Hannover', searchTerms: ['a'], context: {}, maxResults: 5  });
    expect(k1).not.toBe(k2);
  });

  test('unterschiedlicher context → unterschiedlicher Key', () => {
    const k1 = buildKey({ city: 'Hannover', searchTerms: ['a'], context: { gremium: 'X' }, maxResults: 10 });
    const k2 = buildKey({ city: 'Hannover', searchTerms: ['a'], context: { gremium: 'Y' }, maxResults: 10 });
    expect(k1).not.toBe(k2);
  });

  test('liefert sha256-Hex (64 Zeichen)', () => {
    const k = buildKey({ city: 'Hannover', searchTerms: ['a'], context: {}, maxResults: 10 });
    expect(k).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ── portalSearchService – Cache-Integration ───────────────────────────────────

describe('portalSearchService – cache integration', () => {
  let registry;
  let search;
  let politicalSearchCache;

  beforeAll(() => {
    jest.doMock('../../server/political-context/registry/cityPortalRegistry.js', () => {
      const original = jest.requireActual('../../server/political-context/registry/cityPortalRegistry.js');
      return { ...original, getProviderForCity: jest.fn() };
    });
    registry            = require('../../server/political-context/registry/cityPortalRegistry.js');
    search              = require('../../server/political-context/services/portalSearchService.js').search;
    politicalSearchCache = require('../../server/political-context/services/portalSearchCache.js').sharedCache;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    politicalSearchCache.clear();
  });

  test('zweiter Aufruf mit identischer Eingabe wird aus dem Cache bedient (kein zweiter Provider-Call)', async () => {
    let providerCalls = 0;
    registry.getProviderForCity.mockReturnValue({
      _key: 'mock',
      search: async () => {
        providerCalls++;
        return [{ title: 'Antrag Radweg', url: 'https://x/1', rawType: 'antrag' }];
      }
    });
    const args = { city: 'Hannover', searchTerms: ['Limmer'], context: {}, maxResults: 5 };
    const a = await search(args);
    const b = await search(args);
    expect(providerCalls).toBe(1);
    expect(a.meta.cache.hit).toBe(false);
    expect(b.meta.cache.hit).toBe(true);
    expect(b.meta.cache.enabled).toBe(true);
    expect(typeof b.meta.cache.key).toBe('string');
    expect(b.references).toEqual(a.references);
  });

  test('useCache:false umgeht den Cache (zweimal Provider-Call)', async () => {
    let providerCalls = 0;
    registry.getProviderForCity.mockReturnValue({
      _key: 'mock',
      search: async () => { providerCalls++; return []; }
    });
    const args = { city: 'Hannover', searchTerms: ['Limmer'], useCache: false };
    await search(args);
    await search(args);
    expect(providerCalls).toBe(2);
  });

  test('unterschiedliche maxResults teilen den Cache nicht', async () => {
    let providerCalls = 0;
    registry.getProviderForCity.mockReturnValue({
      _key: 'mock',
      search: async () => { providerCalls++; return []; }
    });
    await search({ city: 'Hannover', searchTerms: ['x'], maxResults: 10 });
    await search({ city: 'Hannover', searchTerms: ['x'], maxResults: 5  });
    expect(providerCalls).toBe(2);
  });

  test('unsupported city: meta.cache liefert hit=false und enabled gemäß useCache', async () => {
    registry.getProviderForCity.mockReturnValue(null);
    const out = await search({ city: 'Musterstadt', searchTerms: ['x'] });
    expect(out.meta.supported).toBe(false);
    expect(out.meta.cache).toEqual({ hit: false, enabled: true });
  });
});
