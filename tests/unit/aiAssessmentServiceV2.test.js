'use strict';

/**
 * Tests for v2 AI assessment pipeline:
 *  - deriveFeatures
 *  - preselectMeasures
 *  - aiAssessmentCache (key building, TTL, LRU)
 *  - aiJobQueue (sequencing)
 *  - exportAssessmentPrompt.v2 (prompt builder)
 *  - aiAssessmentServiceV2 (input building, schema validation, parsing recovery,
 *    cache integration, fallback path)
 */

const { deriveFeatures }    = require('../../server/ai/features/deriveFeatures.js');
const { preselectMeasures } = require('../../server/ai/scoring/preselectMeasures.js');
const { MEASURE_CATALOG, MEASURE_BY_ID } = require('../../server/ai/catalog/measureCatalog.js');
const { AiAssessmentCache, canonicalize } = require('../../server/ai/cache/aiAssessmentCache.js');
const { AiJobQueue }        = require('../../server/ai/jobs/aiJobQueue.js');
const { buildPrompt, PROMPT_VERSION } = require('../../server/ai/prompts/exportAssessmentPrompt.v2.js');
const v2 = require('../../server/ai/aiAssessmentServiceV2.js');

// ── Sample data ────────────────────────────────────────────────────────────────

const STRUCTURED_FIXTURE = {
  meta: {
    city: 'Hannover',
    areaName: 'Testbereich Mitte',
    date: '01.01.2025',
    link: 'http://localhost/?city=Hannover',
    filters: { severity: 'all', roadCondition: 'all' },
    gremium: { name: 'Bezirksrat Mitte', typ: 'Bezirksrat' },
    involvementMode: 'or'
  },
  severity: {
    total: 25,
    bySev: { '1': 1, '2': 6, '3': 18, other: 0 }
  },
  deviations: {
    focus: [
      { mask: 5, label: '🚲+🚗', localCount: 9, baselineCount: 3, relativeDiff: 2.0 },
      { mask: 1, label: '🚲',     localCount: 5, baselineCount: 4, relativeDiff: 0.25 }
    ],
    rows: []
  },
  yearTable: [
    { year: 2020, total: 4 },
    { year: 2021, total: 4 },
    { year: 2022, total: 7 },
    { year: 2023, total: 10 }
  ],
  patterns: ['Radunfall-Häufung'],
  poi: {
    withinByType: { Schule: 1 },
    nearByType:   { Kindergarten: 2, Haltestelle: 1 },
    totalWithin: 1,
    totalNear:   3
  },
  references: [{ title: 'Nahverkehrsplan 2022', type: 'plan' }],
  crossTable: {
    rows: [
      { mask: 5,  label: '🚲+🚗', sev1: 0, sev2: 3, sev3: 6, total: 9 },
      { mask: 1,  label: '🚲',     sev1: 0, sev2: 1, sev3: 4, total: 5 },
      { mask: 4,  label: '🚗',     sev1: 1, sev2: 2, sev3: 7, total: 10 },
      { mask: 17, label: '🚲+🚛',  sev1: 0, sev2: 0, sev3: 1, total: 1 }
    ],
    totals: { sev1: 1, sev2: 6, sev3: 18, total: 25 }
  },
  accidentDetails: {
    rows: Array.from({ length: 8 }, (_, i) => ({
      year: 2022, sevLabel: 'leicht', involved: 'Rad+PKW',
      hour: 16, lat: 52.375 + i * 0.0001, lon: 9.730 + i * 0.0001
    })),
    total: 8,
    truncated: false
  }
};

const CONTEXT_HINTS_FIXTURE = {
  knownHazards:  ['Schienenquerung im spitzen Winkel'],
  surfaceHints:  ['Kopfsteinpflaster bei Nässe rutschig'],
  locationHints: ['nahe Grundschule'],
  notes:         ['Abendlicher Berufsverkehr aufgefallen']
};

// ── deriveFeatures ─────────────────────────────────────────────────────────────

