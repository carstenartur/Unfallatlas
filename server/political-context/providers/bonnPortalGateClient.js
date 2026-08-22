'use strict';

/**
 * Session-aware client for the official Bonn ALLRIS portal.
 *
 * The public portal protects HTML pages with a published ALTCHA v1
 * proof-of-work challenge. This client follows that contract exactly:
 * fetch challenge, solve the bounded hash puzzle, submit the signed payload,
 * retain the official session cookies and then perform the requested portal
 * operation. It does not bypass, replay or weaken the gate.
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const {
  assertAllowedNetworkUrl,
  normalizeUrl,
} = require('./bonnOparlHttp.js');

const PORTAL_BASE = 'https://www.bonn.sitzung-online.de';
const CHALLENGE_URL = `${PORTAL_BASE}/public/_gate/challenge`;
const VERIFY_URL = `${PORTAL_BASE}/public/_gate/verify`;
const DEFAULT_TIMEOUT_MS = Number(process.env.PORTAL_SEARCH_TIMEOUT_MS) || 10_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const MAX_ALTCHA_NUMBER = 1_000_000;

const BonnPortalGateErrorCode = Object.freeze({
  HTTP_ERROR: 'BONN_PORTAL_HTTP_ERROR',
  INVALID_CHALLENGE: 'BONN_PORTAL_INVALID_CHALLENGE',
  UNSUPPORTED_ALGORITHM: 'BONN_PORTAL_UNSUPPORTED_ALGORITHM',
  UNSAFE_CHALLENGE: 'BONN_PORTAL_UNSAFE_CHALLENGE',
  CHALLENGE_EXPIRED: 'BONN_PORTAL_CHALLENGE_EXPIRED',
  SOLUTION_NOT_FOUND: 'BONN_PORTAL_SOLUTION_NOT_FOUND',
  VERIFY_FAILED: 'BONN_PORTAL_VERIFY_FAILED',
  GATE_REJECTED: 'BONN_PORTAL_GATE_REJECTED',
  RESPONSE_TOO_LARGE: 'BONN_PORTAL_RESPONSE_TOO_LARGE',
  TOO_MANY_REDIRECTS: 'BONN_PORTAL_TOO_MANY_REDIRECTS',
});

class BonnPortalGateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BonnPortalGateError';
    this.code = code;
    this.details = details;
  }
}

class CookieJar {
  constructor() {
    this.values = new Map();
  }

  absorb(values) {
    for (const value of Array.isArray(values) ? values : []) {
      const pair = String(value || '').split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const content = pair.slice(separator + 1).trim();
      if (!name) continue;
      if (content) this.values.set(name, content);
      else this.values.delete(name);
    }
  }

  header() {
    return [...this.values.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  names() {
    return [...this.values.keys()];
  }

  clear() {
    this.values.clear();
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function requestRaw(urlValue, options = {}) {
  const url = assertAllowedNetworkUrl(urlValue);
  const parsed = new URL(url);
  const transport = parsed.protocol === 'http:' ? http : https;
  const method = String(options.method || 'GET').toUpperCase();
  const body = options.body == null ? null : Buffer.from(String(options.body), 'utf8');
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
  const headers = {
    Accept: options.accept || 'text/html, application/xhtml+xml;q=0.9, application/json;q=0.5, */*;q=0.1',
    'User-Agent': 'Unfallwerkbank-Bonn-Portal/1.0 (+https://github.com/carstenartur/Unfallatlas)',
    ...(options.headers || {}),
  };
  if (body) headers['Content-Length'] = String(body.length);

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = transport.request(parsed, { method, timeout: timeoutMs, headers }, response => {
      const status = Number(response.statusCode || 0);
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) {
          const error = new BonnPortalGateError(
            BonnPortalGateErrorCode.RESPONSE_TOO_LARGE,
            `Bonner Portalantwort überschreitet ${maxBytes} Byte: ${url}`,
            { url, maxBytes }
          );
          response.destroy(error);
          fail(error);
          return;
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({
          url,
          status,
          contentType: String(response.headers['content-type'] || ''),
          location: response.headers.location
            ? normalizeUrl(response.headers.location, url)
            : '',
          setCookie: Array.isArray(response.headers['set-cookie'])
            ? response.headers['set-cookie']
            : [],
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
      response.on('error', fail);
    });
    req.on('timeout', () => req.destroy(new BonnPortalGateError(
      BonnPortalGateErrorCode.HTTP_ERROR,
      `Bonner Portal-Timeout nach ${timeoutMs} ms: ${url}`,
      { url, timeoutMs }
    )));
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

function isRedirect(status) {
  return status >= 300 && status < 400;
}

function redirectMethod(status, method) {
  if (status === 307 || status === 308) return method;
  return 'GET';
}

function isGateHtml(value) {
  const html = String(value || '');
  return /<title[^>]*>\s*Zugriff\s+pruefen\s*<\/title>/i.test(html)
    || /action=["'][^"']*\/_gate\/verify["']/i.test(html)
    || /<altcha-widget\b/i.test(html);
}

function challengeJson(response) {
  if (!response || response.status < 200 || response.status >= 300) {
    throw new BonnPortalGateError(
      BonnPortalGateErrorCode.HTTP_ERROR,
      `ALTCHA-Challenge lieferte HTTP ${response && response.status}: ${CHALLENGE_URL}`,
      { status: response && response.status, url: CHALLENGE_URL }
    );
  }
  try {
    const value = JSON.parse(String(response.text || '').replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('kein Objekt');
    return value;
  } catch (error) {
    throw new BonnPortalGateError(
      BonnPortalGateErrorCode.INVALID_CHALLENGE,
      `Ungültige ALTCHA-Challenge vom Bonner Portal: ${error.message}`,
      { status: response.status, contentType: response.contentType }
    );
  }
}

function nodeHashAlgorithm(value) {
  const normalized = String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!['sha1', 'sha256', 'sha512'].includes(normalized)) {
    throw new BonnPortalGateError(
      BonnPortalGateErrorCode.UNSUPPORTED_ALGORITHM,
      `Nicht unterstützter ALTCHA-v1-Algorithmus: ${String(value || '')}`,
      { algorithm: String(value || '') }
    );
  }
  return normalized;
}

function challengeExpiration(salt) {
  const query = String(salt || '').split('?')[1] || '';
  const raw = new URLSearchParams(query).get('expires')
    || new URLSearchParams(query).get('expire');
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function solveAltchaV1(challenge, options = {}) {
  if (!challenge || typeof challenge !== 'object') {
    throw new BonnPortalGateError(
      BonnPortalGateErrorCode.INVALID_CHALLENGE,
      'Die ALTCHA-Challenge ist kein Objekt.'
    );
  }
  const algorithm = nodeHashAlgorithm(challenge.algorithm);
  const maxnumber = Number(challenge.maxnumber ?? challenge.maxNumber);
  const configuredMax = positiveInteger(options.maxNumber, MAX_ALTCHA_NUMBER);
  if (!Number.isInteger(maxnumber) || maxnumber < 0 || maxnumber > configuredMax) {
    throw new BonnPortalGateError(
      BonnPortalGateErrorCode.UNSAFE_CHALLENGE,
      `Unsichere ALTCHA-Suchgrenze: ${String(challenge.maxnumber ?? challenge.maxNumber)}`,
      { maxnumber, configuredMax }
    );
  }
  const salt = String(challenge.salt || '');
  const expected = String(challenge.challenge || '').toLowerCase();
  const signature = String(challenge.signature || '');
  if (!salt || salt.length > 4_096 || !/^[0-9a-f]+$/i.test(expected) || !signature) {
    throw new BonnPortalGateError(
      BonnPortalGateErrorCode.INVALID_CHALLENGE,
      'Die ALTCHA-Challenge enthält ungültige Hash-, Salt- oder Signaturfelder.'
    );
  }
  const expiresAt = challengeExpiration(salt);
  const now = options.now instanceof Date ? options.now.getTime() : Number(options.now || Date.now());
  if (expiresAt && expiresAt <= now) {
    throw new BonnPortalGateError(
      BonnPortalGateErrorCode.CHALLENGE_EXPIRED,
      'Die ALTCHA-Challenge ist bereits abgelaufen.',
      { expiresAt }
    );
  }

  const started = Date.now();
  for (let number = 0; number <= maxnumber; number++) {
    const digest = crypto.createHash(algorithm)
      .update(salt + number, 'utf8')
      .digest('hex');
    if (digest === expected) {
      return { number, tookMs: Date.now() - started };
    }
  }
  throw new BonnPortalGateError(
    BonnPortalGateErrorCode.SOLUTION_NOT_FOUND,
    `Keine ALTCHA-Lösung im veröffentlichten Bereich 0..${maxnumber} gefunden.`,
    { maxnumber }
  );
}

function encodeAltchaPayload(challenge, solution) {
  return Buffer.from(JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    number: solution.number,
    salt: challenge.salt,
    signature: challenge.signature,
  }), 'utf8').toString('base64');
}

function nextPath(urlValue) {
  const url = new URL(assertAllowedNetworkUrl(urlValue));
  return `${url.pathname}${url.search}`;
}

class BonnPortalSession {
  constructor(options = {}) {
    this.requestImpl = options.requestImpl || requestRaw;
    this.jar = options.cookieJar || new CookieJar();
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
    this.maxRedirects = positiveInteger(options.maxRedirects, DEFAULT_MAX_REDIRECTS);
    this.maxAltchaNumber = positiveInteger(options.maxAltchaNumber, MAX_ALTCHA_NUMBER);
    this.unlockPromise = null;
    this.lastUnlock = null;
  }

  async _request(urlValue, options = {}, redirectCount = 0) {
    const url = assertAllowedNetworkUrl(urlValue);
    const method = String(options.method || 'GET').toUpperCase();
    const cookie = this.jar.header();
    const response = await this.requestImpl(url, {
      ...options,
      method,
      timeoutMs: positiveInteger(options.timeoutMs, this.timeoutMs),
      maxBytes: positiveInteger(options.maxBytes, this.maxBytes),
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(options.headers || {}),
      },
    });
    this.jar.absorb(response && response.setCookie);
    if (options.followRedirects !== false && response && isRedirect(response.status) && response.location) {
      if (redirectCount >= this.maxRedirects) {
        throw new BonnPortalGateError(
          BonnPortalGateErrorCode.TOO_MANY_REDIRECTS,
          `Zu viele Weiterleitungen beim Bonner Portalabruf: ${url}`,
          { url, redirectCount }
        );
      }
      const nextMethod = redirectMethod(response.status, method);
      return this._request(response.location, {
        ...options,
        method: nextMethod,
        body: nextMethod === 'GET' ? null : options.body,
      }, redirectCount + 1);
    }
    return response;
  }

  async _unlock(targetUrl) {
    if (this.unlockPromise) return this.unlockPromise;
    this.unlockPromise = (async () => {
      const challengeResponse = await this._request(CHALLENGE_URL, {
        accept: 'application/json, */*;q=0.1',
      });
      const challenge = challengeJson(challengeResponse);
      const solution = solveAltchaV1(challenge, { maxNumber: this.maxAltchaNumber });
      const form = new URLSearchParams({
        next: nextPath(targetUrl),
        altcha: encodeAltchaPayload(challenge, solution),
      });
      const verify = await this._request(VERIFY_URL, {
        method: 'POST',
        body: form.toString(),
        followRedirects: false,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: targetUrl,
        },
      });
      if (!verify || ![200, 201, 202, 204, 302, 303].includes(verify.status)) {
        throw new BonnPortalGateError(
          BonnPortalGateErrorCode.VERIFY_FAILED,
          `Das Bonner Portal lehnte die ALTCHA-Lösung mit HTTP ${verify && verify.status} ab.`,
          { status: verify && verify.status }
        );
      }
      const destination = verify.location || targetUrl;
      const portal = await this._request(destination);
      if (!portal || portal.status < 200 || portal.status >= 400 || isGateHtml(portal.text)) {
        throw new BonnPortalGateError(
          BonnPortalGateErrorCode.GATE_REJECTED,
          'Das Bonner Portal blieb nach einer gültigen ALTCHA-Lösung gesperrt.',
          { status: portal && portal.status, destination }
        );
      }
      this.lastUnlock = {
        at: new Date().toISOString(),
        algorithm: challenge.algorithm,
        maxnumber: challenge.maxnumber ?? challenge.maxNumber,
        solutionNumber: solution.number,
        solutionMs: solution.tookMs,
        cookieNames: this.jar.names(),
      };
      return portal;
    })();
    try {
      return await this.unlockPromise;
    } finally {
      this.unlockPromise = null;
    }
  }

  async request(urlValue, options = {}) {
    const url = assertAllowedNetworkUrl(urlValue);
    const method = String(options.method || 'GET').toUpperCase();
    let response = await this._request(url, options);
    if (!isGateHtml(response && response.text)) return response;

    const unlocked = await this._unlock(url);
    if (method === 'GET' && !options.body) return unlocked;
    response = await this._request(url, options);
    if (isGateHtml(response && response.text)) {
      throw new BonnPortalGateError(
        BonnPortalGateErrorCode.GATE_REJECTED,
        'Das Bonner Portal verlangte unmittelbar nach erfolgreicher Prüfung erneut ALTCHA.',
        { url }
      );
    }
    return response;
  }

  async fetchHtml(urlValue, options = {}) {
    const response = await this.request(urlValue, options);
    if (!response || response.status < 200 || response.status >= 300) {
      throw new BonnPortalGateError(
        BonnPortalGateErrorCode.HTTP_ERROR,
        `Bonner Portal HTTP ${response && response.status}: ${String(urlValue || '')}`,
        { status: response && response.status, url: String(urlValue || '') }
      );
    }
    return response.text;
  }
}

function createBonnPortalSession(options = {}) {
  return new BonnPortalSession(options);
}

const sharedSession = createBonnPortalSession();

function fetchHtmlWithGate(urlValue, options = {}) {
  return sharedSession.fetchHtml(urlValue, options);
}

module.exports = {
  PORTAL_BASE,
  CHALLENGE_URL,
  VERIFY_URL,
  MAX_ALTCHA_NUMBER,
  BonnPortalGateError,
  BonnPortalGateErrorCode,
  CookieJar,
  requestRaw,
  isGateHtml,
  challengeJson,
  solveAltchaV1,
  encodeAltchaPayload,
  createBonnPortalSession,
  sharedSession,
  fetchHtmlWithGate,
};
