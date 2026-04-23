'use strict';

/**
 * Unit tests for server/ai/aiAssessmentService.js
 */

// We require the service directly – the provider (geminiProvider) will be
// mocked so no real HTTP calls are made.
jest.mock('../../server/ai/providers/geminiProvider.js', () => ({
  callGemini: jest.fn()
}));

const { callGemini } = require('../../server/ai/providers/geminiProvider.js');
const {
  runAssessment,
  isAvailable,
  buildAiInput,
  validateOutput
} = require('../../server/ai/aiAssessmentService.js');

// ── Hilfsdaten ─────────────────────────────────────────────────────────────────

const VALID_STRUCTURED = {
  meta: {
    city: 'Hannover',
    areaName: 'Testbereich',
    date: '01.01.2025',
    link: 'http://localhost/',
    filters: { severity: 'all', roadCondition: 'all' },
    gremium: { name: 'Bezirksrat Mitte', typ: 'Bezirksrat' },
    involvementMode: 'or'
  },
  severity: {
    total: 12,
    bySev: { '1': 1, '2': 3, '3': 8, other: 0 }
  },
  deviations: {
    focus: [
      { mask: 5, label: '🚲+🚗', localCount: 5, baselineCount: 2, relativeDiff: 150 }
    ],
    rows: []
  },
  yearTable: [
    { year: 2021, total: 4 },
    { year: 2022, total: 5 },
    { year: 2023, total: 3 }
  ],
  patterns: ['Radunfall-Häufung'],
  poi: {
    withinByType: { Schule: 1 },
    nearByType: { Kindergarten: 2 },
    totalWithin: 1,
    totalNear: 2
  },
  references: [{ title: 'Nahverkehrsplan 2022' }]
};

const VALID_OUTPUT = {
  summary: 'Im Testbereich sind 12 Unfälle dokumentiert.',
  assessment: 'Der Bereich ist auffällig.',
  hypotheses: ['beobachtet: Rad-PKW-Konflikte', 'plausibel: Sichtbehinderungen'],
  measures: ['Schutzstreifen anlegen', 'Sichtbeziehungen verbessern'],
  openPoints: ['Ortsbegehung erforderlich'],
  formulations: {
    sachverhalt: 'Im markierten Bereich ...',
    bewertung: 'Der Bereich ist ...',
    beschlussvorschlag: 'Der Bezirksrat bittet ...',
    pruefauftrag: 'Die Verwaltung wird gebeten ...'
  }
};

// ── validateOutput ─────────────────────────────────────────────────────────────

describe('validateOutput', () => {
  test('valid output passes validation', () => {
    const result = validateOutput(VALID_OUTPUT);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('missing required fields are reported', () => {
    const { valid, errors } = validateOutput({ summary: 'x', assessment: 'y' });
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('hypotheses'))).toBe(true);
    expect(errors.some(e => e.includes('measures'))).toBe(true);
    expect(errors.some(e => e.includes('openPoints'))).toBe(true);
  });

  test('null input fails validation', () => {
    const { valid, errors } = validateOutput(null);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  test('array input fails validation', () => {
    const { valid } = validateOutput([]);
    expect(valid).toBe(false);
  });

  test('wrong type for string field is reported', () => {
    const { valid, errors } = validateOutput({ ...VALID_OUTPUT, summary: 42 });
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('summary'))).toBe(true);
  });

  test('wrong type for array field is reported', () => {
    const { valid, errors } = validateOutput({ ...VALID_OUTPUT, measures: 'not an array' });
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('measures'))).toBe(true);
  });

  test('formulations can be absent', () => {
    const { summary, assessment, hypotheses, measures, openPoints } = VALID_OUTPUT;
    const { valid } = validateOutput({ summary, assessment, hypotheses, measures, openPoints });
    expect(valid).toBe(true);
  });
});

// ── buildAiInput ───────────────────────────────────────────────────────────────

