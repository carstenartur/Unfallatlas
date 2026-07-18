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
      <div id="ctxFilterEmpty"></div>
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
    expect(button.textContent).toMatch(/Bonn lokal erzeugen/);
    expect(button.disabled).toBe(false);
    expect(document.getElementById('ctxGenerationStatus').textContent).toMatch(/atomar|erfolgreicher Prüfung/i);
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
