#!/usr/bin/env node
'use strict';

/**
 * scripts/lib/read-json-maybe-gz.js
 *
 * Node.js utility for reading JSON/text files with optional gzip decompression.
 *
 * Two operating modes:
 *
 *   'raw-ok'     (default) – reads the raw file if it exists, falls back to
 *                 the .gz variant if not. Used during local development and
 *                 transitional periods where both formats co-exist.
 *
 *   'gzip-only'  – reads exclusively the .gz variant and throws if only the
 *                 raw file is present. Used in CI/Pages checks to verify that
 *                 the gzip-only artefact state is genuinely self-contained.
 *
 * Environment variable:
 *   UNFALLATLAS_DATA_MODE=gzip-only  overrides the default mode for all
 *   callers that don't pass an explicit `options.mode`.
 *
 * Usage
 * -----
 *   const { readJsonMaybeGz, readTextMaybeGz } = require('./lib/read-json-maybe-gz');
 *
 *   // Reads ./out/ways_bonn.json or ./out/ways_bonn.json.gz automatically
 *   const data = readJsonMaybeGz('out/ways_bonn.json');
 *
 *   // gzip-only mode: fails if .gz is absent
 *   const data = readJsonMaybeGz('out/ways_bonn.json', { mode: 'gzip-only' });
 *
 *   // Respects UNFALLATLAS_DATA_MODE env
 *   UNFALLATLAS_DATA_MODE=gzip-only node scripts/check-context-datasets.js
 */

const fs   = require('fs');
const zlib = require('zlib');

/**
 * Returns the effective mode: explicit option wins; otherwise falls back
 * to the UNFALLATLAS_DATA_MODE environment variable; default is 'raw-ok'.
 *
 * @param {string|undefined} explicitMode
 * @returns {'raw-ok'|'gzip-only'}
 */
function _resolveMode(explicitMode) {
  if (explicitMode === 'gzip-only' || explicitMode === 'raw-ok') return explicitMode;
  const env = process.env.UNFALLATLAS_DATA_MODE;
  if (env === 'gzip-only') return 'gzip-only';
  return 'raw-ok';
}

/**
 * Decompress a Buffer containing gzip data.
 *
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function _gunzip(buf) {
  return zlib.gunzipSync(buf);
}

/**
 * Read a text file, falling back to (or exclusively reading) its .gz variant
 * depending on `options.mode`.
 *
 * @param {string} filePath  Logical file path (without .gz suffix).
 * @param {{ mode?: 'raw-ok'|'gzip-only' }} [options]
 * @returns {string}
 */
function readTextMaybeGz(filePath, options) {
  const opts = options || {};
  const mode = _resolveMode(opts.mode);
  const gzPath = filePath.endsWith('.gz') ? filePath : `${filePath}.gz`;

  if (mode === 'gzip-only') {
    if (!fs.existsSync(gzPath)) {
      const err = new Error(
        `[readTextMaybeGz] gzip-only mode: ${gzPath} not found` +
        (fs.existsSync(filePath) ? ` (only raw file exists: ${filePath})` : '')
      );
      err.code = 'ENOENT_GZ';
      throw err;
    }
    return _gunzip(fs.readFileSync(gzPath)).toString('utf8');
  }

  // raw-ok: prefer raw, fall back to .gz
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8');
  }
  if (fs.existsSync(gzPath)) {
    return _gunzip(fs.readFileSync(gzPath)).toString('utf8');
  }

  const err = new Error(
    `[readTextMaybeGz] file not found: ${filePath} (also tried ${gzPath})`
  );
  err.code = 'ENOENT';
  throw err;
}

/**
 * Read a JSON file, falling back to (or exclusively reading) its .gz variant
 * depending on `options.mode`.
 *
 * @param {string} filePath  Logical file path (without .gz suffix).
 * @param {{ mode?: 'raw-ok'|'gzip-only' }} [options]
 * @returns {*}  Parsed JSON value.
 */
function readJsonMaybeGz(filePath, options) {
  const text = readTextMaybeGz(filePath, options);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`[readJsonMaybeGz] JSON parse error for ${filePath}: ${e.message}`);
  }
}

module.exports = { readJsonMaybeGz, readTextMaybeGz };
