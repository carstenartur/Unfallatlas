'use strict';

const { decodeEntities, inferType, stripTags } = require('./_portalUtils');

const ORIGIN = 'https://e-government.hannover-stadt.de';
const PATH = '/lhhsimwebre.nsf/';
const ROOT = ORIGIN + PATH;
const SEARCH = `${ROOT}Suche.xsp`;
const RAT_ARCHIVE = `${ROOT}Termine.xsp`;
const SELECTORS = { districts: `${ROOT}AuswahlStadtbezirke.xsp`, committees: `${ROOT}Ausschuesse.xsp` };
const FEEDS = [`${ROOT}RSS_Drucksachen_Rat.xml`, `${ROOT}RSS_Drucksachen_STBR.xml`];
const SOURCE = 'hannover-sim';
const DAY_MS = 86_400_000;
const RSS_DAYS = 14;
const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');
const ATTRS = String.raw`((?:[^"'<>]|"[^"]*"|'[^']*')*)`;
const NUMBER = /^((?:(?:[A-Z]{1,3}|\d{1,2})-)?\d{1,6})[-/](\d{4})((?:[ -]?[A-Z]{1,3}\d{1,3}){0,3})$/i;
const ENTITIES = {
  nbsp: ' ', auml: 'ä', Auml: 'Ä', ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü', szlig: 'ß',
  apos: "'", ndash: '–', mdash: '—', hellip: '…', bdquo: '„', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»', shy: '', euro: '€', eacute: 'é',
};
const BERLIN_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });

function entities(value) {
  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z][a-z\d]*);/gi, (entity, key) => {
    if (key[0] === '#') {
      const cp = /^#x/i.test(key) ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�';
    }
    return Object.hasOwn(ENTITIES, key) ? ENTITIES[key] : decodeEntities(entity);
  });
}

function plain(markup = '') {
  return entities(stripTags(markup.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))).replace(/\s+/g, ' ').trim();
}

