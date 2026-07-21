#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  auditRenderedDocument,
  assertRenderedDocument,
} = require('./rendered-document-audit');

class PopplerAdapterError extends Error {
  constructor(code, message, details) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'PopplerAdapterError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new PopplerAdapterError(code, message, details);
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([a-f0-9]+);/gi, (_, hexadecimal) => String.fromCodePoint(parseInt(hexadecimal, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripTags(value) {
  const decoded = decodeXml(String(value || ''));
  return decoded
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAttributes(value) {
  const attributes = {};
  const pattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(String(value || '')))) {
    attributes[match[1]] = decodeXml(match[2] == null ? match[3] : match[2]);
  }
  return attributes;
}

function numberAttribute(attributes, key, pathLabel) {
  const number = Number(attributes[key]);
  if (!Number.isFinite(number)) fail('invalid_poppler_xml', `${pathLabel}.${key} is not numeric`);
  return number;
}

function elementBlocks(xml, tagName) {
  const pattern = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const blocks = [];
  let match;
  while ((match = pattern.exec(String(xml || '')))) {
    blocks.push({ attributes: parseAttributes(match[1]), content: match[2], index: match.index });
  }
  return blocks;
}

function parseBboxPages(xml) {
  const pages = elementBlocks(xml, 'page');
  if (!pages.length) fail('missing_poppler_pages', 'pdftotext bbox output contains no pages');
  return pages.map((page, pageIndex) => {
    const width = numberAttribute(page.attributes, 'width', `bbox.pages[${pageIndex}]`);
    const height = numberAttribute(page.attributes, 'height', `bbox.pages[${pageIndex}]`);
    const wordPattern = /<word\b([^>]*)>([\s\S]*?)<\/word>/gi;
    const words = [];
    let wordMatch;
    while ((wordMatch = wordPattern.exec(page.content))) {
      const attributes = parseAttributes(wordMatch[1]);
      const text = stripTags(wordMatch[2]);
      if (!text) continue;
      words.push({
        text,
        xMin: numberAttribute(attributes, 'xMin', `bbox.pages[${pageIndex}].word`),
        yMin: numberAttribute(attributes, 'yMin', `bbox.pages[${pageIndex}].word`),
        xMax: numberAttribute(attributes, 'xMax', `bbox.pages[${pageIndex}].word`),
        yMax: numberAttribute(attributes, 'yMax', `bbox.pages[${pageIndex}].word`),
      });
    }
    return { number: pageIndex + 1, width, height, words };
  });
}

function parsePdfToHtmlPages(xml) {
  const fontSpecs = new Map();
  const fontPattern = /<fontspec\b([^>]*)\/?\s*>/gi;
  let fontMatch;
  while ((fontMatch = fontPattern.exec(String(xml || '')))) {
    const attributes = parseAttributes(fontMatch[1]);
    if (attributes.id == null) continue;
    fontSpecs.set(String(attributes.id), {
      size: Number(attributes.size),
      family: attributes.family || null,
      color: attributes.color || null,
    });
  }

  const pages = elementBlocks(xml, 'page');
  if (!pages.length) fail('missing_poppler_pages', 'pdftohtml XML contains no pages');
  return pages.map((page, pageIndex) => {
    const width = numberAttribute(page.attributes, 'width', `html.pages[${pageIndex}]`);
    const height = numberAttribute(page.attributes, 'height', `html.pages[${pageIndex}]`);
    const texts = [];
    const links = [];
    const images = [];
    const textPattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let textMatch;
    while ((textMatch = textPattern.exec(page.content))) {
      const attributes = parseAttributes(textMatch[1]);
      const left = numberAttribute(attributes, 'left', `html.pages[${pageIndex}].text`);
      const top = numberAttribute(attributes, 'top', `html.pages[${pageIndex}].text`);
      const textWidth = numberAttribute(attributes, 'width', `html.pages[${pageIndex}].text`);
      const textHeight = numberAttribute(attributes, 'height', `html.pages[${pageIndex}].text`);
      const text = stripTags(textMatch[2]);
      const font = fontSpecs.get(String(attributes.font)) || null;
      if (text) {
        texts.push({
          text,
          xMin: left,
          yMin: top,
          xMax: left + textWidth,
          yMax: top + textHeight,
          fontSize: font && Number.isFinite(font.size) ? font.size : null,
          fontFamily: font && font.family,
          color: font && font.color,
        });
      }
      const linkPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
      let linkMatch;
      while ((linkMatch = linkPattern.exec(textMatch[2]))) {
        const linkAttributes = parseAttributes(linkMatch[1]);
        const uri = linkAttributes.href;
        if (!uri) continue;
        links.push({
          uri,
          label: stripTags(linkMatch[2]) || null,
          xMin: left,
          yMin: top,
          xMax: left + textWidth,
          yMax: top + textHeight,
        });
      }
    }

    const imagePattern = /<image\b([^>]*)\/?\s*>/gi;
    let imageMatch;
    let imageIndex = 0;
    while ((imageMatch = imagePattern.exec(page.content))) {
      const attributes = parseAttributes(imageMatch[1]);
      const left = numberAttribute(attributes, 'left', `html.pages[${pageIndex}].image`);
      const top = numberAttribute(attributes, 'top', `html.pages[${pageIndex}].image`);
      const imageWidth = numberAttribute(attributes, 'width', `html.pages[${pageIndex}].image`);
      const imageHeight = numberAttribute(attributes, 'height', `html.pages[${pageIndex}].image`);
      images.push({
        imageId: attributes.src || `page-${pageIndex + 1}-image-${++imageIndex}`,
        kind: 'other',
        xMin: left,
        yMin: top,
        xMax: left + imageWidth,
        yMax: top + imageHeight,
        sourceWidth: null,
        sourceHeight: null,
        altText: null,
        caption: null,
        sourceIds: [],
      });
    }
    return { number: pageIndex + 1, width, height, texts, links, images };
  });
}

function median(values) {
  const filtered = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!filtered.length) return null;
  const middle = Math.floor(filtered.length / 2);
  return filtered.length % 2 ? filtered[middle] : (filtered[middle - 1] + filtered[middle]) / 2;
}

function containsPoint(box, x, y) {
  return x >= box.xMin - 1 && x <= box.xMax + 1 && y >= box.yMin - 1 && y <= box.yMax + 1;
}

function scaleBox(item, scaleX, scaleY) {
  return {
    ...item,
    xMin: item.xMin * scaleX,
    yMin: item.yMin * scaleY,
    xMax: item.xMax * scaleX,
    yMax: item.yMax * scaleY,
    ...(item.fontSize == null ? {} : { fontSize: item.fontSize * scaleY }),
  };
}

function applyImageHints(images, hints, pageNumber) {
  const pageHints = Array.isArray(hints) ? hints.filter(hint => Number(hint.page) === pageNumber) : [];
  return images.map((image, index) => {
    const hint = pageHints.find(candidate =>
      candidate.imageId === image.imageId || Number(candidate.imageIndex) === index
    );
    if (!hint) return image;
    return {
      ...image,
      kind: hint.kind || image.kind,
      altText: hint.altText == null ? image.altText : String(hint.altText),
      caption: hint.caption == null ? image.caption : String(hint.caption),
      sourceIds: Array.isArray(hint.sourceIds) ? hint.sourceIds.map(String) : image.sourceIds,
      sourceWidth: hint.sourceWidth == null ? image.sourceWidth : Number(hint.sourceWidth),
      sourceHeight: hint.sourceHeight == null ? image.sourceHeight : Number(hint.sourceHeight),
    };
  });
}

function combinePopplerModels(bboxPages, htmlPages, options = {}) {
  if (bboxPages.length !== htmlPages.length) {
    fail('page_count_mismatch', `pdftotext produced ${bboxPages.length} pages; pdftohtml produced ${htmlPages.length}`);
  }
  return bboxPages.map((bboxPage, pageIndex) => {
    const htmlPage = htmlPages[pageIndex];
    const scaleX = bboxPage.width / htmlPage.width;
    const scaleY = bboxPage.height / htmlPage.height;
    const texts = htmlPage.texts.map(item => scaleBox(item, scaleX, scaleY));
    const bodyFont = median(texts.map(item => item.fontSize));
    const words = bboxPage.words.map(word => {
      const centerX = (word.xMin + word.xMax) / 2;
      const centerY = (word.yMin + word.yMax) / 2;
      const owner = texts.find(text => containsPoint(text, centerX, centerY));
      return {
        ...word,
        ...(owner && Number.isFinite(owner.fontSize) ? { fontSize: owner.fontSize } : {}),
      };
    });
    const headings = texts
      .filter(item => Number.isFinite(item.fontSize) && bodyFont && item.fontSize >= bodyFont * 1.22)
      .filter(item => item.text.length <= 180)
      .map(item => ({
        text: item.text,
        level: item.fontSize >= bodyFont * 1.7 ? 1 : 2,
        xMin: item.xMin,
        yMin: item.yMin,
        xMax: item.xMax,
        yMax: item.yMax,
      }));
    return {
      number: bboxPage.number,
      width: bboxPage.width,
      height: bboxPage.height,
      words,
      headings,
      links: htmlPage.links.map(item => scaleBox(item, scaleX, scaleY)),
      images: applyImageHints(
        htmlPage.images.map(item => scaleBox(item, scaleX, scaleY)),
        options.imageHints,
        bboxPage.number
      ),
      tableRows: [],
    };
  });
}

function run(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
  });
  if (result.error) fail('poppler_command_failed', `${command}: ${result.error.message}`);
  if (result.status !== 0) {
    fail('poppler_command_failed', `${command} exited ${result.status}`, {
      stderr: String(result.stderr || '').slice(-4000),
    });
  }
  return String(result.stdout || '');
}

