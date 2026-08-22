'use strict';

const valueAdd = require('../../server/ai/proposalBriefValueAdd.js');
const { SYSTEM_URL: BONN_OPARL_SYSTEM_URL } =
  require('../../server/political-context/providers/bonnOparlClient.js');

function features() {
  return {
    counts: { total: 12, fatal: 0, serious: 2, slight: 10, other: 0 },
    analysisMethodology: {
      schemaVersion: 'unfallwerkbank.analysisMethodology.v1',
    },
  };
}

describe('proposal brief runtime political evidence bridge', () => {
  test('uses the same verified Bonn OParl system URL as the live provider', () => {
    expect(valueAdd.BONN_OPARL_SYSTEM_URL).toBe(BONN_OPARL_SYSTEM_URL);
    expect(valueAdd.BONN_OPARL_SYSTEM_URL)
      .toBe('https://www.bonn.sitzung-online.de/oparl/system');
  });

  test('converts the real browser searchTerms state into deterministic documented queries', () => {
    const structured = {
      meta: { city: 'Bonn', areaName: 'Adenauerallee' },
      severity: { total: 12, bySev: { '1': 0, '2': 2, '3': 10, other: 0 } },
      politicalContextResearch: {
        schemaVersion: 'unfallwerkbank.politicalContextResearch.v1',
        status: 'results-found',
        city: 'Bonn',
        providerKey: 'bonn-allris',
        searchTerms: ['Adenauerallee', 'Verkehrssicherheit'],
        officialPortalUrl: 'https://www.bonn.sitzung-online.de/public/',
        portalSearchUrls: [
          'https://www.bonn.sitzung-online.de/public/tr010?q=Adenauerallee',
          'https://www.bonn.sitzung-online.de/public/tr010?q=Verkehrssicherheit',
        ],
        references: [{
          title: 'Antrag zur Adenauerallee',
          type: 'Antrag',
          url: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=123',
          source: 'bonn-allris',
          aiGating: { allowed: true },
        }],
      },
    };

    const contracts = valueAdd.buildProposalEvidenceContracts(structured, features());
    const political = contracts.deterministicAnalysisDigest.politicalResearch;

    expect(political.status).toBe('results-found');
    expect(political.queries).toHaveLength(2);
    expect(political.queries[0]).toEqual({
      query: 'Adenauerallee',
      source: 'bonn-oparl+official-portal',
      sourceType: 'oparl-1.1-with-official-portal-fallback',
      url: valueAdd.BONN_OPARL_SYSTEM_URL,
    });
    expect(political.references).toEqual([
      expect.objectContaining({
        title: 'Antrag zur Adenauerallee',
        url: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=123',
      }),
    ]);
  });

  test('prefers an explicit provider query log over synthesized terms', () => {
    const queries = valueAdd.runtimeResearchQueries({
      status: 'results-found',
      searchTerms: ['synthesized'],
      queryLog: [{
        query: 'Adenauerallee',
        source: 'bonn-oparl',
        sourceType: 'oparl-1.1',
        url: valueAdd.BONN_OPARL_SYSTEM_URL,
        status: 'results-found',
      }],
    }, { city: 'Bonn' });

    expect(queries).toEqual([{
      query: 'Adenauerallee',
      source: 'bonn-oparl',
      sourceType: 'oparl-1.1',
      url: valueAdd.BONN_OPARL_SYSTEM_URL,
    }]);
  });

  test('does not promote references rejected by deterministic AI/traffic gating', () => {
    const bridged = valueAdd.bridgeRuntimePoliticalResearch({
      meta: { city: 'Bonn' },
      politicalContextResearch: {
        status: 'results-found-unusable',
        city: 'Bonn',
        providerKey: 'bonn-allris',
        searchTerms: ['Adenauerallee'],
        references: [{
          title: 'Unrelated item',
          url: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=999',
          aiGating: { allowed: false },
        }],
      },
    });

    expect(bridged.politicalReferences).toEqual([]);
    expect(bridged.politicalContextResearch.queries).toHaveLength(1);
    expect(bridged.politicalContextResearch.status).toBe('results-found-unusable');
  });

  test('preserves searched-no-results as conditional evidence rather than complete', () => {
    const evidence = valueAdd.politicalEvidence({
      status: 'conditional',
      searchTerms: ['Adenauerallee'],
      providerKey: 'bonn-allris',
      city: 'Bonn',
      evidenceRefs: [],
    });

    expect(evidence.status).toBe('conditional');
    expect(evidence.complete).toBe(false);
    expect(evidence.queries).toHaveLength(1);
  });
});
