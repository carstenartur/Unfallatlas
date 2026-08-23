/** @jest-environment jsdom */
'use strict';

describe('UA.aiPoliticalReferenceBridge reference containers', () => {
  afterEach(() => {
    delete window.UA;
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('preserves the canonical reference-document object while adding political evidence', async () => {
    const ctx = { __uaPoliticalResearchPromise: Promise.resolve() };
    const state = {
      status: 'results-found',
      references: [{
        title: 'Beschluss Adenauerallee',
        type: 'Beschluss',
        url: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=2028269',
        source: 'bonn-allris',
        trafficCategory: 'direct_traffic',
        isTrafficRelevant: true,
        aiGating: { allowed: true, reason: 'Orts- und Verkehrsbezug belegt.' },
      }],
    };
    window.UA = {
      getRuntimeContext: () => ctx,
      aiPoliticalEvidence: {
        currentState: () => state,
        _internal: { isSuitableForAutomaticHandoff: () => true },
      },
      computeExportReport: async () => ({
        text: 'Bericht',
        html: '<p>Bericht</p>',
        structured: {
          references: {
            schemaVersion: 'unfallwerkbank.referenceDocuments.v1',
            source: 'global-and-city-files',
            documents: [{
              title: 'ERA',
              author: 'FGSV',
              type: 'Regelwerk',
              url: 'https://example.test/era',
              description: 'Bestehendes Referenzdokument',
            }],
          },
          politicalReferences: [],
        },
      }),
    };

    require('../../js/ua.ai_political_reference_bridge.js');
    const result = await window.UA.computeExportReport(ctx);

    expect(Array.isArray(result.structured.references)).toBe(false);
    expect(result.structured.references).toEqual(expect.objectContaining({
      schemaVersion: 'unfallwerkbank.referenceDocuments.v1',
      source: 'global-and-city-files',
    }));
    expect(result.structured.references.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'ERA',
        author: 'FGSV',
        description: 'Bestehendes Referenzdokument',
      }),
      expect.objectContaining({
        title: 'Beschluss Adenauerallee',
        source: 'bonn-allris',
      }),
    ]));
    expect(result.structured.politicalReferences).toEqual([
      expect.objectContaining({ title: 'Beschluss Adenauerallee' }),
    ]);
  });
});
