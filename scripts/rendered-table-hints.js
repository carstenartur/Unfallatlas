#!/usr/bin/env node
'use strict';

/**
 * Reconstructs declared Golden tables from final Poppler word coordinates.
 *
 * The contract provides only semantic anchors (page, headers and expected cell
 * patterns). Row boxes and visible cell text are derived from the final PDF,
 * never from DOCX or pdfMake intermediate structures.
 */

class RenderedTableHintError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'RenderedTableHintError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new RenderedTableHintError(code, message, details);
}

function normalizeText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[—−]/g, '–')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:%\]])/g, '$1')
    .replace(/([\[])\s+/g, '$1')
    .trim();
}

function wordCenterY(word) {
  return (Number(word.yMin) + Number(word.yMax)) / 2;
}

function clusterWordsIntoLines(words, tolerance = 3) {
  if (!Array.isArray(words)) fail('invalid_words', 'words must be an array');
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    fail('invalid_table_hint', 'lineTolerance must be a finite non-negative number', {
      value: tolerance,
    });
  }
  const sorted = [...words].sort((left, right) =>
    wordCenterY(left) - wordCenterY(right) || Number(left.xMin) - Number(right.xMin)
  );
  const lines = [];
  for (const word of sorted) {
    const center = wordCenterY(word);
    let best = null;
    let bestDistance = Infinity;
    for (const line of lines) {
      const distance = Math.abs(line.centerY - center);
      if (distance <= tolerance && distance < bestDistance) {
        best = line;
        bestDistance = distance;
      }
    }
    if (!best) {
      best = { centerY: center, words: [] };
      lines.push(best);
    }
    best.words.push(word);
    best.centerY = best.words.reduce((sum, item) => sum + wordCenterY(item), 0) / best.words.length;
  }
  return lines
    .map((line) => {
      const lineWords = [...line.words].sort((left, right) => Number(left.xMin) - Number(right.xMin));
      return Object.freeze({
        centerY: line.centerY,
        words: Object.freeze(lineWords),
        text: normalizeText(lineWords.map((word) => word.text).join(' ')),
        xMin: Math.min(...lineWords.map((word) => Number(word.xMin))),
        yMin: Math.min(...lineWords.map((word) => Number(word.yMin))),
        xMax: Math.max(...lineWords.map((word) => Number(word.xMax))),
        yMax: Math.max(...lineWords.map((word) => Number(word.yMax))),
      });
    })
    .sort((left, right) => left.centerY - right.centerY);
}

function phraseBox(line, phrase) {
  const expected = normalizeText(phrase).toLocaleLowerCase('de-DE');
  if (!expected) fail('invalid_table_hint', 'header phrase must not be empty');
  for (let start = 0; start < line.words.length; start += 1) {
    for (let end = start + 1; end <= line.words.length; end += 1) {
      const candidate = normalizeText(
        line.words.slice(start, end).map((word) => word.text).join(' '),
      ).toLocaleLowerCase('de-DE');
      if (candidate === expected) {
        const selected = line.words.slice(start, end);
        return {
          xMin: Math.min(...selected.map((word) => Number(word.xMin))),
          yMin: Math.min(...selected.map((word) => Number(word.yMin))),
          xMax: Math.max(...selected.map((word) => Number(word.xMax))),
          yMax: Math.max(...selected.map((word) => Number(word.yMax))),
        };
      }
    }
  }
  return null;
}

function locateHeader(lines, headers, tableId) {
  if (!Array.isArray(headers) || headers.length < 2) {
    fail('invalid_table_hint', `${tableId}.headers must contain at least two cells`);
  }
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const boxes = headers.map((header) => phraseBox(line, header));
    if (boxes.every(Boolean)) {
      const centres = boxes.map((box) => (box.xMin + box.xMax) / 2);
      if (!centres.every((value, index) => index === 0 || value > centres[index - 1])) {
        continue;
      }
      return { lineIndex, line, boxes, centres };
    }
  }
  fail('table_header_missing', `Cannot locate final header for table ${tableId}`, { headers });
}