describe('buildAiInput', () => {
  test('produces expected top-level keys', () => {
    const input = buildAiInput(VALID_STRUCTURED);
    expect(input).toHaveProperty('meta');
    expect(input).toHaveProperty('filters');
    expect(input).toHaveProperty('statistics');
    expect(input).toHaveProperty('poi');
    expect(input).toHaveProperty('references');
    expect(input).toHaveProperty('contextHints');
  });

  test('meta contains city and areaName', () => {
    const { meta } = buildAiInput(VALID_STRUCTURED);
    expect(meta.city).toBe('Hannover');
    expect(meta.areaName).toBe('Testbereich');
    expect(meta.gremium.name).toBe('Bezirksrat Mitte');
  });

  test('statistics totalAccidents matches severity.total', () => {
    const { statistics } = buildAiInput(VALID_STRUCTURED);
    expect(statistics.totalAccidents).toBe(12);
  });

  test('poi summary is correctly derived', () => {
    const { poi } = buildAiInput(VALID_STRUCTURED);
    expect(poi.totalWithin).toBe(1);
    expect(poi.totalNear).toBe(2);
    expect(poi.withinArea).toContain('Schule');
    expect(poi.nearArea).toContain('Kindergarten');
  });

  test('references are mapped to title strings', () => {
    const { references } = buildAiInput(VALID_STRUCTURED);
    expect(references).toContain('Nahverkehrsplan 2022');
  });

  test('contextHints are passed through', () => {
    const hints = { knownHazards: ['Schienenquerung'], notes: ['spitzer Winkel'] };
    const { contextHints } = buildAiInput(VALID_STRUCTURED, hints);
    expect(contextHints.knownHazards).toContain('Schienenquerung');
    expect(contextHints.notes).toContain('spitzer Winkel');
  });

  test('handles missing optional fields gracefully', () => {
    const minimal = { meta: { city: 'Berlin' }, severity: { total: 0 } };
    expect(() => buildAiInput(minimal)).not.toThrow();
    const { poi } = buildAiInput(minimal);
    expect(poi).toBeNull();
  });

  test('deviations limited to 10 entries', () => {
    const manyDeviations = Array.from({ length: 20 }, (_, i) => ({
      mask: i + 1, label: `mask${i}`, localCount: i, baselineCount: 0
    }));
    const structured = { ...VALID_STRUCTURED, deviations: { focus: manyDeviations } };
    const { statistics } = buildAiInput(structured);
    expect(statistics.deviations.length).toBeLessThanOrEqual(10);
  });
});

// ── isAvailable ────────────────────────────────────────────────────────────────

describe('isAvailable', () => {
  const originalKey = process.env.GEMINI_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });

  test('returns false when GEMINI_API_KEY is absent', () => {
    delete process.env.GEMINI_API_KEY;
    expect(isAvailable()).toBe(false);
  });

  test('returns true when GEMINI_API_KEY is set', () => {
    process.env.GEMINI_API_KEY = 'test-key-123';
    expect(isAvailable()).toBe(true);
  });
});

// ── runAssessment ──────────────────────────────────────────────────────────────

describe('runAssessment', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  test('returns validated output on success', async () => {
    callGemini.mockResolvedValueOnce(JSON.stringify(VALID_OUTPUT));

    const result = await runAssessment(VALID_STRUCTURED);
    expect(result.summary).toBe(VALID_OUTPUT.summary);
    expect(result.hypotheses).toEqual(VALID_OUTPUT.hypotheses);
    expect(callGemini).toHaveBeenCalledTimes(1);
  });

  test('strips markdown code fences from response', async () => {
    const fenced = '```json\n' + JSON.stringify(VALID_OUTPUT) + '\n```';
    callGemini.mockResolvedValueOnce(fenced);

    const result = await runAssessment(VALID_STRUCTURED);
    expect(result.summary).toBe(VALID_OUTPUT.summary);
  });

  test('throws on invalid JSON from provider', async () => {
    callGemini.mockResolvedValueOnce('not valid json {');

    await expect(runAssessment(VALID_STRUCTURED)).rejects.toThrow();
  });

  test('throws when required fields are missing in response', async () => {
    const incomplete = { summary: 'ok', assessment: 'ok' };
    callGemini.mockResolvedValueOnce(JSON.stringify(incomplete));

    await expect(runAssessment(VALID_STRUCTURED)).rejects.toThrow(/Schema/i);
  });

  test('throws when provider throws', async () => {
    callGemini.mockRejectedValueOnce(new Error('Network timeout'));

    await expect(runAssessment(VALID_STRUCTURED)).rejects.toThrow('Network timeout');
  });

  test('passes contextHints to provider via prompt', async () => {
    callGemini.mockResolvedValueOnce(JSON.stringify(VALID_OUTPUT));

    const hints = { knownHazards: ['rutschige Gleise'], notes: [] };
    await runAssessment(VALID_STRUCTURED, hints);

    const [, userPrompt] = callGemini.mock.calls[0];
    expect(userPrompt).toContain('rutschige Gleise');
  });
});