describe('deriveFeatures', () => {
  test('produces top-level keys', () => {
    const f = deriveFeatures(STRUCTURED_FIXTURE);
    expect(f).toHaveProperty('counts');
    expect(f).toHaveProperty('ksiShare');
    expect(f).toHaveProperty('involvement');
    expect(f).toHaveProperty('dominantPatterns');
    expect(f).toHaveProperty('trend');
    expect(f).toHaveProperty('spatialDensity');
    expect(f).toHaveProperty('tags');
    expect(f).toHaveProperty('normalizedHints');
    expect(f).toHaveProperty('poiSummary');
    expect(f).toHaveProperty('references');
  });

  test('counts and KSI share are correct', () => {
    const f = deriveFeatures(STRUCTURED_FIXTURE);
    expect(f.counts.total).toBe(25);
    expect(f.counts.fatal).toBe(1);
    expect(f.counts.serious).toBe(6);
    expect(f.counts.slight).toBe(18);
    // (1+6)/25 = 0.28
    expect(f.ksiShare).toBeCloseTo(0.28, 2);
  });

  test('involvement shares are computed from crossTable', () => {
    const f = deriveFeatures(STRUCTURED_FIXTURE);
    expect(f.involvement.bike).toBeGreaterThan(0);
    expect(f.involvement.car).toBeGreaterThan(0);
    expect(f.involvement).toHaveProperty('sampleSize');
  });

  test('dominantPatterns sorted by relativeDiff descending', () => {
    const f = deriveFeatures(STRUCTURED_FIXTURE);
    expect(f.dominantPatterns.length).toBeGreaterThan(0);
    const first = f.dominantPatterns[0];
    expect(first.localCount).toBe(9);
    expect(first.label).toContain('🚗');
  });

  test('trend over years: rising', () => {
    const f = deriveFeatures(STRUCTURED_FIXTURE);
    expect(f.trend.direction).toBe('rising');
    expect(f.trend.firstYear).toBe(2020);
    expect(f.trend.lastYear).toBe(2023);
  });

  test('trend with single year is "unknown"', () => {
    const f = deriveFeatures({ ...STRUCTURED_FIXTURE, yearTable: [{ year: 2023, total: 5 }] });
    expect(f.trend.direction).toBe('unknown');
  });

  test('tags include bike_car when bike share high enough', () => {
    const f = deriveFeatures(STRUCTURED_FIXTURE);
    // Many bike-involved rows in crossTable
    expect(f.tags).toEqual(expect.arrayContaining(['bike_car']));
  });

  test('tags include school_zone via POI', () => {
    const f = deriveFeatures(STRUCTURED_FIXTURE);
    expect(f.tags).toEqual(expect.arrayContaining(['school_zone']));
  });

  test('contextHints add surface and rail tags', () => {
    const f = deriveFeatures(STRUCTURED_FIXTURE, CONTEXT_HINTS_FIXTURE);
    expect(f.tags).toEqual(expect.arrayContaining(['surface', 'rail']));
  });

  test('contextHints normalization caps length and trims', () => {
    const huge = Array.from({ length: 20 }, (_, i) => 'x'.repeat(300) + i);
    const f = deriveFeatures(STRUCTURED_FIXTURE, { knownHazards: huge });
    // capped to <=10 entries, each <=200 chars filtered out (300>200) -> all dropped
    expect(f.normalizedHints.knownHazards.length).toBe(0);
  });

  test('contextHints normalization keeps valid-length entries and trims whitespace', () => {
    const f = deriveFeatures(STRUCTURED_FIXTURE, {
      knownHazards: ['  Glatter Belag bei Nässe  ', '', '   ', 'Sichtbehinderung'],
      surfaceHints: Array.from({ length: 15 }, (_, i) => `hint ${i}`)
    });
    expect(f.normalizedHints.knownHazards).toEqual(['Glatter Belag bei Nässe', 'Sichtbehinderung']);
    // capped at 10 entries
    expect(f.normalizedHints.surfaceHints.length).toBe(10);
    expect(f.normalizedHints.surfaceHints[0]).toBe('hint 0');
  });

  test('handles missing optional fields without throwing', () => {
    expect(() => deriveFeatures({ meta: {}, severity: {} })).not.toThrow();
  });

  test('spatialDensity reports "tight_cluster" for tightly packed coords', () => {
    const tight = {
      ...STRUCTURED_FIXTURE,
      accidentDetails: {
        rows: Array.from({ length: 6 }, () => ({ lat: 52.3750, lon: 9.7300 })),
        total: 6, truncated: false
      }
    };
    const f = deriveFeatures(tight);
    expect(f.spatialDensity.hint).toBe('tight_cluster');
  });
});

