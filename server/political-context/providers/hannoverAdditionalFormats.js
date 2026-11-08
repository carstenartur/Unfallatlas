'use strict';

// These are adapters for observed public documents, not a NILAS/ALLRIS API.
const { createHash } = require('node:crypto');
const LANDTAG = 'https://www.landtag-niedersachsen.de';
const REGION = 'https://bekanntmachungen.region-hannover.de';
const REGION_INDEX = `${REGION}/Regionsversammlung-und-Aussch%C3%BCsse`;
const HOSTS = new Set(['www.landtag-niedersachsen.de', 'www.nilas.niedersachsen.de', 'bekanntmachungen.region-hannover.de']);
const MAX_INPUT = 2 * 1024 * 1024;
const MONTHS = ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];

function officialUrl(value, base, host) {
  const raw = String(value || '');
  if (!raw || /[\u0000-\u0020\\]/u.test(raw)) throw new Error('Invalid official URL');
  const url = new URL(raw, base);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !HOSTS.has(url.hostname) || (host && url.hostname !== host)) {
    throw new Error('Invalid official HTTPS host');
  }
  return url.href;
}
const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', sect: '§', ndash: '–', mdash: '—' };
function entities(value) {
  return String(value || '').replace(/&(?:amp|lt|gt|quot|apos|nbsp|auml|ouml|uuml|szlig|sect|ndash|mdash|#x([0-9a-f]+)|#(\d+));/gi, (m, hex, dec) => {
    if (hex || dec) {
      const n = parseInt(hex || dec, hex ? 16 : 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    }
    return HTML_ENTITIES[m.slice(1, -1)] || HTML_ENTITIES[m.slice(1, -1).toLowerCase()] || m;
  });
}
function text(value) {
  // Extract source text with a forward-only scanner. Removing nested HTML
  // fragments with replacement regexes can reassemble markup. This returns
  // plain text, never HTML; consumers must still use their normal text sinks.
  const source = String(value || ''), lower = source.toLowerCase();
  const pieces = [];
  let cursor = 0, rawTag = null;
  function tagEnd(start) {
    let quote = null;
    for (let i = start; i < source.length; i++) {
      const character = source[i];
      if (quote) { if (character === quote) quote = null; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') return i;
    }
    return -1;
  }
  while (cursor < source.length) {
    if (rawTag) {
      const closing = lower.indexOf(`</${rawTag}`, cursor);
      if (closing < 0) break;
      const afterName = closing + rawTag.length + 2;
      if (!/[\s/>]/.test(source[afterName] || '')) { cursor = afterName; continue; }
      const end = tagEnd(afterName);
      if (end < 0) break;
      cursor = end + 1; rawTag = null; pieces.push(' ');
      continue;
    }
    const opening = source.indexOf('<', cursor);
    if (opening < 0) { pieces.push(source.slice(cursor)); break; }
    pieces.push(source.slice(cursor, opening), ' ');
    if (source.startsWith('<!--', opening)) {
      const end = source.indexOf('-->', opening + 4);
      if (end < 0) break;
      cursor = end + 3;
      continue;
    }
    const end = tagEnd(opening + 1);
    if (end < 0) break;
    const tag = source.slice(opening + 1, end).match(/^(script|style)(?:[\s/]|$)/i);
    if (tag) rawTag = tag[1].toLowerCase();
    cursor = end + 1;
  }
  // Decode once, then discard every angle bracket, including encoded input.
  return entities(pieces.join('')).replace(/[<>]/g, ' ').replace(/[\s\u0000-\u001f]+/g, ' ').trim();
}
function input(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_INPUT) throw new Error('Invalid source response size');
  if (/Zugriff\s+pruefen|Schutz vor automatisierten Zugriffen/i.test(value)) throw new Error('Source access protection');
  return value;
}
function dateOnly(value) {
  if (!value) return null;
  const match = String(value).match(/\b(\d{1,2})\.\s*(?:(\d{1,2})\.|(Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember))\s*(\d{4})\b/i);
  if (!match) return null;
  const month = match[2] ? Number(match[2]) : MONTHS.indexOf(match[3].toLowerCase()) + 1;
  const iso = `${match[4]}-${String(month).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(dt.getTime()) && dt.toISOString().slice(0, 10) === iso ? iso : null;
}
function sourceContext(level, documentKind, status, dates = {}) {
  return { level, publisher: level === 'state' ? 'Niedersächsischer Landtag' : 'Region Hannover', issuer: null,
    documentKind, status, publicationDate: null, documentDate: null, meetingDate: null, ...dates };
}
function semantics(description, kind) {
  if (/Antwort\b|mit Antwort der Landesregierung/i.test(description)) return { status: 'answer', type: 'Verwaltungsantwort' };
  if (/Tagesordnung|Bekanntmachung/.test(kind)) return { status: 'agenda', type: 'Sonstige' };
  if (/Stenograf|Protokoll|Niederschrift/.test(kind)) return { status: 'minutes', type: 'Protokoll' };
  // Beschlussempfehlung is a recommendation; never infer a resolution from its name.
  if (/Änderungsantrag/i.test(description)) return { status: 'proposal', type: 'Änderungsantrag' };
  if (/Anfrage/i.test(description)) return { status: 'proposal', type: 'Anfrage' };
  if (/Antrag|Beschlussempfehlung/i.test(description)) return { status: 'proposal', type: 'Antrag' };
  return { status: 'other', type: 'Sonstige' };
}
function record({ title, url, number = null, description = '', kind, level = 'state', ...rest }) {
  const semantic = semantics(description, kind);
  return { id: createHash('sha256').update(url).digest('hex').slice(0, 16), title, type: semantic.type, rawType: description || kind,
    number, date: null, gremium: null, url, source: level === 'state' ? 'niedersachsen-landtag' : 'region-hannover-bekanntmachungen',
    snippet: description || null, sourceContext: sourceContext(level, kind, semantic.status), ...rest };
}
function tag(html, name) {
  const m = html.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, 'i'));
  if (!m) return '';
  const cdata = m[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1] : entities(m[1]);
}
function classText(html, className) {
  const re = new RegExp(`<([a-z0-9]+)\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1\\s*>`, 'i');
  return text(html.match(re)?.[2]);
}
function anchors(html) {
  return [...html.matchAll(/<a\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a\s*>/gi)]
    .map(m => ({ href: entities(m[2]), attributes: m[1] + m[3], label: text(m[4]) }));
}
function parseLandtagCatalogue(value, pageUrl) {
  const html = input(value);
  officialUrl(pageUrl, LANDTAG, 'www.landtag-niedersachsen.de');
  const count = text(html).match(/Anzahl Ergebnisse:\s*([\d.]+)/);
  if (!count || !/class=["'][^"']*\bdocuments\b/.test(html)) throw new Error('Unrecognised Landtag catalogue shape');
  const records = [];
  for (const m of html.matchAll(/<div\b[^>]*class=["']document["'][^>]*>([\s\S]*?)<\/li\s*>/gi)) {
    const card = m[1], title = classText(card, 'doctitle'), importer = classText(card, 'docimporter');
    const description = classText(card, 'docsubject');
    const links = anchors(card);
    const pdf = links.find(a => /\bicon-pdf\b/.test(a.attributes));
    if (!title || !pdf) throw new Error('Invalid Landtag document card shape');
    const url = officialUrl(pdf.href, pageUrl, 'www.landtag-niedersachsen.de');
    const number = importer.match(/\b\d{1,2}\/\d+\b/)?.[0] || null;
    const kind = importer.replace(/\s+\d{1,2}\/\d+\b/, '').trim().replace(/^Drucksachen$/, 'Drucksache');
    const detail = links.find(a => /www\.nilas\.niedersachsen\.de/.test(a.href));
    const dates = /Tagesordnungen|Stenograf|Niederschriften|Kurzberichte/.test(kind) ? { meetingDate: dateOnly(title) } : {};
    records.push(record({ title, url, originalPdfUrl: url, number, kind, description,
      ...(detail ? { detailUrl: officialUrl(detail.href, pageUrl, 'www.nilas.niedersachsen.de') } : {}),
      sourceContext: sourceContext('state', kind, semantics(description, kind).status, dates), date: dates.meetingDate || null }));
  }
  const total = Number(count[1].replace(/\./g, ''));
  if (!Number.isSafeInteger(total) || total < 0 || (total && !records.length)) throw new Error('Invalid Landtag catalogue result count');
  const next = html.match(/<li\b([^>]*\bclass=["'][^"']*\bpage-next\b[^"']*["'][^>]*)>([\s\S]*?)<\/li\s*>/i);
  let nextUrl = null;
  if (next && !/\bdisable\b|aria-disabled=["']true/i.test(next[1])) {
    const link = anchors(next[2])[0];
    if (!link) throw new Error('Invalid catalogue pagination shape');
    nextUrl = officialUrl(link.href, pageUrl, 'www.landtag-niedersachsen.de');
    if (new URL(nextUrl).pathname !== '/dokumentensuche/') throw new Error('Invalid official catalogue continuation');
  }
  return { records, total, nextUrl };
}
function parseLandtagFeed(value, feedUrl) {
  const xml = input(value);
  officialUrl(feedUrl, LANDTAG, 'www.landtag-niedersachsen.de');
  if (!/<rss\b[^>]*version=["']2\.0["']/i.test(xml) || !/<channel\b/i.test(xml) || !/<\/channel>\s*<\/rss>\s*$/i.test(xml) || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error('Unrecognised RSS response shape');
  }
  const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)];
  if ((xml.match(/<item\b/gi) || []).length !== items.length || items.length > 500) throw new Error('Invalid RSS item shape');
  return items.map(m => {
    const item = m[1], description = text(tag(item, 'description')), rawTitle = text(tag(item, 'title'));
    const kind = /Drucksachennummer/i.test(rawTitle) || !/stenoberichte/.test(feedUrl) ? 'Drucksache' : 'Stenografischer Bericht';
    const title = text(tag(item, 'description').match(/<b\b[^>]*>([\s\S]*?)<\/b>/i)?.[1]) || rawTitle;
    const url = officialUrl(text(tag(item, 'link')), feedUrl, 'www.landtag-niedersachsen.de');
    if (!title || !new URL(url).pathname.toLowerCase().endsWith('.pdf')) throw new Error('Invalid RSS document shape');
    const date = tag(item, 'pubDate').match(/\b(\d{2}) (\w{3}) (\d{4})\b/);
    const month = date ? ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(date[2]) + 1 : 0;
    const publicationDate = date && month ? `${date[3]}-${String(month).padStart(2,'0')}-${date[1]}` : null;
    const meetingDate = kind === 'Stenografischer Bericht' ? dateOnly(description) : null;
    return record({ title, url, originalPdfUrl: url, description, kind,
      number: rawTitle.match(/\b\d{1,2}\/\d+\b/)?.[0] || null, date: meetingDate,
      sourceContext: sourceContext('state', kind, semantics(description, kind).status, { publicationDate, meetingDate }) });
  });
}
function parseRegionIndex(value) {
  const html = input(value);
  if (!/Regionsversammlung und Ausschüsse/.test(text(html))) throw new Error('Unrecognised Region index shape');
  const result = [];
  for (const link of anchors(html)) {
    let url;
    try { url = officialUrl(link.href, REGION_INDEX, 'bekanntmachungen.region-hannover.de'); } catch { continue; }
    if (/^\/Regionsversammlung-und-Aussch(?:%C3%BC|ü)sse\/.+/i.test(new URL(url).pathname)) result.push(url);
  }
  return [...new Set(result)];
}
function parseRegionNotice(value, noticeUrl) {
  const html = input(value);
  officialUrl(noticeUrl, REGION, 'bekanntmachungen.region-hannover.de');
  const plain = text(html), meetingDate = dateOnly(plain.match(/Sitzung[^]*?findet[^]*?öffentlich statt\./i)?.[0]);
  const publicationDate = dateOnly(plain.match(/Veröffentlicht am\s+[^:]+:/i)?.[0]);
  const gremium = plain.match(/Sitzung (?:der|des) (.*?) findet/i)?.[1] || null;
  const agenda = html.match(/Tagesordnung\s*<\/[^>]+>([\s\S]*?)Weitere Informationen zur Tagesordnung/i)?.[1];
  if (!meetingDate || !gremium || !agenda) throw new Error('Unrecognised Region notice shape');
  const issuer = plain.match(/\b(Der Regionspräsident|Die Regionspräsidentin)\b/)?.[1] || null;
  const pdf = anchors(html).find(a => /\/content\/download\/.+\.pdf$/i.test(a.href));
  const originalPdfUrl = pdf ? officialUrl(pdf.href, noticeUrl, 'bekanntmachungen.region-hannover.de') : null;
  const paragraphs = [...agenda.matchAll(/<(?:p|li)\b[^>]*>([\s\S]*?)<\/(?:p|li)>/gi)].map(m => text(m[1]));
  const records = [];
  for (const paragraph of paragraphs) {
    const item = paragraph.match(/^(\d+(?:\.\d+)*\.)\s+(.+)$/);
    if (!item) continue;
    const title = item[2], top = item[1].replace(/\.$/, '');
    records.push(record({ title, url: noticeUrl.split('#')[0], id: createHash('sha256').update(`${noticeUrl.split('#')[0]}#top-${top}`).digest('hex').slice(0, 16), kind: 'Tagesordnung', level: 'region',
      number: null, date: meetingDate, gremium, snippet: title, ...(originalPdfUrl ? { originalPdfUrl } : {}),
      sourceContext: sourceContext('region', 'Tagesordnung', 'agenda', { issuer, publicationDate, meetingDate }) }));
  }
  if (!records.length) throw new Error('Region notice contains no agenda items');
  return records;
}
function substantiveText(record) {
  // Institutional boilerplate must never locate a statewide/regionwide document.
  return `${record.title || ''}\n${record.snippet || ''}`
    .replace(/(?:Treffpunkt|Sitzungssaal|Veranstaltungsort)\s*[^\n]*/gi, '')
    .replace(/(?:Hannah-Arendt-Platz|Hildesheimer Straße)\s+\d+\s*,?\s*30\d{3}\s+Hannover/gi, '')
    .replace(/Hannover,?\s*(?:den\s*)?\d{1,2}\.\s*(?:\d{1,2}\.|\w+)\s*\d{4}/gi, '')
    .replace(/(?:ÜSTRA\s+)?Hannoversche(?:n)? Verkehrsbetriebe(?:\s+AG)?|(?:Polizeidirektion|Region|regiobus|Zoo|Klinikum|Sparkasse|Versorgungs- und Verkehrsgesellschaft)\s+Hannover(?:\s+GmbH)?/gi, '');
}
function hasLocalTrafficEvidence(record) {
  const plain = substantiveText(record);
  const traffic = /Verkehr|Radweg|Radwege|Radfahr|Fahrrad|Fußgänger|Gehweg|Gehwege|Tempo.?30|Stadtbahn|Straßenbahn|Busverkehr|Zug|Züge|Fahrplan|zusätzlichen Linie|Ampel|Kreuzung|Unfall/i.test(plain);
  const local = /\bHannover\b|hannoverschen Eilenriede|\bEilenriede\b/i.test(plain);
  return traffic && local;
}

module.exports = { LANDTAG, REGION, REGION_INDEX, officialUrl, text, entities, dateOnly, sourceContext,
  parseLandtagCatalogue, parseLandtagFeed, parseRegionIndex, parseRegionNotice, hasLocalTrafficEvidence, substantiveText };
