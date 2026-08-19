'use strict';

const fs = require('fs');
const path = require('path');

function loadSchema() {
  return JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../schemas/ai-investigation-result.schema.json'),
    'utf8'
  ));
}

describe('AI investigation result schema contract', () => {
  test('publishes the same reproducible political-research contract as the local gate', () => {
    const schema = loadSchema();
    const political = schema.properties.politicalAdministrativeResearch;

    expect(political.required).toEqual(expect.arrayContaining([
      'status', 'queries', 'proceedings', 'projects',
    ]));
    expect(political.properties.queries).toMatchObject({
      type: 'array',
      minItems: 1,
      items: { $ref: '#/$defs/politicalQuery' },
    });
    expect(schema.$defs.politicalQuery.allOf).toHaveLength(2);
    expect(schema.$defs.linkedPoliticalEvidence.required).toContain('sourceUrl');
    expect(schema.$defs.linkedPoliticalEvidence.properties.sourceUrl.pattern)
      .toBe('^https?://');

    const completedResearchRule = political.allOf[0];
    expect(completedResearchRule.if.properties.status.enum).toEqual([
      'results-found', 'completed', 'complete',
    ]);
    expect(completedResearchRule.then.anyOf).toEqual([
      {
        required: ['proceedings'],
        properties: { proceedings: { minItems: 1 } },
      },
      {
        required: ['projects'],
        properties: { projects: { minItems: 1 } },
      },
    ]);
  });

  test('requires non-empty unique references in evidence-bearing result sections', () => {
    const schema = loadSchema();
    const mapRefs = schema.properties.mapObservations.items.properties.evidenceRefs;
    const insightRefs = schema.properties.crossLayerInsights.items.properties.evidenceRefs;
    const measureRefs = schema.properties.candidateMeasures.items.properties.findingRefs;

    expect(mapRefs).toMatchObject({ minItems: 1, uniqueItems: true });
    expect(insightRefs).toMatchObject({ minItems: 2, uniqueItems: true });
    expect(measureRefs).toMatchObject({ minItems: 1, uniqueItems: true });
  });
});
