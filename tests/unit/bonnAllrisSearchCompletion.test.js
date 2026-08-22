'use strict';

const provider = require('../../server/political-context/providers/bonnAllrisProvider.js');
const {
  fallbackSearchStatus,
  normalizeProviderMeta,
} = require('../../server/political-context/services/portalSearchService.js');

function unavailableOparl() {
  const error = new Error('OParl returned HTML.');
  error.code = 'OPARL_INVALID_JSON';
  throw error;
}

describe('bonnAllrisProvider – completed-search evidence', () => {
  test('does not promote an empty legacy array to a completed zero-result search', () => {
    const fallback = fallbackSearchStatus([]);
    expect(fallback).toBe('incomplete');
    expect(normalizeProviderMeta({}, fallback).searchStatus).toBe('incomplete');
    expect(normalizeProviderMeta({ status: 'searched-no-results' }, fallback).searchStatus)
      .toBe('searched-no-results');
    expect(fallbackSearchStatus([{ title: 'Amtlicher Treffer' }])).toBe('results-found');
  });

  test('distinguishes a plain ALLRIS search form from explicit zero-result evidence', () => {
    expect(provider.indicatesCompletedSearch(
      '<html><h1>Volltext</h1><label>eines dieser Wörter enthalten:</label><input></html>'
    )).toBe(false);
    expect(provider.indicatesCompletedSearch('<html><p>Keine Treffer</p></html>')).toBe(true);
    expect(provider.indicatesCompletedSearch('<html><p>Treffer: 0</p></html>')).toBe(true);
  });

  test('continues to the legacy source when the modern URL only returns its search form', async () => {
    const fetchHtmlImpl = jest.fn(async url => {
      if (url.startsWith('https://www.bonn.sitzung-online.de/')) {
        return '<html><h1>Volltext</h1><label>eines dieser Wörter enthalten:</label><input></html>';
      }
      return [
        '<table><tr>',
        '<td><a href="vo020.asp?VOLFDNR=123">Radverkehr in der Adenauerallee verbessern</a></td>',
        '<td>Antrag</td><td>01.06.2026</td><td>Ausschuss für Mobilität und Verkehr</td>',
        '</tr></table>',
      ].join('');
    });

    const out = await provider.search({
      searchTerms: ['Adenauerallee'],
      searchOparlImpl: unavailableOparl,
      fetchHtmlImpl,
    });

    expect(fetchHtmlImpl).toHaveBeenCalledTimes(2);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({
      title: expect.stringContaining('Adenauerallee'),
      url: 'https://www2.bonn.de/bo_ris/ws_buergerinfo/vo020.asp?VOLFDNR=123',
    });
    expect(out.meta.queryLog).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'bonn-sitzung-online', status: 'incomplete', count: 0 }),
      expect.objectContaining({ source: 'bonn-legacy-buergerinfo', status: 'results-found', count: 1 }),
    ]));
    expect(out.meta.warnings.join(' ')).toMatch(/nur die Suchmaske/);
  });

  test('fails closed when both HTML URLs only return an unexecuted search form', async () => {
    await expect(provider.search({
      searchTerms: ['Adenauerallee'],
      searchOparlImpl: unavailableOparl,
      fetchHtmlImpl: async () => '<html><h1>Volltext</h1><input></html>',
    })).rejects.toMatchObject({
      code: 'POLITICAL_PROVIDER_UNAVAILABLE',
      providerKey: 'bonn-allris',
    });
  });
});
