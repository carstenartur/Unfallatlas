'use strict';

/** Backwards-compatible Bonn API over the shared official ALLRIS session client. */
const allris = require('./allrisPortalGateClient.js');
const { assertAllowedNetworkUrl, OParlClientError, OParlClientErrorCode } = require('./bonnOparlHttp.js');

const PORTAL_BASE = 'https://www.bonn.sitzung-online.de';
const CHALLENGE_URL = `${PORTAL_BASE}/public/_gate/challenge`;
const VERIFY_URL = `${PORTAL_BASE}/public/_gate/verify`;
const { MAX_ALTCHA_NUMBER, CookieJar, isGateHtml, encodeAltchaPayload } = allris;

const BonnPortalGateErrorCode = Object.freeze(Object.fromEntries(
  Object.keys(allris.AllrisPortalGateErrorCode)
    .filter(key => key !== 'INVALID_URL' && key !== 'UNTRUSTED_ORIGIN')
    .map(key => [key, `BONN_PORTAL_${key}`])
));

class BonnPortalGateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BonnPortalGateError';
    this.code = code;
    this.details = details;
  }
}

function legacyError(error) {
  if (!(error instanceof allris.AllrisPortalGateError)) return error;
  const key = error.code.replace(/^ALLRIS_PORTAL_/, '');
  if (key === 'INVALID_URL' || key === 'UNTRUSTED_ORIGIN') {
    return new OParlClientError(
      key === 'INVALID_URL' ? OParlClientErrorCode.INVALID_URL : OParlClientErrorCode.UNTRUSTED_HOST,
      error.message,
      error.details
    );
  }
  return new BonnPortalGateError(BonnPortalGateErrorCode[key], error.message, error.details);
}

function withLegacyErrors(operation) {
  return (...args) => {
    try {
      const result = operation(...args);
      return result && typeof result.catch === 'function'
        ? result.catch(error => { throw legacyError(error); })
        : result;
    } catch (error) {
      throw legacyError(error);
    }
  };
}

const requestRaw = withLegacyErrors((url, options) => allris.requestRaw(assertAllowedNetworkUrl(url), options));
const challengeJson = withLegacyErrors(response => allris.challengeJson(response, CHALLENGE_URL));
const solveAltchaV1 = withLegacyErrors(allris.solveAltchaV1);

function createBonnPortalSession(options = {}) {
  const session = allris.createAllrisPortalSession({ ...options, portalBase: PORTAL_BASE });
  for (const name of ['request', 'fetchHtml', '_request', '_unlock']) {
    session[name] = withLegacyErrors(session[name].bind(session));
  }
  return session;
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
