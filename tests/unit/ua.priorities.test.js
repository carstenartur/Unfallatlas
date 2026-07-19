'use strict';

/**
 * Frontend-Unit-Tests für `js/ua.priorities.js`.
 *
 * Geprüft werden die im Modul exportierten Methoden:
 *   - UA.Priorities.loadProfiles (graceful fallback bei Server-Fehler)
 *   - UA.Priorities.fetchTop / fetchByLocation (URL-Aufbau, Fehlerbehandlung)
 *   - UA.Priorities.openPanel (DOM-Initialisierung, ohne Server-Aufrufe nötig)
 *   - UA.Priorities.init (Button-Bindings, end-to-end mit Stub-fetch)
 *
 * @jest-environment jsdom
 */

const fs   = require('fs');
const path = require('path');

function loadPrioritiesModule() {
  // Modul-Quelle in den jsdom-Window-Kontext laden.  Das Modul nutzt eine
  // IIFE und greift auf `window.UA` zu – daher reicht ein einfaches eval.
  const src = fs.readFileSync(path.resolve(__dirname, '../../js/ua.priorities.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(src);
  return window.UA.Priorities;
}

beforeEach(() => {
  // Saubere Welt für jeden Test
  delete window.UA;
  document.body.innerHTML = '';
});

// ── loadProfiles ─────────────────────────────────────────────────────────────

describe('UA.Priorities.loadProfiles', () => {
  test('gibt Server-Antwort durch, wenn die API erreichbar ist', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        profiles: ['low_hanging_fruit', 'safety_first'],
        defaultProfile: 'low_hanging_fruit',
        dataStatusValues: ['freshly_computed', 'loaded_from_store', 'persisted', 'fallback_result']
      })
    });
    const Priorities = loadPrioritiesModule();
    const r = await Priorities.loadProfiles();
    expect(r.profiles).toEqual(['low_hanging_fruit', 'safety_first']);
    expect(r.defaultProfile).toBe('low_hanging_fruit');
    expect(r.dataStatusValues).toContain('fallback_result');
    expect(global.fetch).toHaveBeenCalledWith('/api/priorities/profiles');
  });

  test('liefert sinnvolle Defaults im Browser-only-Modus (fetch wirft)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network'));
    const Priorities = loadPrioritiesModule();
    const r = await Priorities.loadProfiles();
    expect(Array.isArray(r.profiles)).toBe(true);
    expect(r.profiles.length).toBeGreaterThan(0);
    expect(r.dataStatusValues).toEqual([
      'freshly_computed', 'loaded_from_store', 'persisted', 'fallback_result'
    ]);
  });

  test('liefert Defaults auch bei HTTP-Fehler (z. B. 503)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const Priorities = loadPrioritiesModule();
    const r = await Priorities.loadProfiles();
    expect(Array.isArray(r.profiles)).toBe(true);
    expect(r.profiles.length).toBeGreaterThan(0);
  });
});

// ── fetchTop ─────────────────────────────────────────────────────────────────

describe('UA.Priorities.fetchTop', () => {
  test('baut URL korrekt mit URLSearchParams und reicht JSON durch', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ mode: 'top', items: [], dataStatus: 'loaded_from_store', empty: true, count: 0 })
    });
    const Priorities = loadPrioritiesModule();
    const r = await Priorities.fetchTop('Hannover', 'safety_first', 5);
    const url = global.fetch.mock.calls[0][0];
    expect(url).toMatch(/^\/api\/priorities\/top\?/);
    expect(url).toContain('city=Hannover');
    expect(url).toContain('profile=safety_first');
    expect(url).toContain('limit=5');
    expect(r.dataStatus).toBe('loaded_from_store');
    expect(r.empty).toBe(true);
  });

  test('wirft mit aussagekräftiger Meldung bei HTTP-Fehler', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 400,
      json: async () => ({ error: 'Pflicht-Query-Parameter "city" fehlt.' })
    });
    const Priorities = loadPrioritiesModule();
    await expect(Priorities.fetchTop('', 'safety_first')).rejects.toThrow(/city/);
  });

  test('default-Limit ist 10', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const Priorities = loadPrioritiesModule();
    await Priorities.fetchTop('Hannover', 'safety_first');
    expect(global.fetch.mock.calls[0][0]).toContain('limit=10');
  });
});

