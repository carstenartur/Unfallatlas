'use strict';

/**
 * Renderer-neutral audit of final document pages.
 *
 * Adapters for native PDF and LibreOffice-rendered DOCX feed the same model:
 * page boxes plus positioned words, images, links, headings and table rows.
 * This module never inspects pdfMake or OOXML intermediate structures, so a
 * renderer that clips or paginates content incorrectly cannot pass through a
 * structurally correct source model alone.
 */

const DEFAULTS = Object.freeze({
  pageMargin: 12,
  emptyPageMinWords: 3,
  minimumTextHeight: 7,
  orphanHeadingBottomFraction: 0.82,
  orphanHeadingMinFollowingWords: 4,
  minimumMapWidth: 180,
  minimumMapHeight: 120,
  mapAspectTolerance: 0.02,
});

class DocumentAuditError extends Error {
  constructor(code, path, value, message) {
    super(message ? `${code}: ${message}` : `${code}:${path}`);
    this.name = 'DocumentAuditError';
    this.code = code;
    this.path = path;
    this.value = value;
  }
}

function fail(code, path, value, message) {
  throw new DocumentAuditError(code, path, value, message);
}

function plainObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_object', path, value, `${path} must be an object`);
  }
  return value;
}

function finite(value, path, options = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || (!options.allowNegative && number < 0)) {
    fail('invalid_number', path, value, `${path} must be a finite${options.allowNegative ? '' : ' non-negative'} number`);
  }
  return number;
}

function integer(value, path, options = {}) {
  const number = finite(value, path, options);
  if (!Number.isInteger(number)) fail('invalid_integer', path, value, `${path} must be an integer`);
  return number;
}

