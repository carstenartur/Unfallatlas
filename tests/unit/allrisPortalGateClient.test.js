/** @jest-environment node */
'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const clientPath = path.resolve(__dirname, '../../server/political-context/providers/allrisPortalGateClient.js');
// Keep the initial red phase an assertion failure for the missing public API.
const allris = fs.existsSync(clientPath) ? require(clientPath) : {};
const bonn = require('../../server/political-context/providers/bonnPortalGateClient.js');
const BASE = 'https://ris.hannit.de';
const BONN_BASE = 'https://www.bonn.sitzung-online.de';
const TARGET = `${BASE}/public/vo020?VOLFDNR=123`;
const GATE = '<title>Zugriff pruefen</title><form action="/public/_gate/verify"><altcha-widget challengeurl="/public/_gate/challenge"></altcha-widget></form>';

function challenge(overrides = {}) {
  const salt = 'public-gate-test-salt';
  return {
    algorithm: 'SHA-256', salt, maxnumber: 9,
    challenge: crypto.createHash('sha256').update(`${salt}7`).digest('hex'),
    signature: 'server-issued-signature', ...overrides,
  };
}

function response(url, text, extra = {}) {
  return { url, status: 200, text, location: '', setCookie: [], ...extra };
}

function gateTransport({ verifyStatus = 303, verifyLocation = '/public/vo020?VOLFDNR=123', stillGated = false, challengeValue = challenge() } = {}) {
  const calls = [];
  let verified = false;
  const requestImpl = async (url, options) => {
    calls.push({ url, ...options });
    if (url === `${BASE}/public/_gate/challenge`) return response(url, JSON.stringify(challengeValue));
    if (url === `${BASE}/public/_gate/verify`) {
      const form = new URLSearchParams(options.body);
      const payload = JSON.parse(Buffer.from(form.get('altcha'), 'base64').toString('utf8'));
      expect(form.get('next')).toBe('/public/vo020?VOLFDNR=123');
      expect(payload).toEqual({ algorithm: 'SHA-256', challenge: challengeValue.challenge, number: 7, salt: challengeValue.salt, signature: challengeValue.signature });
      expect(options.method).toBe('POST');
      expect(options.headers.Cookie).toBe('gate_nonce=official');
      expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      verified = verifyStatus === 303;
      return response(url, '', { status: verifyStatus, location: verifyLocation, setCookie: ['portal_session=accepted; Secure; HttpOnly; Path=/'] });
    }
    if (verified && !stillGated) {
      expect(options.headers.Cookie).toBe('gate_nonce=official; portal_session=accepted');
      return response(url, '<html>Public document 123</html>');
    }
    return response(url, GATE, { setCookie: ['gate_nonce=official; Secure; HttpOnly; Path=/'] });
  };
  return { calls, requestImpl };
}

function createSession(options = {}) {
  expect(allris.createAllrisPortalSession).toEqual(expect.any(Function));
  return allris.createAllrisPortalSession({ portalBase: BASE, ...options });
}