// ── fetchByLocation ──────────────────────────────────────────────────────────

describe('UA.Priorities.fetchByLocation', () => {
  test('URL-encodet locationKey und reicht profile als Query an', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ mode: 'by-location', items: [{ id: 'a' }], dataStatus: 'loaded_from_store', empty: false, count: 1 })
    });
    const Priorities = loadPrioritiesModule();
    const r = await Priorities.fetchByLocation('hannover::altenbekener damm', 'safety_first');
    const url = global.fetch.mock.calls[0][0];
    expect(url).toBe('/api/priorities/by-location/hannover%3A%3Aaltenbekener%20damm?profile=safety_first');
    expect(r.items[0].id).toBe('a');
  });

  test('ohne Profil keine ?profile=… Query', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const Priorities = loadPrioritiesModule();
    await Priorities.fetchByLocation('h::a');
    expect(global.fetch.mock.calls[0][0]).toBe('/api/priorities/by-location/h%3A%3Aa');
  });
});

// ── openPanel ────────────────────────────────────────────────────────────────

describe('UA.Priorities.openPanel', () => {
  function buildPanelDom() {
    document.body.innerHTML = `
      <div id="prioPanel" style="display:none;"></div>
      <input id="prioCity" type="text" />
      <select id="prioProfile"><option>Lade…</option></select>
      <select id="prioMode">
        <option value="top">top</option>
        <option value="byLocation">byLocation</option>
      </select>
      <div id="prioByLocationRow" style="display:none;"></div>
      <div id="prioResults"></div>
      <div id="prioStatus"></div>
      <span id="prioStatusBadge" style="display:none;"></span>
    `;
  }

  test('macht Panel sichtbar und füllt Stadt aus ctx.CITY_RAW vor', async () => {
    buildPanelDom();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        profiles: ['low_hanging_fruit', 'safety_first'],
        defaultProfile: 'low_hanging_fruit',
        dataStatusValues: []
      })
    });
    const Priorities = loadPrioritiesModule();
    await Priorities.openPanel({ CITY_RAW: 'Hannover' });
    expect(document.getElementById('prioPanel').style.display).toBe('flex');
    expect(document.getElementById('prioCity').value).toBe('Hannover');
    const opts = Array.from(document.getElementById('prioProfile').options).map(o => o.value);
    expect(opts).toContain('safety_first');
    expect(opts).toContain('low_hanging_fruit');
  });

  test('Modus-Wechsel auf byLocation blendet die LocationKey-Zeile ein', async () => {
    buildPanelDom();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ profiles: ['p'], defaultProfile: 'p', dataStatusValues: [] })
    });
    const Priorities = loadPrioritiesModule();
    await Priorities.openPanel({});
    const modeSel = document.getElementById('prioMode');
    const row     = document.getElementById('prioByLocationRow');
    expect(row.style.display).toBe('none');
    modeSel.value = 'byLocation';
    modeSel.dispatchEvent(new window.Event('change'));
    expect(row.style.display).toBe('');
  });
});

// ── init / Load-Button ───────────────────────────────────────────────────────

