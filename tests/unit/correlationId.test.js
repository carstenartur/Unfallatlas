'use strict';

/**
 * Tests für `server/lib/correlationId.js`:
 *  - Whitelisting eingehender IDs
 *  - Generierung neuer IDs
 *  - Express-Middleware-Verhalten (Header gespiegelt, req-Property
 *    gesetzt, AsyncLocalStorage liefert die ID innerhalb der Anfrage,
 *    außerhalb null).
 */

const http = require('http');
const {
  HEADER_NAME,
  ID_PATTERN,
  generateId,
  isAcceptableId,
  getCurrentCorrelationId,
  correlationIdMiddleware
} = require('../../server/lib/correlationId.js');

describe('correlationId – isAcceptableId/ID_PATTERN', () => {
  test('akzeptiert übliche Tracing-Tokens', () => {
    expect(isAcceptableId('1234abcd')).toBe(true);
    expect(isAcceptableId('req.42_b:7-x')).toBe(true);
    expect(ID_PATTERN.test('A'.repeat(128))).toBe(true);
  });
  test('lehnt zu kurze, zu lange und unerlaubte Zeichen ab', () => {
    expect(isAcceptableId('abc')).toBe(false);            // <4
    expect(isAcceptableId('A'.repeat(129))).toBe(false);  // >128
    expect(isAcceptableId('with space')).toBe(false);
    expect(isAcceptableId('newline\n')).toBe(false);
    expect(isAcceptableId('quote"x')).toBe(false);
    expect(isAcceptableId(null)).toBe(false);
    expect(isAcceptableId(undefined)).toBe(false);
    expect(isAcceptableId(12345)).toBe(false);
  });
});

describe('correlationId – generateId', () => {
  test('liefert 16 Hex-Zeichen, die das Whitelisting passieren', () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(isAcceptableId(id)).toBe(true);
  });
  test('zwei Aufrufe ergeben unterschiedliche Werte', () => {
    expect(generateId()).not.toBe(generateId());
  });
});

describe('correlationId – getCurrentCorrelationId außerhalb einer Anfrage', () => {
  test('liefert null, wenn kein AsyncLocalStorage-Frame aktiv ist', () => {
    expect(getCurrentCorrelationId()).toBeNull();
  });
});

describe('correlationId – correlationIdMiddleware', () => {
  let server;
  let port;

  beforeEach(() => new Promise((resolve) => {
    // Minimaler HTTP-Server, der die Middleware durchläuft und die
    // beobachteten Werte als JSON zurückgibt.  Wir konstruieren das
    // req/res-Objekt so, dass es der Express-Vertrag erfüllt
    // (`req.get`, `res.setHeader`, `res.locals`).
    const mw = correlationIdMiddleware();
    server = http.createServer((req, res) => {
      // Express-kompatible Helfer auf dem Node-Request nachrüsten
      req.get = (name) => req.headers[String(name).toLowerCase()];
      res.locals = {};
      mw(req, res, () => {
        const inAls = getCurrentCorrelationId();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          reqCorrelationId:    req.correlationId,
          resLocalsId:         res.locals.correlationId,
          asyncLocalStorageId: inAls
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  }));

  afterEach(() => new Promise((r) => server.close(r)));

  function fetchJson(headers) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/', method: 'GET', headers: headers || {} },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({
            status:  res.statusCode,
            headers: res.headers,
            body:    JSON.parse(Buffer.concat(chunks).toString('utf8'))
          }));
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  test('generiert neue ID, wenn kein Header gesetzt ist', async () => {
    const r = await fetchJson();
    expect(r.status).toBe(200);
    expect(r.body.reqCorrelationId).toMatch(/^[0-9a-f]{16}$/);
    expect(r.body.resLocalsId).toBe(r.body.reqCorrelationId);
    expect(r.body.asyncLocalStorageId).toBe(r.body.reqCorrelationId);
    expect(r.headers['x-correlation-id']).toBe(r.body.reqCorrelationId);
  });

  test('übernimmt eingehenden Header, wenn er das Whitelisting passiert', async () => {
    const r = await fetchJson({ [HEADER_NAME]: 'caller-abc-123' });
    expect(r.body.reqCorrelationId).toBe('caller-abc-123');
    expect(r.headers['x-correlation-id']).toBe('caller-abc-123');
  });

  test('verwirft eingehende ID mit unerlaubten Zeichen und generiert eine neue', async () => {
    const r = await fetchJson({ [HEADER_NAME]: 'has space and "quote"' });
    expect(r.body.reqCorrelationId).not.toBe('has space and "quote"');
    expect(r.body.reqCorrelationId).toMatch(/^[0-9a-f]{16}$/);
  });

  test('verwirft zu kurze IDs', async () => {
    const r = await fetchJson({ [HEADER_NAME]: 'ab' });
    expect(r.body.reqCorrelationId).toMatch(/^[0-9a-f]{16}$/);
  });
});
