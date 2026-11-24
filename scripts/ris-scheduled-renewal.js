'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { CookieJar, isGateHtml } = require('../server/political-context/providers/allrisPortalGateClient');

const workflows = new Set(['.github/workflows/deploy-pages-current-data.yml', '.github/workflows/generate-data-deploy-pages.yml']);
const MIB = 1024 * 1024;
const REQUEST_LIMIT = 320;
// Keep scheduled municipal requests disabled until archive publication and the
// continuity of daily receipts have been approved. Set a fixed first UTC day
// in a reviewed change; cache loss must never create a new first day.
const RENEWAL_START_DAY = null;
const ROUTES = {
  bonn: {
    'www.bonn.sitzung-online.de': /^\/oparl\//,
    'bonn.sitzung-online.de': /^\/oparl\//,
  },
  hannover: {
    'e-government.hannover-stadt.de': /^\/lhhsimwebre\.nsf\/(?:Suche\.xsp|RSS_Drucksachen_(?:Rat|STBR)\.xml|DS\/[\w.-]+)$/i,
    'ris.hannit.de': /^\/public\/vo0[24]0$/i,
    'www.landtag-niedersachsen.de': /^\/(?:rss\/(?:drucksachen|stenoberichte)\.xml|service\/suche\/|dokumentensuche\/)$/,
    'bekanntmachungen.region-hannover.de': /^\//,
  },
};

async function renewalDay(env, fetch = globalThis.fetch, now = new Date(), startDay = RENEWAL_START_DAY) {
  if (env.GITHUB_EVENT_NAME !== 'schedule' || env.GITHUB_RUN_ATTEMPT !== '1' || env.GITHUB_REF !== 'refs/heads/main') return '';
  const day = now.toISOString().slice(0, 10);
  if (!startDay || day < startDay) return '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY) || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID)) throw new Error('Invalid scheduled run identity');
  // Even if an Actions cache was evicted or two schedules were delayed into
  // the same day, only the earliest original run in GitHub's run history may collect.
  const url = new URL('https://api.github.com/repos/' + env.GITHUB_REPOSITORY + '/actions/runs');
  url.search = new URLSearchParams({ branch: 'main', event: 'schedule', created: day, per_page: '100' });
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: env.RIS_SCHEDULE_TOKEN ? { Authorization: 'Bearer ' + env.RIS_SCHEDULE_TOKEN } : {} });
  if (!response.ok) throw new Error('Scheduled run inventory unavailable: HTTP ' + response.status);
  const { total_count: count, workflow_runs: runs } = await response.json();
  if (!Array.isArray(runs) || count !== runs.length || runs.some(run => !Number.isSafeInteger(run.id) || !run.path)) {
    throw new Error('Incomplete scheduled run inventory');
  }
  const first = runs.filter(run => workflows.has(run.path)).reduce((id, run) => Math.min(id, run.id), Infinity);
  return String(first) === env.GITHUB_RUN_ID ? day : '';
}

