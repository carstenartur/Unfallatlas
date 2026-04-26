/**
 * #E1: deriveFeatures + prompt builder propagate the Stufe-1 enrichments
 * (`structured.yearlyTrend`, `structured.osmContext`) to the LLM prompt.
 */

const { deriveFeatures } = require('../../server/ai/features/deriveFeatures');
const { buildPrompt }    = require('../../server/ai/prompts/exportAssessmentPrompt.v2');

function baseStructured(extra) {
  return Object.assign({
    meta: { city: 'Hannover', date: '2026-04-26', bounds: '...', areaName: 'Test', filters: {} },
    severity: { total: 50, bySev: { '1': 0, '2': 5, '3': 45 } },
    deviations: { local: { total: 50 }, baseline: { total: 1000 }, rows: [] },
    yearTable: [
      { year: 2018, total: 8 }, { year: 2019, total: 9 },
      { year: 2020, total: 10 }, { year: 2021, total: 11 }, { year: 2022, total: 12 }
    ]
  }, extra);
}

describe('#E1 — deriveFeatures pass-through of Stufe-1 enrichments', () => {
  test('exposes osmContext and yearlyTrend on the features object', () => {
    const f = deriveFeatures(baseStructured({
      yearlyTrend: { classification: 'rising', slope: 1.0, rSquared: 0.99, nYears: 5, mean: 10, firstYear: 2018, lastYear: 2022 },
      osmContext: { summary: { dominantMaxspeed: 50, speedSampleSize: 4, cycleInfraWays: 1, cycleInfraShare: 0.25, trafficSignals: 1, crossings: 0, wayCount: 4, avgLanes: null, avgWidthMeters: null, lanesSampleSize: 0, widthSampleSize: 0 }, source: { publisher: 'OSM', license: 'ODbL', url: '', retrievedVia: 'Overpass API' } }
    }), null);
    expect(f.yearlyTrend).toBeTruthy();
    expect(f.yearlyTrend.classification).toBe('rising');
    expect(f.osmContext).toBeTruthy();
    expect(f.osmContext.summary.dominantMaxspeed).toBe(50);
  });

  test('omits the fields when not provided in structured (back-compat)', () => {
    const f = deriveFeatures(baseStructured({}), null);
    expect(f.yearlyTrend).toBeNull();
    expect(f.osmContext).toBeNull();
  });
});

describe('#E1 — buildPrompt renders new sections', () => {
  function aiInput(extra) {
    const structured = baseStructured(extra);
    const features = deriveFeatures(structured, null);
    return {
      meta: structured.meta,
      features,
      preselectedMeasures: []
    };
  }

  test('appends the OSM-KONTEXT section when osmContext is present', () => {
    const { user } = buildPrompt(aiInput({
      osmContext: { summary: { dominantMaxspeed: 30, speedSampleSize: 6, cycleInfraWays: 0, cycleInfraShare: 0, trafficSignals: 2, crossings: 1, wayCount: 6, avgLanes: 2.0, avgWidthMeters: 7.5, lanesSampleSize: 4, widthSampleSize: 2 }, source: {} }
    }), 'proposal-brief');
    expect(user).toContain('=== OSM-KONTEXT ===');
    expect(user).toContain('Vorherrschendes Tempolimit: 30 km/h');
    expect(user).toContain('Keine separaten Radverkehrsanlagen erkannt');
    expect(user).toContain('Signalisierte Knoten: 2');
    expect(user).toContain('Markierte Querungen: 1');
    expect(user).toContain('Ø Fahrstreifen: 2.0');
    expect(user).toContain('Ø Fahrbahnbreite: 7.5 m');
  });

  test('appends the regression-classification line when yearlyTrend is present', () => {
    const { user } = buildPrompt(aiInput({
      yearlyTrend: { classification: 'rising', slope: 1.0, rSquared: 0.99, nYears: 5, mean: 10, firstYear: 2018, lastYear: 2022 }
    }), 'assessment');
    expect(user).toMatch(/Klassifikation \(lineare Regression\): rising/);
    expect(user).toMatch(/R²=0\.99/);
  });

  test('does NOT add the OSM section when osmContext.summary is missing (e.g. error stub)', () => {
    const { user } = buildPrompt(aiInput({
      osmContext: { quality: { error: 'HTTP 504' } }
    }), 'assessment');
    expect(user).not.toContain('=== OSM-KONTEXT ===');
  });

  test('does NOT add the regression line when yearlyTrend.classification is "insufficient_data"', () => {
    const { user } = buildPrompt(aiInput({
      yearlyTrend: { classification: 'insufficient_data', slope: 0, rSquared: 0, nYears: 1 }
    }), 'assessment');
    expect(user).not.toMatch(/Klassifikation \(lineare Regression\)/);
  });
});