function columnBoundaries(centres) {
  const boundaries = [-Infinity];
  for (let index = 1; index < centres.length; index += 1) {
    boundaries.push((centres[index - 1] + centres[index]) / 2);
  }
  boundaries.push(Infinity);
  return boundaries;
}

function columnForWord(word, boundaries) {
  const centerX = (Number(word.xMin) + Number(word.xMax)) / 2;
  const column = boundaries.findIndex((right, index) => index > 0 && centerX < right) - 1;
  return Math.max(0, Math.min(boundaries.length - 2, column));
}

function cellsForLines(lines, boundaries) {
  if (!Array.isArray(lines) || !lines.length) {
    fail('invalid_table_hint', 'at least one rendered line is required for a table row');
  }
  const columns = Array.from({ length: boundaries.length - 1 }, () => []);
  for (const line of lines) {
    for (const word of line.words) {
      columns[columnForWord(word, boundaries)].push(word);
    }
  }
  return columns.map((words) => normalizeText(
    words
      .sort((left, right) => wordCenterY(left) - wordCenterY(right) || Number(left.xMin) - Number(right.xMin))
      .map((word) => word.text)
      .join(' '),
  ));
}

function cellsForLine(line, boundaries) {
  return cellsForLines([line], boundaries);
}

function boxForLines(lines) {
  return {
    xMin: Math.min(...lines.map((line) => line.xMin)),
    yMin: Math.min(...lines.map((line) => line.yMin)),
    xMax: Math.max(...lines.map((line) => line.xMax)),
    yMax: Math.max(...lines.map((line) => line.yMax)),
  };
}

function positiveInteger(value, path, fallback) {
  const candidate = value == null ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < 1) {
    fail('invalid_table_hint', `${path} must be a positive integer`, { value });
  }
  return candidate;
}

function booleanFlag(value, path) {
  if (value == null) return false;
  if (typeof value !== 'boolean') {
    fail('invalid_table_hint', `${path} must be a boolean`, { value });
  }
  return value;
}

function pattern(value, path) {
  if (typeof value !== 'string' || !value.trim()) {
    fail('invalid_table_hint', `${path} must be a non-empty regular expression`);
  }
  try {
    return new RegExp(value, 'u');
  } catch (error) {
    fail('invalid_table_hint', `${path} is not a valid regular expression`, {
      value,
      cause: error.message,
    });
  }
}

function rowMatchers(rowHint, columnCount, path) {
  const patterns = rowHint.cellPatterns;
  if (!Array.isArray(patterns) || patterns.length !== columnCount) {
    fail('invalid_table_hint', `${path}.cellPatterns must match the header column count`, {
      expected: columnCount,
      actual: Array.isArray(patterns) ? patterns.length : null,
    });
  }
  return patterns.map((expression, index) => ({
    expression,
    matcher: pattern(expression, `${path}.cellPatterns[${index}]`),
  }));
}

function firstCellMismatch(cells, matchers) {
  for (let index = 0; index < matchers.length; index += 1) {
    if (!matchers[index].matcher.test(cells[index])) {
      return {
        column: index,
        expression: matchers[index].expression,
        actual: cells[index],
        cells,
      };
    }
  }
  return null;
}

function assertCellPatterns(cells, rowHint, path) {
  const mismatch = firstCellMismatch(cells, rowMatchers(rowHint, cells.length, path));
  if (mismatch) {
    fail('table_cell_mismatch', `${path} column ${mismatch.column + 1} does not match final text`, mismatch);
  }
}

function headerRowId(tableId, hint, repeatedHeader) {
  const explicit = normalizeText(hint.headerRowId);
  if (explicit) return explicit;
  return repeatedHeader
    ? `${tableId}.header.page${positiveInteger(hint.page, `${tableId}.page`)}`
    : `${tableId}.header`;
}