function elements(markup, tag) {
  return [...markup.matchAll(new RegExp(`<${tag}\\b${ATTRS}>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi'))];
}

function attributes(markup) {
  const result = Object.create(null);
  for (const [, name, double, single, bare] of markup.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g)) {
    const key = name.toLowerCase();
    if (!(key in result)) result[key] = entities(double ?? single ?? bare ?? '');
  }
  return result;
}

function anchors(markup) {
  return elements(markup, 'a').map(([, attrs, label]) => ({ attrs: attributes(attrs), label: plain(label) }));
}

function htmlPage(text, url) {
  // Preserve a boundary so removing ignored content cannot create a tag.
  const markup = text.replace(/<!--[\s\S]*?-->|<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const main = elements(markup, 'main')[0]?.[2];
  if (!main) throw new Error('Kein öffentlicher SIM-Seiteninhalt');
  const baseTag = markup.match(new RegExp(`<base\\b${ATTRS}>`, 'i'));
  const base = baseTag && officialUrl(attributes(baseTag[1]).href, url);
  const bases = [...new Set([base?.pathname === PATH && !base.search ? base.href : url, url, ROOT])];
  return { main, bases };
}

function officialUrl(value, base = ROOT) {
  if (!value || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value, base);
    return url.origin === ORIGIN && !url.username && !url.password && url.pathname.toLowerCase().startsWith(PATH) ? url : null;
  } catch (_) { return null; }
}

function localDate(year, month, day) {
  const text = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const value = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === text ? text : null;
}

function isoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? localDate(...value.split('-')) : null;
}

function germanDate(value) {
  const date = String(value || '').match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  return date ? localDate(date[3], date[2], date[1]) : null;
}

function documentNumber(value) {
  const parts = value.match(NUMBER);
  if (!parts) return null;
  const [, prefix, year, ending] = parts;
  const suffixes = ending.toUpperCase().match(/[A-Z]{1,3}\d{1,3}/g) || [];
  const suffix = suffixes.join('');
  const baseKey = `${prefix.toUpperCase()}-${year}`;
  return { key: baseKey + suffix, baseKey, suffix, number: [ `${prefix.toUpperCase()}/${year}`, ...suffixes ].join(' ') };
}

function sourceLink(href, bases, kind) {
  // SIM sometimes omits the database root from a link even without a <base>.
  for (const location of bases) {
    const url = officialUrl(href, location);
    if (!url) continue;
    let tail;
    try { tail = decodeURIComponent(url.pathname.slice(PATH.length)); }
    catch (_) { continue; }
    if (kind === 'archive') {
      if (tail.toLowerCase() !== 'termine.xsp') continue;
      const params = [...url.searchParams];
      const view = url.searchParams.get('view');
      const body = url.searchParams.get('grem');
      if (params.length === 1 && /^TermineSTBR\d{2}$/.test(view)) return { url: `${RAT_ARCHIVE}?view=${view}` };
      if (params.length === 2 && view === 'Termine' && /^[\p{L}\d_-]{1,80}$/u.test(body || '')) {
        return { url: `${RAT_ARCHIVE}?view=Termine&grem=${encodeURIComponent(body)}` };
      }
      continue;
    }
    if (url.search && !/^\?OpenDocument=?$/i.test(url.search)) continue;
    if (kind === 'meeting') {
      const match = tail.match(/^TM\/(\d{4})(\d{2})(\d{2})_([\p{L}\d_-]{1,80})$/iu);
      if (match) {
        const [, y, m, d, body] = match;
        const date = localDate(y, m, d);
        if (date) return { url: `${ROOT}TM/${y}${m}${d}_${encodeURIComponent(/^rat$/i.test(body) ? 'Rat' : body)}`, date };
      }
    } else if (/^DS\//i.test(tail)) {
      const doc = documentNumber(tail.slice(3));
      if (doc) return { ...doc, url: `${ROOT}DS/${doc.key}` };
    }
  }
  return null;
}

function privateRow(attrs, label = '') {
  return Object.hasOwn(attrs, 'hidden') || attrs['aria-hidden'] === 'true' || attrs['data-public'] === 'false'
    || /^(?:private|non[-_ ]?public|nicht[-_ ]?(?:ö|oe|o)ffentlich)$/i.test(attrs['data-visibility'] || '')
    || /(?:^|\s)(?:nicht[-_]?(?:ö|oe|o)ffentlich\S*|non[-_]?public|private|hidden)(?:\s|$)/i.test(attrs.class || '')
    || /^(?:\d+[.)]?\s+)?(?:nicht[\s-]?(?:ö|oe|o)ffentlich(?:e[rn]?)?\s+(?:teil|tagesordnungspunkte?)|\[nichtöffentlich\])(?:[\s:]|$)/i.test(label);
}

function links(markup, bases, kind) {
  return anchors(markup).flatMap(({ attrs, label }) => {
    if (privateRow(attrs, label)) return [];
    const link = sourceLink(attrs.href, bases, kind);
    return link ? [{ ...link, label }] : [];
  });
}

function rowLinks(rows, bases) {
  return rows.flatMap(([, attrs, row]) => privateRow(attributes(attrs), plain(row)) ? [] : links(row, bases, 'document'));
}

function parseArchive(text, url) {
  const { main, bases } = htmlPage(text, url);
  const title = plain(elements(main, 'h2')[0]?.[2]);
  const meetings = links(main, bases, 'meeting');
  if (!/^Termine\b/i.test(title) || !meetings.length) throw new Error('Keine lesbare öffentliche Terminliste');
  for (const meeting of meetings) {
    const labelledDate = germanDate(meeting.label);
    if (labelledDate && labelledDate !== meeting.date) throw new Error('Terminlink und Sitzungsdatum widersprechen sich');
  }
  return meetings;
}

function parseSelector(text, url) {
  const { main, bases } = htmlPage(text, url);
  const archives = links(main, bases, 'archive');
  if (!archives.length) throw new Error('Keine verlinkten Gremienarchive');
  return archives;
}

function searchRequest(text, response, year) {
  const { main } = htmlPage(text, SEARCH);
  const forms = elements(main, 'form');
  const form = forms.find(([, attrs]) => {
    const values = attributes(attrs);
    return values.method?.toLowerCase() === 'post' && officialUrl(values.action, SEARCH)?.href === SEARCH;
  });
  if (!form) throw new Error('Kein gültiges öffentliches SIM-Suchformular');
  const fields = new URLSearchParams();
  const choices = new Map();
  for (const input of form[2].matchAll(new RegExp(`<input\\b${ATTRS}>`, 'gi'))) {
    const attrs = attributes(input[1]);
    if (!attrs.name || Object.hasOwn(attrs, 'disabled')) continue;
    const type = attrs.type?.toLowerCase() || 'text';
    if (['submit', 'button', 'image', 'file'].includes(type)) continue;
    if (['radio', 'checkbox'].includes(type)) {
      const values = choices.get(attrs.name) || new Set();
      values.add(attrs.value || '');
      choices.set(attrs.name, values);
      if (!Object.hasOwn(attrs, 'checked')) continue;
    }
    fields.set(attrs.name, attrs.value || '');
  }
  for (const [, attrs, content] of elements(form[2], 'select')) {
    const select = attributes(attrs);
    if (!select.name || Object.hasOwn(select, 'disabled')) continue;
    const items = elements(content, 'option').map(([, option, label]) => ({ ...attributes(option), label: plain(label) }));
    choices.set(select.name, new Set(items.map(item => item.value ?? item.label)));
    const selected = items.find(item => Object.hasOwn(item, 'selected')) || items[0];
    if (selected) fields.set(select.name, selected.value ?? selected.label);
  }
  const selections = {
    Edit_SucheTyp: 'Vorlage', Edit_SucheKriterium: 'alle', Edit_SucheNach: '',
    Edit_Jahr: String(year), Edit_Maske: 'egal', Edit_Beratungsfolge: 'egal', Edit_Maximal: '0', Edit_SortierenNach: '4',
  };
  for (const [suffix, value] of Object.entries(selections)) {
    const names = [...new Set([...fields.keys(), ...choices.keys()])].filter(name => name.endsWith(`:${suffix}`));
    if (names.length !== 1 || (choices.has(names[0]) && !choices.get(names[0]).has(value))) {
      throw new Error(`SIM-Suchformular unterstützt ${suffix}=${value} nicht`);
    }
    fields.set(names[0], value);
  }
  if (!fields.has('$$viewid') || fields.get('toSearch') !== '1') throw new Error('Unvollständiger Zustand des SIM-Suchformulars');
  const cookie = (response.cookies || []).map(value => String(value).split(';', 1)[0])
    .filter(value => /^[!#$%&'*+.^_`|~\w-]+=[^;\r\n]*$/.test(value)).join('; ');
  return { method: 'POST', body: fields.toString(), cookie };
}

function parseSearchResults(text, year) {
  const { main, bases } = htmlPage(text, SEARCH);
  const countText = plain(main).match(/\b([\d.\s]+)\s+Dokumente?\s+wurde[n]?\s+gefunden\b/i);
  const expected = countText && Number(countText[1].replace(/[.\s]/g, ''));
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error('SIM-Suchliste ohne prüfbare Trefferzahl');
  const table = elements(main, 'table').find(([, , content]) =>
    /Vorlagennummer/i.test(plain(content)) && /Vorlagentyp/i.test(plain(content)));
  if (!table && expected) throw new Error('SIM-Suchliste ohne Vorlagentabelle');
  const documents = new Map();
  let rows = 0;
  for (const [, attrs, row] of elements(table?.[2] || '', 'tr')) {
    const cells = elements(row, 'td').map(match => match[2]);
    if (!cells.length) continue;
    if (privateRow(attributes(attrs), plain(row))) throw new Error('Nichtöffentliche Zeile in der SIM-Suchliste');
    const number = documentNumber(plain(cells[1] || '').replace(/\s+/g, ''));
    const doc = links(cells[2] || '', bases, 'document').find(link => link.key === number?.key);
    if (!doc || Number(doc.baseKey.slice(-4)) !== year || !doc.label) throw new Error('Unlesbare oder jahresfremde Vorlage in der SIM-Suchliste');
    const sourceDates = [...plain(cells[3] || '').matchAll(/\b\d{1,2}\.\d{1,2}\.\d{4}\b/g)].map(match => germanDate(match[0]));
    if (!sourceDates[0]) throw new Error('Vorlage in der SIM-Suchliste ohne gültiges Datum');
    rows++;
    documents.set(doc.key, {
      ...doc, searchTitle: doc.label, searchType: plain(cells[0]), searchDate: sourceDates[0],
      sourceRevision: sourceDates.at(-1),
    });
  }
  if (rows !== expected) throw new Error(`Unvollständige SIM-Suchliste: ${rows} von ${expected} Treffern`);
  return { documents: [...documents.values()], rows };
}

function headingSection(markup, pattern, tag = 'h[34]') {
  const headings = elements(markup, tag);
  const index = headings.findIndex(match => pattern.test(plain(match[2])));
  if (index === -1) return '';
  const start = headings[index];
  return markup.slice(start.index + start[0].length, headings[index + 1]?.index);
}

function labelledCell(markup, pattern) {
  for (const [, , row] of elements(markup, 'tr')) {
    if (pattern.test(plain(elements(row, 'th')[0]?.[2]))) return plain(elements(row, 'td')[0]?.[2]);
  }
  return '';
}

function parseAgenda(text, { url, date, label }) {
  const { main, bases } = htmlPage(text, url);
  const heading = plain(elements(main, 'h2')[0]?.[2]);
  const meetingDate = germanDate(labelledCell(main, /^Sitzungsdatum\s*:?$/i) || heading);
  const gremium = labelledCell(main, /^Gremium\s*:?$/i) || label;
  if (!heading || meetingDate !== date || !gremium) throw new Error('SIM-Seite passt nicht zum verlinkten Sitzungstermin');
  const agenda = headingSection(main, /^Tagesordnung\s*:?$/i, 'h3');
  const rows = elements(agenda, 'tr');
  if (!rows.length) throw new Error('Keine lesbare öffentliche Tagesordnung');
  const privateHeading = elements(agenda, 'h4').find(match => privateRow({}, plain(match[2])));
  const documents = rowLinks(privateHeading ? rows.filter(row => row.index < privateHeading.index) : rows, bases);
  return { documents, date, gremium };
}

function visibleMeasureMarkup(markup) {
  const tags = new RegExp(`<(/?)([a-z][\\w:-]*)\\b${ATTRS}>`, 'gi');
  const ignored = [];
  let cursor = 0;
  let visible = '';
  for (const token of markup.matchAll(tags)) {
    const [tag, close, rawName, rawAttributes] = token;
    const name = rawName.toLowerCase();
    const end = token.index + tag.length;
    const voidElement = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name)
      || /\/\s*>$/.test(tag);
    if (ignored.length) {
      if (close && ignored.at(-1) === name) ignored.pop();
      else if (!close && !voidElement) ignored.push(name);
      cursor = end;
      continue;
    }
    if (close) continue;
    const attrs = attributes(rawAttributes);
    const style = attrs.style || '';
    if (/^(?:del|s|strike|blockquote)$/.test(name) || privateRow(attrs)
        || /(?:display\s*:\s*none|visibility\s*:\s*hidden|text-decoration[^:;]*:[^;]*line-through)/i.test(style)) {
      visible += `${markup.slice(cursor, token.index)} `;
      cursor = end;
      if (!voidElement) ignored.push(name);
    }
  }
  return visible + (ignored.length ? '' : markup.slice(cursor));
}

