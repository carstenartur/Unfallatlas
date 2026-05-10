#!/usr/bin/env node
/**
 * scripts/check-context-datasets.js
 *
 * Build-time validator for v3 context-layer datasets (per-tile slope /
 * traffic-proxy / OSM-context payloads under `out/ctxtiles/<slug>/`).
 *
 * Why this exists
 * ---------------
 * The original "Bielefeld + mapLayer=slope shows empty legend / empty
 * tile index" bug had two root causes that no existing CI gate would
 * have caught:
 *
 *   1. `out/ctxtiles/<slug>/index.json` could ship without the `dicts`
 *      block — without it the loader cannot decode int-coded per-tile
 *      attrs, the slope classifier returns `null` for every way, and
 *      the slope overlay renders nothing → empty legend.
 *
 *   2. `out/ways_<slug>.json` could ship as a v3 envelope while the
 *      `out/ctxtiles/<slug>/` directory was missing or contained zero
 *      tiles (e.g. a producer skipped the city silently). The loader
 *      then fetched a 404 manifest and the UI showed
 *      "Layer nicht verfügbar (alte Datenversion)".
 *
 * What this script asserts (per v3 city)
 * --------------------------------------
 * For every `out/output_all_years_<slug>.enrichment.meta.json` that
 * declares a `tileIndexPath` (= v3 dataset):
 *
 *   - The `index.json` it points at exists, parses, and has
 *       schemaVersion === 3
 *       coverage    === 'full'
 *       tiles.length > 0
 *       dicts is a non-empty object
 *   - Every tile referenced by the index has a matching
 *       <baseDir>/<x>/<y>.json    on disk that parses and is non-empty
 *   - The companion `out/ways_<slug>.json` exists, parses, has
 *       schemaVersion === 3
 *       coverage      === 'full'
 *       tileIndexUrl  resolves to the same on-disk index.json
 *   - The meta sidecar carries a `slope` quality summary written by
 *       `summarizeSlopeQuality()` (see scripts/enrich_geojson.js):
 *       slope.classCounts        present + plausible histogram
 *       slope.noSignalCount      present
 *       slope.coveragePercent    >= MIN_SLOPE_COVERAGE_PERCENT (default 50)
 *       slope.verySteepShare      <= MAX_VERY_STEEP_SHARE_PERCENT (default 30)
 *                                (a runaway `very_steep` share is the
 *                                 single most reliable tell-tale that
 *                                 endpoint-noise has crept back in and
 *                                 produced wildly inconsistent slopes
 *                                 for adjacent residential streets)
 *
 * Both thresholds are configurable via env so a one-off bad-DEM city
 * can be unblocked without rewriting the script:
 *   MIN_SLOPE_COVERAGE_PERCENT=30 npm run validate:context-datasets
 *   MAX_VERY_STEEP_SHARE_PERCENT=50 npm run validate:context-datasets
 *
 * Exit codes
 * ----------
 *   0 — every v3 city is consistent
 *   1 — at least one violation; details printed to stderr
 *
 * Usage
 * -----
 *   node scripts/check-context-datasets.js          # validate ./out
 *   node scripts/check-context-datasets.js <root>   # validate <root>/out
 *   npm run validate:context-datasets               # alias
 *
 * The script is pure Node (no deps) so it runs in any CI step.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT_DEFAULT = path.resolve(__dirname, '..');

// Defaults; overridable via env to unblock one-off bad-DEM cities
// without rewriting the script (see file header).
const DEFAULT_MIN_SLOPE_COVERAGE_PERCENT = 50;
const DEFAULT_MAX_VERY_STEEP_SHARE_PERCENT = 30;

function _slopeThresholds() {
  const min = Number(process.env.MIN_SLOPE_COVERAGE_PERCENT);
  const max = Number(process.env.MAX_VERY_STEEP_SHARE_PERCENT);
  return {
    minCoveragePercent: Number.isFinite(min) ? min : DEFAULT_MIN_SLOPE_COVERAGE_PERCENT,
    maxVerySteepShare:   Number.isFinite(max) ? max : DEFAULT_MAX_VERY_STEEP_SHARE_PERCENT,
  };
}

/**
 * Walk `<repoRoot>/out` and return one validation result per v3 city.
 * Pure function — never throws on bad data, returns structured findings.
 *
 * @param {string} repoRoot absolute path to the repo root (so `<root>/out` is searched)
 * @returns {{cities: Array<{slug:string, ok:boolean, problems:string[]}>, summary:{total:number, ok:number, failed:number, skippedNonV3:number}}}
 */
