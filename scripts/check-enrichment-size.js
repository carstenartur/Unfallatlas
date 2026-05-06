#!/usr/bin/env node
'use strict';

/**
 * scripts/check-enrichment-size.js
 *
 * CI gate that compares the gzipped size of every per-city
 * `out/output_all_years_<city>.geojson` against a committed baseline
 * (`out/.enrichment-size-baseline.json`) and fails the workflow when a
 * city's gzipped payload grows by more than the documented threshold.
 *
 * This is the mechanical guard that backs the "do not slow down the web
 * application" constraint from the enrichment plan (§C.5). The web app
 * fetches the per-city GeoJSON gzipped, so gzipped size is the only
 * payload metric that matters in practice.
 *
 * Usage:
 *
 *     node scripts/check-enrichment-size.js                # check
 *     node scripts/check-enrichment-size.js --update       # rewrite baseline
 *     node scripts/check-enrichment-size.js --threshold 5  # 5 % growth allowed
 *
 * Exit code:
 *   0 – every city is within budget (or no baseline yet → seed mode).
 *   1 – at least one city exceeds the budget.
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const REPO_ROOT     = path.resolve(__dirname, '..');
const OUT_DIR       = path.join(REPO_ROOT, 'out');
const BASELINE_PATH = path.join(OUT_DIR, '.enrichment-size-baseline.json');

const DEFAULT_THRESHOLD_PCT = 10; // see docs/enrichment.md

function gzippedSize(filePath) {
  const raw = fs.readFileSync(filePath);
  return zlib.gzipSync(raw, { level: 9 }).length;
}

function listCityFiles() {
  if (!fs.existsSync(OUT_DIR)) return [];
  return fs.readdirSync(OUT_DIR)
    .filter(n => /^output_all_years_[a-z0-9_]+\.geojson$/.test(n))
    .sort()
    .map(n => ({
      slug:    n.replace(/^output_all_years_/, '').replace(/\.geojson$/, ''),
      file:    path.join(OUT_DIR, n),
    }));
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')); }
  catch (e) {
    console.warn(`[size-check] baseline unreadable: ${e.message}`);
    return null;
  }
}

function writeBaseline(map) {
  const out = { generatedAt: new Date().toISOString(), thresholdPctDefault: DEFAULT_THRESHOLD_PCT, cities: map };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(out, null, 2) + '\n');
}

function check({ thresholdPct = DEFAULT_THRESHOLD_PCT, update = false } = {}) {
  const files = listCityFiles();
  if (files.length === 0) {
    console.log('[size-check] no per-city geojson files found, nothing to check.');
    return { ok: true, results: [] };
  }

  const measured = {};
  for (const f of files) measured[f.slug] = gzippedSize(f.file);

  if (update) {
    writeBaseline(measured);
    console.log(`[size-check] baseline rewritten with ${Object.keys(measured).length} cities.`);
    return { ok: true, results: [], updated: true };
  }

  const baseline = loadBaseline();
  if (!baseline) {
    writeBaseline(measured);
    console.log(`[size-check] no baseline existed, seeded with ${Object.keys(measured).length} cities.`);
    return { ok: true, results: [], seeded: true };
  }

  const results = [];
  let ok = true;
  for (const slug of Object.keys(measured)) {
    const cur  = measured[slug];
    const base = baseline.cities ? baseline.cities[slug] : undefined;
    if (typeof base !== 'number') {
      results.push({ slug, status: 'new', current: cur });
      continue;
    }
    const growthPct = base === 0 ? 0 : ((cur - base) / base) * 100;
    const status = growthPct > thresholdPct ? 'fail' : 'ok';
    if (status === 'fail') ok = false;
    results.push({ slug, status, baseline: base, current: cur, growthPct: +growthPct.toFixed(2) });
  }
  return { ok, thresholdPct, results };
}

function printReport(report) {
  for (const r of report.results) {
    if (r.status === 'new') {
      console.log(`  + ${r.slug.padEnd(20)} new (${r.current} B gz)`);
    } else if (r.status === 'fail') {
      console.log(`  ✗ ${r.slug.padEnd(20)} ${r.baseline} → ${r.current} B gz  (+${r.growthPct} %, exceeds ${report.thresholdPct} %)`);
    } else {
      console.log(`  ✓ ${r.slug.padEnd(20)} ${r.baseline} → ${r.current} B gz  (${r.growthPct >= 0 ? '+' : ''}${r.growthPct} %)`);
    }
  }
  if (!report.ok) {
    console.error(`\n[size-check] FAIL: at least one city exceeded the +${report.thresholdPct} % gzipped-size budget.`);
    console.error('             Address the bloat or, if intentional, rerun with --update to refresh the baseline.');
  }
}

function main(argv) {
  const opts = { thresholdPct: DEFAULT_THRESHOLD_PCT, update: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--update')         opts.update = true;
    else if (a === '--threshold') {
      const raw = argv[++i];
      const n   = Number(raw);
      if (raw == null || !Number.isFinite(n) || n < 0) {
        console.error(`[size-check] --threshold needs a non-negative number, got ${JSON.stringify(raw)}`);
        return 2;
      }
      opts.thresholdPct = n;
    }
    else if (a === '--help' || a === '-h') {
      process.stdout.write('Usage: node scripts/check-enrichment-size.js [--update] [--threshold <pct>]\n');
      return 0;
    }
  }
  const report = check(opts);
  if (!opts.update) printReport(report);
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { check, listCityFiles, main, BASELINE_PATH, DEFAULT_THRESHOLD_PCT };