async function createRenewalTransport({ directory, city, day, fetch = globalThis.fetch, now = () => new Date(),
  startDay = RENEWAL_START_DAY, maxRequests = REQUEST_LIMIT, maxBytes = 128 * MIB, intervalMs = 1000 }) {
  if (!startDay || day < startDay) throw new Error('Scheduled RIS renewal is disabled');
  if (!Object.hasOwn(ROUTES, city) || day !== now().toISOString().slice(0, 10)) throw new Error('Invalid renewal city/day');
  const folder = path.join(directory, 'daily-renewal');
  await fs.mkdir(folder, { recursive: true });
  const journal = path.join(folder, day + '-' + city + '.jsonl');
  const cooldowns = {};
  if (day !== startDay) {
    const previous = new Date(Date.parse(day + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
    try {
      const content = await fs.readFile(path.join(folder, `${previous}-${city}.jsonl`), 'utf8');
      const receipt = JSON.parse(content.trimEnd().split('\n').at(-1));
      if (receipt.closed !== true || receipt.day !== previous || receipt.city !== city || receipt.startDay !== startDay
        || !receipt.cooldowns || typeof receipt.cooldowns !== 'object' || Array.isArray(receipt.cooldowns)) throw new Error('invalid receipt');
      for (const [host, until] of Object.entries(receipt.cooldowns)) {
        if (!Object.hasOwn(ROUTES[city], host) || !Number.isSafeInteger(until)) throw new Error('invalid host cooldown');
        if (until > now().getTime()) cooldowns[host] = until;
      }
    } catch (error) { throw new Error('Missing or incomplete previous RIS renewal receipt', { cause: error }); }
  }
  const entry = value => JSON.stringify({ time: now().toISOString(), ...value }) + '\n';
  // Claim the entire city allowance before opening a socket. An interrupted
  // process or another worker may never spend the unused reservation again.
  await fs.writeFile(journal, entry({ city, maxRequests, maxBytes, intervalMs }), { flag: 'wx' });
  let requests = 0, bytes = 0, nextStart = 0;
  const blocked = new Set();
  let closing = false, accountingFailed = false;
  async function record(fields) {
    try { await fs.appendFile(journal, entry(fields)); }
    catch (error) { accountingFailed = true; throw error; }
  }
  const jar = new CookieJar();
  let queue = Promise.resolve();

  async function perform(value, options) {
    const url = new URL(value);
    const host = url.hostname;
    const method = options.method || 'GET';
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
        !ROUTES[city][host]?.test(url.pathname) || /(?:^|\/)(?:_gate|login|logout|admin)(?:\/|$)/i.test(decodeURIComponent(url.pathname)) ||
        !(method === 'GET' || method === 'POST' && url.href === 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/Suche.xsp')) {
      throw new Error('Source route outside scheduled renewal');
    }
    if (accountingFailed) throw new Error('RIS renewal accounting is incomplete');
    if (blocked.has(host) || cooldowns[host] > now().getTime()) throw Object.assign(new Error('Source blocked by cooldown'), { status: 429 });
    if (requests >= maxRequests || bytes >= maxBytes) throw new Error('RIS daily request/byte budget exhausted');
    if (performance.now() < nextStart) await delay(nextStart - performance.now());
    if (day !== now().toISOString().slice(0, 10)) throw new Error('UTC renewal day ended');
    const limit = Math.min(options.maxBytes ?? 2 * MIB, maxBytes - bytes);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid RIS response budget');
    // Charge the full application-body allowance before sending. Only a fully
    // consumed, accepted response can return unused bytes to the daily pool.
    bytes += limit;
    await record({ host, request: ++requests, reservedBytes: limit, remainingBytes: maxBytes - bytes });
    nextStart = performance.now() + intervalMs;
    const region = host === 'ris.hannit.de';
    const cookie = region ? jar.header() : options.cookie;
    let received = 0, status = 0, accepted = false;
    try {
      const response = await fetch(url.href, { method, redirect: 'manual',
        signal: AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs ?? 20_000, Date.parse(day + 'T00:00:00Z') + 86400000 - now().getTime()))),
        headers: { 'User-Agent': 'Unfallwerkbank-RIS/1.0 (+https://github.com/carstenartur/Unfallatlas)',
          Accept: city === 'bonn' ? 'application/json, application/ld+json;q=0.9' : 'text/html, application/xhtml+xml, application/rss+xml, application/xml',
          'Accept-Encoding': 'identity', ...options.headers, ...(cookie ? { Cookie: cookie } : {}),
          ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        ...(method === 'POST' ? { body: options.body } : {}) });
      status = response.status;
      const after = response.headers.get('retry-after');
      if (after) {
        const until = /^\d+$/.test(after) ? Math.min(Number.MAX_SAFE_INTEGER, now().getTime() + Number(after) * 1000) : Date.parse(after);
        if (Number.isSafeInteger(until) && until > now().getTime()) {
          cooldowns[host] = Math.max(cooldowns[host] || 0, until);
          await record({ host, retryUntil: cooldowns[host] });
        }
      }
      if (status !== 200) {
        await response.body?.cancel();
        throw Object.assign(new Error('Source HTTP ' + status), { status, details: { status } });
      }
      if (Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel();
        throw new Error('Source exceeds byte budget');
      }
      const chunks = [];
      const reader = response.body?.getReader({ mode: 'byob' });
      if (reader) {
        try {
          while (received < limit) {
            // Bound each read, including a chunked response with no advertised size.
            const buffer = new Uint8Array(Math.min(64 * 1024, limit - received));
            const { value, done } = await reader.read(buffer);
            if (done) break;
            received += value.byteLength;
            chunks.push(value);
          }
          if (received === limit && response.headers.get('content-length') !== String(limit)) {
            throw new Error('Source exceeds byte budget');
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
      }
      const text = Buffer.concat(chunks, received).toString('utf8');
      if (isGateHtml(text) || /Schutz vor automatisierten Zugriffen/i.test(text)) {
        throw Object.assign(new Error('Source access gate'), { status: 403 });
      }
      const cookies = response.headers.getSetCookie();
      if (region) jar.absorb(cookies);
      accepted = true;
      return { text, url: url.href, status, contentType: response.headers.get('content-type'), cookies };
    } catch (error) {
      // One failure is sufficient for this host today. This also stops any
      // queued providers when a gate, redirect, timeout or rate limit occurs.
      blocked.add(host);
      throw error;
    } finally {
      const chargedBytes = accepted ? received : limit;
      bytes -= limit - chargedBytes;
      await record({ host, status, bodyBytesRead: received, chargedBytes, totalBytes: bytes, blocked: blocked.has(host) });
    }
  }
  function read(value, options = {}) {
    if (closing) return Promise.reject(new Error('RIS renewal transport is closed'));
    const result = queue.then(() => perform(value, options));
    queue = result.catch(() => {});
    return result;
  }
  async function close() {
    closing = true;
    await queue;
    if (accountingFailed) throw new Error('RIS renewal accounting is incomplete');
    await record({ closed: true, day, startDay, city, cooldowns, requests, totalBytes: bytes });
  }
  return { read, journal, close };
}

module.exports = { createRenewalTransport, renewalDay, REQUEST_LIMIT };
if (require.main === module) {
  renewalDay(process.env).catch(error => {
    // Unable to establish an exclusive slot. Offline publication can still
    // succeed if both source snapshots pass their usual age and coverage gates.
    console.warn('RIS renewal stays offline: ' + error.message);
    return '';
  }).then(day => fs.appendFile(process.env.GITHUB_OUTPUT, 'day=' + day + '\n'))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
