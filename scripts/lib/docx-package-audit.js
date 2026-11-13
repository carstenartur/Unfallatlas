'use strict';

const { createHash } = require('node:crypto');
const { posix } = require('node:path');
const { isDeepStrictEqual, TextDecoder } = require('node:util');
const JSZip = require('jszip');
const { SaxesParser } = require('saxes');
const { readStrictZip } = require('./strict-zip');

const PACKAGE = 'http://schemas.openxmlformats.org/package/2006';
const TYPES = `${PACKAGE}/content-types`;
const RELATIONSHIPS = `${PACKAGE}/relationships`;
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const WORD_DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const MAIN_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const RELATIONSHIPS_TYPE = 'application/vnd.openxmlformats-package.relationships+xml';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function parseXml(name, bytes) {
  const parser = new SaxesParser({ xmlns: true });
  const stack = [];
  let root;
  parser.on('opentag', tag => {
    const node = { ...tag, children: [] };
    if (stack.length) stack.at(-1).children.push(node);
    else root = node;
    stack.push(node);
  });
  const text = value => stack.at(-1)?.children.push(value);
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => stack.pop());
  parser.on('doctype', () => { throw new Error('DTD declarations are unsupported'); });
  try {
    parser.write(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).close();
  } catch (error) {
    throw new Error(`Invalid XML in ${name}: ${error.message}`, { cause: error });
  }
  return root;
}

function matches(node, uri, local) {
  return node?.uri === uri && node.local === local;
}

function child(node, uri, local) {
  return node?.children.find(value => matches(value, uri, local));
}

function* elements(node) {
  if (typeof node === 'string') return;
  yield node;
  for (const value of node.children) yield* elements(value);
}

function attribute(node, uri, name) {
  return node && Object.values(node.attributes).find(value => value.uri === uri && value.local === name)?.value;
}