function measureText(markup) {
  const visible = visibleMeasureMarkup(markup);
  const heading = elements(visible, 'h3').find(match => /^Inhalt der Drucksache/i.test(plain(match[2])));
  if (!heading) return { locationEvidence: [], locationEvidenceUnavailable: true };
  const body = visible.slice(heading.index + heading[0].length);
  const answer = headingSection(body, /^(?:text der antwort|antwort(?: der verwaltung)?)\s*:?$/i);
  const motion = headingSection(body, /^(?:antrag|anfrage|beschluss(?:vorschlag)?|entscheidung)\s*:?$/i);
  // The portal uses an empty h4 for unlabelled request text. In a reply the
  // same section may reproduce the original question above the actual answer.
  const content = answer || motion || headingSection(body, /^$/);
  const paragraphs = content
    .replace(/<(b|strong)\b[^>]*>\s*(?:<u>\s*)?frage\s+\d+\s*:\s*(?:<\/u>\s*)?<\/\1>\s*<(b|strong)\b[^>]*>[\s\S]*?<\/\2>/gi, '\n')
    .replace(/<(b|strong)\b[^>]*>\s*(?:<u>\s*)?frage\s+\d+\s*:[\s\S]*?<\/\1>/gi, '\n')
    .split(/<(?:br\b[^>]*|\/(?:p|li|div|tr)\s*)>/i)
    .map(plain).filter(Boolean);
  const bounded = paragraphs.filter(value => value.length <= 4000);
  return {
    locationEvidence: bounded.slice(0, 40),
    ...(!bounded.length ? { locationEvidenceUnavailable: true } : {}),
    ...(bounded.length > 40 || bounded.length !== paragraphs.length ? { locationEvidenceTruncated: true } : {}),
  };
}

