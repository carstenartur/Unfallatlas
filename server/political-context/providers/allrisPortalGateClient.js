'use strict';

/**
 * Session-aware client for explicitly approved official ALLRIS public portals.
 *
 * The public portal protects HTML pages with a published ALTCHA v1
 * proof-of-work challenge. This client follows that contract exactly:
 * fetch challenge, solve the bounded hash puzzle, submit the signed payload,
 * retain the official session cookies and then perform the requested portal
 * operation. It does not bypass, replay or weaken the gate.
 */

const crypto = require('crypto');
const https = require('https');
// This registry is intentionally independent of the Bonn OParl network policy.
// Callers select an origin here; they cannot add origins through client options.
const OFFICIAL_ALLRIS_ORIGINS = Object.freeze([
  'https://www.bonn.sitzung-online.de',
  'https://bonn.sitzung-online.de',
  'https://www2.bonn.de',
  'https://ris.hannit.de',
]);
const officialOrigins = new Set(OFFICIAL_ALLRIS_ORIGINS);
const cookieJarOrigins = new WeakMap();
const DEFAULT_TIMEOUT_MS = Number(process.env.PORTAL_SEARCH_TIMEOUT_MS) || 10_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const MAX_ALTCHA_NUMBER = 1_000_000;

const AllrisPortalGateErrorCode = Object.freeze({
  INVALID_URL: 'ALLRIS_PORTAL_INVALID_URL',
  UNTRUSTED_ORIGIN: 'ALLRIS_PORTAL_UNTRUSTED_ORIGIN',
  HTTP_ERROR: 'ALLRIS_PORTAL_HTTP_ERROR',
  INVALID_CHALLENGE: 'ALLRIS_PORTAL_INVALID_CHALLENGE',
  UNSUPPORTED_ALGORITHM: 'ALLRIS_PORTAL_UNSUPPORTED_ALGORITHM',
  UNSAFE_CHALLENGE: 'ALLRIS_PORTAL_UNSAFE_CHALLENGE',
  CHALLENGE_EXPIRED: 'ALLRIS_PORTAL_CHALLENGE_EXPIRED',
  SOLUTION_NOT_FOUND: 'ALLRIS_PORTAL_SOLUTION_NOT_FOUND',
  VERIFY_FAILED: 'ALLRIS_PORTAL_VERIFY_FAILED',
  GATE_REJECTED: 'ALLRIS_PORTAL_GATE_REJECTED',
  RESPONSE_TOO_LARGE: 'ALLRIS_PORTAL_RESPONSE_TOO_LARGE',
  TOO_MANY_REDIRECTS: 'ALLRIS_PORTAL_TOO_MANY_REDIRECTS',
});

class AllrisPortalGateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AllrisPortalGateError';
    this.code = code;
    this.details = details;
  }
}

function assertAllowedPortalUrl(value, base, relativeTo = base) {
  const raw = String(value == null ? '' : value).trim();
  const authority = raw.match(/^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/i);
  let url;
  try {
    // Explicit ports and userinfo are unnecessary for these fixed origins.
    if (!raw || /[\u0000-\u0020\u007f\\]/.test(raw)
      || (authority && /[@:]/.test(authority[1]))
      || (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https:\/\//i.test(raw))) {
      throw new Error('invalid URL syntax');
    }
    url = relativeTo ? new URL(raw, relativeTo) : new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname.startsWith('//')) {
      throw new Error('invalid public portal URL');
    }
  } catch (_) {
    throw new AllrisPortalGateError(AllrisPortalGateErrorCode.INVALID_URL, 'Ungültige öffentliche ALLRIS-URL.');
  }
  if (!officialOrigins.has(url.origin) || (base && url.origin !== base)) {
    throw new AllrisPortalGateError(
      AllrisPortalGateErrorCode.UNTRUSTED_ORIGIN,
      `Nicht zugelassener ALLRIS-Ursprung: ${url.origin}`,
      { origin: url.origin }
    );
  }
  return url.href;
}

