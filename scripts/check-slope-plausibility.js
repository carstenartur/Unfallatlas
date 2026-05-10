#!/usr/bin/env node
/**
 * scripts/check-slope-plausibility.js
 *
 * PR-berlin-slope-qa: city-level plausibility gate for the per-way
 * slope dataset.
 *
 * Why
 * ---
 * `scripts/check-context-datasets.js` already enforces a *global*
 * upper bound on `slope.verySteepShare` (default 30 %). That catches
 * "endpoint-noise dominates the whole network", but it cannot catch
 * "Berlin renders mostly very_steep" — Berlin is genuinely flat, so
 * even 8 % very_steep would be implausible there, while it's normal
 * in Stuttgart or Wuppertal.
 *
 * This validator reads `scripts/slope-plausibility.json` (small,
 * hand-curated table of upper/lower bounds per city) and compares it
 * against `slope.verySteepShare` and `slope.flatGentleShare` in each
 * `out/output_all_years_<slug>.enrichment.meta.json`. Cities not
 * listed in the table fall back to `_default`, so adding a new city
 * to `cities.txt` does not silently weaken the gate.
 *
 * Exit codes
 * ----------
 *   0 — every city passes
 *   1 — at least one city violates its bounds
 *
 * Usage
 * -----
 *   node scripts/check-slope-plausibility.js          # validate ./out
 *   node scripts/check-slope-plausibility.js <root>   # validate <root>/out
 *   npm run validate:slope-plausibility               # alias
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT_DEFAULT = path.resolve(__dirname, '..');
const PLAUSIBILITY_FILE_DEFAULT = path.join(__dirname, 'slope-plausibility.json');

/**
 * Load the plausibility bounds table. Pure — never throws on bad I/O,
 * returns an empty `cities` map and a permissive `_default` so callers
 * can unblock CI by deleting the file rather than rewriting the
 * script. A missing or malformed file is reported by `validateAll`.
 *
 * @param {string} [file]
 * @returns {{cities: object, _default: object, ok: boolean, error?: string}}
 */
function loadPlausibility(file) {
  const f = file || PLAUSIBILITY_FILE_DEFAULT;
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); }
  catch (e) {
    return { cities: {}, _default: { maxVerySteepShare: 30, minFlatGentleShare: 30 }, ok: false, error: `cannot read ${f}: ${e.message}` };
  }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) {
    return { cities: {}, _default: { maxVerySteepShare: 30, minFlatGentleShare: 30 }, ok: false, error: `${f} is not valid JSON: ${e.message}` };
  }
  return {
    cities: (data && typeof data.cities === 'object' && data.cities !== null) ? data.cities : {},
    _default: (data && typeof data._default === 'object' && data._default !== null)
      ? data._default
      : { maxVerySteepShare: 30, minFlatGentleShare: 30 },
    ok: true,
  };
}

/**
 * Validate every per-city meta sidecar against the plausibility table.
 * Pure — never throws; returns structured findings.
 *
 * @param {string} repoRoot   absolute repo root (so `<root>/out` is searched)
 * @param {object} [opts]
 * @param {string} [opts.plausibilityFile]
 * @returns {{cities: Array<{slug, ok, problems, warnings, verySteepShare, flatGentleShare, bounds}>, summary, plausibilityError?: string}}
 */
function validateAll(repoRoot, opts = {}) {
  const outDir = path.join(repoRoot, 'out');
  const cities = [];
  const plausibility = loadPlausibility(opts.plausibilityFile);

  if (!fs.existsSync(outDir)) {
    return {
      cities,
      summary: { total: 0, ok: 0, failed: 0, skippedNoSlope: 0, usedDefaultBounds: 0 },
      plausibilityError: plausibility.ok ? undefined : plausibility.error,
    };
  }

  const metaFiles = fs.readdirSync(outDir)
    .filter(f => /^output_all_years_.+\.enrichment\.meta\.json$/.test(f))
    .sort();

  let skippedNoSlope = 0;
  let usedDefaultBounds = 0;
  for (const metaFile of metaFiles) {
    const m = metaFile.match(/^output_all_years_(.+)\.enrichment\.meta\.json$/);
    if (!m) continue;
    const slug = m[1];
    const meta = _readJson(path.join(outDir, metaFile));
    const result = _validateCity(slug, meta, plausibility);
    if (result.skip === 'no_slope') {
      skippedNoSlope++;
      continue;
    }
    if (result.usedDefault) {
      // Cities that fall back to `_default` ARE validated — just
      // against the table-wide default bounds rather than a per-city
      // entry. Count them in total/ok/failed alongside listed cities;
      // the `usedDefaultBounds` counter is just an informational
      // tally so the summary line can highlight that the default was
      // exercised.
      usedDefaultBounds++;
    }
    cities.push(result);
  }

  const summary = {
    total: cities.length,
    ok: cities.filter(c => c.ok).length,
    failed: cities.filter(c => !c.ok).length,
    skippedNoSlope,
    usedDefaultBounds,
  };
  return {
    cities,
    summary,
    plausibilityError: plausibility.ok ? undefined : plausibility.error,
  };
}