describe('official ALLRIS public gate sessions', () => {
  test('confirms the published challenge once and retains cookies for the selected portal', async () => {
    const transport = gateTransport();
    const session = createSession(transport);
    expect(await session.fetchHtml(TARGET)).toBe('<html>Public document 123</html>');
    expect(transport.calls.map(call => call.url)).toEqual([TARGET, `${BASE}/public/_gate/challenge`, `${BASE}/public/_gate/verify`, TARGET]);
    expect(session.lastUnlock).toMatchObject({ algorithm: 'SHA-256', maxnumber: 9, solutionNumber: 7, cookieNames: ['gate_nonce', 'portal_session'] });
    expect(await session.fetchHtml(`${BASE}/public/vo020?VOLFDNR=124`)).toContain('Public document');
    expect(transport.calls).toHaveLength(5);
  });

  test('reads already-open pages without requesting a challenge', async () => {
    const calls = [];
    const session = createSession({ requestImpl: async (url, options) => { calls.push({ url, options }); return response(url, '<html>Open</html>'); } });
    expect(await session.fetchHtml('/public/')).toBe('<html>Open</html>');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/public/`);
    expect(session.lastUnlock).toBeNull();
  });

  test.each(['https://example.org', BONN_BASE, 'http://ris.hannit.de', 'https://ris.hannit.de:444', 'https://visitor@ris.hannit.de'])('denies redirect %s before sending session cookies to it', async destination => {
    const calls = [];
    const session = createSession({ requestImpl: async (url, options) => {
      calls.push({ url, options });
      return response(url, '', { status: 302, location: `${destination}/public/`, setCookie: ['session=private; Secure'] });
    } });
    await expect(session.request(TARGET)).rejects.toMatchObject({ code: expect.stringMatching(/^ALLRIS_PORTAL_(INVALID_URL|UNTRUSTED_ORIGIN)$/) });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TARGET);
  });

  test.each([
    'https://example.org', 'http://ris.hannit.de', 'https://name:secret@ris.hannit.de', 'https://@ris.hannit.de',
    'https://ris.hannit.de:443', 'https://ris.hannit.de:444', 'https://ris.hannit.de/public/',
    'https://ris.hannit.de?next=other', 'https://ris.hannit.de#anchor', '', null,
  ])('rejects invalid or unapproved portal base %s', portalBase => {
    expect(allris.createAllrisPortalSession).toEqual(expect.any(Function));
    expect(() => allris.createAllrisPortalSession({ portalBase })).toThrow();
  });

  test.each([BASE, BONN_BASE, 'https://bonn.sitzung-online.de', 'https://www2.bonn.de'])('accepts the explicit official origin %s', portalBase => {
    expect(allris.createAllrisPortalSession).toEqual(expect.any(Function));
    expect(allris.createAllrisPortalSession({ portalBase }).portalBase).toBe(portalBase);
  });

  test('does not allow a caller to add an arbitrary allowed origin', () => {
    expect(allris.createAllrisPortalSession).toEqual(expect.any(Function));
    expect(() => allris.createAllrisPortalSession({ portalBase: 'https://example.org', allowedOrigins: ['https://example.org'] })).toThrow();
  });

  test('rejects a direct cross-origin target before any network operation', async () => {
    const requestImpl = jest.fn();
    await expect(createSession({ requestImpl }).request(`${BONN_BASE}/public/`)).rejects.toMatchObject({ code: 'ALLRIS_PORTAL_UNTRUSTED_ORIGIN' });
    expect(requestImpl).not.toHaveBeenCalled();
  });

  test('rejects protocol-relative next paths before any network operation', async () => {
    const requestImpl = jest.fn();
    await expect(createSession({ requestImpl }).request(`${BASE}//example.org/public/`)).rejects.toMatchObject({ code: 'ALLRIS_PORTAL_INVALID_URL' });
    expect(requestImpl).not.toHaveBeenCalled();
  });

  test('rejects sharing the same cookie jar between portal origins', () => {
    const session = createSession();
    session.jar.absorb(['session=hannover-only; Secure']);
    expect(() => allris.createAllrisPortalSession({ portalBase: BONN_BASE, cookieJar: session.jar })).toThrow();
  });

  test('denies a cross-origin verification redirect before disclosing gate cookies', async () => {
    const transport = gateTransport({ verifyLocation: `${BONN_BASE}/public/` });
    await expect(createSession(transport).fetchHtml(TARGET)).rejects.toMatchObject({ code: 'ALLRIS_PORTAL_UNTRUSTED_ORIGIN' });
    expect(transport.calls).toHaveLength(3);
  });

  test('honors a rejected verification without retrying the challenge', async () => {
    const transport = gateTransport({ verifyStatus: 403 });
    await expect(createSession(transport).fetchHtml(TARGET)).rejects.toMatchObject({ code: 'ALLRIS_PORTAL_VERIFY_FAILED' });
    expect(transport.calls).toHaveLength(3);
  });

  test('stops when the requested page remains gated after one confirmation', async () => {
    const transport = gateTransport({ stillGated: true });
    await expect(createSession(transport).fetchHtml(TARGET)).rejects.toMatchObject({ code: 'ALLRIS_PORTAL_GATE_REJECTED' });
    expect(transport.calls).toHaveLength(4);
  });

  test.each([
    [{ algorithm: 'MD5' }, 'ALLRIS_PORTAL_UNSUPPORTED_ALGORITHM'],
    [{ maxnumber: 1_000_001 }, 'ALLRIS_PORTAL_UNSAFE_CHALLENGE'],
    [{ salt: 'test?expires=1' }, 'ALLRIS_PORTAL_CHALLENGE_EXPIRED'],
    [{ signature: '' }, 'ALLRIS_PORTAL_INVALID_CHALLENGE'],
    [{ challenge: '0'.repeat(64) }, 'ALLRIS_PORTAL_SOLUTION_NOT_FOUND'],
  ])('rejects unsafe or invalid challenges without posting (%s)', async (overrides, code) => {
    const transport = gateTransport({ challengeValue: challenge(overrides) });
    await expect(createSession(transport).fetchHtml(TARGET)).rejects.toMatchObject({ code });
    expect(transport.calls).toHaveLength(2);
  });

  test('cannot raise the fixed proof-of-work cap through session options', async () => {
    const transport = gateTransport({ challengeValue: challenge({ maxnumber: 1_000_001 }) });
    await expect(createSession({ ...transport, maxAltchaNumber: 2_000_000 }).fetchHtml(TARGET)).rejects.toMatchObject({ code: 'ALLRIS_PORTAL_UNSAFE_CHALLENGE' });
  });

  test('bounds redirects on the same origin', async () => {
    const calls = [];
    const session = createSession({ maxRedirects: 1, requestImpl: async url => { calls.push(url); return response(url, '', { status: 302, location: '/public/again' }); } });
    await expect(session.fetchHtml(TARGET)).rejects.toMatchObject({ code: 'ALLRIS_PORTAL_TOO_MANY_REDIRECTS' });
    expect(calls).toHaveLength(2);
  });

  test('concurrent gated requests return each requested document after a single confirmation', async () => {
    let verified = false;
    const calls = [];
    const requestImpl = async (url, options) => {
      calls.push(url);
      if (url.endsWith('/_gate/challenge')) return response(url, JSON.stringify(challenge()));
      if (url.endsWith('/_gate/verify')) {
        verified = true;
        return response(url, '', { status: 303, location: new URLSearchParams(options.body).get('next') });
      }
      return response(url, verified ? `<html>${new URL(url).searchParams.get('VOLFDNR')}</html>` : GATE);
    };
    const session = createSession({ requestImpl });
    const documents = await Promise.all([session.fetchHtml(TARGET), session.fetchHtml(`${BASE}/public/vo020?VOLFDNR=456`)]);
    expect(documents).toEqual(['<html>123</html>', '<html>456</html>']);
    expect(calls.filter(url => url.endsWith('/_gate/challenge'))).toHaveLength(1);
  });

  test.each([[200, 'not-json', 'ALLRIS_PORTAL_INVALID_CHALLENGE'], [429, '{}', 'ALLRIS_PORTAL_HTTP_ERROR']])('stops on invalid challenge response %s', async (status, body, code) => {
    const calls = [];
    const session = createSession({ requestImpl: async url => {
      calls.push(url);
      return url.endsWith('/_gate/challenge') ? response(url, body, { status }) : response(url, GATE);
    } });
    await expect(session.fetchHtml(TARGET)).rejects.toMatchObject({ code });
    expect(calls).toHaveLength(2);
  });

  test('resolves a relative redirect against the response URL within the selected origin', async () => {
    const calls = [];
    const session = createSession({ requestImpl: async url => {
      calls.push(url);
      return calls.length === 1 ? response(url, '', { status: 302, location: 'vo020?VOLFDNR=789' }) : response(url, '<html>789</html>');
    } });
    expect(await session.fetchHtml(TARGET)).toBe('<html>789</html>');
    expect(calls[1]).toBe(`${BASE}/public/vo020?VOLFDNR=789`);
  });

  test.each([401, 403, 429, 503])('does not attempt gate confirmation after explicit HTTP %s rejection', async status => {
    const calls = [];
    const session = createSession({ requestImpl: async url => { calls.push(url); return response(url, GATE, { status }); } });
    await expect(session.fetchHtml(TARGET)).rejects.toMatchObject({ code: 'ALLRIS_PORTAL_HTTP_ERROR' });
    expect(calls).toHaveLength(1);
  });

  test('preserves Bonn exports, solver results and legacy error class and codes', async () => {
    expect(Object.keys(bonn).sort()).toEqual([
      'PORTAL_BASE', 'CHALLENGE_URL', 'VERIFY_URL', 'MAX_ALTCHA_NUMBER', 'BonnPortalGateError', 'BonnPortalGateErrorCode',
      'CookieJar', 'requestRaw', 'isGateHtml', 'challengeJson', 'solveAltchaV1', 'encodeAltchaPayload',
      'createBonnPortalSession', 'sharedSession', 'fetchHtmlWithGate',
    ].sort());
    expect(bonn.solveAltchaV1(challenge())).toMatchObject({ number: 7 });
    try { bonn.solveAltchaV1(challenge({ algorithm: 'MD5' })); throw new Error('expected challenge failure'); }
    catch (error) { expect(error).toBeInstanceOf(bonn.BonnPortalGateError); expect(error.code).toBe('BONN_PORTAL_UNSUPPORTED_ALGORITHM'); }
    const session = bonn.createBonnPortalSession({ requestImpl: async url => response(url, '', { status: 503 }) });
    await expect(session.fetchHtml(`${BONN_BASE}/public/`)).rejects.toBeInstanceOf(bonn.BonnPortalGateError);
    await expect(session.fetchHtml(`${BONN_BASE}/public/`)).rejects.toMatchObject({ code: 'BONN_PORTAL_HTTP_ERROR' });
  });
});
