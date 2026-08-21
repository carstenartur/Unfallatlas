'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const provider = require('../../server/political-context/providers/bonnAllrisProvider.js');

const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, 'out', 'qa', 'bonn-portal-search-discovery.json');
const SEARCH_URL = 'https://www.bonn.sitzung-online.de/public/tr010';
const SEARCH_TERM = 'Adenauerallee';
const liveTest = process.env.BONN_OPARL_LIVE === '1' ? test : test.skip;

jest.setTimeout(150_000);

function attributes(value) {
  const out = {};
  const pattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(String(value || ''))) !== null) {
    out[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return out;
}

function stripTags(value) {
  return String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

test('stripTags removes script and style blocks with whitespace before the closing bracket', () => {
  expect(stripTags('vor<script data-x="1">evil</script >mitte<style>x</style >nach'))
    .toBe('vor mitte nach');
});

function parseForms(html, baseUrl) {
  const forms = [];
  const pattern = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let match;
  while ((match = pattern.exec(String(html || ''))) !== null) {
    const formAttrs = attributes(match[1]);
    const inner = match[2];
    const controls = [];
    const inputPattern = /<input\b([^>]*)>/gi;
    let input;
    while ((input = inputPattern.exec(inner)) !== null) {
      const attrs = attributes(input[1]);
      if (!attrs.name) continue;
      controls.push({
        tag: 'input',
        name: attrs.name,
        type: String(attrs.type || 'text').toLowerCase(),
        value: attrs.value || '',
        checked: Object.prototype.hasOwnProperty.call(attrs, 'checked'),
      });
    }
    const textareaPattern = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
    let textarea;
    while ((textarea = textareaPattern.exec(inner)) !== null) {
      const attrs = attributes(textarea[1]);
      if (!attrs.name) continue;
      controls.push({ tag: 'textarea', name: attrs.name, type: 'textarea', value: stripTags(textarea[2]) });
    }
    const selectPattern = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
    let select;
    while ((select = selectPattern.exec(inner)) !== null) {
      const attrs = attributes(select[1]);
      if (!attrs.name) continue;
      const options = [];
      const optionPattern = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
      let option;
      while ((option = optionPattern.exec(select[2])) !== null) {
        const optionAttrs = attributes(option[1]);
        options.push({
          value: optionAttrs.value || stripTags(option[2]),
          selected: Object.prototype.hasOwnProperty.call(optionAttrs, 'selected'),
        });
      }
      const selected = options.find(option => option.selected) || options[0];
      controls.push({ tag: 'select', name: attrs.name, type: 'select', value: selected ? selected.value : '' });
    }
    forms.push({
      action: new URL(formAttrs.action || baseUrl, baseUrl).href,
      method: String(formAttrs.method || 'GET').toUpperCase(),
      id: formAttrs.id || null,
      name: formAttrs.name || null,
      controls,
    });
  }
  return forms;
}

function requestText(urlValue, options = {}, redirectCount = 0) {
  const url = new URL(urlValue);
  const transport = url.protocol === 'http:' ? http : https;
  const method = String(options.method || 'GET').toUpperCase();
  const body = options.body == null ? null : Buffer.from(String(options.body));
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const headers = {
      Accept: 'text/html, application/xhtml+xml;q=0.9, application/json;q=0.3, */*;q=0.1',
      'User-Agent': 'Unfallwerkbank-Bonn-Portal-Discovery/1.0 (+https://github.com/carstenartur/Unfallatlas)',
      ...(options.headers || {}),
    };
    if (body) headers['Content-Length'] = String(body.length);
    const req = transport.request(url, { method, timeout: 25_000, headers }, response => {
      const status = Number(response.statusCode || 0);
      const setCookie = Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'] : [];
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectCount >= 5) {
          fail(new Error(`Too many redirects for ${url.href}`));
          return;
        }
        const redirectMethod = status === 307 || status === 308 ? method : 'GET';
        requestText(new URL(response.headers.location, url).href, {
          ...options,
          method: redirectMethod,
          body: redirectMethod === 'GET' ? null : options.body,
        }, redirectCount + 1).then(resolve, fail);
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8 * 1024 * 1024) {
          const error = new Error(`Response exceeds 8 MiB: ${url.href}`);
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
          url: url.href,
          status,
          contentType: String(response.headers['content-type'] || ''),
          setCookie,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
      response.on('error', fail);
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout for ${url.href}`)));
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

function cookieHeader(setCookie) {
  return setCookie.map(value => String(value).split(';', 1)[0]).filter(Boolean).join('; ');
}

function defaultParameters(form) {
  const params = new URLSearchParams();
  for (const control of form.controls) {
    if (!control.name) continue;
    if (['checkbox', 'radio'].includes(control.type) && !control.checked) continue;
    if (['button', 'reset', 'image', 'file'].includes(control.type)) continue;
    if (control.type === 'submit') continue;
    params.append(control.name, control.value || '');
  }
  const submit = form.controls.find(control => control.type === 'submit' && control.name);
  if (submit) params.append(submit.name, submit.value || '');
  return params;
}

function responseSummary(label, response) {
  const titleMatch = response.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const text = stripTags(response.text);
  const termIndex = text.toLowerCase().indexOf(SEARCH_TERM.toLowerCase());
  return {
    label,
    url: response.url,
    status: response.status,
    contentType: response.contentType,
    responseBytes: Buffer.byteLength(response.text),
    title: titleMatch ? stripTags(titleMatch[1]) : null,
    parsedResultCount: provider.parseResults(response.text).length,
    completedSearch: provider.indicatesCompletedSearch(response.text),
    termContext: termIndex >= 0 ? text.slice(Math.max(0, termIndex - 250), termIndex + 750) : null,
    bodyPrefix: response.text.slice(0, 12_000),
  };
}

function serializableError(error) {
  return {
    name: String(error && error.name || 'Error'),
    code: error && error.code ? String(error.code) : null,
    message: String(error && error.message || error || 'Unknown error').slice(0, 1_000),
  };
}

describe('official Bonn HTML search contract', () => {
  liveTest('discovers and exercises the published search forms', async () => {
    const landing = await requestText(SEARCH_URL);
    const forms = parseForms(landing.text, landing.url);
    const cookie = cookieHeader(landing.setCookie);
    const attempts = [];

    attempts.push(responseSummary('landing', landing));
    for (const [index, form] of forms.entries()) {
      const candidates = form.controls.filter(control =>
        control.name && ['text', 'search', 'textarea'].includes(control.type)
      );
      for (const candidate of candidates.slice(0, 6)) {
        const params = defaultParameters(form);
        params.set(candidate.name, SEARCH_TERM);
        try {
          let response;
          if (form.method === 'POST') {
            response = await requestText(form.action, {
              method: 'POST',
              body: params.toString(),
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                ...(cookie ? { Cookie: cookie } : {}),
                Referer: landing.url,
              },
            });
          } else {
            const url = new URL(form.action);
            for (const [key, value] of params) url.searchParams.append(key, value);
            response = await requestText(url.href, {
              headers: {
                ...(cookie ? { Cookie: cookie } : {}),
                Referer: landing.url,
              },
            });
          }
          attempts.push(responseSummary(`form-${index}-${candidate.name}`, response));
        } catch (error) {
          attempts.push({ label: `form-${index}-${candidate.name}`, error: serializableError(error) });
        }
      }
    }

    const evidence = {
      schemaVersion: 'unfallwerkbank.bonnPortalSearchDiscovery.v1',
      collectedAt: new Date().toISOString(),
      searchUrl: SEARCH_URL,
      searchTerm: SEARCH_TERM,
      forms,
      attempts,
    };
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    console.log('[bonn-portal-search-discovery]', JSON.stringify({
      formCount: forms.length,
      attempts: attempts.map(attempt => ({
        label: attempt.label,
        status: attempt.status,
        parsedResultCount: attempt.parsedResultCount,
        completedSearch: attempt.completedSearch,
        error: attempt.error,
      })),
    }));

    expect(landing.status).toBe(200);
    expect(forms.length).toBeGreaterThan(0);
  });
});
