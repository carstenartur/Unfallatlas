/**
 * Link-first user-owned AI handoff.
 *
 * @jest-environment jsdom
 */

describe('UA.aiLinkHandoff', () => {
  let UA;
  let clipboardWrite;

  function load(relativePath) {
    const fs = require('fs');
    const path = require('path');
    const code = fs.readFileSync(path.resolve(__dirname, '../../js/', relativePath), 'utf8');
    // eslint-disable-next-line no-new-func
    (new Function('window', 'document', code))(window, document);
  }

  function flush(n = 5) {
    let promise = Promise.resolve();
    for (let index = 0; index < n; index += 1) {
      promise = promise.then(() => new Promise(resolve => setTimeout(resolve, 0)));
    }
    return promise;
  }

  beforeEach(() => {
    document.body.innerHTML = `
      <fieldset id="aiProposalSection">
        <button id="btnAiProposal"></button>
        <div id="aiProposalStatus"></div>
        <div id="aiProposalResult"></div>
      </fieldset>
      <textarea id="exportBoxTa"></textarea>
    `;
    delete window.UA;
    window.UA = {};
    window.history.replaceState(
      null,
      '',
      '/werkbank_v2.html?city=Bonn&includeCyclist=1&showHeatmap=0&mapMode=hybrid&selSouth=50.70&selWest=7.05&selNorth=50.75&selEast=7.15'
    );
    clipboardWrite = jest.fn(async () => undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: clipboardWrite },
      configurable: true,
    });

    load('ua.ai_proposal.js');
    UA = window.UA;
    UA.syncAllToUrl = jest.fn();
    window.fetch = jest.fn();
    UA.computeExportReport = jest.fn(async () => ({
      structured: {
        meta: { city: 'Bonn' },
        summary: { totalAccidents: 7 },
      },
      text: 'Deterministischer Bericht.',
      html: '<main><h1>Bonn</h1></main>',
    }));
    UA.DataResources = {
      resolve: jest.fn((kind, params) => ({
        kind,
        logicalUrl: `out/${kind}_${String(params.city || '').toLowerCase()}.json`,
        gzipUrl: `out/${kind}_${String(params.city || '').toLowerCase()}.json.gz`,
        compression: kind.includes('TileIndex') ? 'gzip-only' : 'gzip-preferred',
      })),
    };

    load('ua.ai_link_handoff.js');
  });

  test('makes the reproducible analysis link the primary handoff', async () => {
    const ctx = { CITY_RAW: 'Bonn', ui: {}, exportOptions: {} };
    UA.aiProposal.wire(ctx);
    await flush();

    expect(document.getElementById('btnAiResearchLinkCopy')).toBeTruthy();
    expect(document.getElementById('btnAiResearchLinkCopy').textContent)
      .toMatch(/Analyse-Link/i);
    expect(document.getElementById('btnAiPromptCopy').textContent)
      .toMatch(/Text-Snapshot/i);
    expect(document.getElementById('btnAiPromptDownloadMd').textContent)
      .toMatch(/Text-Snapshot/i);
    expect(document.getElementById('aiLinkHandoffNote').textContent)
      .toMatch(/öffentlich erreichbare.*Link zuerst|Link zuerst.*öffentlich erreichbare/i);
    expect(document.getElementById('btnAiHandoffDownload')).toBeNull();
    expect(document.querySelector('#externalAiPromptPanel > div:first-child').textContent)
      .toMatch(/Docker-Links.*PDF-\/Word-Export/i);
  });

  test('copies a public research task with the exact analysis state and compressed data URLs', async () => {
    const ctx = { CITY_RAW: 'Bonn', ui: {}, exportOptions: {} };
    UA.aiProposal.wire(ctx);
    await flush();

    document.getElementById('btnAiResearchLinkCopy').click();
    await flush(8);

    expect(UA.computeExportReport).toHaveBeenCalledTimes(1);
    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    const prompt = clipboardWrite.mock.calls[0][0];
    expect(prompt).toContain('Primärer Einstieg: öffentliche Analyseansicht öffnen');
    expect(prompt).toContain('https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?');
    expect(prompt).toContain('export=1');
    expect(prompt).toContain('mapMode=hybrid');
    expect(prompt).toContain('selSouth=50.70');
    expect(prompt).toContain('https://carstenartur.github.io/Unfallatlas/out/accidentGeoJson_bonn.json.gz');
    expect(prompt).toContain('https://carstenartur.github.io/Unfallatlas/out/accidentTileIndex_bonn.json.gz');
    expect(prompt).toContain('zusätzliche Untersuchungen');
    expect(prompt).toContain('PDF- oder Word-Export');
    expect(window.fetch).not.toHaveBeenCalled();
  });

  test('binds one baseline snapshot while permitting separately labelled investigations', async () => {
    const ctx = { CITY_RAW: 'Bonn', ui: {}, exportOptions: {} };
    const handoff = await UA.aiLinkHandoff.generateResearchHandoff(UA, ctx);

    expect(UA.computeExportReport).toHaveBeenCalledTimes(1);
    expect(handoff.schemaVersion).toBe('unfallwerkbank.aiResearchHandoff.v1');
    expect(handoff.analysisUrl).toContain('export=1');
    expect(handoff.analysisUrl).toMatch(/^https:\/\/carstenartur\.github\.io\/Unfallatlas\/werkbank_v2\.html\?/);
    expect(handoff.resources).toHaveLength(6);
    expect(handoff.resources.every(resource => resource.preferredUrl.endsWith('.gz'))).toBe(true);
    expect(handoff.facts.collaborationMode).toBe('link-first');
    expect(handoff.prompt).toMatch(/Verändere den Ausgangszustand nicht stillschweigend/);
  });

  test('supports a configured public deployment and preserves already public URLs', () => {
    UA.PUBLIC_APP_URL = 'https://example.org/unfallwerkbank/app.html';
    const internal = UA.aiLinkHandoff._internal;

    expect(internal.shareableAnalysisUrl(UA, 'http://localhost:8000/werkbank_v2.html?city=Bonn'))
      .toBe('https://example.org/unfallwerkbank/app.html?city=Bonn');
    expect(internal.shareableAnalysisUrl(UA, 'https://stadt.example/werkbank.html?city=Bonn'))
      .toBe('https://stadt.example/werkbank.html?city=Bonn');
    expect(internal.isPrivateHostname('192.168.1.8')).toBe(true);
    expect(internal.isPrivateHostname('stadt.example')).toBe(false);
  });
});
