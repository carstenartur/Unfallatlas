/**
 * #E1: UA.aiProposal frontend module — calls /api/ai/export-assessment/v2,
 * renders the proposalBrief.v1 result, handles 503/error paths, and exports
 * a user-owned ChatGPT/Gemini prompt without sending data to any AI service.
 *
 * @jest-environment jsdom
 */

describe('UA.aiProposal (#E1)', () => {
  let UA;

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
    jest.resetModules();
    const fs = require('fs');
    const path = require('path');
    const code = fs.readFileSync(path.resolve(__dirname, '../../js/ua.ai_proposal.js'), 'utf8');
    // eslint-disable-next-line no-eval
    (new Function('window', 'document', code))(window, document);
    UA = window.UA;
  });

  function flush(n = 8) {
    let p = Promise.resolve();
    for (let i = 0; i < n; i++) p = p.then(() => new Promise(r => setTimeout(r, 0)));
    return p;
  }

  test('exposes a public wire() and helpers', () => {
    expect(typeof UA.aiProposal.wire).toBe('function');
    expect(UA.aiProposal._internal.labelForSource('ai')).toBe('KI-generiert');
    expect(UA.aiProposal._internal.labelForSource('fallback')).toMatch(/Fallback/);
    expect(UA.aiProposal._internal.buildPlainText({ title: 'T', shortVersion: 'S', caveats: ['x'] }))
      .toContain('# T');
    expect(typeof UA.aiProposal._internal.buildExternalAiPrompt).toBe('function');
    expect(typeof UA.aiProposal._internal.buildExternalAiFactsPackage).toBe('function');
  });

  test('happy path: posts structured payload, renders result, appends to textarea', async () => {
    const sampleResult = {
      schemaVersion: 'proposalBrief.v1',
      title: 'Antrag XYZ',
      shortVersion: 'Kurz.',
      longVersion: 'Lang.',
      sachverhalt: '...',
      begruendung: '...',
      beschlussvorschlag: 'Beschluss XYZ',
      pruefauftrag: 'Prüfen XYZ',
      measureSummary: [{ title: 'Tempo 30', category: 'quickWin', rationale: '…' }],
      caveats: ['Hinweis A'],
      confidence: { overall: 'medium' }
    };
    let captured = null;
    window.fetch = async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 200, async json() { return { mode: 'proposal-brief', source: 'ai', result: sampleResult }; } };
    };
    const ctx = {};
    UA.computeExportReport = async () => ({ structured: { meta: { city: 'X' } } });
    UA.aiProposal.wire(ctx);

    document.getElementById('btnAiProposal').click();
    await flush();

    expect(captured.url).toBe('/api/ai/export-assessment/v2?mode=proposal-brief');
    expect(captured.init.method).toBe('POST');
    const body = JSON.parse(captured.init.body);
    expect(body.mode).toBe('proposal-brief');
    expect(body.structured.meta.city).toBe('X');

    const resultHtml = document.getElementById('aiProposalResult').innerHTML;
    expect(resultHtml).toContain('Antrag XYZ');
    expect(resultHtml).toContain('Kurz.');
    expect(resultHtml).toContain('Beschluss XYZ');
    expect(resultHtml).toContain('Tempo 30');
    expect(resultHtml).toContain('Hinweis A');

    const ta = document.getElementById('exportBoxTa').value;
    expect(ta).toContain('KI-Antragsentwurf');
    expect(ta).toContain('Beschluss XYZ');
  });

  test('503 → friendly status hint, no exception, deterministic export untouched', async () => {
    window.fetch = async () => ({ ok: false, status: 503, async json() { return { message: 'AI_NOT_CONFIGURED' }; } });
    UA.computeExportReport = async () => ({ structured: { meta: {} } });
    UA.aiProposal.wire({});
    document.getElementById('btnAiProposal').click();
    await flush();
    const status = document.getElementById('aiProposalStatus').textContent;
    expect(status).toMatch(/KI nicht konfiguriert/);
    expect(document.getElementById('aiProposalResult').style.display).toBe('none');
    expect(document.getElementById('exportBoxTa').value).toBe('');
  });

  test('non-OK non-503 → status shows the error message', async () => {
    window.fetch = async () => ({ ok: false, status: 500, async json() { return { message: 'boom' }; } });
    UA.computeExportReport = async () => ({ structured: { meta: {} } });
    UA.aiProposal.wire({});
    document.getElementById('btnAiProposal').click();
    await flush();
    expect(document.getElementById('aiProposalStatus').textContent).toMatch(/HTTP 500.*boom/);
  });

  test('fallback source labelled in UI', async () => {
    window.fetch = async () => ({ ok: true, status: 200, async json() { return { mode: 'proposal-brief', source: 'fallback', result: { title: 'F', shortVersion: 's', longVersion: 'l', sachverhalt: '', begruendung: '', beschlussvorschlag: '', pruefauftrag: '', measureSummary: [], caveats: [], confidence: { overall: 'low' } } }; } });
    UA.computeExportReport = async () => ({ structured: { meta: {} } });
    UA.aiProposal.wire({});
    document.getElementById('btnAiProposal').click();
    await flush();
    const html = document.getElementById('aiProposalResult').innerHTML;
    expect(html).toMatch(/Fallback/);
    expect(document.getElementById('aiProposalStatus').textContent).toMatch(/Fallback/);
  });

  test('wire() injects user-owned prompt controls without requiring HTML changes', () => {
    UA.computeExportReport = async () => ({ structured: { meta: { city: 'Bonn' } }, text: 'Report' });
    UA.aiProposal.wire({ CITY_RAW: 'Bonn' });
    expect(document.getElementById('btnAiPromptCopy')).toBeTruthy();
    expect(document.getElementById('btnAiPromptDownloadMd')).toBeTruthy();
    expect(document.getElementById('btnAiFactsDownloadJson')).toBeTruthy();
    expect(document.getElementById('btnOpenChatGpt')).toBeTruthy();
    expect(document.getElementById('btnOpenGemini')).toBeTruthy();
    expect(document.getElementById('externalAiPromptPanel').textContent).toMatch(/nichts automatisch/);
  });

  test('external prompt copy uses deterministic report and does not call the AI API', async () => {
    const writeText = jest.fn(async () => {});
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    window.fetch = jest.fn();
    UA.syncAllToUrl = jest.fn();
    UA.computeExportReport = async () => ({
      structured: {
        meta: { city: 'Bonn' },
        summary: { accidents: 12 },
        hints: ['sichtbarer Hinweis, keine Ursache']
      },
      text: 'Deterministischer Bericht mit Beschlussvorschlag.'
    });
    UA.aiProposal.wire({ CITY_RAW: 'Bonn', ui: {} });

    document.getElementById('btnAiPromptCopy').click();
    await flush();

    expect(window.fetch).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledTimes(1);
    const prompt = writeText.mock.calls[0][0];
    expect(prompt).toContain('KI-Prompt für einen kommunalpolitischen Antrag');
    expect(prompt).toContain('Kartenlink zur Prüfung');
    expect(prompt).toContain('Deterministischer Bericht mit Beschlussvorschlag');
    expect(prompt).toContain('"city": "Bonn"');
    expect(prompt).toContain('nichts automatisch an einen KI-Dienst gesendet');
    expect(document.getElementById('aiPromptStatus').textContent).toMatch(/Prompt kopiert/);
  });

  test('external prompt helper preserves facts, map link, provenance and cautious wording rules', () => {
    const facts = UA.aiProposal._internal.buildExternalAiFactsPackage({
      city: 'Hannover',
      mapUrl: 'https://example.test/werkbank?city=Hannover&export=1',
      generatedAt: '2026-07-03T12:00:00.000Z',
      structured: { meta: { city: 'Hannover' }, counts: { total: 5 } },
      deterministicReportText: 'Sachverhalt: fünf Unfälle.'
    });
    const prompt = UA.aiProposal._internal.buildExternalAiPrompt(facts);

    expect(facts.schemaVersion).toBe('unfallwerkbank.externalAiPromptFacts.v1');
    expect(facts.privacyNote).toMatch(/erst an einen KI-Dienst/);
    expect(prompt).toContain('https://example.test/werkbank?city=Hannover&export=1');
    expect(prompt).toContain('Sachverhalt: fünf Unfälle.');
    expect(prompt).toContain('Behaupte keine gesicherten Unfallursachen');
    expect(prompt).toContain('prüfbedürftig');
  });
});