function requiredString(value, path) {
  if (typeof value !== 'string' || !value.trim()) {
    fail('invalid_string', path, value, `${path} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value, path) {
  if (value == null || value === '') return null;
  return requiredString(value, path);
}

function normalizeBox(value, path) {
  const box = plainObject(value, path);
  const normalized = {
    xMin: finite(box.xMin, `${path}.xMin`, { allowNegative: true }),
    yMin: finite(box.yMin, `${path}.yMin`, { allowNegative: true }),
    xMax: finite(box.xMax, `${path}.xMax`, { allowNegative: true }),
    yMax: finite(box.yMax, `${path}.yMax`, { allowNegative: true }),
  };
  if (normalized.xMin >= normalized.xMax || normalized.yMin >= normalized.yMax) {
    fail('invalid_box', path, value, `${path} has non-positive dimensions`);
  }
  return normalized;
}

function normalizeWord(value, path) {
  const word = plainObject(value, path);
  return Object.freeze({
    text: requiredString(word.text, `${path}.text`),
    ...normalizeBox(word, path),
    ...(word.fontSize == null ? {} : { fontSize: finite(word.fontSize, `${path}.fontSize`) }),
    ...(word.style == null ? {} : { style: requiredString(word.style, `${path}.style`) }),
  });
}

function normalizeImage(value, path) {
  const image = plainObject(value, path);
  const kind = optionalString(image.kind, `${path}.kind`) || 'other';
  if (!['map', 'chart', 'logo', 'photo', 'other'].includes(kind)) {
    fail('invalid_image_kind', `${path}.kind`, kind);
  }
  const box = normalizeBox(image, path);
  const sourceWidth = image.sourceWidth == null ? null : finite(image.sourceWidth, `${path}.sourceWidth`);
  const sourceHeight = image.sourceHeight == null ? null : finite(image.sourceHeight, `${path}.sourceHeight`);
  if ((sourceWidth == null) !== (sourceHeight == null)) {
    fail('incomplete_source_dimensions', path, image,
      `${path} must provide both sourceWidth and sourceHeight or neither`);
  }
  return Object.freeze({
    imageId: requiredString(image.imageId, `${path}.imageId`),
    kind,
    ...box,
    sourceWidth,
    sourceHeight,
    altText: optionalString(image.altText, `${path}.altText`),
    caption: optionalString(image.caption, `${path}.caption`),
    sourceIds: Object.freeze(normalizeStringArray(image.sourceIds || [], `${path}.sourceIds`, true)),
  });
}

function normalizeLink(value, path) {
  const link = plainObject(value, path);
  const uri = requiredString(link.uri, `${path}.uri`);
  let parsed;
  try { parsed = new URL(uri); } catch (_) {
    fail('invalid_link', `${path}.uri`, uri, `${path}.uri must be absolute`);
  }
  if (!['https:', 'mailto:'].includes(parsed.protocol)) {
    fail('unsafe_link', `${path}.uri`, uri, `${path}.uri uses unsupported scheme`);
  }
  return Object.freeze({
    uri,
    ...normalizeBox(link, path),
    label: optionalString(link.label, `${path}.label`),
  });
}

function normalizeHeading(value, path) {
  const heading = plainObject(value, path);
  return Object.freeze({
    text: requiredString(heading.text, `${path}.text`),
    level: integer(heading.level, `${path}.level`),
    ...normalizeBox(heading, path),
  });
}

function normalizeTableRow(value, path) {
  const row = plainObject(value, path);
  return Object.freeze({
    rowId: requiredString(row.rowId, `${path}.rowId`),
    tableId: requiredString(row.tableId, `${path}.tableId`),
    ...normalizeBox(row, path),
    repeatedHeader: Boolean(row.repeatedHeader),
    cells: Object.freeze(normalizeStringArray(row.cells || [], `${path}.cells`, true)),
  });
}

function normalizeStringArray(value, path, allowEmpty) {
  if (!Array.isArray(value)) fail('invalid_array', path, value, `${path} must be an array`);
  const normalized = value.map((item, index) => requiredString(item, `${path}[${index}]`));
  if (!allowEmpty && normalized.length === 0) fail('empty_array', path, value, `${path} must not be empty`);
  return [...new Set(normalized)];
}

function normalizePage(value, index) {
  const path = `document.pages[${index}]`;
  const page = plainObject(value, path);
  const width = finite(page.width, `${path}.width`);
  const height = finite(page.height, `${path}.height`);
  const number = integer(page.number, `${path}.number`);
  if (number !== index + 1) {
    fail('non_sequential_pages', `${path}.number`, number,
      `expected page number ${index + 1}, got ${number}`);
  }
  return Object.freeze({
    number,
    width,
    height,
    words: Object.freeze((page.words || []).map((word, wordIndex) =>
      normalizeWord(word, `${path}.words[${wordIndex}]`)
    )),
    images: Object.freeze((page.images || []).map((image, imageIndex) =>
      normalizeImage(image, `${path}.images[${imageIndex}]`)
    )),
    links: Object.freeze((page.links || []).map((link, linkIndex) =>
      normalizeLink(link, `${path}.links[${linkIndex}]`)
    )),
    headings: Object.freeze((page.headings || []).map((heading, headingIndex) =>
      normalizeHeading(heading, `${path}.headings[${headingIndex}]`)
    )),
    tableRows: Object.freeze((page.tableRows || []).map((row, rowIndex) =>
      normalizeTableRow(row, `${path}.tableRows[${rowIndex}]`)
    )),
  });
}

function normalizeExpectedCount(value, index) {
  const path = `document.expectedCounts[${index}]`;
  const count = plainObject(value, path);
  return Object.freeze({
    countId: requiredString(count.countId, `${path}.countId`),
    value: integer(count.value, `${path}.value`),
    requiredTextPatterns: Object.freeze(normalizeStringArray(
      count.requiredTextPatterns || [], `${path}.requiredTextPatterns`, false
    )),
  });
}

function normalizeDocument(value) {
  const document = plainObject(value, 'document');
  if (!Array.isArray(document.pages) || document.pages.length === 0) {
    fail('missing_pages', 'document.pages', document.pages, 'document.pages must not be empty');
  }
  return Object.freeze({
    documentId: requiredString(document.documentId, 'document.documentId'),
    renderer: requiredString(document.renderer, 'document.renderer'),
    pages: Object.freeze(document.pages.map(normalizePage)),
    requiredHeadings: Object.freeze(normalizeStringArray(
      document.requiredHeadings || [], 'document.requiredHeadings', true
    )),
    requiredLinks: Object.freeze(normalizeStringArray(
      document.requiredLinks || [], 'document.requiredLinks', true
    )),
    requiredImageKinds: Object.freeze(normalizeStringArray(
      document.requiredImageKinds || [], 'document.requiredImageKinds', true
    )),
    expectedCounts: Object.freeze((document.expectedCounts || []).map(normalizeExpectedCount)),
    ...(document.sourceManifestHash == null ? {} : {
      sourceManifestHash: requiredString(document.sourceManifestHash, 'document.sourceManifestHash'),
    }),
  });
}

function normalizeOptions(value) {
  const options = { ...DEFAULTS, ...(value || {}) };
  for (const key of [
    'pageMargin', 'emptyPageMinWords', 'minimumTextHeight',
    'orphanHeadingBottomFraction', 'orphanHeadingMinFollowingWords',
    'minimumMapWidth', 'minimumMapHeight', 'mapAspectTolerance',
  ]) {
    options[key] = finite(options[key], `options.${key}`);
  }
  if (options.orphanHeadingBottomFraction <= 0 || options.orphanHeadingBottomFraction >= 1) {
    fail('invalid_option', 'options.orphanHeadingBottomFraction', options.orphanHeadingBottomFraction);
  }
  return Object.freeze(options);
}

function pageText(page) {
  return page.words
    .slice()
    .sort((left, right) => left.yMin - right.yMin || left.xMin - right.xMin)
    .map(word => word.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function documentText(document) {
  return document.pages.map(pageText).join('\n');
}

function issue(code, severity, page, path, message, details) {
  return Object.freeze({
    code,
    severity,
    page: page == null ? null : page,
    path,
    message,
    details: details || null,
  });
}

function insidePage(box, page, margin) {
  return box.xMin >= margin && box.yMin >= margin &&
    box.xMax <= page.width - margin && box.yMax <= page.height - margin;
}

function auditPageBounds(page, options, issues) {
  const collections = [
    ['words', page.words],
    ['images', page.images],
    ['links', page.links],
    ['headings', page.headings],
    ['tableRows', page.tableRows],
  ];
  for (const [collectionName, collection] of collections) {
    collection.forEach((entry, index) => {
      if (!insidePage(entry, page, options.pageMargin)) {
        issues.push(issue(
          'content_outside_page', 'error', page.number,
          `pages[${page.number - 1}].${collectionName}[${index}]`,
          `${collectionName} entry crosses the printable page boundary`,
          { box: entry, page: { width: page.width, height: page.height }, margin: options.pageMargin }
        ));
      }
    });
  }
}

function auditEmptyPage(page, options, issues) {
  const significantWords = page.words.filter(word => /[\p{L}\p{N}]/u.test(word.text));
  const structuralElements = page.images.length + page.links.length +
    page.headings.length + page.tableRows.length;
  if (significantWords.length < options.emptyPageMinWords && structuralElements === 0) {
    issues.push(issue(
      'empty_page', 'error', page.number, `pages[${page.number - 1}]`,
      `page ${page.number} has only ${significantWords.length} significant words and no structural content`
    ));
  }
}

function effectiveTextHeight(word) {
  return word.fontSize == null ? word.yMax - word.yMin : word.fontSize;
}

function auditTextSize(page, options, issues) {
  page.words.forEach((word, index) => {
    if (effectiveTextHeight(word) + 1e-6 < options.minimumTextHeight) {
      issues.push(issue(
        'text_too_small', 'error', page.number,
        `pages[${page.number - 1}].words[${index}]`,
        `text “${word.text}” is below the minimum readable size`,
        { measuredHeight: effectiveTextHeight(word), minimum: options.minimumTextHeight }
      ));
    }
  });
}

function followingWords(page, heading) {
  return page.words.filter(word =>
    word.yMin >= heading.yMax && word.yMin <= page.height && /[\p{L}\p{N}]/u.test(word.text)
  );
}

function auditOrphanHeadings(page, options, issues) {
  page.headings.forEach((heading, index) => {
    const bottomFraction = heading.yMax / page.height;
    const following = followingWords(page, heading);
    if (bottomFraction >= options.orphanHeadingBottomFraction &&
        following.length < options.orphanHeadingMinFollowingWords) {
      issues.push(issue(
        'orphan_heading', 'error', page.number,
        `pages[${page.number - 1}].headings[${index}]`,
        `heading “${heading.text}” is orphaned near the page bottom`,
        { bottomFraction, followingWords: following.length }
      ));
    }
  });
}

function auditMaps(page, options, issues) {
  page.images.forEach((image, index) => {
    if (image.kind !== 'map') return;
    const width = image.xMax - image.xMin;
    const height = image.yMax - image.yMin;
    if (width < options.minimumMapWidth || height < options.minimumMapHeight) {
      issues.push(issue(
        'map_too_small', 'error', page.number,
        `pages[${page.number - 1}].images[${index}]`,
        `map ${image.imageId} is too small for labels and accident markers`,
        { width, height, minimumWidth: options.minimumMapWidth, minimumHeight: options.minimumMapHeight }
      ));
    }
    if (!image.altText || !image.caption) {
      issues.push(issue(
        'map_unlabelled', 'error', page.number,
        `pages[${page.number - 1}].images[${index}]`,
        `map ${image.imageId} requires alt text and a caption`
      ));
    }
    if (image.sourceIds.length === 0) {
      issues.push(issue(
        'map_source_missing', 'error', page.number,
        `pages[${page.number - 1}].images[${index}]`,
        `map ${image.imageId} is not linked to any source IDs`
      ));
    }
    if (image.sourceWidth != null && image.sourceHeight != null) {
      const sourceRatio = image.sourceWidth / image.sourceHeight;
      const renderedRatio = width / height;
      const relativeError = Math.abs(renderedRatio - sourceRatio) / sourceRatio;
      if (relativeError > options.mapAspectTolerance) {
        issues.push(issue(
          'map_aspect_distorted', 'error', page.number,
          `pages[${page.number - 1}].images[${index}]`,
          `map ${image.imageId} changes aspect ratio during rendering`,
          { sourceRatio, renderedRatio, relativeError, tolerance: options.mapAspectTolerance }
        ));
      }
    }
  });
}

function auditTableRows(page, issues) {
  const rowsByTable = new Map();
  page.tableRows.forEach((row, index) => {
    if (!rowsByTable.has(row.tableId)) rowsByTable.set(row.tableId, []);
    rowsByTable.get(row.tableId).push({ row, index });
  });
  for (const [tableId, rows] of rowsByTable.entries()) {
    rows.sort((left, right) => left.row.yMin - right.row.yMin);
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1].row;
      const current = rows[index].row;
      if (current.yMin < previous.yMax - 0.5) {
        issues.push(issue(
          'table_rows_overlap', 'error', page.number,
          `pages[${page.number - 1}].tableRows[${rows[index].index}]`,
          `table ${tableId} has overlapping rows ${previous.rowId} and ${current.rowId}`,
          { previous, current }
        ));
      }
    }
  }
}

function auditRequiredHeadings(document, text, issues) {
  for (const heading of document.requiredHeadings) {
    if (!text.toLocaleLowerCase('de-DE').includes(heading.toLocaleLowerCase('de-DE'))) {
      issues.push(issue(
        'required_heading_missing', 'error', null, 'document.requiredHeadings',
        `required heading “${heading}” is absent from rendered text`
      ));
    }
  }
}

function auditRequiredLinks(document, issues) {
  const rendered = new Set(document.pages.flatMap(page => page.links.map(link => link.uri)));
  for (const uri of document.requiredLinks) {
    if (!rendered.has(uri)) {
      issues.push(issue(
        'required_link_missing', 'error', null, 'document.requiredLinks',
        `required clickable link ${uri} is absent from the final document`
      ));
    }
  }
}

function auditRequiredImageKinds(document, issues) {
  const kinds = new Set(document.pages.flatMap(page => page.images.map(image => image.kind)));
  for (const kind of document.requiredImageKinds) {
    if (!kinds.has(kind)) {
      issues.push(issue(
        'required_image_missing', 'error', null, 'document.requiredImageKinds',
        `required ${kind} image is absent from rendered pages`
      ));
    }
  }
}

function countPatternOccurrences(text, patternText) {
  let pattern;
  try { pattern = new RegExp(patternText, 'giu'); } catch (error) {
    fail('invalid_count_pattern', 'document.expectedCounts.requiredTextPatterns', patternText,
      `invalid regular expression: ${error.message}`);
  }
  return [...text.matchAll(pattern)].length;
}

function auditExpectedCounts(document, text, issues) {
  for (const expected of document.expectedCounts) {
    for (const pattern of expected.requiredTextPatterns) {
      const expanded = pattern.replace(/\{value\}/g, String(expected.value));
      if (countPatternOccurrences(text, expanded) === 0) {
        issues.push(issue(
          'expected_count_missing', 'error', null, 'document.expectedCounts',
          `count ${expected.countId}=${expected.value} is not represented by pattern ${pattern}`,
          { countId: expected.countId, value: expected.value, pattern }
        ));
      }
    }
  }
}

function auditRenderedDocument(documentValue, optionValue) {
  const document = normalizeDocument(documentValue);
  const options = normalizeOptions(optionValue);
  const issues = [];
  for (const page of document.pages) {
    auditEmptyPage(page, options, issues);
    auditPageBounds(page, options, issues);
    auditTextSize(page, options, issues);
    auditOrphanHeadings(page, options, issues);
    auditMaps(page, options, issues);
    auditTableRows(page, issues);
  }
  const text = documentText(document);
  auditRequiredHeadings(document, text, issues);
  auditRequiredLinks(document, issues);
  auditRequiredImageKinds(document, issues);
  auditExpectedCounts(document, text, issues);
  const counts = issues.reduce((result, item) => {
    result[item.severity] = (result[item.severity] || 0) + 1;
    return result;
  }, {});
  return Object.freeze({
    schemaVersion: 1,
    documentId: document.documentId,
    renderer: document.renderer,
    pageCount: document.pages.length,
    passed: (counts.error || 0) === 0,
    counts: Object.freeze({ error: counts.error || 0, warning: counts.warning || 0 }),
    issues: Object.freeze(issues),
    summary: Object.freeze({
      wordCount: document.pages.reduce((sum, page) => sum + page.words.length, 0),
      imageCount: document.pages.reduce((sum, page) => sum + page.images.length, 0),
      mapCount: document.pages.reduce((sum, page) =>
        sum + page.images.filter(image => image.kind === 'map').length, 0
      ),
      linkCount: document.pages.reduce((sum, page) => sum + page.links.length, 0),
      tableRowCount: document.pages.reduce((sum, page) => sum + page.tableRows.length, 0),
      sourceManifestHash: document.sourceManifestHash || null,
    }),
  });
}

function assertRenderedDocument(documentValue, optionValue) {
  const report = auditRenderedDocument(documentValue, optionValue);
  if (!report.passed) {
    const codes = [...new Set(report.issues.map(item => item.code))].join(', ');
    const error = new DocumentAuditError(
      'rendered_document_audit_failed', 'document', report,
      `${report.counts.error} error(s): ${codes}`
    );
    error.report = report;
    throw error;
  }
  return report;
}

module.exports = {
  DEFAULTS,
  DocumentAuditError,
  auditRenderedDocument,
  assertRenderedDocument,
  normalizeDocument,
  pageText,
};