function validateAll(repoRoot) {
  const outDir = path.join(repoRoot, 'out');
  const cities = [];
  let skippedNonV3 = 0;

  if (!fs.existsSync(outDir)) {
    return {
      cities,
      summary: { total: 0, ok: 0, failed: 0, skippedNonV3: 0 },
    };
  }

  const metaFiles = fs.readdirSync(outDir)
    .filter((f) => /^output_all_years_.+\.enrichment\.meta\.json$/.test(f))
    .sort();

  for (const metaFile of metaFiles) {
    const m = metaFile.match(/^output_all_years_(.+)\.enrichment\.meta\.json$/);
    if (!m) continue;
    const slug = m[1];
    const meta = _readJson(path.join(outDir, metaFile));
    if (!meta || typeof meta !== 'object') {
      cities.push({ slug, ok: false, problems: [`meta sidecar ${metaFile} unreadable or invalid JSON`] });
      continue;
    }
    if (Number(meta.schemaVersion) !== 3 || typeof meta.tileIndexPath !== 'string') {
      // Not a v3 city — skip silently. The validator only asserts v3
      // invariants. v1/v2 cities are still served by the legacy ways
      // file and don't ship a tile index at all.
      skippedNonV3++;
      continue;
    }
    cities.push(_validateV3City(repoRoot, slug, meta));
  }

  const summary = {
    total: cities.length,
    ok: cities.filter((c) => c.ok).length,
    failed: cities.filter((c) => !c.ok).length,
    skippedNonV3,
  };
  return { cities, summary };
}

function _validateV3City(repoRoot, slug, meta) {
  const problems = [];
  const outDir = path.join(repoRoot, 'out');
  // `_toLocalPath` always returns a repo-root-relative path (with the
  // `out/` prefix re-added when the input — like meta.tileIndexPath —
  // was relative to `out/`). Resolve against the repo root, NOT outDir,
  // to avoid double-prefixing `out/out/...`.
  const indexAbs = path.join(repoRoot, _toLocalPath(meta.tileIndexPath));
  const baseDir = path.dirname(indexAbs);

  // 1. index.json exists + structurally valid + non-empty.
  const index = _readJson(indexAbs);
  if (!index || typeof index !== 'object') {
    problems.push(`tile index missing or invalid JSON at ${path.relative(repoRoot, indexAbs)}`);
  } else {
    if (Number(index.schemaVersion) !== 3) {
      problems.push(`tile index schemaVersion is ${index.schemaVersion}, expected 3`);
    }
    if (index.coverage !== 'full') {
      problems.push(`tile index coverage is "${index.coverage}", expected "full"`);
    }
    if (!Array.isArray(index.tiles) || index.tiles.length === 0) {
      problems.push(`tile index has no tiles (tiles=${JSON.stringify(index.tiles)})`);
    }
    if (!index.dicts || typeof index.dicts !== 'object' || Array.isArray(index.dicts) || Object.keys(index.dicts).length === 0) {
      problems.push('tile index is missing the `dicts` block (per-tile int-coded attrs cannot be decoded)');
    }

    // 2. Every referenced tile exists on disk + parses + has at least
    //    one way. We only spot-check the *referenced* tiles — extra
    //    files on disk are fine.
    if (Array.isArray(index.tiles)) {
      let firstMissing = null;
      let missingCount = 0;
      let firstUnreadable = null;
      let unreadableCount = 0;
      let firstEmpty = null;
      let emptyCount = 0;
      for (const t of index.tiles) {
        const x = t && t.x;
        const y = t && t.y;
        if (!Number.isInteger(x) || !Number.isInteger(y)) {
          problems.push(`tile entry has non-integer coordinates: ${JSON.stringify(t)}`);
          continue;
        }
        const tileFile = path.join(baseDir, String(x), `${y}.json`);
        if (!fs.existsSync(tileFile)) {
          if (!firstMissing) firstMissing = `${x}/${y}.json`;
          missingCount++;
          continue;
        }
        const payload = _readJson(tileFile);
        if (!payload || typeof payload !== 'object') {
          if (!firstUnreadable) firstUnreadable = `${x}/${y}.json`;
          unreadableCount++;
          continue;
        }
        if (!payload.ways || typeof payload.ways !== 'object' || Object.keys(payload.ways).length === 0) {
          if (!firstEmpty) firstEmpty = `${x}/${y}.json`;
          emptyCount++;
        }
      }
      if (missingCount > 0) {
        problems.push(`${missingCount} referenced tile file(s) missing on disk (first: ${firstMissing})`);
      }
      if (unreadableCount > 0) {
        problems.push(`${unreadableCount} referenced tile file(s) unreadable / invalid JSON (first: ${firstUnreadable})`);
      }
      if (emptyCount > 0) {
        problems.push(`${emptyCount} referenced tile file(s) carry no ways (first: ${firstEmpty})`);
      }
    }
  }

  // 3. Companion ways_<slug>.json envelope.
  const waysFile = path.join(outDir, `ways_${slug}.json`);
  const ways = _readJson(waysFile);
  if (!ways || typeof ways !== 'object') {
    problems.push(`companion ${path.relative(repoRoot, waysFile)} missing or invalid JSON`);
  } else {
    if (Number(ways.schemaVersion) !== 3) {
      problems.push(`companion ways file schemaVersion is ${ways.schemaVersion}, expected 3`);
    }
    if (ways.coverage !== 'full') {
      problems.push(`companion ways file coverage is "${ways.coverage}", expected "full"`);
    }
    if (typeof ways.tileIndexUrl !== 'string' || !ways.tileIndexUrl) {
      problems.push('companion ways file is missing tileIndexUrl');
    } else {
      // tileIndexUrl is a frontend-relative URL like
      // "out/ctxtiles/<slug>/index.json". Resolve against repo root and
      // confirm it points at the same file the meta sidecar declares.
      const fromWaysAbs = path.resolve(repoRoot, _toLocalPath(ways.tileIndexUrl));
      if (path.normalize(fromWaysAbs) !== path.normalize(indexAbs)) {
        problems.push(
          `companion ways file tileIndexUrl resolves to ${path.relative(repoRoot, fromWaysAbs)}, ` +
          `but meta sidecar tileIndexPath points at ${path.relative(repoRoot, indexAbs)}`
        );
      }
    }
  }

  // 4. Slope-quality summary in the meta sidecar (PR-bielefeld-slope).
  //    Absence of the block is treated as a non-fatal warning so older
  //    cached cities don't break the gate during the rollout — but
  //    when present, the thresholds are enforced.
  const slope = meta.slope;
  if (slope && typeof slope === 'object') {
    const t = _slopeThresholds();
    if (!slope.classCounts || typeof slope.classCounts !== 'object') {
      problems.push('slope-quality summary is missing `classCounts`');
    }
    if (!Number.isFinite(slope.noSlopeSignal) && !Number.isFinite(slope.noSignalCount)) {
      // Accept both names defensively (script writes `noSlopeSignal`).
      problems.push('slope-quality summary is missing `noSlopeSignal`');
    }
    if (!Number.isFinite(slope.coveragePercent)) {
      problems.push('slope-quality summary is missing `coveragePercent`');
    } else if (slope.coveragePercent < t.minCoveragePercent) {
      problems.push(
        `slope coverage ${slope.coveragePercent}% is below threshold ${t.minCoveragePercent}% ` +
        `(set MIN_SLOPE_COVERAGE_PERCENT to override) — slope layer would mostly render in neutral grey`
      );
    }
    if (Number.isFinite(slope.verySteepShare) && slope.verySteepShare > t.maxVerySteepShare) {
      problems.push(
        `slope very_steep share is ${slope.verySteepShare}% of signal ways, ` +
        `above threshold ${t.maxVerySteepShare}% — likely DEM-noise-dominated endpoint slopes ` +
        `(adjacent parallel streets will look wildly inconsistent in the slope overlay)`
      );
    }
  }

  return { slug, ok: problems.length === 0, problems };
}

