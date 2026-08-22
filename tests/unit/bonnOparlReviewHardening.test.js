'use strict';

const http = require('http');
const { once } = require('events');
const catalogueDiscovery = require('../../scripts/qa-bonn-oparl-catalogue-discovery.js');
const client = require('../../server/political-context/providers/bonnOparlClient.js');

describe('Bonn OParl review hardening', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, { Location: '/middle' });
        response.end();
        return;
      }
      if (request.url === '/middle') {
        response.writeHead(307, { Location: '/final' });
        response.end();
        return;
      }
      if (request.url === '/final') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end('{"ok":true}');
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (!server) return;
    server.close();
    await once(server, 'close');
  });

  test('keeps the initial URL, final URL and complete redirect chain distinct', async () => {
    const response = await catalogueDiscovery.requestText(`${baseUrl}/start`, {
      timeoutMs: 5_000,
    });

    expect(response).toMatchObject({
      requestedUrl: `${baseUrl}/start`,
      finalUrl: `${baseUrl}/final`,
      status: 200,
      text: '{"ok":true}',
    });
    expect(response.redirectChain).toEqual([
      {
        status: 302,
        fromUrl: `${baseUrl}/start`,
        toUrl: `${baseUrl}/middle`,
      },
      {
        status: 307,
        fromUrl: `${baseUrl}/middle`,
        toUrl: `${baseUrl}/final`,
      },
    ]);

    expect(catalogueDiscovery.responseEvidence('test', response)).toMatchObject({
      requestedUrl: `${baseUrl}/start`,
      finalUrl: `${baseUrl}/final`,
      redirectChain: response.redirectChain,
      jsonParsed: true,
    });
  });

  test('maps the reliable business date and never exposes Bonn placeholder created dates', () => {
    const matchedTerm = { value: 'Adenauerallee', normalized: 'adenauerallee' };
    const common = {
      name: 'Radverkehr in der Adenauerallee',
      web: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=123',
      id: 'https://www.bonn.sitzung-online.de/oparl/papers/123',
      created: '1970-01-01T00:00:00Z',
    };

    const withModified = client.mapPaper({
      ...common,
      modified: '2026-04-05T13:45:00Z',
    }, matchedTerm);
    expect(withModified.date).toBe('2026-04-05');

    const createdOnly = client.mapPaper(common, matchedTerm);
    expect(createdOnly.date == null).toBe(true);
  });
});
