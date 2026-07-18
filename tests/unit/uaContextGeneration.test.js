'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../js/ua.context_generation.js'), 'utf8');

function jsonResponse(body, options = {}) {
  return {
    ok: options.ok !== false,
    status: options.status || 200,
    headers: { get: name => String(name).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null },
    json: async () => body,
  };
}

async function loadModule() {
  window.UA = {};
  window.eval(SOURCE);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  return window.UA.ContextGeneration;
}

describe('UA.ContextGeneration', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <select id="citySel"><option selected>Bonn</option></select>
      <div id="ctxFilterSection">
        <div id="ctxFilterEmpty"></div>
        <div id="ctxSlopeRow" hidden></div>
        <div id="ctxTrafficRow" hidden></div>
        <div id="ctxOnlyMatchedRow" hidden></div>
      </div>
    `;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete window.UA;
    jest.restoreAllMocks();
  });

  test('shows the GitHub Actions fallback on a static deployment', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => 'text/html' },
      json: async () => { throw new Error('not json'); },
    });

    const api = await loadModule();
    expect(api.selectedCity()).toBe('Bonn');
    const button = document.getElementById('ctxGenerateMissingBtn');
    expect(button).not.toBeNull();
    expect(button.textContent).toMatch(/GitHub-Workflow für Bonn öffnen/);
    expect(document.getElementById('ctxGenerationHeading').textContent).toMatch(/Steigung.*Verkehrsproxy.*OSM-Straßenbezug/);
    expect(document.getElementById('ctxGenerationStatus').textContent).toMatch(/kein Zugangsschlüssel/);
  });

  test('shows direct local generation when the Docker API is available', async () => {
    global.fetch.mockResolvedValue(jsonResponse({
      available: true,
      execution: 'local-docker',
      requiresToken: false,
      city: 'Bonn',
      slug: 'bonn',
      activeJob: null,
    }));

    await loadModule();
    const button = document.getElementById('ctxGenerateMissingBtn');
    expect(button.textContent).toMatch(/Bonn.*lokal neu erzeugen/);
    expect(button.disabled).toBe(false);
    expect(document.getElementById('ctxGenerationStatus').textContent).toMatch(/atomar|erfolgreicher Prüfung/i);
  });

  test('shows recovery for a partial dataset and names only missing capabilities', async () => {
    document.getElementById('ctxSlopeRow').hidden = false;
    document.getElementById('ctxOnlyMatchedRow').hidden = false;
    global.fetch.mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => 'text/html' },
      json: async () => { throw new Error('not json'); },
    });

    const api = await loadModule();
    expect(api.missingContextLabels()).toEqual(['Verkehrsproxy']);
    expect(document.getElementById('ctxGenerationActions').hidden).toBe(false);
    expect(document.getElementById('ctxGenerationHeading').textContent).toBe('Fehlende Kontextdaten: Verkehrsproxy');
  });

  test('hides the recovery action when all context capabilities are present', async () => {
    document.getElementById('ctxSlopeRow').hidden = false;
    document.getElementById('ctxTrafficRow').hidden = false;
    document.getElementById('ctxOnlyMatchedRow').hidden = false;

    await loadModule();
    expect(document.getElementById('ctxGenerationActions').hidden).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('keeps a token-protected running job actionable instead of disabling it forever', async () => {
    global.fetch.mockResolvedValue(jsonResponse({
      available: true,
      execution: 'local-docker',
      requiresToken: true,
      city: 'Bonn',
      slug: 'bonn',
      activeJob: { id: 'job-1', city: 'Bonn', status: 'running', logs: [] },
    }));

    await loadModule();
    const button = document.getElementById('ctxGenerateMissingBtn');
    expect(button.disabled).toBe(false);
    expect(button.textContent).toMatch(/mit Token verfolgen/);
  });
});
