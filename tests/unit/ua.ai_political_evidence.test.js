/**
 * Political-context research must be part of the AI evidence chain instead of
 * remaining an optional, manually selected side panel.
 *
 * @jest-environment jsdom
 */

describe('UA.aiPoliticalEvidence', () => {
  let ctx;
  let searchMock;
  let mirrorMock;
  let factsMock;
  let computeMock;

  function reference(overrides = {}) {
    return {
      title: 'Beschluss zur Neuordnung des Verkehrsversuchs Adenauerallee',
      type: 'Beschluss',
      date: '29.08.2024',
      gremium: 'Rat der Stadt Bonn',
      number: 'DS 240948',
      url: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=2028269',
      source: 'bonn-allris',
      referenceType: 'Beschluss',
      reason: 'Adenauerallee im Titel und direkter Verkehrsbezug.',
      trafficCategory: 'direct_traffic',
      trafficRelevanceScore: 95,
      isTrafficRelevant: true,
      aiGating: { allowed: true, reason: 'Orts- und Verkehrsbezug belegt.' },
      ...overrides,
    };
  }

  function searchResult(references) {
    return {
      references,
      meta: {
        city: 'Bonn',
        searchTerms: ['Bonn', 'Adenauerallee', 'Südstadt'],
        searchedAt: '2026-08-15T20:00:00.000Z',
        totalFound: references.length,
        providerKey: 'bonn-allris',
        supported: true,
      },
    };
  }

  function setup(searchImplementation) {
    jest.resetModules();
    ctx = {
      CITY_RAW: 'Bonn',
      locationHint: {
        street: 'Adenauerallee',
        district: 'Südstadt',
        label: 'Adenauerallee, Bonn-Südstadt',
      },
      ui: {},
      exportOptions: {},
    };
    searchMock = jest.fn(searchImplementation);
    mirrorMock = jest.fn();
    factsMock = jest.fn(input => ({
      schemaVersion: 'test-facts.v1',
      city: 'Bonn',
      structured: input.structured,
    }));
    computeMock = jest.fn(async () => ({
      text: 'Deterministischer Bericht für die Adenauerallee.',
      structured: { meta: { city: 'Bonn', areaName: 'Adenauerallee' } },
    }));

    window.UA = {
      getRuntimeContext: () => ctx,
      normKey: value => String(value || '').toLowerCase(),
      PoliticalContext: {
        buildSearchTerms: jest.fn(() => ['Bonn', 'Adenauerallee', 'Südstadt']),
        search: searchMock,
      },
      aiProposal: {
        _internal: {
          mirrorExportOptions: mirrorMock,
          buildExternalAiFactsPackage: factsMock,
        },
      },
      computeExportReport: computeMock,
    };

    require('../../js/ua.ai_political_evidence.js');
    return window.UA.aiPoliticalEvidence;
  }

  afterEach(() => {
    delete window.UA;
    jest.restoreAllMocks();
  });

  test('searches before report generation and carries suitable proceedings into AI facts', async () => {
    setup(async () => searchResult([reference()]));

    window.UA.aiProposal._internal.mirrorExportOptions(ctx);
    const report = await window.UA.computeExportReport(ctx);

    expect(mirrorMock).toHaveBeenCalledWith(ctx);
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0][0]).toMatchObject({
      city: 'Bonn',
      searchTerms: ['Bonn', 'Adenauerallee', 'Südstadt'],
      context: {
        location: 'Adenauerallee, Bonn-Südstadt',
        street: 'Adenauerallee',
        district: 'Südstadt',
      },
      maxResults: 15,
    });
    expect(computeMock).toHaveBeenCalledTimes(1);

    expect(ctx.politicalReferences).toHaveLength(1);
    expect(ctx.politicalReferences[0]).toMatchObject({
      title: expect.stringContaining('Adenauerallee'),
      source: 'bonn-allris',
      url: expect.stringContaining('bonn.sitzung-online.de'),
    });

    const state = report.structured.politicalContextResearch;
    expect(state.status).toBe('results-found');
    expect(state.usableReferenceCount).toBe(1);
    expect(state.automaticallyAdopted).toBe(true);
    expect(state.reviewRequired).toBe(true);
    expect(state.readyToFileBlocked).toBe(false);
    expect(state.officialPortalUrl).toBe('https://www.bonn.sitzung-online.de/public/');
    expect(state.portalSearchUrls.some(url => /tr010\?q=Adenauerallee/.test(url))).toBe(true);

    const facts = window.UA.aiProposal._internal.buildExternalAiFactsPackage({
      structured: report.structured,
    });
    expect(facts.politicalContextResearch.status).toBe('results-found');
    expect(facts.politicalContextQaRule.requiredAction)
      .toMatch(/amtlichen Portal.*Such-URLs.*bestehende Anträge.*Beschlüsse/i);
  });

  test('distinguishes a completed empty search from proof that no proceedings exist', async () => {
    setup(async () => searchResult([]));

    window.UA.aiProposal._internal.mirrorExportOptions(ctx);
    const report = await window.UA.computeExportReport(ctx);
    const state = report.structured.politicalContextResearch;

    expect(state.status).toBe('searched-no-results');
    expect(state.readyToFileBlocked).toBe(true);
    expect(state.message).toMatch(/kein Beweis.*keine politische Vorbefassung/i);
    expect(state.officialPortalUrl).toContain('bonn.sitzung-online.de');
    expect(state.portalSearchUrls.length).toBeGreaterThan(0);
    expect(ctx.politicalReferences).toBeUndefined();
  });

  test('records provider failures without suppressing the deterministic accident report', async () => {
    setup(async () => { throw new Error('Portal timeout'); });

    window.UA.aiProposal._internal.mirrorExportOptions(ctx);
    const report = await window.UA.computeExportReport(ctx);
    const state = report.structured.politicalContextResearch;

    expect(report.text).toContain('Deterministischer Bericht');
    expect(state.status).toBe('failed');
    expect(state.readyToFileBlocked).toBe(true);
    expect(state.details.error).toBe('Portal timeout');
    expect(state.searchTerms).toContain('Adenauerallee');
    expect(state.qaInstruction).toMatch(/Ratsinformationssystem.*nachvollziehbar/i);
  });

  test('does not auto-adopt non-traffic or explicitly gated-out portal hits', async () => {
    setup(async () => searchResult([
      reference({
        title: 'Kulturveranstaltung Adenauerallee',
        trafficCategory: 'non_traffic',
        isTrafficRelevant: false,
        aiGating: { allowed: false, reason: 'Kein belastbarer Verkehrsbezug.' },
      }),
    ]));

    window.UA.aiProposal._internal.mirrorExportOptions(ctx);
    const report = await window.UA.computeExportReport(ctx);
    const state = report.structured.politicalContextResearch;

    expect(state.status).toBe('results-found-unusable');
    expect(state.totalFound).toBe(1);
    expect(state.usableReferenceCount).toBe(0);
    expect(state.readyToFileBlocked).toBe(true);
    expect(ctx.politicalReferences).toBeUndefined();
  });

  test('marks an AI package without a preceding search as not-searched and blocking', () => {
    const api = setup(async () => searchResult([]));

    const state = api.currentState(ctx);

    expect(state.status).toBe('not-searched');
    expect(state.readyToFileBlocked).toBe(true);
    expect(state.message).toMatch(/keine politische Portalsuche dokumentiert/i);
  });
});
