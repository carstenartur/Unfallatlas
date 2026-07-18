/** @jest-environment node */
'use strict';

const express = require('express');
const { registerContextGenerationRoutes } = require('../../server/context-generation/routes');

async function withServer(env, fn) {
  const previous = {
    enabled: process.env.CONTEXT_GENERATION_ENABLED,
    token: process.env.CONTEXT_GENERATION_TOKEN,
  };
  if (env.enabled === undefined) delete process.env.CONTEXT_GENERATION_ENABLED;
  else process.env.CONTEXT_GENERATION_ENABLED = env.enabled;
  if (env.token === undefined) delete process.env.CONTEXT_GENERATION_TOKEN;
  else process.env.CONTEXT_GENERATION_TOKEN = env.token;

  const app = express();
  app.use(express.json());
  registerContextGenerationRoutes(app, { root: require('path').resolve(__dirname, '../..') });
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previous.enabled === undefined) delete process.env.CONTEXT_GENERATION_ENABLED;
    else process.env.CONTEXT_GENERATION_ENABLED = previous.enabled;
    if (previous.token === undefined) delete process.env.CONTEXT_GENERATION_TOKEN;
    else process.env.CONTEXT_GENERATION_TOKEN = previous.token;
  }
}

describe('context generation routes', () => {
  test('reports disabled generation without starting work', async () => {
    await withServer({ enabled: 'false' }, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/context-generation/status?city=Bonn`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.available).toBe(false);
      expect(body.reason).toBe('context_generation_disabled');
    });
  });

  test('requires configured token before validating or starting a job', async () => {
    await withServer({ enabled: 'true', token: 'secret-token' }, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/context-generation/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city: 'Bonn' }),
      });
      expect(response.status).toBe(401);
      expect((await response.json()).error).toBe('context_generation_unauthorized');
    });
  });

  test('rejects arbitrary city input even with a valid token', async () => {
    await withServer({ enabled: 'true', token: 'secret-token' }, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/context-generation/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret-token',
        },
        body: JSON.stringify({ city: 'Bonn; rm -rf /' }),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('context_generation_rejected');
    });
  });
});