function documentType(doc, result, answer = false) {
  const detailType = inferType('', result.rawType || result.type);
  if (answer || /^antwort\b/i.test(result.title) || detailType === 'Verwaltungsantwort') return 'Verwaltungsantwort';
  const listType = inferType('', doc?.searchType);
  if (listType !== 'Sonstige') return listType;
  return detailType === 'Sonstige' ? inferType(result.title, '') : detailType;
}

function evidenceQualification(result, includeLocationEvidence, checkedAt) {
  // Older sim-v3 entries may have parsed no usable section without qualifying it.
  // Normalize the projection, retaining valid cached evidence and its source clock.
  if (!result.locationEvidenceUnavailable && (!includeLocationEvidence || result.locationEvidence?.length)) return {};
  const detailVerifiedAt = result.detailVerifiedAt || checkedAt;
  return { locationEvidenceUnavailable: true, ...(detailVerifiedAt ? { detailVerifiedAt } : {}) };
}

function parseDocument(text, doc, includeLocationEvidence) {
  const { main, bases } = htmlPage(text, doc.url);
  const h2 = elements(main, 'h2')[0];
  const heading = plain(h2?.[2]).match(/^(.{1,100}?)\s+Nr\.?\s*(.+?):\s*(.+)$/i);
  const number = heading && documentNumber(heading[2]);
  if (number?.key !== doc.key || privateRow(attributes(h2?.[1] || ''), heading?.[3])) {
    throw new Error('Keine öffentliche Drucksache mit der erwarteten Drucksachennummer');
  }
  const title = heading[3];
  const contentHeading = elements(main, 'h3').find(match => /^Inhalt der Drucksache/i.test(plain(match[2])));
  const metadata = main.slice(0, contentHeading?.index);
  const relatedSection = headingSection(metadata, /^verwandte Drucksachen\s*:?$/i);
  const relatedRows = elements(relatedSection, 'tr');
  const related = (relatedRows.length ? rowLinks(relatedRows, bases) : links(relatedSection, bases, 'document'))
    .filter(link => link.key !== doc.key);
  const published = /^(?:Veröffentlicht(?: am)?|Eingereicht(?: am)?|Datum der Drucksache)\s*:?$/i;
  const dateText = labelledCell(metadata, published) || plain(headingSection(metadata, published));
  const consultation = headingSection(metadata, /^Beratungsverlauf\s*:?$/i);
  const meetingLabel = links(consultation, bases, 'meeting')[0]?.label;
  const notified = elements(headingSection(metadata, /^Nachrichtlich\s*:?$/i), 'li')[0]?.[2];
  return {
    title,
    rawType: heading[1],
    date: isoDate(dateText) || germanDate(dateText),
    gremium: meetingLabel?.replace(/^\d{1,2}\.\d{1,2}\.\d{4}\s*:\s*/, '') || plain(notified) || null,
    related,
    ...(includeLocationEvidence ? measureText(main) : {}),
  };
}

function rssDate(value) {
  const date = value.match(/^(?:[a-z]{3}, )?(\d{1,2}) ([a-z]{3}) (\d{4}) (?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)? (?:[+-](?:[01]\d|2[0-3])[0-5]\d|GMT|UTC)$/i);
  if (!date || !localDate(date[3], MONTHS.indexOf(date[2].toLowerCase()) + 1, date[1])) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? BERLIN_DATE.format(new Date(time)) : null;
}

function parseFeed(text, url) {
  const channel = elements(elements(text, 'rss')[0]?.[2] || '', 'channel')[0]?.[2];
  if (!channel || /<!DOCTYPE/i.test(text) || !plain(elements(channel, 'title')[0]?.[2])) throw new Error('Kein lesbarer SIM-RSS-Kanal');
  const items = elements(channel, 'item');
  if (items.length !== (channel.match(/<item\b/gi) || []).length) throw new Error('Unvollständige RSS-Einträge');
  return items.flatMap(([, , item]) => {
    const link = sourceLink(plain(elements(item, 'link')[0]?.[2]), [url, ROOT], 'document');
    if (!link) return [];
    const date = rssDate(plain(elements(item, 'pubDate')[0]?.[2]));
    if (!date) throw new Error('RSS-Eintrag ohne gültiges Veröffentlichungsdatum');
    const description = plain(elements(item, 'description')[0]?.[2]);
    const bodyList = description.match(/\bGremien:\s*(.+)$/i)?.[1] || '';
    const bodies = [...new Set(bodyList.split(/\s*[,;]\s*/).filter(Boolean))];
    return [{ ...link, date, bodies }];
  });
}

