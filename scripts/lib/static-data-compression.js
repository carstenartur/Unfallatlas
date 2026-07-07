#!/usr/bin/env node
'use strict';

/**
 * scripts/lib/static-data-compression.js
 *
 * Core compression library for gzip-only static data artefacts.
 *
 * This module implements the policy-driven compression logic that both
 * producer scripts and the `scripts/gzip-static-data.js` CLI use.
 *
 * Key design decisions
 * --------------------
 * - Deterministic output: gzip mtime is fixed at 0 for byte-identical
 *   output across runs (important for git diff / Pages deploy diffing).
 * - Atomic writes: files are written via a `.tmp` + rename two-step so
 *   a crash mid-write never leaves a truncated .gz on disk.
 * - Policy-driven: what gets compressed / kept raw / forbidden is
 *   declared in the policy object, not hardcoded in workflow files.
 * - Size reporting: compressArtifacts returns a per-file size summary
 *   that can be written to `out/gzip-summary.json` for audit trails.
 *
 * Public API
 * ----------
 *   compressArtifact(sourcePath, options)            → SizeEntry
 *   compressArtifacts(root, policy, options)         → SizeSummary
 *   writeJsonArtifact(targetPath, value, options)    → SizeEntry
 *   writeTextArtifact(targetPath, text, options)     → SizeEntry
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default size threshold below which files may stay uncompressed (8 KiB). */
const DEFAULT_MAX_RAW_BYTES = 8 * 1024;

/** Fixed mtime for deterministic gzip output. */
const DETERMINISTIC_MTIME = new Date(0);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _atomicWrite(destPath, buf) {
  const tmp = `${destPath}.tmp`;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, destPath);
}

/**
 * Compress `buf` with gzip at level 9 using a fixed mtime for
 * deterministic output.
 *
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function _gzipSync(buf) {
  return zlib.gzipSync(buf, {
    level: 9,
    // mtime: 0 ensures byte-identical output regardless of wall-clock time.
    // Node zlib accepts a Date or numeric seconds-since-epoch value.
    mtime: DETERMINISTIC_MTIME,
  });
}

/**
 * Expand a glob pattern relative to `root` into matching file paths.
 * Uses a simple recursive walk — no external glob library needed.
 *
 * @param {string} root
 * @param {string} pattern  Simplified glob: supports `**` and `*`.
 * @returns {string[]}  Absolute file paths.
 */
function _expandGlob(root, pattern) {
  // Convert the glob to a RegExp.
  // - `**/` → zero or more path segments (including none)
  // - `**`  → match across segments
  // - `*`   → match within a single segment
  const regexStr = pattern
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')   // escape regex special chars (before replacing *)
    .replace(/\*\*\//g, '(.*\/)?')         // **/ → optional path prefix
    .replace(/\*\*/g, '.*')                // ** → match anything
    .replace(/\*/g, '[^/]*');              // * → match within single segment
  const re = new RegExp(`^${regexStr}$`);

  const results = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
      } else {
        // Test relative path from root
        const rel = path.relative(root, abs).replace(/\\/g, '/');
        if (re.test(rel)) results.push(abs);
      }
    }
  }
  walk(root);
  return results;
}

/**
 * Returns true if `filePath` matches any pattern in the given list.
 * Pattern matching is the same simplified glob used by `_expandGlob`.
 *
 * @param {string} filePath  Absolute path.
 * @param {string} root      Repository root for relative-path matching.
 * @param {string[]} patterns
 * @returns {boolean}
 */