function required(value, label) {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Invalid ${label}: ${value}`);
  return number;
}

function internalTarget(owner, target) {
  // Generated OPC parts use unescaped names. Resolve relative targets against
  // their owning part, including legitimate parent-directory references.
  if (/[\\%?#:\s]/u.test(target) || target.startsWith('//')) throw new Error(`Invalid internal OPC target ${target}`);
  const name = target.startsWith('/') ? target.slice(1) : posix.join(owner ? posix.dirname(owner) : '.', target);
  if (!name || name.startsWith('/') || name.startsWith('../') || name === '..' || posix.normalize(name) !== name || name.endsWith('/')) {
    throw new Error(`Invalid internal OPC target ${target}`);
  }
  return name;
}

function contentTypes(root, files) {
  if (!matches(root, TYPES, 'Types')) throw new Error('Invalid [Content_Types].xml root');
  const defaults = new Map();
  const overrides = new Map();
  for (const node of root.children.filter(value => typeof value !== 'string')) {
    const type = required(attribute(node, '', 'ContentType'), 'OPC ContentType');
    if (matches(node, TYPES, 'Default')) {
      const extension = required(attribute(node, '', 'Extension'), 'OPC Extension').toLowerCase();
      if (defaults.has(extension)) throw new Error(`Duplicate OPC extension ${extension}`);
      defaults.set(extension, type);
    } else if (matches(node, TYPES, 'Override')) {
      const part = required(attribute(node, '', 'PartName'), 'OPC PartName');
      const name = internalTarget(null, part);
      if (!part.startsWith('/') || !files.has(name) || overrides.has(name)) {
        throw new Error(`Invalid, duplicate or missing OPC content type part ${part}`);
      }
      overrides.set(name, type);
    } else {
      throw new Error(`Invalid OPC content type element ${node.name}`);
    }
  }
  const types = new Map();
  for (const name of files.keys()) {
    if (name === '[Content_Types].xml') continue;
    const extension = /\.([^.\/]+)$/u.exec(name)?.[1].toLowerCase();
    types.set(name, required(overrides.get(name) || defaults.get(extension), `content type for ${name}`));
  }
  return types;
}

function relationshipsFor(name, root, files) {
  if (!matches(root, RELATIONSHIPS, 'Relationships')) throw new Error(`Invalid relationship part ${name}`);
  const owner = name === '_rels/.rels' ? null : name.replace(/(^|\/)_rels\/([^/]+)\.rels$/u, '$1$2');
  if (owner !== null && (owner === name || !files.has(owner))) throw new Error(`Missing owner for relationship part ${name}`);
  const relationships = new Map();
  for (const node of root.children.filter(value => typeof value !== 'string')) {
    if (!matches(node, RELATIONSHIPS, 'Relationship')) throw new Error(`Invalid relationship element in ${name}`);
    const id = required(attribute(node, '', 'Id'), `relationship ID in ${name}`);
    const type = required(attribute(node, '', 'Type'), `relationship ${id} type in ${name}`);
    const target = required(attribute(node, '', 'Target'), `relationship ${id} target in ${name}`);
    const mode = attribute(node, '', 'TargetMode');
    if (relationships.has(id)) throw new Error(`Duplicate relationship ID ${id} in ${name}`);
    if (mode === 'External') {
      if (type !== `${OFFICE}/hyperlink` || !URL.canParse(target) || new URL(target).protocol !== 'https:') {
        throw new Error(`Unsupported external relationship ${id} in ${name}`);
      }
      relationships.set(id, { type, target, external: true });
    } else {
      const resolved = internalTarget(owner, target);
      if (mode && mode !== 'Internal') throw new Error(`Invalid relationship target mode ${mode} in ${name}`);
      if (!files.has(resolved)) throw new Error(`Relationship ${id} in ${name} points to missing part ${resolved}`);
      relationships.set(id, { type, target: resolved, external: false });
    }
  }
  return [owner, relationships];
}

function wordText(node) {
  return [...elements(node)].filter(value => matches(value, WORD, 't'))
    .map(value => value.children.filter(text => typeof text === 'string').join(''))
    .join('').normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function onOff(node) {
  return Boolean(node) && !['0', 'false', 'off'].includes(attribute(node, WORD, 'val'));
}

function bodySignature(document, relationships, files, types) {
  const body = child(document, WORD, 'body');
  if (!matches(document, WORD, 'document') || !body) throw new Error('Invalid WordprocessingML document body');
  const paragraphs = [];
  const tables = [];
  const pageSizes = [];
  const links = [];
  const images = [];

  for (const node of elements(body)) {
    if (matches(node, WORD, 'p')) {
      const text = wordText(node);
      if (text.includes('\ufffd')) throw new Error('WordprocessingML paragraph contains a replacement glyph');
      paragraphs.push({ text, keepNext: onOff(child(child(node, WORD, 'pPr'), WORD, 'keepNext')) });
    } else if (matches(node, WORD, 'tbl')) {
      const rows = node.children.filter(value => matches(value, WORD, 'tr')).map(row => {
        const props = child(row, WORD, 'trPr');
        return {
          repeatedHeader: onOff(child(props, WORD, 'tblHeader')),
          cantSplit: onOff(child(props, WORD, 'cantSplit')),
          cells: row.children.filter(value => matches(value, WORD, 'tc')).map(wordText),
        };
      });
      tables.push(rows);
    } else if (matches(node, WORD, 'pgSz')) {
      const width = positiveInteger(attribute(node, WORD, 'w'), 'Word page width');
      const height = positiveInteger(attribute(node, WORD, 'h'), 'Word page height');
      const orientation = attribute(node, WORD, 'orient') || 'portrait';
      if (orientation !== (width > height ? 'landscape' : 'portrait')) throw new Error('Inconsistent Word page orientation');
      pageSizes.push({ orientation, width, height });
    } else if (matches(node, WORD, 'hyperlink')) {
      const id = attribute(node, OFFICE, 'id');
      if (!id) continue;
      const relationship = relationships.get(id);
      if (!relationship?.external || relationship.type !== `${OFFICE}/hyperlink`) throw new Error(`Invalid hyperlink relationship ${id}`);
      links.push(relationship.target);
    } else if (matches(node, WORD, 'drawing')) {
      const drawing = [...elements(node)];
      const blip = drawing.find(value => matches(value, DRAWING, 'blip'));
      const extent = drawing.find(value => matches(value, WORD_DRAWING, 'extent'));
      const id = required(attribute(blip, OFFICE, 'embed'), 'embedded drawing relationship');
      const relationship = relationships.get(id);
      if (relationship?.type !== `${OFFICE}/image` || !types.get(relationship.target)?.startsWith('image/')) {
        throw new Error(`Invalid embedded image relationship ${id}`);
      }
      images.push({
        sha256: sha256(files.get(relationship.target)),
        width: positiveInteger(attribute(extent, '', 'cx'), 'Word drawing width'),
        height: positiveInteger(attribute(extent, '', 'cy'), 'Word drawing height'),
      });
    }
  }
  if (!paragraphs.length || !pageSizes.length) throw new Error('WordprocessingML lacks paragraphs or page sizes');
  return { paragraphs, tables, pageSizes, links, images };
}

async function readParts(bytes, officeSavedCopy) {
  if (!officeSavedCopy) return new Map(readStrictZip(bytes).files.map(file => [file.name, file.data]));

  // Writer saves valid ZIP data descriptors. JSZip checks the CRC of every
  // entry and is used only for the copy just created by the local converter.
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  return new Map(await Promise.all(Object.values(zip.files).filter(file => !file.dir).map(async file => {
    if (file.unsafeOriginalName !== file.name) throw new Error(`Invalid saved DOCX part path ${file.unsafeOriginalName}`);
    return [file.name, await file.async('nodebuffer')];
  })));
}

async function inspectDocx(bytes, { officeSavedCopy = false } = {}) {
  const files = await readParts(bytes, officeSavedCopy);
  const types = contentTypes(parseXml('[Content_Types].xml', required(files.get('[Content_Types].xml'), '[Content_Types].xml')), files);
  const xml = new Map([...types].filter(([, type]) => /(?:\+|\/)xml$/u.test(type))
    .map(([name]) => [name, parseXml(name, files.get(name))]));
  const relationships = new Map([...types].filter(([, type]) => type === RELATIONSHIPS_TYPE)
    .map(([name]) => relationshipsFor(name, xml.get(name), files)));
  const entryPoints = [...(relationships.get(null)?.values() || [])].filter(value => value.type === `${OFFICE}/officeDocument`);
  if (entryPoints.length !== 1 || types.get(entryPoints[0].target) !== MAIN_TYPE) {
    throw new Error('DOCX must declare one WordprocessingML main document part');
  }
  const main = entryPoints[0].target;
  for (const [name, root] of xml) {
    for (const node of elements(root)) {
      for (const { uri, local, value } of Object.values(node.attributes)) {
        if (uri === OFFICE && ['id', 'embed', 'link'].includes(local) && !relationships.get(name)?.has(value)) {
          throw new Error(`Missing relationship ${value} referenced by ${name}`);
        }
      }
    }
  }
  return {
    bytes: bytes.length,
    sha256: sha256(bytes),
    parts: files.size,
    signature: bodySignature(xml.get(main), relationships.get(main) || new Map(), files, types),
  };
}

function assertPreserved(original, saved) {
  for (const [name, value] of Object.entries(original.signature)) {
    if (!isDeepStrictEqual(value, saved.signature[name])) throw new Error(`DOCX round trip changed ${name}`);
  }
}

module.exports = { inspectDocx, assertPreserved };