function _readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

// Normalize an input path (either repo-root-relative like
// "out/ctxtiles/<slug>/index.json" from the ways envelope, or
// out/-relative like "ctxtiles/<slug>/index.json" from the meta
// sidecar) to a single repo-root-relative form that always starts
// with "out/". Callers join the result against the repo root.
function _toLocalPath(p) {
  if (typeof p !== 'string') return '';
  // Strip a leading "./" or "/" so the join works regardless of how
  // the producer wrote the path.
  let s = p.replace(/\\/g, '/').replace(/^\.?\//, '');
  // The meta sidecar stores tileIndexPath relative to `out/`, the
  // ways envelope stores tileIndexUrl relative to the repo root.
  // Re-prefix `out/` when missing so the returned form is always
  // repo-root-relative and the caller can resolve uniformly against
  // the repo root.
  if (!s.startsWith('out/')) s = 'out/' + s;
  return s;
}

function _formatReport(result) {
  const lines = [];
  for (const c of result.cities) {
    if (c.ok) {
      lines.push(`✓ ${c.slug}`);
    } else {
      lines.push(`✗ ${c.slug}`);
      for (const p of c.problems) lines.push(`    - ${p}`);
    }
  }
  lines.push(
    '',
    `Summary: ${result.summary.ok}/${result.summary.total} v3 cities OK` +
    (result.summary.failed > 0 ? `, ${result.summary.failed} failed` : '') +
    (result.summary.skippedNonV3 > 0 ? ` (skipped ${result.summary.skippedNonV3} non-v3 cities)` : '')
  );
  return lines.join('\n');
}

function main(argv) {
  const repoRoot = (argv && argv[0]) ? path.resolve(argv[0]) : REPO_ROOT_DEFAULT;
  const result = validateAll(repoRoot);
  // Always print the per-city report so CI logs are self-explanatory.
  // Route to stderr on failure so CI tooling that greps stdout vs.
  // stderr (and the documented contract above) sees violations on
  // stderr, while a clean run prints to stdout.
  const sink = result.summary.failed > 0 ? console.error : console.log;
  sink(_formatReport(result));
  if (result.summary.failed > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { validateAll, _toLocalPath };