async function requestPublicText(url, { timeoutMs, maxBytes, method = 'GET', body, cookie }) {
  if ((method !== 'GET' && method !== 'POST') || (method === 'POST' && url !== SEARCH)) {
    throw new Error('Unzulässige SIM-Abfragemethode');
  }
  const response = await fetch(url, {
    method, ...(method === 'POST' ? { body } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'text/html, application/rss+xml, application/xml;q=0.9', 'User-Agent': 'Unfallwerkbank-SIM/1.0',
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(cookie ? { Cookie: cookie } : {}) },
  });
  const result = { url: response.url, status: response.status, contentType: response.headers.get('content-type'),
    cookies: response.headers.getSetCookie(), text: '' };
  if (result.status !== 200 || Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    if (result.status === 200) throw new Error('SIM-Antwort überschreitet das Größenlimit');
    return result;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body || []) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error('SIM-Antwort überschreitet das Größenlimit');
    chunks.push(chunk);
  }
  return { ...result, text: Buffer.concat(chunks).toString('utf8') };
}

function boundedOption(value, fallback, maximum) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new RangeError(`Hannover-SIM-Limit muss zwischen 1 und ${maximum} liegen`);
  return value;
}

/**
 * Imports metadata from the official SIM meeting list, agendas and related document links.
 * `from`/`to` are inclusive, applied to agenda and feed dates, not the age of related documents.
 * `discoverArchives: ['districts', 'committees']` follows the optional official archive selectors.
 * `archiveBodies` optionally limits discovery to the exact official link labels, in addition to Rat.
 * `strict` rejects discovery failures or truncation; search-mode detail failures
 * retain verified list metadata and explicitly report unavailable evidence.
 * `includeLocationEvidence` retains the public measure text for build-time geocoding.
 * `discovery: 'search'` enumerates all public document-year lists in the requested window.
 * `sourceCache.getOrLoad(key, revision, loader)` resumes validated detail reads.
 * `requestText(url, { timeoutMs, maxBytes, method?, body?, cookie? })` may supply
 * { url, status, contentType, text, cookies? }. POST is limited to the public search form.
 */