function reconstructTable(words, hint) {
  if (!hint || typeof hint !== 'object' || Array.isArray(hint)) {
    fail('invalid_table_hint', 'table hint must be an object');
  }
  const tableId = normalizeText(hint.tableId);
  if (!tableId) fail('invalid_table_hint', 'tableId must not be empty');
  const repeatedHeader = booleanFlag(hint.repeatedHeader, `${tableId}.repeatedHeader`);
  const tolerance = Number(hint.lineTolerance ?? 3);
  const lines = clusterWordsIntoLines(words, tolerance);
  const header = locateHeader(lines, hint.headers, tableId);
  const boundaries = columnBoundaries(header.centres);
  const headerLineCount = positiveInteger(hint.headerLines, `${tableId}.headerLines`, 1);
  const headerLines = lines.slice(header.lineIndex, header.lineIndex + headerLineCount);
  if (headerLines.length !== headerLineCount) {
    fail('table_header_incomplete', `Table ${tableId} requires ${headerLineCount} rendered header line(s)`, {
      tableId,
      headerLineCount,
      available: headerLines.length,
    });
  }
  const headerBox = boxForLines(headerLines);
  const rows = [{
    rowId: headerRowId(tableId, hint, repeatedHeader),
    tableId,
    ...headerBox,
    repeatedHeader,
    cells: cellsForLines(headerLines, boundaries),
  }];

  if (!Array.isArray(hint.rows) || !hint.rows.length) {
    fail('invalid_table_hint', `${tableId}.rows must not be empty`);
  }
  const tableMaxLines = positiveInteger(
    hint.maxLinesPerRow,
    `${tableId}.maxLinesPerRow`,
    1,
  );
  let searchIndex = header.lineIndex + headerLineCount;
  hint.rows.forEach((rowHint, rowIndex) => {
    const path = `${tableId}.rows[${rowIndex}]`;
    const rowId = normalizeText(rowHint?.rowId);
    if (!rowId) fail('invalid_table_hint', `${path}.rowId must not be empty`);
    const matchers = rowMatchers(rowHint, hint.headers.length, path);
    const maxLines = positiveInteger(rowHint.maxLines, `${path}.maxLines`, tableMaxLines);
    let found = null;
    let closestMismatch = null;
    for (let lineIndex = searchIndex; lineIndex < lines.length; lineIndex += 1) {
      for (let lineCount = 1; lineCount <= maxLines && lineIndex + lineCount <= lines.length; lineCount += 1) {
        const selectedLines = lines.slice(lineIndex, lineIndex + lineCount);
        const cells = cellsForLines(selectedLines, boundaries);
        if (!matchers[0].matcher.test(cells[0])) continue;
        const mismatch = firstCellMismatch(cells, matchers);
        if (!mismatch) {
          found = { lineIndex, lineCount, lines: selectedLines, cells };
          break;
        }
        closestMismatch = mismatch;
      }
      if (found) break;
    }
    if (!found && closestMismatch) {
      fail(
        'table_cell_mismatch',
        `${path} column ${closestMismatch.column + 1} does not match final text`,
        closestMismatch,
      );
    }
    if (!found) {
      fail('table_row_missing', `Cannot locate ${rowId} in final table ${tableId}`, {
        firstCellPattern: rowHint.cellPatterns?.[0],
        maxLines,
      });
    }
    const box = boxForLines(found.lines);
    rows.push({
      rowId,
      tableId,
      ...box,
      repeatedHeader: false,
      cells: found.cells,
    });
    searchIndex = found.lineIndex + found.lineCount;
  });
  return Object.freeze(rows.map(Object.freeze));
}

function applyTableHints(words, hints, pageNumber) {
  const pageHints = Array.isArray(hints)
    ? hints.filter((hint) => Number(hint?.page) === Number(pageNumber))
    : [];
  return Object.freeze(pageHints.flatMap((hint) => reconstructTable(words, hint)));
}

module.exports = {
  RenderedTableHintError,
  normalizeText,
  clusterWordsIntoLines,
  phraseBox,
  locateHeader,
  cellsForLine,
  cellsForLines,
  reconstructTable,
  applyTableHints,
};