// ── preselectMeasures ─────────────────────────────────────────────────────────

describe('preselectMeasures', () => {
  test('returns at most "max" entries', () => {
    const out = preselectMeasures(['bike_car'], { max: 4 });
    expect(out.length).toBeLessThanOrEqual(4);
  });

  test('selects measures that match tags', () => {
    const out = preselectMeasures(['bike_car', 'junction']);
    const ids = out.map(m => m.id);
    expect(ids).toEqual(expect.arrayContaining(['qw_marking_bike_lane']));
  });

  test('always appends monitoring measure', () => {
    const out = preselectMeasures(['ped_car']);
    expect(out.some(m => m.category === 'monitoring')).toBe(true);
  });

  test('falls back to generic measures when no tags match', () => {
    const out = preselectMeasures([]);
    expect(out.length).toBeGreaterThan(0);
    // Should at least include monitoring + an organizational/quickWin measure
    expect(out.some(m => m.category === 'organizational' || m.id === 'qw_sight_clearance')).toBe(true);
  });

  test('school_zone tag selects school-route measure', () => {
    const out = preselectMeasures(['school_zone', 'ped_car']);
    expect(out.some(m => m.id === 'inf_school_route')).toBe(true);
  });

  test('higher score (more matching tags) ranks higher', () => {
    const out = preselectMeasures(['bike_car', 'bike_truck', 'bike_alone', 'junction']);
    const idxProtected = out.findIndex(m => m.id === 'inf_protected_bike_lane');
    const idxMonitoring = out.findIndex(m => m.id === 'mon_followup');
    // Monitoring is appended last
    expect(idxMonitoring).toBe(out.length - 1);
    expect(idxProtected).toBeGreaterThanOrEqual(0);
    expect(idxProtected).toBeLessThan(idxMonitoring);
  });

  test('reserves only one monitoring slot and never produces negative slice', () => {
    // With a tiny max (1) the result must still respect the cap and not crash.
    const tiny = preselectMeasures(['bike_car', 'junction'], { max: 1 });
    expect(tiny.length).toBeLessThanOrEqual(1);

    // With a normal max, monitoring appears at most once and at the end.
    const out = preselectMeasures(['bike_car', 'junction'], { max: 6 });
    const monitoringCount = out.filter(m => m.category === 'monitoring').length;
    expect(monitoringCount).toBeLessThanOrEqual(1);
    if (monitoringCount === 1) {
      expect(out[out.length - 1].category).toBe('monitoring');
    }
    expect(out.length).toBeLessThanOrEqual(6);
  });
});

// ── aiAssessmentCache ─────────────────────────────────────────────────────────

