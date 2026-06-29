'use strict';

const bonnProvider = require('../../server/political-context/providers/bonnAllrisProvider.js');

describe('bonnAllrisProvider – supportsCity', () => {
  test('gibt true für Bonn zurück', () => {
    expect(bonnProvider.supportsCity('Bonn')).toBe(true);
    expect(bonnProvider.supportsCity('bonn')).toBe(true);
  });

  test('gibt false für andere Städte zurück', () => {
    expect(bonnProvider.supportsCity('Köln')).toBe(false);
    expect(bonnProvider.supportsCity(null)).toBe(false);
  });
});

describe('bonnAllrisProvider – Sitzung Online URLs', () => {
  test('buildSearchUrl nutzt die neue zentrale Bonner Recherche', () => {
    expect(bonnProvider.buildSearchUrl('Oxfordstraße'))
      .toBe('https://www.bonn.sitzung-online.de/public/tr010?q=Oxfordstra%C3%9Fe');
  });

  test('parseResults erkennt neue /public/vo020?VOLFDNR Links', () => {
    const html = `
      <table><tr>
        <td><a href="/public/vo020?VOLFDNR=2028269&amp;refresh=false">Antrag zur Schulwegsicherheit an der Oxfordstraße</a></td>
        <td>12.05.2026</td>
        <td>Ausschuss für Mobilität und Verkehr</td>
        <td>DS 2026/1234</td>
        <td>Beschlussvorlage</td>
      </tr></table>`;

    const results = bonnProvider.parseResults(html);

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Antrag zur Schulwegsicherheit an der Oxfordstraße');
    expect(results[0].url).toBe('https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=2028269&refresh=false');
    expect(results[0].date).toBe('12.05.2026');
    expect(results[0].gremium).toBe('Ausschuss für Mobilität und Verkehr');
    expect(results[0].number).toBe('DS 2026/1234');
  });

  test('parseResults bleibt kompatibel mit alten vo020.asp Links', () => {
    const html = `
      <table><tr>
        <td><a href="vo020.asp?VOLFDNR=12345">Antrag zur Radverkehrsführung</a></td>
        <td>01.02.2024</td>
        <td>Bezirksvertretung Bonn</td>
        <td>Drs. 2024-0421</td>
      </tr></table>`;

    const results = bonnProvider.parseResults(html, {
      portalBase: 'https://www2.bonn.de',
      detailDir: '/bo_ris/ws_buergerinfo/'
    });

    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://www2.bonn.de/bo_ris/ws_buergerinfo/vo020.asp?VOLFDNR=12345');
  });
});
