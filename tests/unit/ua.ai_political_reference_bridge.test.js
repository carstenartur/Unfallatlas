/** @jest-environment jsdom */
'use strict';

describe('UA.aiPoliticalReferenceBridge', () => {
  function installWith({ ctx, state, report }) {
    jest.resetModules();
    const originalCompute = jest.fn(async () => JSON.parse(JSON.stringify(report)));
    window.UA = {
      getRuntimeContext: () => ctx,
      aiPoliticalEvidence: {
        currentState: () => state,
        _internal: {
          isSuitableForAutomaticHandoff: ref =>
            ref?.aiGating?.allowed !== false
            && ref?.trafficCategory !== 'non_traffic'
            && ref?.isTrafficRelevant !== false,
        },
      },
      computeExportReport: originalCompute,
    };
    require('../../js/ua.ai_political_reference_bridge.js');
    return originalCompute;
  }

  afterEach(() => {
    delete window.UA;
    jest.restoreAllMocks();
  });

  test('copies suitable political proceedings into structured.references for the server AI', async () => {
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
    installWith({
      ctx,
      state,
      report: {
        text: 'Bericht',
        structured: {
          references: [{ title: 'ERA', type: 'Regelwerk', url: 'https://example.test/era' }],
          politicalReferences: [],
        },
      },
    });

    const result = await window.UA.computeExportReport(ctx);

    expect(result.structured.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'ERA' }),
      expect.objectContaining({ title: 'Beschluss Adenauerallee', source: 'bonn-allris' }),
    ]));
    expect(result.structured.politicalReferences).toEqual([
      expect.objectContaining({ title: 'Beschluss Adenauerallee' }),
    ]);
    expect(result.structured.politicalContextResearch).toBe(state);
  });

  test('inserts an explicit blocking status instead of silently passing an empty references array', async () => {
    const ctx = { __uaPoliticalResearchPromise: Promise.resolve() };
    const state = {
      status: 'failed',
      references: [],
      officialPortalUrl: 'https://www.bonn.sitzung-online.de/public/',
      providerKey: 'bonn-allris',
      message: 'Die konfigurierte politische Portalsuche ist fehlgeschlagen.',
      qaInstruction: 'Vor Einreichung ist eine nachvollziehbare amtliche Recherche erforderlich.',
    };
    installWith({
      ctx,
      state,
      report: { text: 'Bericht', structured: { references: [] } },
    });

    const result = await window.UA.computeExportReport(ctx);
    const statusRef = result.structured.references[0];

    expect(statusRef.title).toMatch(/Politische Recherche unvollständig.*failed/i);
    expect(statusRef.title).toMatch(/nicht als fehlende Vorbefassung interpretieren/i);
    expect(statusRef.url).toBe('https://www.bonn.sitzung-online.de/public/');
    expect(statusRef.reason).toMatch(/Vor Einreichung/i);
  });

  test('does not alter normal reports outside an AI political-research workflow', async () => {
    const ctx = {};
    const state = { status: 'not-searched', references: [] };
    installWith({
      ctx,
      state,
      report: { text: 'Technischer Export', structured: { references: [] } },
    });

    const result = await window.UA.computeExportReport(ctx);

    expect(result.structured.references).toEqual([]);
    expect(result.structured.politicalContextResearch).toBeUndefined();
  });
});