describe('AiAssessmentCache', () => {
  test('canonicalize sorts object keys deterministically', () => {
    const a = canonicalize({ b: 2, a: 1, c: { y: 2, x: 1 } });
    expect(JSON.stringify(a)).toBe('{"a":1,"b":2,"c":{"x":1,"y":2}}');
  });

  test('canonicalize drops undefined', () => {
    const a = canonicalize({ a: 1, b: undefined });
    expect(JSON.stringify(a)).toBe('{"a":1}');
  });

  test('buildKey is stable across reorderings', () => {
    const k1 = AiAssessmentCache.buildKey({
      input: { b: 2, a: 1 }, promptVersion: 'v', model: 'm', mode: 'assessment'
    });
    const k2 = AiAssessmentCache.buildKey({
      input: { a: 1, b: 2 }, promptVersion: 'v', model: 'm', mode: 'assessment'
    });
    expect(k1).toBe(k2);
  });

  test('different mode → different key', () => {
    const k1 = AiAssessmentCache.buildKey({ input: { a: 1 }, promptVersion: 'v', model: 'm', mode: 'assessment' });
    const k2 = AiAssessmentCache.buildKey({ input: { a: 1 }, promptVersion: 'v', model: 'm', mode: 'proposal-brief' });
    expect(k1).not.toBe(k2);
  });

  test('different model → different key', () => {
    const k1 = AiAssessmentCache.buildKey({ input: { a: 1 }, promptVersion: 'v', model: 'm1', mode: 'assessment' });
    const k2 = AiAssessmentCache.buildKey({ input: { a: 1 }, promptVersion: 'v', model: 'm2', mode: 'assessment' });
    expect(k1).not.toBe(k2);
  });

  test('get/set/has work and respect TTL', async () => {
    const cache = new AiAssessmentCache({ ttlMs: 30 });
    cache.set('k1', { x: 1 });
    expect(cache.has('k1')).toBe(true);
    expect(cache.get('k1')).toEqual({ x: 1 });
    await new Promise(r => setTimeout(r, 50));
    expect(cache.has('k1')).toBe(false);
    expect(cache.get('k1')).toBeUndefined();
  });

  test('LRU eviction at max size', () => {
    const cache = new AiAssessmentCache({ max: 3 });
    cache.set('a', 1); cache.set('b', 2); cache.set('c', 3);
    expect(cache.size()).toBe(3);
    cache.set('d', 4); // evicts 'a' (oldest)
    expect(cache.has('a')).toBe(false);
    expect(cache.has('d')).toBe(true);
  });

  test('get refreshes LRU order', () => {
    const cache = new AiAssessmentCache({ max: 3 });
    cache.set('a', 1); cache.set('b', 2); cache.set('c', 3);
    cache.get('a'); // refresh a
    cache.set('d', 4); // should evict 'b' (oldest after refresh)
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });
});

// ── AiJobQueue ────────────────────────────────────────────────────────────────

