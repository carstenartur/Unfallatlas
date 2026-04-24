'use strict';

/**
 * Tests für den optionalen Forwarder zum Analysis Service.
 *
 * Geprüft werden:
 *   - Konfigurations-Auswertung (Env-Variablen, Default-Werte)
 *   - Skipping bei nicht konfigurierter / deaktivierter Service-URL
 *   - Erfolgreiche Persistenz mit gemocktem HTTP-Server
 *   - Retry-Verhalten bei 5xx und Netzwerkfehlern
 *   - Fallback-/Skip-Verhalten bei Timeout
 *   - Read-Forwarder (`fetchByLocationKey`, `fetchTopByCityProfile`,
 *     `fetchByCity`)
 *   - Mapping `toIngestPayload()` (Pflichtfelder im versionierten Format)
 *
 * Es wird ein echter Loopback-HTTP-Server gestartet (kein Network-Mock-Lib),
 * damit das Verhalten gegen die `http`-Builtins identisch zur Produktion
 * abgedeckt ist.
 */

const http = require('http');

const ORIG_ENV = {};
[
  'ANALYSIS_SERVICE_BASE_URL',
  'ANALYSIS_SERVICE_ENABLED',
  'ANALYSIS_SERVICE_TIMEOUT_MS',
  'ANALYSIS_SERVICE_RETRIES',
  'ANALYSIS_SERVICE_RETRY_DELAY_MS'
].forEach((k) => { ORIG_ENV[k] = process.env[k]; });

function clearEnv() {
  Object.keys(ORIG_ENV).forEach((k) => { delete process.env[k]; });
}
function restoreEnv() {
  Object.keys(ORIG_ENV).forEach((k) => {
    if (ORIG_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG_ENV[k];
  });
}

beforeEach(() => {
  jest.resetModules();
  clearEnv();
});
afterAll(() => {
  restoreEnv();
});

function loadClient() {
  // eslint-disable-next-line global-require
  return require('../../server/analysis-service/analysisServiceClient.js');
}

/**
 * Startet einen Test-HTTP-Server, dessen Antwort­verhalten der Test
 * pro Request über den Handler steuert.  Liefert `{ url, server, calls }`.
 */
function startTestServer(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        if (raw) { try { body = JSON.parse(raw); } catch (_) { body = raw; } }
        const ctx = { method: req.method, url: req.url, body, headers: req.headers };
        calls.push(ctx);
        try {
          handler(ctx, res);
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err && err.message));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, server, calls });
    });
  });
}