async function collectHannoverYear(options = {}) {
  const now = new Date(options.now ?? Date.now());
  const today = BERLIN_DATE.format(now);
  const from = isoDate(options.from ?? `${Number(today.slice(0, 4)) - 1}-01-01`);
  const requestedTo = isoDate(options.to ?? today);
  const to = requestedTo && requestedTo < today ? requestedTo : requestedTo && today;
  if (!from || !to || from > to) throw new RangeError('Ungültiger Zeitraum für den Hannover-SIM-Katalog');
  const inWindow = date => date >= from && date <= to;
  if (options.discovery !== undefined && !['archives', 'search'].includes(options.discovery)) throw new TypeError('Unbekannte SIM-Quellenauswahl');
  const searchMode = options.discovery === 'search';
  const scopes = options.discoverArchives ?? [];
  if (!Array.isArray(scopes) || scopes.some(scope => !Object.hasOwn(SELECTORS, scope))) throw new TypeError('Unbekanntes Hannover-SIM-Gremienarchiv');
  const bodyNames = options.archiveBodies ?? [];
  if (!Array.isArray(bodyNames) || bodyNames.some(name => typeof name !== 'string' || !name.trim()) || (bodyNames.length && !scopes.length)) {
    throw new TypeError('Hannover-SIM-Gremiennamen benötigen ein amtliches Auswahlverzeichnis');
  }
  const selectedBodies = new Set(bodyNames.map(name => name.trim()));
  const maxArchives = boundedOption(options.maxArchives, 48, 64);
  const maxMeetings = boundedOption(options.maxMeetings, 36, 200);
  const maxDocuments = boundedOption(options.maxDocuments, searchMode ? 50_000 : 1800, 50_000);
  const concurrency = boundedOption(options.concurrency, 6, 8);
  const timeoutMs = boundedOption(options.timeoutMs, 12_000, 60_000);
  const maxBytes = boundedOption(options.maxBytes, (searchMode ? 8 : 2) * 1024 * 1024, 8 * 1024 * 1024);
  const deadline = performance.now() + boundedOption(options.maxDurationMs, (searchMode ? 55 : 8) * 60_000, 60 * 60_000);
  const requestText = options.requestText || requestPublicText;
  const includeRss = options.includeRss !== false;
  const warnings = [searchMode
    ? 'Die öffentliche Vorlagensuche wurde jahrgangsweise für alle Gremien ausgelesen. Die Vollständigkeit des amtlichen Gesamtarchivs ist damit nicht belegt.'
    : 'Die Terminarchive erschließen veröffentlichte Tagesordnungen und verlinkte Drucksachen. Eine stadtweite Vollabdeckung ist damit nicht belegt.'];
  if (includeRss) warnings.push('Die RSS-Feeds ergänzen Veröffentlichungen aus den letzten 14 Tagen für Rat, Verwaltungsausschuss und Stadtbezirksräte.');
  if (!searchMode && !scopes.length) warnings.push('Historische Termine stammen aus der Ratsversammlung; Fachausschüsse und Stadtbezirksräte sind historisch nicht systematisch erfasst.');
  else if (!searchMode && selectedBodies.size) warnings.push(`Die historische Suche ist auf Ratsversammlung und ausgewählte Gremienarchive begrenzt: ${[...selectedBodies].join(', ')}.`);
  const failures = new Map();
  const sources = new Set();
  const dates = new Set();
  const bodies = new Set();

  function limited(message) {
    if (options.strict && !options.yearWork) throw new Error(message);
    warnings.push(message);
  }

  async function load(url, phase, parse, xml = false, request = {}, mustThrow = false) {
    try {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw new Error('Gesamtzeitlimit erreicht');
      const response = await requestText(url, { timeoutMs: Math.min(timeoutMs, remaining), maxBytes, ...request });
      if (response?.status !== 200) throw new Error(`HTTP ${Number(response?.status) || 'unbekannt'}`);
      if (response.url !== url) throw new Error('Unerwartete Weiterleitung');
      const media = String(response.contentType || '').split(';')[0].trim().toLowerCase();
      if (!(xml ? ['application/rss+xml', 'application/xml', 'text/xml'] : ['text/html', 'application/xhtml+xml']).includes(media)) {
        throw new Error('Unerwartetes Antwortformat');
      }
      if (typeof response.text !== 'string' || !response.text.trim() || Buffer.byteLength(response.text) > maxBytes) {
        throw new Error('Leere oder zu große SIM-Antwort');
      }
      return parse(response.text, response);
    } catch (error) {
      const { pathname, search } = new URL(url);
      const detail = `${pathname}${search}: ${String(error.message || 'Abruf fehlgeschlagen').slice(0, 160)}`;
      if (options.strict || mustThrow) throw new Error(`${phase}: ${detail}`);
      const entry = failures.get(phase) || { count: 0, detail };
      entry.count += 1;
      failures.set(phase, entry);
      return null;
    }
  }

  async function batches(entries, run) {
    const results = [];
    for (let i = 0; i < entries.length; i += concurrency) {
      if (performance.now() >= deadline) {
        limited('Gesamtzeitlimit für Hannover-SIM erreicht.');
        break;
      }
      results.push(...await Promise.all(entries.slice(i, i + concurrency).map(run)));
    }
    return results.filter(Boolean);
  }

  const searchDocuments = [];
  if (searchMode) {
    for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
      const request = await load(SEARCH, 'Suchformular', (text, response) => searchRequest(text, response, year));
      if (!request) throw new Error(`SIM-Suchformular für ${year} nicht verfügbar`);
      const result = await load(SEARCH, 'Suchliste', text => parseSearchResults(text, year), false, request);
      if (!result) throw new Error(`SIM-Suchliste für ${year} nicht vollständig verfügbar`);
      searchDocuments.push(...result.documents);
      options.report?.({ phase: 'search', year, rows: result.rows, documents: result.documents.length });
    }
    sources.add(SEARCH);
    bodies.add('Alle öffentlichen Gremien');
    if (searchDocuments.length > maxDocuments) throw new Error(`Drucksachenlimit (${maxDocuments}) für ${searchDocuments.length} gefundene Vorlagen erreicht`);
  }

  const archiveInputs = searchMode ? [] : [{ url: RAT_ARCHIVE, label: 'Ratsversammlung' }];
  const discoveredBodies = new Set();
  for (const scope of searchMode ? [] : new Set(scopes)) {
    const url = SELECTORS[scope];
    const archives = await load(url, 'Gremienauswahl', text => parseSelector(text, url));
    if (!archives) continue;
    sources.add(url);
    for (const archive of archives) {
      if (selectedBodies.size && !selectedBodies.has(archive.label)) continue;
      discoveredBodies.add(archive.label);
      archiveInputs.push(archive);
    }
  }
  const missingBodies = [...selectedBodies].filter(name => !discoveredBodies.has(name));
  if (missingBodies.length) limited(`Nicht im amtlichen Gremienverzeichnis gefunden: ${missingBodies.join(', ')}.`);
  const archives = [...new Map(archiveInputs.map(archive => [archive.url, archive])).values()];
  if (archives.length > maxArchives) limited(`Archivlimit (${maxArchives} von ${archives.length}) erreicht.`);
  const archiveResults = await batches(archives.slice(0, maxArchives), async archive => {
    const meetings = await load(archive.url, 'Terminarchive', text => parseArchive(text, archive.url));
    return meetings && { archive, meetings };
  });
  const meetings = new Map();
  for (const { archive, meetings: items } of archiveResults) {
    sources.add(archive.url);
    for (const item of items) if (inWindow(item.date)) meetings.set(item.url, { ...item, label: archive.label });
  }
  const schedule = [...meetings.values()].sort((a, b) => b.date.localeCompare(a.date));
  if (schedule.length > maxMeetings) limited(`Terminlimit (${maxMeetings} von ${schedule.length}) erreicht.`);
  const agendas = await batches(schedule.slice(0, maxMeetings), meeting => load(meeting.url, 'Tagesordnungen', text => parseAgenda(text, meeting)));

  const candidates = new Map();
  function enqueue(link, hint = {}) {
    const existing = candidates.get(link.key);
    if (existing) {
      existing.agendaBody ||= hint.agendaBody;
      if (hint.feedBodies?.length) existing.feedBodies = [...new Set([...(existing.feedBodies || []), ...hint.feedBodies])];
      existing.feedDate ||= hint.feedDate;
      return null;
    }
    const doc = { ...link, ...hint };
    candidates.set(doc.key, doc);
    return doc;
  }
  for (const doc of searchDocuments) enqueue(doc);
  for (const agenda of agendas) {
    dates.add(agenda.date);
    bodies.add(agenda.gremium);
    for (const link of agenda.documents) enqueue(link, { agendaBody: agenda.gremium });
  }
  const rssFrom = new Date(Date.parse(`${today}T00:00:00Z`) - RSS_DAYS * DAY_MS).toISOString().slice(0, 10);
  if (includeRss && to >= rssFrom) {
    const feeds = await batches(FEEDS, async url => {
      const items = await load(url, 'RSS-Feeds', text => parseFeed(text, url), true);
      return items && { url, items };
    });
    for (const { url, items } of feeds) {
      sources.add(url);
      for (const item of items) {
        if (inWindow(item.date) && item.date >= rssFrom) enqueue(item, { feedBodies: item.bodies, feedDate: item.date });
      }
    }
  }

  const pending = [...candidates.values()];
  const yearWork = options.yearWork;
  if (yearWork) {
    yearWork.documents = searchDocuments;
    yearWork.details ||= {};
    yearWork.failedDetails = [];
    yearWork.deferred = [];
    yearWork.discoveryVerifiedAt = now.toISOString();
    await options.saveWork();
  }
  const found = [];
  const relations = new Map();
  const answers = new Set();
  let attempted = 0;
  while (pending.length && attempted < maxDocuments && (yearWork || performance.now() < deadline)) {
    // A bounded work queue keeps the allowed connections busy when one
    // individual document is slow, without increasing source concurrency.
    const next = pending.splice(0, Math.min(searchMode ? 128 : concurrency, maxDocuments - attempted));
    attempted += next.length;
    const related = [];
    const readDocument = async doc => {
      const revision = `sim-v3:${options.includeLocationEvidence === true}:${doc.sourceRevision || 'linked'}`;
      const retained = yearWork?.details[doc.key];
      if (retained?.revision === revision && now.getTime() - Date.parse(retained.checkedAt) < 7 * DAY_MS) {
        return { ...retained.result, ...evidenceQualification(retained.result, options.includeLocationEvidence, retained.checkedAt) };
      }
      const metadata = () => {
        if (!retained?.result && !doc.searchTitle) return null;
        return { related: [], locationEvidence: [], ...retained?.result,
          ...(doc.searchTitle ? { title: doc.searchTitle, rawType: doc.searchType, date: doc.searchDate } : {}),
          locationEvidenceUnavailable: true,
          ...(retained?.result ? { detailVerifiedAt: retained.checkedAt } : {}) };
      };
      if (yearWork && (options.work.remaining <= 0 || performance.now() >= deadline)) {
        yearWork.deferred.push(doc.key);
        return metadata();
      }
      if (yearWork) options.work.remaining--;
      let failureRecorded = false;
      const read = async () => {
        const result = await load(doc.url, 'Drucksachen', text => parseDocument(text, doc, options.includeLocationEvidence), false, {}, searchMode);
        // A tolerant archive read already recorded this source failure in load().
        failureRecorded = !result;
        return result;
      };
      try {
        let result;
        if (options.sourceCache) {
          // Include parser/evidence revision so an old title-only cache cannot
          // falsely claim that the public document text was examined.
          result = await options.sourceCache.getOrLoad(doc.url, revision, async () => {
            const value = await read();
            if (!value) throw new Error('Keine verifizierte öffentliche Drucksache');
            return value;
          });
        } else {
          result = await read();
          if (!result && searchMode && doc.searchTitle) throw new Error('Keine verifizierte öffentliche Drucksache');
        }
        if (yearWork && result) yearWork.details[doc.key] = { revision, checkedAt: now.toISOString(), result, doc };
        return result;
      } catch (error) {
        if (!searchMode && options.strict) throw error;
        if (!failureRecorded) {
          const phase = !searchMode || doc.searchTitle ? 'Drucksachen' : 'Verknüpfte Drucksachen';
          const issue = failures.get(phase) || { count: 0, detail: String(error.message).slice(0, 160) };
          issue.count++;
          failures.set(phase, issue);
        }
        if (!searchMode) return null;
        // An auxiliary link has no verified year-list metadata to publish.
        // Its absence must not discard the independently verified year lists.
        if (yearWork) yearWork.failedDetails.push(doc.key);
        return metadata();
      }
    };
    const results = new Array(next.length);
    let nextIndex = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, next.length) }, async () => {
      while (nextIndex < next.length) {
        const index = nextIndex++;
        results[index] = await readDocument(next[index]);
      }
    }));
    for (const [index, result] of results.entries()) {
      if (!result) continue;
      const doc = next[index];
      found.push({ doc, result });
      if (doc.feedDate) dates.add(doc.feedDate);
      for (const body of doc.feedBodies || []) bodies.add(body);
      if (searchMode && result.gremium) bodies.add(result.gremium);
      for (const link of result.related) {
        if (link.baseKey === doc.baseKey) {
          if (doc.suffix && !link.suffix) relations.set(doc.key, link.key);
          if (!doc.suffix && link.suffix) relations.set(link.key, doc.key);
          if (/\bantwort\b/i.test(link.label) && link.suffix) answers.add(link.key);
        }
        const candidate = enqueue(link);
        if (candidate) related.push(candidate);
      }
    }
    if (searchMode || attempted % 100 < concurrency || !pending.length) options.report?.({ phase: 'documents', attempted, found: found.length, pending: pending.length });
    pending.unshift(...related);
    if (yearWork) { yearWork.cursor = attempted; await options.saveWork(); }
  }
  if (pending.length) {
    if (attempted >= maxDocuments) limited(`Drucksachenlimit (${maxDocuments}) erreicht; ${pending.length} verlinkte Drucksachen bleiben offen.`);
    else limited('Gesamtzeitlimit für Hannover-SIM erreicht.');
  }
  for (const [phase, issue] of failures) warnings.push(`${phase}: ${issue.count} Abruf(e) fehlgeschlagen. Erster Fehler: ${issue.detail}.`);

  if (yearWork?.deferred.length) warnings.push(`Quellenarbeit ist fortsetzbar; ${yearWork.deferred.length} Drucksachen bleiben offen.`);
  const records = found.map(({ doc, result }) => {
    const parent = relations.get(doc.key);
    return {
      id: `${SOURCE}:${doc.key}`, title: result.title, number: doc.number,
      type: documentType(doc, result, answers.has(doc.key)),
      date: result.date || doc.searchDate || doc.feedDate || null, gremium: doc.agendaBody || doc.feedBodies?.join(', ') || result.gremium || null,
      url: doc.url, source: SOURCE, ...(parent ? { relatedTo: `${SOURCE}:${parent}` } : {}),
      ...(result.locationEvidence ? { locationEvidence: result.locationEvidence } : {}),
      ...evidenceQualification(result, options.includeLocationEvidence),
      ...(result.detailVerifiedAt ? { detailVerifiedAt: result.detailVerifiedAt } : {}),
      ...(result.locationEvidenceTruncated ? { locationEvidenceTruncated: true } : {}),
    };
  });
  records.sort((a, b) => a.id.localeCompare(b.id));
  const observed = [...dates].sort();
  const catalogue = {
    records,
    sources: [...sources],
    coverage: { from: searchMode ? from : observed[0] || null, to: searchMode ? to : observed.at(-1) || null,
      bodies: [...bodies].sort(), complete: false, warnings, ...(searchMode ? { scope: 'citywide' } : {}) },
  };
  if (yearWork) {
    yearWork.pending = Boolean(yearWork.failedDetails.length || yearWork.deferred.length || pending.length);
    yearWork.catalogue = catalogue;
    await options.saveWork();
  }
  return catalogue;
}