function _validateCity(slug, meta, plausibility) {
  const problems = [];
  const warnings = [];
  if (!meta || typeof meta !== 'object') {
    problems.push('meta sidecar unreadable or invalid JSON');
    return { slug, ok: false, problems, warnings };
  }
  const slope = meta.slope;
  if (!slope || typeof slope !== 'object' || !Number.isFinite(slope.withSlope) || slope.withSlope <= 0) {
    return { slug, ok: true, problems, warnings, skip: 'no_slope' };
  }
  // Compute flatGentleShare on the fly when older sidecars don't carry
  // it yet — keeps the validator forward-compatible during rollout.
  const cc = slope.classCounts || {};
  const flatGentleShare = Number.isFinite(slope.flatGentleShare)
    ? slope.flatGentleShare
    : ((Number(cc.flat) || 0) + (Number(cc.gentle) || 0)) > 0
      ? Math.round((((Number(cc.flat) || 0) + (Number(cc.gentle) || 0)) / slope.withSlope) * 1000) / 10
      : 0;
  const verySteepShare = Number.isFinite(slope.verySteepShare) ? slope.verySteepShare : null;

  const bounds = plausibility.cities[slug];
  if (!bounds) {
    warnings.push(`city not listed in scripts/slope-plausibility.json — falling back to _default`);
  }
  const effective = Object.assign({}, plausibility._default, bounds || {});

  if (verySteepShare === null) {
    warnings.push('slope.verySteepShare missing from meta sidecar — skipping upper-bound check');
  } else if (Number.isFinite(effective.maxVerySteepShare) && verySteepShare > effective.maxVerySteepShare) {
    problems.push(
      `verySteepShare=${verySteepShare}% exceeds plausibility bound ${effective.maxVerySteepShare}% ` +
      `(city expected to be ${bounds ? 'as listed' : 'no flatter than _default'}; ` +
      `runaway very_steep usually means endpoint-noise has crept back into the slope pipeline)`
    );
  }
  if (Number.isFinite(effective.minFlatGentleShare) && flatGentleShare < effective.minFlatGentleShare) {
    problems.push(
      `flatGentleShare=${flatGentleShare}% below plausibility bound ${effective.minFlatGentleShare}% ` +
      `(too few signal ways classified flat/gentle for this city profile)`
    );
  }

  return {
    slug,
    ok: problems.length === 0,
    problems,
    warnings,
    verySteepShare,
    flatGentleShare,
    bounds: effective,
    // True when no per-city entry was found and the validator fell
    // back to `_default`. The city is still validated and counted in
    // total/ok/failed — this flag is purely informational so callers
    // can highlight default-bound usage in summaries.
    usedDefault: !bounds,
  };
}

function _readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function _formatReport(result) {
  const lines = [];
  if (result.plausibilityError) {
    lines.push(`! plausibility table problem: ${result.plausibilityError}`);
  }
  for (const c of result.cities) {
    // No more "?" tag — `_default`-validated cities are first-class
    // pass/fail results. The fallback is communicated via the inline
    // warning below.
    const tag = c.ok ? '✓' : '✗';
    const detail = (typeof c.verySteepShare === 'number')
      ? ` verySteep=${c.verySteepShare}% flatGentle=${c.flatGentleShare}%`
      : '';
    lines.push(`${tag} ${c.slug}${detail}`);
    for (const w of (c.warnings || [])) lines.push(`    ! ${w}`);
    for (const p of (c.problems || [])) lines.push(`    - ${p}`);
  }
  const s = result.summary;
  lines.push(
    '',
    `Summary: ${s.ok}/${s.total} cities OK` +
    (s.failed > 0 ? `, ${s.failed} failed` : '') +
    (s.skippedNoSlope > 0 ? ` (${s.skippedNoSlope} without slope signal)` : '') +
    (s.usedDefaultBounds > 0 ? ` (${s.usedDefaultBounds} validated against _default — not in plausibility table)` : '')
  );
  return lines.join('\n');
}

function main(argv) {
  const repoRoot = (argv && argv[0]) ? path.resolve(argv[0]) : REPO_ROOT_DEFAULT;
  const result = validateAll(repoRoot);
  const sink = result.summary.failed > 0 ? console.error : console.log;
  sink(_formatReport(result));
  if (result.summary.failed > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { validateAll, loadPlausibility };