describe('AiJobQueue', () => {
  test('enqueue resolves work in order with concurrency=1', async () => {
    const q = new AiJobQueue({ concurrency: 1 });
    const order = [];
    await Promise.all([
      q.enqueue(async () => { await new Promise(r => setTimeout(r, 20)); order.push('a'); }),
      q.enqueue(async () => { order.push('b'); }),
      q.enqueue(async () => { order.push('c'); })
    ]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  test('rejected work surfaces error to caller', async () => {
    const q = new AiJobQueue();
    await expect(q.enqueue(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });

  test('stats reports active and pending', async () => {
    const q = new AiJobQueue({ concurrency: 1 });
    let release;
    const p1 = q.enqueue(() => new Promise(r => { release = r; }));
    const p2 = q.enqueue(async () => 'done');
    await new Promise(r => setTimeout(r, 5));
    const stats = q.stats();
    expect(stats.active).toBe(1);
    expect(stats.pending).toBe(1);
    release();
    await Promise.all([p1, p2]);
  });
});

// ── prompt builder v2 ─────────────────────────────────────────────────────────

describe('exportAssessmentPrompt.v2 buildPrompt', () => {
  function makeAiInput() {
    const features = deriveFeatures(STRUCTURED_FIXTURE, CONTEXT_HINTS_FIXTURE);
    const preselected = preselectMeasures(features.tags);
    return v2.buildAiInputV2(STRUCTURED_FIXTURE, features, preselected, CONTEXT_HINTS_FIXTURE);
  }

  test('PROMPT_VERSION is stable identifier', () => {
    expect(PROMPT_VERSION).toBe('exportAssessmentPrompt.v2.5');
  });

  test('assessment mode returns system+user strings', () => {
    const { system, user } = buildPrompt(makeAiInput(), 'assessment');
    expect(typeof system).toBe('string');
    expect(typeof user).toBe('string');
    expect(user).toContain('exportAssessment.v2');
    expect(user).toContain('Hannover');
    expect(user).toContain('MASSNAHMEN-VORAUSWAHL');
    expect(system).toContain('preselectedMeasures');
  });

  test('proposal-brief mode uses different system prompt', () => {
    const ai = makeAiInput();
    const a = buildPrompt(ai, 'assessment');
    const b = buildPrompt(ai, 'proposal-brief');
    expect(a.system).not.toBe(b.system);
    expect(b.user).toContain('proposalBrief.v1');
    expect(b.system).toContain('Maßnahmensteckbrief');
  });

  test('user prompt includes context hints when present', () => {
    const { user } = buildPrompt(makeAiInput(), 'assessment');
    expect(user).toContain('Kopfsteinpflaster');
    expect(user).toContain('Schienenquerung');
  });

  test('user prompt mentions involvement shares with percentages', () => {
    const { user } = buildPrompt(makeAiInput(), 'assessment');
    expect(user).toMatch(/Rad: \d+ %/);
  });

  test('user prompt marks orthophoto hints as visual/contextual with provenance', () => {
    const ai = makeAiInput();
    ai.features.visualContextHints = {
      sourceType: 'visual_context',
      source: { layerName: 'DOP20 Niedersachsen', provider: 'LGLN', mapModeLabel: 'Orthofoto' },
      hints: ['Sichtbarer Hinweis aus Orthofoto/Luftbild: Querungsbereich wirkt unübersichtlich.'],
      recommendation: 'Detailprüfung empfohlen (Vor-Ort-Begehung/Unfallkommission); Hinweis ist prüfbedürftig.'
    };
    const { user } = buildPrompt(ai, 'assessment');
    expect(user).toContain('=== VISUELLE HINWEISE (ORTHOFOTO/LUFTBILD) ===');
    expect(user).toContain('Provenienz: DOP20 Niedersachsen / LGLN');
    expect(user).toContain('Einordnung: visuelle Kontextbeobachtung, keine amtlich belegte Unfallursache.');
  });
});

// ── schema validation ─────────────────────────────────────────────────────────

describe('validateBySchema (v2 + proposal)', () => {
  function validV2() {
    return {
      schemaVersion: 'exportAssessment.v2',
      problemProfile: { headline: 'h', summary: 's' },
      evidence: [{ statement: 'e', source: 's' }],
      primaryRiskFactors: [{ factor: 'f', rationale: 'r', confidence: 'medium' }],
      secondaryRiskFactors: [],
      recommendedMeasures: [{
        id: 'qw_marking_bike_lane',
        title: 't', category: 'quickWin', whyThisFitsHere: 'w', expectedEffect: 'e',
        targetAccidentTypes: ['bike_car'], implementationEffort: 'low', costBand: 'low', confidence: 'medium'
      }],
      quickWins: ['qw_marking_bike_lane'],
      infrastructureMeasures: [],
      openChecks: ['Begehung'],
      confidence: { overall: 'medium', rationale: 'r' },
      dataGaps: ['x']
    };
  }

  test('valid v2 assessment passes', () => {
    const r = v2.validateAgainstMode(validV2(), 'assessment');
    expect(r.valid).toBe(true);
  });

  test('missing required field is reported', () => {
    const x = validV2();
    delete x.problemProfile;
    const r = v2.validateAgainstMode(x, 'assessment');
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/problemProfile/);
  });

  test('wrong enum value is reported', () => {
    const x = validV2();
    x.recommendedMeasures[0].category = 'bogus';
    const r = v2.validateAgainstMode(x, 'assessment');
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/category|enum/);
  });

  test('schemaVersion const is enforced', () => {
    const x = validV2();
    x.schemaVersion = 'wrong';
    const r = v2.validateAgainstMode(x, 'assessment');
    expect(r.valid).toBe(false);
  });

  test('proposal-brief schema validates', () => {
    const proposal = {
      schemaVersion: 'proposalBrief.v1',
      title: 't', shortVersion: 's', longVersion: 'l',
      sachverhalt: 'sa', begruendung: 'b', beschlussvorschlag: 'be', pruefauftrag: 'p',
      measureSummary: [{ title: 'm', category: 'quickWin', rationale: 'r' }],
      confidence: { overall: 'medium' },
      caveats: []
    };
    const r = v2.validateAgainstMode(proposal, 'proposal-brief');
    expect(r.valid).toBe(true);
  });
});

// ── parseJsonLoose ────────────────────────────────────────────────────────────

describe('parseJsonLoose', () => {
  test('parses plain JSON', () => {
    expect(v2.parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  test('strips ```json fences', () => {
    expect(v2.parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test('strips ``` fences without language', () => {
    expect(v2.parseJsonLoose('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test('extracts JSON object surrounded by prose', () => {
    const text = 'Hier ist die Antwort:\n{"a": 1, "b": [1,2]}\nViel Erfolg!';
    expect(v2.parseJsonLoose(text)).toEqual({ a: 1, b: [1, 2] });
  });

  test('handles strings with nested braces', () => {
    const text = 'Antwort: {"text": "Wert mit { } Klammern", "n": 42}';
    expect(v2.parseJsonLoose(text)).toEqual({ text: 'Wert mit { } Klammern', n: 42 });
  });

  test('throws when no object can be extracted', () => {
    expect(() => v2.parseJsonLoose('nichts')).toThrow();
  });
});

// ── runAssessmentV2 (with mocked provider) ────────────────────────────────────

describe('runAssessmentV2', () => {
  const originalKey = process.env.GEMINI_API_KEY;
  afterEach(() => {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  });

  function makeValidV2Output() {
    return {
      schemaVersion: 'exportAssessment.v2',
      problemProfile: { headline: 'H', summary: 'S' },
      evidence: [{ statement: 'e', source: 's' }],
      primaryRiskFactors: [{ factor: 'f', rationale: 'r', confidence: 'medium' }],
      secondaryRiskFactors: [],
      recommendedMeasures: [{
        id: 'qw_marking_bike_lane',
        title: 'override', category: 'quickWin', whyThisFitsHere: 'w', expectedEffect: 'e',
        targetAccidentTypes: ['bike_car'], implementationEffort: 'low', costBand: 'low', confidence: 'medium'
      }],
      quickWins: ['qw_marking_bike_lane'],
      infrastructureMeasures: [],
      openChecks: ['Ortsbegehung'],
      confidence: { overall: 'medium', rationale: 'r' },
      dataGaps: []
    };
  }

  test('uses fallback when no API key + withFallback:true', async () => {
    delete process.env.GEMINI_API_KEY;
    const cache = new AiAssessmentCache();
    const out = await v2.runAssessmentV2({
      structured: STRUCTURED_FIXTURE, mode: 'assessment',
      withFallback: true, cache,
      providerCall: jest.fn() // should not be called
    });
    expect(out.source).toBe('fallback');
    expect(out.result.schemaVersion).toBe('exportAssessment.v2');
    expect(Array.isArray(out.result.recommendedMeasures)).toBe(true);
  });

  test('throws NotConfiguredError when no API key + withFallback:false', async () => {
    delete process.env.GEMINI_API_KEY;
    await expect(v2.runAssessmentV2({
      structured: STRUCTURED_FIXTURE, withFallback: false,
      cache: new AiAssessmentCache(),
      providerCall: jest.fn()
    })).rejects.toThrow(/AI_NOT_CONFIGURED|nicht konfiguriert/);
  });

  test('successful AI call returns ai source and caches result', async () => {
    process.env.GEMINI_API_KEY = 'fake-test-key';
    const cache = new AiAssessmentCache();
    const providerCall = jest.fn().mockResolvedValue(JSON.stringify(makeValidV2Output()));

    const out = await v2.runAssessmentV2({
      structured: STRUCTURED_FIXTURE, mode: 'assessment', cache, providerCall
    });
    expect(out.source).toBe('ai');
    expect(providerCall).toHaveBeenCalledTimes(1);
    // Catalog harmonization keeps title from AI when provided
    expect(out.result.recommendedMeasures[0].title).toBe('override');

    // Second call → cache hit
    const out2 = await v2.runAssessmentV2({
      structured: STRUCTURED_FIXTURE, mode: 'assessment', cache, providerCall
    });
    expect(out2.source).toBe('cache');
    expect(providerCall).toHaveBeenCalledTimes(1);
  });

  test('repair attempt: invalid first response, valid second', async () => {
    process.env.GEMINI_API_KEY = 'fake-test-key';
    const cache = new AiAssessmentCache();
    const providerCall = jest.fn()
      .mockResolvedValueOnce(JSON.stringify({ summary: 'invalid: missing required' }))
      .mockResolvedValueOnce(JSON.stringify(makeValidV2Output()));
    const out = await v2.runAssessmentV2({
      structured: STRUCTURED_FIXTURE, mode: 'assessment', cache, providerCall
    });
    expect(out.source).toBe('ai-repaired');
    expect(providerCall).toHaveBeenCalledTimes(2);
  });

  test('falls back when repair attempt also fails (withFallback:true)', async () => {
    process.env.GEMINI_API_KEY = 'fake-test-key';
    const cache = new AiAssessmentCache();
    const providerCall = jest.fn().mockResolvedValue(JSON.stringify({ broken: true }));
    const out = await v2.runAssessmentV2({
      structured: STRUCTURED_FIXTURE, mode: 'assessment', cache, providerCall, withFallback: true
    });
    expect(out.source).toBe('fallback');
    expect(out.result.schemaVersion).toBe('exportAssessment.v2');
  });

  test('throws when repair fails and withFallback:false', async () => {
    process.env.GEMINI_API_KEY = 'fake-test-key';
    const cache = new AiAssessmentCache();
    const providerCall = jest.fn().mockResolvedValue(JSON.stringify({ broken: true }));
    await expect(v2.runAssessmentV2({
      structured: STRUCTURED_FIXTURE, mode: 'assessment', cache, providerCall, withFallback: false
    })).rejects.toThrow();
  });

  test('rejects unknown mode', async () => {
    await expect(v2.runAssessmentV2({
      structured: STRUCTURED_FIXTURE, mode: 'banana',
      cache: new AiAssessmentCache(), providerCall: jest.fn()
    })).rejects.toThrow(/mode/);
  });

  test('rejects missing structured', async () => {
    await expect(v2.runAssessmentV2({
      structured: null, cache: new AiAssessmentCache(), providerCall: jest.fn()
    })).rejects.toThrow();
  });

  test('proposal-brief mode validates against proposal schema', async () => {
    process.env.GEMINI_API_KEY = 'fake-test-key';
    const cache = new AiAssessmentCache();
    const proposal = {
      schemaVersion: 'proposalBrief.v1',
      title: 't', shortVersion: 's', longVersion: 'l',
      sachverhalt: 'sa', begruendung: 'b', beschlussvorschlag: 'be', pruefauftrag: 'p',
      measureSummary: [{ id: 'qw_marking_bike_lane', title: 'm', category: 'quickWin', rationale: 'r' }],
      confidence: { overall: 'medium' },
      caveats: []
    };
    const providerCall = jest.fn().mockResolvedValue(JSON.stringify(proposal));
    const out = await v2.runAssessmentV2({
      structured: STRUCTURED_FIXTURE, mode: 'proposal-brief', cache, providerCall
    });
    expect(out.source).toBe('ai');
    expect(out.result.schemaVersion).toBe('proposalBrief.v1');
  });
});

// ── deterministic fallback alone ──────────────────────────────────────────────

describe('buildDeterministicFallback', () => {
  test('produces valid v2 assessment', () => {
    const features = deriveFeatures(STRUCTURED_FIXTURE);
    const preselected = preselectMeasures(features.tags);
    const aiInput = v2.buildAiInputV2(STRUCTURED_FIXTURE, features, preselected, {});
    const out = v2.buildDeterministicFallback({ aiInput, mode: 'assessment' });
    const r = v2.validateAgainstMode(out, 'assessment');
    expect(r.valid).toBe(true);
  });

  test('produces valid proposal brief', () => {
    const features = deriveFeatures(STRUCTURED_FIXTURE);
    const preselected = preselectMeasures(features.tags);
    const aiInput = v2.buildAiInputV2(STRUCTURED_FIXTURE, features, preselected, {});
    const out = v2.buildDeterministicFallback({ aiInput, mode: 'proposal-brief' });
    const r = v2.validateAgainstMode(out, 'proposal-brief');
    expect(r.valid).toBe(true);
  });
});

// ── catalog sanity ────────────────────────────────────────────────────────────

describe('measureCatalog', () => {
  test('all entries have required fields', () => {
    for (const m of MEASURE_CATALOG) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.title).toBe('string');
      expect(['quickWin', 'infrastructure', 'organizational', 'monitoring']).toContain(m.category);
      expect(['low', 'medium', 'high']).toContain(m.implementationEffort);
      expect(['low', 'medium', 'high']).toContain(m.costBand);
      expect(Array.isArray(m.targetAccidentTypes)).toBe(true);
    }
  });

  test('ids are unique', () => {
    const ids = MEASURE_CATALOG.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('MEASURE_BY_ID lookup works', () => {
    expect(MEASURE_BY_ID['qw_marking_bike_lane']).toBeDefined();
  });
});