function extractPopplerDocument(pdfPath, options = {}) {
  const absolute = path.resolve(pdfPath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    fail('missing_pdf', `PDF does not exist: ${absolute}`);
  }
  const bboxXml = run(options.pdftotext || 'pdftotext', [
    '-bbox-layout', '-enc', 'UTF-8', absolute, '-',
  ]);
  const htmlXml = run(options.pdftohtml || 'pdftohtml', [
    '-xml', '-hidden', '-nodrm', '-stdout', absolute,
  ]);
  const bboxPages = parseBboxPages(bboxXml);
  const htmlPages = parsePdfToHtmlPages(htmlXml);
  const pages = combinePopplerModels(bboxPages, htmlPages, options);
  const contract = options.contract || {};
  return {
    documentId: options.documentId || path.basename(absolute),
    renderer: options.renderer || 'native-pdf-poppler',
    pages,
    requiredHeadings: contract.requiredHeadings || [],
    requiredLinks: contract.requiredLinks || [],
    requiredImageKinds: contract.requiredImageKinds || [],
    expectedCounts: contract.expectedCounts || [],
    ...(contract.sourceManifestHash ? { sourceManifestHash: contract.sourceManifestHash } : {}),
  };
}

function parseArgs(argv) {
  const options = { audit: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--pdf') options.pdf = argv[++index];
    else if (arg === '--out-dir') options.outDir = argv[++index];
    else if (arg === '--document-id') options.documentId = argv[++index];
    else if (arg === '--renderer') options.renderer = argv[++index];
    else if (arg === '--contract') options.contractPath = argv[++index];
    else if (arg === '--no-audit') options.audit = false;
    else fail('unknown_argument', `Unknown argument: ${arg}`);
  }
  if (!options.pdf) fail('missing_argument', '--pdf is required');
  if (!options.outDir) fail('missing_argument', '--out-dir is required');
  return options;
}

function main(argv, runtimeOptions = {}) {
  const options = { ...parseArgs(argv), ...runtimeOptions };
  const outDir = path.resolve(options.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const contract = options.contractPath
    ? JSON.parse(fs.readFileSync(path.resolve(options.contractPath), 'utf8'))
    : {};
  const model = extractPopplerDocument(options.pdf, { ...options, contract });
  const modelPath = path.join(outDir, 'rendered-document.json');
  fs.writeFileSync(modelPath, `${JSON.stringify(model, null, 2)}\n`);
  let report = null;
  if (options.audit) {
    report = assertRenderedDocument(model);
    fs.writeFileSync(path.join(outDir, 'rendered-document-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
  } else {
    report = auditRenderedDocument(model);
  }
  process.stdout.write(
    `[poppler-rendered-document] ${model.pages.length} page(s), ` +
    `${report.summary.wordCount} words, ${report.summary.imageCount} images, ` +
    `${report.summary.linkCount} links.\n`
  );
  return { model, report, modelPath };
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  PopplerAdapterError,
  parseAttributes,
  parseBboxPages,
  parsePdfToHtmlPages,
  combinePopplerModels,
  extractPopplerDocument,
  main,
};
