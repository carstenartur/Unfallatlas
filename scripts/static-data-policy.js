#!/usr/bin/env node
'use strict';

/**
 * scripts/static-data-policy.js
 *
 * Central policy definition for static data artefact compression.
 *
 * This module is the single source of truth for:
 *   - Which files must be gzip-compressed in the Pages / commit target.
 *   - Which small files are allowed to stay uncompressed.
 *   - Which files should be skipped entirely (already .gz, tmp files, etc.).
 *   - The size threshold below which files may remain uncompressed.
 *
 * Usage
 * -----
 *   const policy = require('./static-data-policy');
 *   // policy.compress   – glob patterns for files to compress
 *   // policy.keepRaw    – glob patterns explicitly allowed to remain uncompressed
 *   // policy.skip       – glob patterns to exclude from all processing
 *   // policy.forbidRaw  – glob patterns that MUST NOT exist uncompressed in commit target
 *   // policy.maxRawBytes – threshold (bytes) below which files may stay raw
 *
 * Adding an exception
 * -------------------
 * Add a path to `keepRaw` with a comment explaining why it is allowed
 * to stay uncompressed. Entries without a clear reason will be rejected
 * in code review.
 */

module.exports = {
  /** Root directory containing generated artefacts. */
  root: 'out',

  /**
   * Glob patterns (relative to repo root) for files that should be
   * compressed. Directories under `out/` are matched recursively.
   */
  compress: [
    'out/**/*.geojson',
    'out/**/*.json',
    'out/**/*.csv',
  ],

  /**
   * Patterns for files that are explicitly allowed to remain uncompressed.
   * These must be small enough that they do not meaningfully inflate the
   * repository or Pages artefact.
   *
   * Rationale per entry:
   *   - gzip-summary.json   : human-readable compression report; must be
   *                           readable without decompression in CI logs.
   *   - .enrichment-size-baseline.json : small baseline manifest checked
   *                           in at repo root; read by CI before decompression
   *                           infra is available.
   */
  keepRaw: [
    'out/gzip-summary.json',
    'out/.enrichment-size-baseline.json',
  ],

  /**
   * Patterns to skip entirely (never compress, never flag as forbidden).
   */
  skip: [
    'out/**/*.gz',
    'out/**/*.tmp',
    'out/**/*.png',
    'out/**/*.jpg',
    'out/**/*.jpeg',
    'out/**/*.webp',
    'out/**/*.pdf',
  ],

  /**
   * Patterns that MUST NOT exist as uncompressed files in the
   * commit / Pages target. These are checked by `--check --gzip-only`
   * and are always compressed by `--replace-raw`, regardless of size.
   *
   * Adding a path here does NOT automatically compress it — add it to
   * `compress` as well for that. This list is purely for the gate.
   */
  forbidRaw: [
    'out/output_all_years_*.geojson',
    'out/poi_*.geojson',
    'out/ways_*.json',
    'out/output_all_years_*.enrichment.meta.json',
    'out/ctxtiles/**/*.json',
    'out/*.csv',
  ],

  /**
   * Files smaller than this threshold (bytes) may remain uncompressed
   * even if they match a `compress` pattern. Set to 0 to compress
   * everything regardless of size. This threshold never overrides
   * `forbidRaw`.
   */
  maxRawBytes: 8 * 1024, // 8 KiB
};
