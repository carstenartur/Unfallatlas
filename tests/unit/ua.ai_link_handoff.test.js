/**
 * Evidence-first, link-first user-owned AI handoff.
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

  function richStructuredReport() {
    return {
      meta: {
        city: 'Bonn',
        areaName: 'Bonn Hauptbahnhof',
        date: '15.08.2026',
        filters: { severity: 'all', roadCondition: 'all' },
        involvementMode: 'and',
      },
      severity: {
        total: 7,
        bySev: { '1': 0, '2': 2, '3': 5, other: 0 },
      },
      yearTable: [
        { year: 2019, total: 1 },
        { year: 2020, total: 1 },
        { year: 2021, total: 1 },
        { year: 2022, total: 1 },
        { year: 2023, total: 1 },
        { year: 2024, total: 1 },
        { year: 2025, total: 1 },
      ],
      crossTable: {
        rows: [{ label: 'Rad + Pkw', total: 7, sev1: 0, sev2: 2, sev3: 5 }],
        totals: { sev1: 0, sev2: 2, sev3: 5, total: 7 },
      },
      accidentDetails: {
        total: 7,
        truncated: false,
        rows: Array.from({ length: 7 }, (_, index) => ({
          year: 2019 + index,
          sevLabel: index < 2 ? 'schwer' : 'leicht',
          involved: 'Rad + Pkw',
          lat: 50.732 + index / 10000,
          lon: 7.096 + index / 10000,
        })),
      },
    };
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
      '/werkbank_v2.html?city=Bonn&includeCyclist=1&includeCar=1&involvementMode=and&showHeatmap=0&mapMode=hybrid&selSouth=50.70&selWest=7.05&selNorth=50.75&selEast=7.15'
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
      structured: richStructuredReport(),
      text: 'Deterministischer Bericht: Im markierten Bereich wurden sieben Rad-Pkw-Unfälle dokumentiert, darunter zwei mit Schwerverletzten.',
      html: '<main><h1>Bonn Hauptbahnhof</h1></main>',
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

  test('makes the evidence/QA analysis link the primary and only copy action', async () => {
    const ctx = { CITY_RAW: 'Bonn', ui: {}, exportOptions: {} };
    UA.aiProposal.wire(ctx);
    await flush();

    expect(document.getElementById('btnAiResearchLinkCopy')).toBeTruthy();
    expect(document.getElementById('btnAiResearchLinkCopy').textContent)
      .toMatch(/QA.*Antrag.*Analyse-Link/i);
    expect(document.getElementById('btnAiPromptCopy')).toBeNull();
    expect(document.getElementById('btnAiPromptDownloadMd').textContent)
      .toMatch(/Evidenz-\/QA-Auftrag/i);
    expect(document.getElementById('btnAiFactsDownloadJson').textContent)
      .toMatch(/Evidenzvertrag/i);
    expect(document.getElementById('aiLinkHandoffNote').textContent)
      .toMatch(/Amtliche.*polizeibasierte.*Tatsachenkern.*unabhängig prüfen/i);
    expect(document.getElementById('btnAiHandoffDownload')).toBeNull();
    expect(document.querySelector('#externalAiPromptPanel > div:first-child').textContent)
      .toMatch(/amtlichen.*Tatsachenkern.*Docker-Links.*PDF-\/Word-Export/i);
  });

  test('copies a public evidence-based research task with the exact analysis state and compressed data URLs', async () => {
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
    expect(prompt).toContain('Meldungen der Polizeidienststellen');
    expect(prompt).toContain('Unfälle mit Personenschaden');
    expect(prompt).toContain('reine Sachschadensunfälle');
    expect(prompt).toContain('amtlich dokumentierten Tatsachenkern');
    expect(prompt).toContain('Schreibe den Antrag erst nach');
    expect(prompt).toContain('keine bloße Umformulierung');
    expect(prompt).toContain('QA-Urteil');
    expect(prompt).toContain('Evidenzmatrix');
    expect(prompt).toContain('Maßnahmenmatrix');
    expect(prompt).toContain('"totalAccidents": 7');
    expect(prompt).toContain('PDF- oder Word-Export');
    expect(window.fetch).not.toHaveBeenCalled();
  });

  test('binds one official-evidence snapshot and an automated preflight before independent visual QA', async () => {
    const ctx = { CITY_RAW: 'Bonn', ui: {}, exportOptions: {} };
    const handoff = await UA.aiLinkHandoff.generateResearchHandoff(UA, ctx);

    expect(UA.computeExportReport).toHaveBeenCalledTimes(1);
    expect(handoff.schemaVersion).toBe('unfallwerkbank.aiResearchHandoff.v2');
    expect(handoff.analysisUrl).toContain('export=1');
    expect(handoff.analysisUrl).toMatch(/^https:\/\/carstenartur\.github\.io\/Unfallatlas\/werkbank_v2\.html\?/);
    expect(handoff.resources).toHaveLength(6);
    expect(handoff.resources.every(resource => resource.preferredUrl.endsWith('.gz'))).toBe(true);
    expect(handoff.facts.collaborationMode).toBe('link-first-evidence-first');
    expect(handoff.evidenceContract.schemaVersion).toBe('unfallwerkbank.accidentEvidenceContract.v1');
    expect(handoff.evidenceContract.primaryDataset.provenance)
      .toMatch(/Meldungen der Polizeidienststellen/);
    expect(handoff.evidenceContract.primaryDataset.scope)
      .toMatch(/Unfälle mit Personenschaden.*Sachschadensunfälle/);
    expect(handoff.evidenceContract.snapshotMetrics.totalAccidents).toBe(7);
    expect(handoff.evidenceContract.snapshotMetrics.severity.serious).toBe(2);
    expect(handoff.analysisPreflight.status).toBe('ready-for-independent-review');
    expect(handoff.analysisPreflight.checks.find(check => check.id === 'count-consistency').status)
      .toBe('pass');
    expect(handoff.analysisPreflight.checks.find(check => check.id === 'visual-completeness').status)
      .toBe('pending');
    expect(handoff.promptAudit.passed).toBe(true);
    expect(handoff.prompt).toMatch(/Unsicherheit über die Ursache entwertet.*Tatsachenkern/);
  });

  test('flags contradictory totals before asking the AI to draft an application', () => {
    const structured = richStructuredReport();
    structured.accidentDetails.total = 8;
    const resources = UA.aiLinkHandoff._internal.researchResources(
      UA,
      'Bonn',
      'https://example.org/werkbank?city=Bonn&export=1&selSouth=1&selWest=1&selNorth=2&selEast=2'
    );
    const preflight = UA.aiLinkHandoff.buildAnalysisPreflight(
      structured,
      'Ein ausreichend langer deterministischer Bericht über die Auswertung und ihre Unfallzahlen.',
      'https://example.org/werkbank?city=Bonn&export=1&selSouth=1&selWest=1&selNorth=2&selEast=2',
      resources
    );

    expect(preflight.status).toBe('blocked');
    expect(preflight.blockingCheckIds).toContain('count-consistency');
  });

  test('audits the generated prompt contract instead of relying on attractive wording', () => {
    const valid = UA.aiLinkHandoff.auditResearchPrompt([
      'Meldungen der Polizeidienststellen',
      'Unfälle mit Personenschaden',
      'amtlich dokumentierten Tatsachenkern',
      'keine bloße Umformulierung',
      'QA-Urteil',
      'Evidenzmatrix',
      'Schreibe den Antrag erst nach',
      'Unsicherheit über die Ursache',
      'reine Sachschadensunfälle',
    ].join('\n'));
    const generic = UA.aiLinkHandoff.auditResearchPrompt('Formuliere bitte einen schönen Antrag.');

    expect(valid.passed).toBe(true);
    expect(generic.passed).toBe(false);
    expect(generic.missingMarkers).toContain('Meldungen der Polizeidienststellen');
    expect(generic.missingMarkers).toContain('QA-Urteil');
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