function _matchesAny(filePath, root, patterns) {
  if (!patterns || patterns.length === 0) return false;
  const rel = path.relative(root, filePath).replace(/\\/g, '/');
  for (const pattern of patterns) {
    const normPattern = pattern.replace(/\\/g, '/');
    const regexStr = normPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '(.*\/)?')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*');
    const re = new RegExp(`^${regexStr}$`);
    if (re.test(rel)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SizeEntry
 * @property {string}  file        Absolute path to the compressed .gz file.
 * @property {string}  relPath     Path relative to the repository root.
 * @property {number}  rawBytes    Size of the original uncompressed file (bytes).
 * @property {number}  gzBytes     Size of the .gz file (bytes).
 * @property {number}  savingBytes Bytes saved (rawBytes - gzBytes).
 * @property {number}  savingPct   Percentage saved (0-100, rounded to 1 dp).
 * @property {boolean} deletedRaw  Whether the raw source file was removed.
 */

/**
 * Compress a single file to `<sourcePath>.gz`.
 *
 * The operation is atomic: a `.tmp` file is written first and then
 * renamed to the final destination so a partial write is never
 * observed by concurrent readers.
 *
 * @param {string} sourcePath  Absolute path to the source file.
 * @param {{ deleteRaw?: boolean, dryRun?: boolean, root?: string }} [options]
 * @returns {SizeEntry}
 */
function compressArtifact(sourcePath, options) {
  const opts       = options || {};
  const deleteRaw  = !!opts.deleteRaw;
  const dryRun     = !!opts.dryRun;
  const root       = opts.root || path.resolve('.');
  const gzPath     = sourcePath.endsWith('.gz') ? sourcePath : `${sourcePath}.gz`;

  const rawBuf  = fs.readFileSync(sourcePath);
  const rawBytes = rawBuf.length;

  let gzBytes = 0;
  if (!dryRun) {
    const gzBuf = _gzipSync(rawBuf);
    _atomicWrite(gzPath, gzBuf);
    gzBytes = gzBuf.length;
  } else {
    // Still compute the compressed size for reporting without writing.
    gzBytes = _gzipSync(rawBuf).length;
  }

  if (!dryRun && deleteRaw) {
    fs.unlinkSync(sourcePath);
  }

  const savingBytes = rawBytes - gzBytes;
  const savingPct   = rawBytes > 0
    ? Math.round((savingBytes / rawBytes) * 1000) / 10
    : 0;

  return {
    file:        gzPath,
    relPath:     path.relative(root, gzPath).replace(/\\/g, '/'),
    rawBytes,
    gzBytes,
    savingBytes,
    savingPct,
    deletedRaw:  !dryRun && deleteRaw,
  };
}

/**
 * @typedef {Object} SizeSummary
 * @property {SizeEntry[]} entries     Per-file results.
 * @property {number}      totalRaw    Total uncompressed bytes.
 * @property {number}      totalGz     Total compressed bytes.
 * @property {number}      totalSaving Total bytes saved.
 * @property {number}      savingPct   Overall percentage saved.
 * @property {SizeEntry[]} top20       Top-20 largest compressed artefacts.
 * @property {string[]}    staleRemoved Paths of stale .gz files that were removed.
 */

/**
 * Compress all artefacts under `root` that match the policy.
 *
 * Policy shape (all fields optional):
 * ```
 * {
 *   compress:    ['out/**\/*.geojson', 'out/**\/*.json', 'out/**\/*.csv'],
 *   keepRaw:     ['out/gzip-summary.json'],
 *   skip:        ['out/**\/*.gz', 'out/**\/*.tmp'],
 *   forbidRaw:   [],          // checked only in --check mode, not enforced here
 *   maxRawBytes: 8192,        // files smaller than this may stay uncompressed
 * }
 * ```
 *
 * @param {string} root    Repository root (or out/ directory root).
 * @param {object} policy
 * @param {{ deleteRaw?: boolean, dryRun?: boolean, deleteStale?: boolean }} [options]
 * @returns {SizeSummary}
 */
function compressArtifacts(root, policy, options) {
  const opts        = options  || {};
  const deleteRaw   = !!opts.deleteRaw;
  const dryRun      = !!opts.dryRun;
  const deleteStale = !!opts.deleteStale;
  const pol         = policy   || {};
  const compressPatterns = pol.compress   || ['out/**/*.geojson', 'out/**/*.json', 'out/**/*.csv'];
  const keepRawPatterns  = pol.keepRaw    || [];
  const skipPatterns     = pol.skip       || ['out/**/*.gz', 'out/**/*.tmp'];
  const maxRawBytes      = typeof pol.maxRawBytes === 'number' ? pol.maxRawBytes : DEFAULT_MAX_RAW_BYTES;

  // Collect all candidate files matching compress patterns.
  const seen = new Set();
  const candidates = [];
  for (const pat of compressPatterns) {
    for (const abs of _expandGlob(root, pat)) {
      if (seen.has(abs)) continue;
      seen.add(abs);
      // Skip files matching skip patterns (e.g. already .gz or .tmp)
      if (_matchesAny(abs, root, skipPatterns)) continue;
      // Skip files on the keepRaw list
      if (_matchesAny(abs, root, keepRawPatterns)) continue;
      // Skip files below the size threshold (leave them uncompressed)
      let stat;
      try { stat = fs.statSync(abs); } catch (_) { continue; }
      if (stat.size < maxRawBytes) continue;
      candidates.push(abs);
    }
  }

  const entries = [];
  for (const src of candidates) {
    try {
      const entry = compressArtifact(src, { deleteRaw, dryRun, root });
      entries.push(entry);
    } catch (e) {
      // Non-fatal: log and continue so one bad file doesn't abort the run.
      process.stderr.write(`[static-data-compression] skipping ${src}: ${e.message}\n`);
    }
  }

  // Optionally remove stale .gz files that no longer have a corresponding
  // source file anywhere (i.e. the source was deleted).
  const staleRemoved = [];
  if (deleteStale && !dryRun) {
    for (const pat of compressPatterns) {
      // Build the corresponding .gz pattern
      const gzPat = pat.endsWith('.gz') ? pat : `${pat}.gz`;
      for (const gzAbs of _expandGlob(root, gzPat)) {
        const rawAbs = gzAbs.slice(0, -3); // strip .gz
        if (!fs.existsSync(rawAbs)) {
          try {
            fs.unlinkSync(gzAbs);
            staleRemoved.push(path.relative(root, gzAbs).replace(/\\/g, '/'));
          } catch (_) { /* ignore */ }
        }
      }
    }
  }

  const totalRaw    = entries.reduce((s, e) => s + e.rawBytes, 0);
  const totalGz     = entries.reduce((s, e) => s + e.gzBytes, 0);
  const totalSaving = totalRaw - totalGz;
  const savingPct   = totalRaw > 0
    ? Math.round((totalSaving / totalRaw) * 1000) / 10
    : 0;
  const top20 = [...entries]
    .sort((a, b) => b.gzBytes - a.gzBytes)
    .slice(0, 20);

  return { entries, totalRaw, totalGz, totalSaving, savingPct, top20, staleRemoved };
}

/**
 * Write a JSON value as an artefact, applying compression policy.
 *
 * @param {string}  targetPath  Logical destination path (e.g. 'out/ways_bonn.json').
 * @param {*}       value       JSON-serialisable value.
 * @param {{ compression?: 'gzip-only'|'raw', deleteRaw?: boolean, root?: string }} [options]
 * @returns {SizeEntry|{ file: string, rawBytes: number, gzBytes: number, deletedRaw: boolean }}
 */
function writeJsonArtifact(targetPath, value, options) {
  const opts = options || {};
  const text = JSON.stringify(value);
  return writeTextArtifact(targetPath, text, opts);
}

/**
 * Write text as an artefact, applying compression policy.
 *
 * @param {string} targetPath  Logical destination path.
 * @param {string} text        UTF-8 text content.
 * @param {{ compression?: 'gzip-only'|'raw', deleteRaw?: boolean, root?: string }} [options]
 * @returns {SizeEntry|{ file: string, rawBytes: number, gzBytes: number, deletedRaw: boolean }}
 */
function writeTextArtifact(targetPath, text, options) {
  const opts        = options || {};
  const compression = opts.compression || 'gzip-only';
  const root        = opts.root || path.resolve('.');
  const buf         = Buffer.from(text, 'utf8');
  const rawBytes    = buf.length;

  if (compression === 'raw') {
    _atomicWrite(targetPath, buf);
    return {
      file:       targetPath,
      relPath:    path.relative(root, targetPath).replace(/\\/g, '/'),
      rawBytes,
      gzBytes:    rawBytes,
      savingBytes: 0,
      savingPct:  0,
      deletedRaw: false,
    };
  }

  // gzip-only: write raw temporarily, compress, then delete raw.
  _atomicWrite(targetPath, buf);
  const entry = compressArtifact(targetPath, {
    deleteRaw: true,
    root,
  });
  return entry;
}

module.exports = {
  compressArtifact,
  compressArtifacts,
  writeJsonArtifact,
  writeTextArtifact,
  DEFAULT_MAX_RAW_BYTES,
  DETERMINISTIC_MTIME,
};