describe('UA.Priorities.init – Load-Flow', () => {
  function buildFullDom() {
    document.body.innerHTML = `
      <button id="btnPrioritiesOpen">open</button>
      <div id="prioPanel" style="display:none;"></div>
      <button id="prioBtnClose">x</button>
      <button id="prioBtnLoad">Laden</button>
      <input id="prioCity" type="text" value="Hannover" />
      <select id="prioProfile"><option value="safety_first" selected>safety_first</option></select>
      <select id="prioMode">
        <option value="top" selected>top</option>
        <option value="byLocation">byLocation</option>
      </select>
      <div id="prioByLocationRow" style="display:none;">
        <input id="prioLocationKey" type="text" />
      </div>
      <div id="prioResults"></div>
      <div id="prioStatus"></div>
      <span id="prioStatusBadge" style="display:none;"></span>
    `;
  }

  test('Klick auf „Laden" ruft fetchTop, rendert Cards und zeigt loaded_from_store-Badge', async () => {
    buildFullDom();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        mode: 'top',
        dataStatus: 'loaded_from_store',
        count: 1,
        empty: false,
        items: [{
          id: 'b-1', locationKey: 'hannover::a', city: 'Hannover',
          title: 'Stelle A', profileKey: 'safety_first', confidence: 0.7,
          score: { total: 80, subScores: {} },
          conflictPatterns: [{ id: 'p1', label: 'Konflikt', classification: 'primary', confidence: 'high' }],
          recommendedMeasures: [{ id: 'm1', title: 'Schutzspur', fitScore: 0.9, costBand: 'high' }],
          political: { count: 1, hasHighRelevance: true }
        }]
      })
    });
    const Priorities = loadPrioritiesModule();
    Priorities.init({ CITY_RAW: 'Hannover' });
    document.getElementById('prioBtnLoad').click();
    // Warten auf Promise-Auflösung
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    const badge = document.getElementById('prioStatusBadge');
    expect(badge.style.display).toBe('inline-block');
    expect(badge.textContent).toMatch(/Persistenz/);
    const html = document.getElementById('prioResults').innerHTML;
    expect(html).toContain('Stelle A');
    expect(html).toContain('Schutzspur');
    expect(html).toContain('Konflikt');
  });

  test('leeres Ranking zeigt Hinweis statt Karten', async () => {
    buildFullDom();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ mode: 'top', dataStatus: 'loaded_from_store', count: 0, empty: true, items: [] })
    });
    const Priorities = loadPrioritiesModule();
    Priorities.init({});
    document.getElementById('prioBtnLoad').click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    const html = document.getElementById('prioResults').innerHTML;
    expect(html).toMatch(/keine gespeicherten Briefs/i);
  });

  test('fallback_result wird mit gelbem Badge und Reason angezeigt', async () => {
    buildFullDom();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        mode: 'top', dataStatus: 'fallback_result', empty: true, count: 0, items: [],
        fallbackReason: 'analysis_service_unconfigured'
      })
    });
    const Priorities = loadPrioritiesModule();
    Priorities.init({});
    document.getElementById('prioBtnLoad').click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    const badge = document.getElementById('prioStatusBadge');
    expect(badge.textContent).toMatch(/Fallback/);
    expect(badge.textContent).toMatch(/analysis_service_unconfigured/);
    expect(document.getElementById('prioResults').innerHTML).toMatch(/Persistenz-Service nicht verfügbar/);
  });

  test('Schließen-Button blendet Panel aus', async () => {
    buildFullDom();
    const Priorities = loadPrioritiesModule();
    Priorities.init({});
    document.getElementById('prioPanel').style.display = 'flex';
    document.getElementById('prioBtnClose').click();
    expect(document.getElementById('prioPanel').style.display).toBe('none');
  });

  test('setzt beim Öffnen den Anfangsfokus und stellt ihn nach Escape wieder her', async () => {
    buildFullDom();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        profiles: ['safety_first'],
        defaultProfile: 'safety_first',
        dataStatusValues: []
      })
    });
    const Priorities = loadPrioritiesModule();
    const openButton = document.getElementById('btnPrioritiesOpen');
    const closeButton = document.getElementById('prioBtnClose');
    const panel = document.getElementById('prioPanel');

    Priorities.init({ CITY_RAW: 'Hannover' });
    openButton.focus();
    openButton.click();

    expect(panel.style.display).toBe('flex');
    expect(document.activeElement).toBe(closeButton);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(panel.style.display).toBe('none');
    expect(document.activeElement).toBe(openButton);

    await new Promise(resolve => setTimeout(resolve, 0));
  });
});