function portalOrigin(value) {
  const url = new URL(assertAllowedPortalUrl(value));
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new AllrisPortalGateError(AllrisPortalGateErrorCode.INVALID_URL, 'portalBase muss ein offizieller HTTPS-Ursprung ohne Pfad sein.');
  }
  return url.origin;
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
  const url = assertAllowedPortalUrl(urlValue);
  const parsed = new URL(url);
  const transport = https;
  const method = String(options.method || 'GET').toUpperCase();
  const body = options.body == null ? null : Buffer.from(String(options.body), 'utf8');
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
  const headers = {
    Accept: options.accept || 'text/html, application/xhtml+xml;q=0.9, application/json;q=0.5, */*;q=0.1',
    'User-Agent': 'Unfallwerkbank-ALLRIS-Portal/1.0 (+https://github.com/carstenartur/Unfallatlas)',
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
          const error = new AllrisPortalGateError(
            AllrisPortalGateErrorCode.RESPONSE_TOO_LARGE,
            `ALLRIS-Portalantwort überschreitet ${maxBytes} Byte: ${url}`,
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
            ? String(response.headers.location)
            : '',
          setCookie: Array.isArray(response.headers['set-cookie'])
            ? response.headers['set-cookie']
            : [],
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
      response.on('error', fail);
    });
    req.on('timeout', () => req.destroy(new AllrisPortalGateError(
      AllrisPortalGateErrorCode.HTTP_ERROR,
      `ALLRIS-Portal-Timeout nach ${timeoutMs} ms: ${url}`,
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

function challengeJson(response, challengeUrl = response && response.url || '') {
  if (!response || response.status < 200 || response.status >= 300) {
    throw new AllrisPortalGateError(
      AllrisPortalGateErrorCode.HTTP_ERROR,
      `ALTCHA-Challenge lieferte HTTP ${response && response.status}: ${challengeUrl}`,
      { status: response && response.status, url: challengeUrl }
    );
  }
  try {
    const value = JSON.parse(String(response.text || '').replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('kein Objekt');
    return value;
  } catch (error) {
    throw new AllrisPortalGateError(
      AllrisPortalGateErrorCode.INVALID_CHALLENGE,
      `Ungültige ALTCHA-Challenge vom ALLRIS-Portal: ${error.message}`,
      { status: response.status, contentType: response.contentType }
    );
  }
}

function nodeHashAlgorithm(value) {
  const normalized = String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!['sha1', 'sha256', 'sha512'].includes(normalized)) {
    throw new AllrisPortalGateError(
      AllrisPortalGateErrorCode.UNSUPPORTED_ALGORITHM,
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
    throw new AllrisPortalGateError(
      AllrisPortalGateErrorCode.INVALID_CHALLENGE,
      'Die ALTCHA-Challenge ist kein Objekt.'
    );
  }
  const algorithm = nodeHashAlgorithm(challenge.algorithm);
  const maxnumber = Number(challenge.maxnumber ?? challenge.maxNumber);
  const configuredMax = Math.min(positiveInteger(options.maxNumber, MAX_ALTCHA_NUMBER), MAX_ALTCHA_NUMBER);
  if (!Number.isInteger(maxnumber) || maxnumber < 0 || maxnumber > configuredMax) {
    throw new AllrisPortalGateError(
      AllrisPortalGateErrorCode.UNSAFE_CHALLENGE,
      `Unsichere ALTCHA-Suchgrenze: ${String(challenge.maxnumber ?? challenge.maxNumber)}`,
      { maxnumber, configuredMax }
    );
  }
  const salt = String(challenge.salt || '');
  const expected = String(challenge.challenge || '').toLowerCase();
  const signature = String(challenge.signature || '');
  if (!salt || salt.length > 4_096 || !/^[0-9a-f]+$/i.test(expected) || !signature) {
    throw new AllrisPortalGateError(
      AllrisPortalGateErrorCode.INVALID_CHALLENGE,
      'Die ALTCHA-Challenge enthält ungültige Hash-, Salt- oder Signaturfelder.'
    );
  }
  const expiresAt = challengeExpiration(salt);
  const now = options.now instanceof Date ? options.now.getTime() : Number(options.now || Date.now());
  if (expiresAt && expiresAt <= now) {
    throw new AllrisPortalGateError(
      AllrisPortalGateErrorCode.CHALLENGE_EXPIRED,
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
  throw new AllrisPortalGateError(
    AllrisPortalGateErrorCode.SOLUTION_NOT_FOUND,
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

function nextPath(urlValue, origin) {
  const url = new URL(assertAllowedPortalUrl(urlValue, origin));
  return `${url.pathname}${url.search}`;
}

class AllrisPortalSession {
  constructor(options = {}) {
    const origin = portalOrigin(options.portalBase);
    Object.defineProperty(this, 'portalBase', { value: origin, enumerable: true });
    this.challengeUrl = `${origin}/public/_gate/challenge`;
    this.verifyUrl = `${origin}/public/_gate/verify`;
    this.requestImpl = options.requestImpl || requestRaw;
    this.jar = options.cookieJar || new CookieJar();
    const jarOrigin = cookieJarOrigins.get(this.jar);
    if (jarOrigin && jarOrigin !== origin) {
      throw new AllrisPortalGateError(AllrisPortalGateErrorCode.UNTRUSTED_ORIGIN, 'Ein ALLRIS-Cookie-Speicher darf nicht zwischen Ursprüngen geteilt werden.');
    }
    cookieJarOrigins.set(this.jar, origin);
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
    this.maxRedirects = positiveInteger(options.maxRedirects, DEFAULT_MAX_REDIRECTS);
    this.maxAltchaNumber = Math.min(positiveInteger(options.maxAltchaNumber, MAX_ALTCHA_NUMBER), MAX_ALTCHA_NUMBER);
    this.unlockPromise = null;
    this.lastUnlock = null;
  }

  async _request(urlValue, options = {}, redirectCount = 0) {
    const url = assertAllowedPortalUrl(urlValue, this.portalBase);
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
        throw new AllrisPortalGateError(
          AllrisPortalGateErrorCode.TOO_MANY_REDIRECTS,
          `Zu viele Weiterleitungen beim ALLRIS-Portalabruf: ${url}`,
          { url, redirectCount }
        );
      }
      const nextMethod = redirectMethod(response.status, method);
      return this._request(assertAllowedPortalUrl(response.location, this.portalBase, url), {
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
      const challengeResponse = await this._request(this.challengeUrl, {
        accept: 'application/json, */*;q=0.1',
      });
      const challenge = challengeJson(challengeResponse, this.challengeUrl);
      const solution = solveAltchaV1(challenge, { maxNumber: this.maxAltchaNumber });
      const form = new URLSearchParams({
        next: nextPath(targetUrl, this.portalBase),
        altcha: encodeAltchaPayload(challenge, solution),
      });
      const verify = await this._request(this.verifyUrl, {
        method: 'POST',
        body: form.toString(),
        followRedirects: false,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: targetUrl,
        },
      });
      if (!verify || ![200, 201, 202, 204, 302, 303].includes(verify.status)) {
        throw new AllrisPortalGateError(
          AllrisPortalGateErrorCode.VERIFY_FAILED,
          `Das ALLRIS-Portal lehnte die ALTCHA-Lösung mit HTTP ${verify && verify.status} ab.`,
          { status: verify && verify.status }
        );
      }
      const destination = assertAllowedPortalUrl(verify.location || targetUrl, this.portalBase, this.verifyUrl);
      const portal = await this._request(destination);
      if (!portal || portal.status < 200 || portal.status >= 400 || isGateHtml(portal.text)) {
        throw new AllrisPortalGateError(
          AllrisPortalGateErrorCode.GATE_REJECTED,
          'Das ALLRIS-Portal blieb nach einer gültigen ALTCHA-Lösung gesperrt.',
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
    const url = assertAllowedPortalUrl(urlValue, this.portalBase);
    const method = String(options.method || 'GET').toUpperCase();
    let response = await this._request(url, options);
    if (!response || response.status < 200 || response.status >= 300 || !isGateHtml(response.text)) return response;

    const unlocked = await this._unlock(url);
    if (method === 'GET' && !options.body && unlocked.url === url) return unlocked;
    response = await this._request(url, options);
    if (isGateHtml(response && response.text)) {
      throw new AllrisPortalGateError(
        AllrisPortalGateErrorCode.GATE_REJECTED,
        'Das ALLRIS-Portal verlangte unmittelbar nach erfolgreicher Prüfung erneut ALTCHA.',
        { url }
      );
    }
    return response;
  }

  async fetchHtml(urlValue, options = {}) {
    const response = await this.request(urlValue, options);
    if (!response || response.status < 200 || response.status >= 300) {
      throw new AllrisPortalGateError(
        AllrisPortalGateErrorCode.HTTP_ERROR,
        `ALLRIS-Portal HTTP ${response && response.status}: ${String(urlValue || '')}`,
        { status: response && response.status, url: String(urlValue || '') }
      );
    }
    return response.text;
  }
}

function createAllrisPortalSession(options = {}) {
  return new AllrisPortalSession(options);
}

module.exports = {
  OFFICIAL_ALLRIS_ORIGINS,
  MAX_ALTCHA_NUMBER,
  AllrisPortalGateError,
  AllrisPortalGateErrorCode,
  CookieJar,
  requestRaw,
  isGateHtml,
  challengeJson,
  solveAltchaV1,
  encodeAltchaPayload,
  createAllrisPortalSession,
};