function jsonReply(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

// ── Konfiguration ────────────────────────────────────────────────────────────

describe('analysisServiceClient – getConfig/describeStatus', () => {
  test('ohne BASE_URL ist enabled=false und configured=false', () => {
    const c = loadClient();
    const cfg = c.getConfig();
    expect(cfg.baseUrl).toBeNull();
    expect(cfg.enabled).toBe(false);
    expect(cfg.timeoutMs).toBe(4000);
    expect(cfg.retries).toBe(1);
    expect(cfg.retryDelayMs).toBe(200);
    expect(c.describeStatus()).toEqual({
      configured: false, enabled: false, baseUrl: null, timeoutMs: 4000, retries: 1
    });
  });

  test('BASE_URL aktiviert das Feature implizit', () => {
    process.env.ANALYSIS_SERVICE_BASE_URL = 'http://localhost:8081/';
    const cfg = loadClient().getConfig();
    expect(cfg.baseUrl).toBe('http://localhost:8081'); // trailing slash entfernt
    expect(cfg.enabled).toBe(true);
  });

  test('ENABLED=false deaktiviert trotz vorhandener BASE_URL', () => {
    process.env.ANALYSIS_SERVICE_BASE_URL = 'http://localhost:8081';
    process.env.ANALYSIS_SERVICE_ENABLED = 'false';
    expect(loadClient().getConfig().enabled).toBe(false);
  });

  test('Timeout/Retry/Delay aus Env werden übernommen', () => {
    process.env.ANALYSIS_SERVICE_BASE_URL = 'http://localhost:8081';
    process.env.ANALYSIS_SERVICE_TIMEOUT_MS = '1500';
    process.env.ANALYSIS_SERVICE_RETRIES = '3';
    process.env.ANALYSIS_SERVICE_RETRY_DELAY_MS = '50';
    const cfg = loadClient().getConfig();
    expect(cfg.timeoutMs).toBe(1500);
    expect(cfg.retries).toBe(3);
    expect(cfg.retryDelayMs).toBe(50);
  });

  test('ungültige Env-Werte fallen auf Defaults zurück', () => {
    process.env.ANALYSIS_SERVICE_BASE_URL = 'http://localhost:8081';
    process.env.ANALYSIS_SERVICE_TIMEOUT_MS = 'foo';
    process.env.ANALYSIS_SERVICE_RETRIES = '-2';
    const cfg = loadClient().getConfig();
    expect(cfg.timeoutMs).toBe(4000);
    expect(cfg.retries).toBe(1);
  });
});

// ── Mapping toIngestPayload ──────────────────────────────────────────────────

describe('analysisServiceClient – toIngestPayload', () => {
  test('füllt Pflichtfelder schemaVersion + meta', () => {
    const c = loadClient();
    const brief = {
      schemaVersion: 'locationActionBrief.v1',
      title: 'Hannover – Altenbekener Damm',
      problemSummary: 'Test',
      meta: { city: 'Hannover', profile: 'low_hanging_fruit', schemaVersion: 'locationActionBrief.v1' }
    };
    const p = c.toIngestPayload(brief, { locationId: 'hannover::altenbekener_damm' });
    expect(p.schemaVersion).toBe('locationBriefIngest.v1');
    expect(p.locationId).toBe('hannover::altenbekener_damm');
    expect(p.meta).toMatchObject({
      city: 'Hannover',
      profile: 'low_hanging_fruit',
      schemaVersion: 'locationActionBrief.v1'
    });
    expect(p.meta.generatedWithAi).toBe(false);
  });

  test('ergänzt city/areaName aus extra wenn brief.meta unvollständig', () => {
    const c = loadClient();
    const brief = { title: 'X', meta: { profile: 'data_driven_focus' } };
    const p = c.toIngestPayload(brief, { city: 'Bonn', areaName: 'Marktplatz' });
    expect(p.meta.city).toBe('Bonn');
    expect(p.meta.areaName).toBe('Marktplatz');
  });

  test('generatedWithAi=true wenn aiPolish vorhanden', () => {
    const c = loadClient();
    const brief = { title: 'X', meta: { city: 'Bonn', profile: 'p1' }, aiPolish: { narrative: 'foo' } };
    const p = c.toIngestPayload(brief);
    expect(p.meta.generatedWithAi).toBe(true);
    expect(p.aiPolish).toBeDefined();
  });
});

// ── Skipping ─────────────────────────────────────────────────────────────────

describe('analysisServiceClient – skipping', () => {
  test('persistLocationBrief: ohne BASE_URL → skipped:unconfigured', async () => {
    const c = loadClient();
    const r = await c.persistLocationBrief({ title: 't', meta: { city: 'X', profile: 'p' } });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe('unconfigured');
  });

  test('persistLocationBrief: ENABLED=false → skipped:disabled', async () => {
    process.env.ANALYSIS_SERVICE_BASE_URL = 'http://localhost:9';
    process.env.ANALYSIS_SERVICE_ENABLED = 'false';
    const c = loadClient();
    const r = await c.persistLocationBrief({ title: 't', meta: { city: 'X', profile: 'p' } });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe('disabled');
  });

  test('fetchByLocationKey: ohne BASE_URL → skipped:unconfigured', async () => {
    const r = await loadClient().fetchByLocationKey('hannover::x');
    expect(r.skipped).toBe('unconfigured');
  });
});

// ── Erfolgreiche Persistenz ──────────────────────────────────────────────────

describe('analysisServiceClient – persistLocationBrief (Loopback)', () => {
  let serverInfo;
  afterEach(() => new Promise((r) => serverInfo && serverInfo.server.close(r)));

  test('POST /api/location-briefs wird aufgerufen, Body enthält Ingest-DTO', async () => {
    serverInfo = await startTestServer((ctx, res) => {
      jsonReply(res, 201, { id: 'abc', locationKey: 'hannover::x' });
    });
    process.env.ANALYSIS_SERVICE_BASE_URL = serverInfo.url;
    process.env.ANALYSIS_SERVICE_RETRIES = '0';

    const c = loadClient();
    const r = await c.persistLocationBrief(
      { title: 'T', meta: { city: 'Hannover', profile: 'low_hanging_fruit', schemaVersion: 'locationActionBrief.v1' } },
      { locationId: 'hannover::x' }
    );
    expect(r.ok).toBe(true);
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ id: 'abc' });
    expect(r.attempts).toBe(1);
    expect(serverInfo.calls).toHaveLength(1);
    expect(serverInfo.calls[0].method).toBe('POST');
    expect(serverInfo.calls[0].url).toBe('/api/location-briefs');
    expect(serverInfo.calls[0].body.schemaVersion).toBe('locationBriefIngest.v1');
    expect(serverInfo.calls[0].body.meta.city).toBe('Hannover');
  });

  test('5xx löst Retry aus und gelingt beim zweiten Versuch', async () => {
    let nth = 0;
    serverInfo = await startTestServer((ctx, res) => {
      nth++;
      if (nth === 1) return jsonReply(res, 503, { error: 'temporarily_unavailable' });
      return jsonReply(res, 201, { id: 'retry-ok' });
    });
    process.env.ANALYSIS_SERVICE_BASE_URL = serverInfo.url;
    process.env.ANALYSIS_SERVICE_RETRIES = '2';
    process.env.ANALYSIS_SERVICE_RETRY_DELAY_MS = '5';

    const r = await loadClient().persistLocationBrief({ title: 'T', meta: { city: 'X', profile: 'p' } });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
    expect(serverInfo.calls).toHaveLength(2);
  });

  test('4xx wird ohne Retry zurückgegeben', async () => {
    let calls = 0;
    serverInfo = await startTestServer((ctx, res) => {
      calls++;
      jsonReply(res, 400, { error: 'validation' });
    });
    process.env.ANALYSIS_SERVICE_BASE_URL = serverInfo.url;
    process.env.ANALYSIS_SERVICE_RETRIES = '3';

    const r = await loadClient().persistLocationBrief({ title: 'T', meta: { city: 'X', profile: 'p' } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  test('Netzwerk-Timeout führt nach Retry-Erschöpfung zu ok=false', async () => {
    serverInfo = await startTestServer(() => { /* niemals antworten */ });
    process.env.ANALYSIS_SERVICE_BASE_URL = serverInfo.url;
    process.env.ANALYSIS_SERVICE_TIMEOUT_MS = '50';
    process.env.ANALYSIS_SERVICE_RETRIES = '1';
    process.env.ANALYSIS_SERVICE_RETRY_DELAY_MS = '5';

    const r = await loadClient().persistLocationBrief({ title: 'T', meta: { city: 'X', profile: 'p' } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/timeout/);
    expect(r.attempts).toBe(2);
  }, 10_000);
});

// ── Fallback bei Nichterreichbarkeit ─────────────────────────────────────────

describe('analysisServiceClient – Fallback bei Nichterreichbarkeit', () => {
  test('persistLocationBrief gegen unerreichbaren Port → ok=false, kein Throw', async () => {
    // Port 1 ist mit hoher Wahrscheinlichkeit nicht offen.
    process.env.ANALYSIS_SERVICE_BASE_URL = 'http://127.0.0.1:1';
    process.env.ANALYSIS_SERVICE_TIMEOUT_MS = '200';
    process.env.ANALYSIS_SERVICE_RETRIES = '0';

    const r = await loadClient().persistLocationBrief({ title: 'T', meta: { city: 'X', profile: 'p' } });
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
  });
});

// ── Read-Forwarder ───────────────────────────────────────────────────────────

describe('analysisServiceClient – Read-Forwarder', () => {
  let serverInfo;
  afterEach(() => new Promise((r) => serverInfo && serverInfo.server.close(r)));

  test('fetchByLocationKey URL-encoded und Antwort weitergereicht', async () => {
    serverInfo = await startTestServer((ctx, res) => {
      jsonReply(res, 200, [{ id: 'a', locationKey: 'hannover::x', profileKey: 'p' }]);
    });
    process.env.ANALYSIS_SERVICE_BASE_URL = serverInfo.url;
    const r = await loadClient().fetchByLocationKey('hannover::altenbekener damm');
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data)).toBe(true);
    expect(serverInfo.calls[0].url).toBe('/api/location-briefs/by-location/hannover%3A%3Aaltenbekener%20damm');
  });

  test('fetchTopByCityProfile mit Limit-Clamping', async () => {
    serverInfo = await startTestServer((ctx, res) => {
      jsonReply(res, 200, []);
    });
    process.env.ANALYSIS_SERVICE_BASE_URL = serverInfo.url;
    const r = await loadClient().fetchTopByCityProfile('Bonn', 'safety_first', 9999);
    expect(r.ok).toBe(true);
    expect(serverInfo.calls[0].url).toBe('/api/location-briefs/top?city=Bonn&profile=safety_first&limit=100');
  });

  test('fetchByCity erlaubt optionale profile/page/size', async () => {
    serverInfo = await startTestServer((ctx, res) => {
      jsonReply(res, 200, []);
    });
    process.env.ANALYSIS_SERVICE_BASE_URL = serverInfo.url;
    const r = await loadClient().fetchByCity('Hannover', { profile: 'p', page: 1, size: 5 });
    expect(r.ok).toBe(true);
    const u = serverInfo.calls[0].url;
    expect(u).toMatch(/^\/api\/location-briefs\?/);
    expect(u).toMatch(/city=Hannover/);
    expect(u).toMatch(/profile=p/);
    expect(u).toMatch(/page=1/);
    expect(u).toMatch(/size=5/);
  });

  test('Pflichtparameter werden geprüft', async () => {
    process.env.ANALYSIS_SERVICE_BASE_URL = 'http://127.0.0.1:1';
    const c = loadClient();
    expect((await c.fetchByLocationKey('')).error).toMatch(/locationKey_required/);
    expect((await c.fetchTopByCityProfile('', 'p')).error).toMatch(/city_and_profile_required/);
    expect((await c.fetchByCity('')).error).toMatch(/city_required/);
  });
});