async function collectHannoverCatalogue(options = {}) {
  if (!options.checkpoint || options.discovery !== 'search') return collectHannoverYear(options);
  const now = new Date(options.now ?? Date.now());
  const today = BERLIN_DATE.format(now);
  const from = isoDate(options.from ?? `${Number(today.slice(0, 4)) - 1}-01-01`);
  const to = isoDate(options.to ?? today);
  if (!from || !to || from > to) throw new RangeError('Ungültiger Zeitraum für den Hannover-SIM-Katalog');
  const scope = `public-year-search:${options.includeLocationEvidence === true}`;
  const revision = 'sim-history-v1';
  const requested = Array.from({ length: Number(to.slice(0, 4)) - Number(from.slice(0, 4)) + 1 }, (_, i) => Number(from.slice(0, 4)) + i);
  const years = [...new Set([...await options.checkpoint.years(SOURCE, scope), ...requested])].sort((a, b) => a - b);
  if (options.workBudget !== undefined && (!Number.isSafeInteger(options.workBudget) || options.workBudget < 0)) throw new TypeError('Invalid RIS work budget');
  const work = { remaining: options.workBudget ?? Infinity };
  const deadline = performance.now() + (options.maxDurationMs ?? 58 * 60_000);
  const catalogues = [];
  const pendingYears = [];
  let interrupted = false;
  for (const year of years) {
    const state = await options.checkpoint.read(SOURCE, scope, year, revision) || {};
    const requestedYear = requested.includes(year);
    if (requestedYear && work.remaining > 0 && performance.now() < deadline) {
      await collectHannoverYear({ ...options, yearWork: state, work,
        from: year === Number(from.slice(0, 4)) ? from : `${year}-01-01`,
        to: year === Number(to.slice(0, 4)) ? to : `${year}-12-31`,
        maxDurationMs: Math.max(1, Math.floor(deadline - performance.now())),
        saveWork: () => options.checkpoint.write(SOURCE, scope, year, revision, state),
      });
    } else if (requestedYear) { pendingYears.push(year); interrupted = true; }
    if (state.deferred?.length) interrupted = true;
    if (state.catalogue) {
      const documents = new Map((state.documents || []).map(doc => [`${SOURCE}:${doc.key}`, doc]));
      // A retained year need not be fetched again to correct its existing evidence
      // qualification or reapply the type from its verified annual discovery list.
      catalogues.push({ ...state.catalogue, records: state.catalogue.records.map(record => ({
        ...record,
        type: documentType(documents.get(record.id), record),
        ...evidenceQualification(record, options.includeLocationEvidence, state.details?.[record.id.slice(SOURCE.length + 1)]?.checkedAt),
      })) });
    }
    if (state.pending && !pendingYears.includes(year)) pendingYears.push(year);
  }
  const records = [...new Map(catalogues.flatMap(item => item.records).map(record => [record.id, record])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const coverage = catalogues.map(item => item.coverage);
  return { records, sources: [...new Set(catalogues.flatMap(item => item.sources))],
    history: { pending: pendingYears.length > 0, interrupted, pendingYears, requestedFrom: from, requestedTo: to },
    coverage: { from: coverage.map(item => item.from).filter(Boolean).sort()[0] || null,
      to: coverage.map(item => item.to).filter(Boolean).sort().at(-1) || null,
      bodies: [...new Set(coverage.flatMap(item => item.bodies))].sort(), complete: false, scope: 'citywide',
      warnings: [...new Set(coverage.flatMap(item => item.warnings)), ...(pendingYears.length ? ['Historische Quellenarbeit ist fortsetzbar; Jahrgänge bleiben offen.'] : [])] },
  };
}

module.exports = { collectHannoverCatalogue };
