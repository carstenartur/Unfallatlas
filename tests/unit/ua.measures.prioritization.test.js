/**
 * Unit tests for UA.measures.classifyTimeHorizon and
 * UA.measures.buildPrioritization (Goldstandard-Sektion 8 –
 * Priorisierung Kurz / Mittel / Lang).
 *
 * Regel: Oberer Monatswert aus „X–Y Monate" entscheidet.
 *   Y ≤ 3   → "kurzfristig"
 *   Y ≤ 12  → "mittelfristig"
 *   Y > 12  → "langfristig"
 *   parsing fail / leer → "unbekannt"
 */

describe('UA.measures.classifyTimeHorizon', () => {
  let UA;

  beforeAll(() => {
    window.UA = {};
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.resolve(__dirname, '../../js/ua.measures.js'), 'utf8');
    eval(src);
    UA = window.UA;
  });

  afterAll(() => {
    delete window.UA;
  });

  test.each([
    ['1–3 Monate', 'kurzfristig'],
    ['1-3 Monate', 'kurzfristig'],   // ASCII Bindestrich
    ['1—3 Monate', 'kurzfristig'],   // Geviertstrich
    ['3 Monate', 'kurzfristig'],     // Einzelwert
    ['3–6 Monate', 'mittelfristig'],
    ['3–9 Monate', 'mittelfristig'],
    ['6–12 Monate', 'mittelfristig'],
    ['3–12 Monate', 'mittelfristig'],
    ['6–18 Monate', 'langfristig'],
    ['12–24 Monate', 'langfristig'],
    ['18–36 Monate', 'langfristig'],
  ])('%s → %s', (leadTime, expected) => {
    expect(UA.measures.classifyTimeHorizon(leadTime)).toBe(expected);
  });

  test('boundary: upper=3 → kurzfristig (inclusive)', () => {
    expect(UA.measures.classifyTimeHorizon('1–3 Monate')).toBe('kurzfristig');
  });

  test('boundary: upper=12 → mittelfristig (inclusive)', () => {
    expect(UA.measures.classifyTimeHorizon('6–12 Monate')).toBe('mittelfristig');
  });

  test('boundary: upper=13 → langfristig', () => {
    expect(UA.measures.classifyTimeHorizon('1–13 Monate')).toBe('langfristig');
  });

  test.each([
    [null, 'unbekannt'],
    [undefined, 'unbekannt'],
    ['', 'unbekannt'],
    ['   ', 'unbekannt'],
    ['demnächst', 'unbekannt'],
    ['—', 'unbekannt'],
    [42, 'unbekannt'],         // non-string
  ])('%p → unbekannt (defensive)', (input, expected) => {
    expect(UA.measures.classifyTimeHorizon(input)).toBe(expected);
  });
});

describe('UA.measures.buildPrioritization', () => {
  let UA;

  beforeAll(() => {
    window.UA = {};
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.resolve(__dirname, '../../js/ua.measures.js'), 'utf8');
    eval(src);
    UA = window.UA;
  });

  afterAll(() => {
    delete window.UA;
  });

  function makeRm(measures) {
    return { measures: measures.map(m => ({ measure: m, score: 1, matchedPatterns: [] })) };
  }

  test('returns empty buckets + meta.totals.all=0 for null / empty input', () => {
    const r1 = UA.measures.buildPrioritization(null);
    expect(r1.kurzfristig).toEqual([]);
    expect(r1.mittelfristig).toEqual([]);
    expect(r1.langfristig).toEqual([]);
    expect(r1.unbekannt).toEqual([]);
    expect(r1.meta.totals.all).toBe(0);

    const r2 = UA.measures.buildPrioritization({ measures: [] });
    expect(r2.meta.totals.all).toBe(0);
  });

  test('buckets measures by leadTime upper bound', () => {
    const rm = makeRm([
      { id: 'a', label: 'Sicht freischneiden', leadTime: '1–3 Monate' },
      { id: 'b', label: 'Querungshilfe',       leadTime: '3–9 Monate' },
      { id: 'c', label: 'Knotenpunktumbau',    leadTime: '18–36 Monate' },
      { id: 'd', label: 'Tempo 30',            leadTime: '1–3 Monate' },
      { id: 'e', label: 'Mittelinsel',         leadTime: '6–18 Monate' },
    ]);
    const r = UA.measures.buildPrioritization(rm);
    expect(r.kurzfristig.map(x => x.id)).toEqual(['a', 'd']);
    expect(r.mittelfristig.map(x => x.id)).toEqual(['b']);
    expect(r.langfristig.map(x => x.id)).toEqual(['c', 'e']);
    expect(r.meta.totals).toEqual({
      kurzfristig: 2, mittelfristig: 1, langfristig: 2, unbekannt: 0, all: 5
    });
  });

  test('preserves input order inside each bucket (no re-sorting)', () => {
    const rm = makeRm([
      { id: 'first',  label: 'Erst',  leadTime: '1–3 Monate' },
      { id: 'second', label: 'Zweit', leadTime: '1–3 Monate' },
      { id: 'third',  label: 'Dritt', leadTime: '1–3 Monate' },
    ]);
    const r = UA.measures.buildPrioritization(rm);
    expect(r.kurzfristig.map(x => x.id)).toEqual(['first', 'second', 'third']);
  });

  test('routes unparsable leadTime to "unbekannt"', () => {
    const rm = makeRm([
      { id: 'x', label: 'Vage', leadTime: 'demnächst' },
      { id: 'y', label: 'Leer', leadTime: '' },
    ]);
    const r = UA.measures.buildPrioritization(rm);
    expect(r.unbekannt.map(x => x.id)).toEqual(['x', 'y']);
    expect(r.kurzfristig).toEqual([]);
  });

  test('each entry exposes id, label, leadTime, horizon, and original entry', () => {
    const m = { id: 'tempo_30', label: 'Tempo 30', leadTime: '1–3 Monate' };
    const rm = makeRm([m]);
    const r = UA.measures.buildPrioritization(rm);
    expect(r.kurzfristig[0]).toEqual({
      id: 'tempo_30',
      label: 'Tempo 30',
      leadTime: '1–3 Monate',
      horizon: 'kurzfristig',
      entry: { measure: m, score: 1, matchedPatterns: [] }
    });
  });

  test('TIME_HORIZON_KEYS exposes the canonical bucket names', () => {
    expect(UA.measures.TIME_HORIZON_KEYS).toEqual(
      ['kurzfristig', 'mittelfristig', 'langfristig', 'unbekannt']
    );
  });
});
