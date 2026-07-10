#!/usr/bin/env node
'use strict';

/**
 * scripts/gzip-static-data.js
 *
 * CLI for managing gzip-only static data artefacts.
 *
 * This script is the Workflow-level entry point that ensures the commit /
 * Pages target is in the correct gzip-only state. It wraps the
 * `scripts/lib/static-data-compression.js` library and the
 * `scripts/static-data-policy.js` policy.
 *
 * Modes
 * -----
 *
 *   --replace-raw
 *     Compress all artefacts matching the policy and delete their raw
 *     originals. Run this before committing to ensure the commit target
 *     contains only .gz files for large artefacts.
 *
 *     node scripts/gzip-static-data.js --replace-raw
 *     node scripts/gzip-static-data.js --replace-raw --summary-json out/gzip-summary.json
 *
 *   --delete-stale
 *     Remove .gz files whose raw source no longer exists. Can be
 *     combined with --replace-raw.
 *
 *   --check [--gzip-only]
 *     Validate the artefact state without modifying any files.
 *     Without --gzip-only: warns about large uncompressed files.
 *     With    --gzip-only: fails (exit 1) if any large artefact
 *                          exists only in raw form — the gzip-only
 *                          invariant is not met.
 *
 *     node scripts/gzip-static-data.js --check
 *     node scripts/gzip-static-data.js --check --gzip-only
 *
 *   --dry-run
 *     Print what would be done without writing or deleting files.
 *     Works with both --replace-raw and --check.
 *
 *   --summary-json <path>
 *     Write a JSON size report to <path>.
 *
 *   --policy <path>
 *     Override the default policy file (scripts/static-data-policy.js).
 *
 * Exit codes
 * ----------
 *   0 – success / all checks passed
 *   1 – at least one check failed (--check --gzip-only: uncompressed large
 *       artefacts present; --check: warnings printed but exit 0 unless
 *       stale .gz detected)
 *
 * Examples (from workflow YAML)
 * -----
 *   node scripts/gzip-static-data.js --replace-raw --summary-json out/gzip-summary.json
 *   node scripts/gzip-static-data.js --check --gzip-only
 *   UNFALLATLAS_DATA_MODE=gzip-only node scripts/check-context-datasets.js
 */

const fs   = require('fs');
const path = require('path');

const { compressArtifacts, DEFAULT_MAX_RAW_BYTES } = require('./lib/static-data-compression');

const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    replaceRaw:  false,
    deleteStale: false,
    check:       false,
    gzipOnly:    false,
    dryRun:      false,
    summaryJson: null,
    policyPath:  null,
    root:        REPO_ROOT,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--replace-raw':  args.replaceRaw  = true; break;
      case '--delete-stale': args.deleteStale = true; break;
      case '--check':        args.check       = true; break;
      case '--gzip-only':    args.gzipOnly    = true; break;
      case '--dry-run':      args.dryRun      = true; break;
      case '--summary-json':
        args.summaryJson = argv[++i] || null;
        break;
      case '--policy':
        args.policyPath = argv[++i] || null;
        break;
      default:
        if (argv[i] && !argv[i].startsWith('-')) {
          // Positional: treat as repo root override
          args.root = path.resolve(argv[i]);
        }
        break;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Check mode helpers
// ---------------------------------------------------------------------------

/**
 * Perform a read-only check of the artefact state.
 * Returns { ok: boolean, violations: string[], warnings: string[] }.
 */
function checkState(root, policy) {
  const { _expandGlob, _matchesAny } = _internals(root, policy);
  const maxRawBytes = typeof policy.maxRawBytes === 'number'
    ? policy.maxRawBytes
    : DEFAULT_MAX_RAW_BYTES;

  const violations = [];
  const warnings   = [];

  // Check 1: large artefacts in the forbidRaw list must have a .gz counterpart.
  const forbidPatterns = policy.forbidRaw || [];
  for (const pat of forbidPatterns) {
    for (const abs of _expandGlob(pat)) {
      if (abs.endsWith('.gz')) continue;
      let stat;
      try { stat = fs.statSync(abs); }
      catch (_) { continue; }
      if (stat.size < maxRawBytes) continue;
      const gzAbs = `${abs}.gz`;
      const relRaw = path.relative(root, abs).replace(/\\/g, '/');
      const relGz  = path.relative(root, gzAbs).replace(/\\/g, '/');
      const hasGz  = fs.existsSync(gzAbs);
      if (!hasGz) {
        violations.push(`MISSING_GZ  ${relRaw} — .gz artefact absent (${relGz})`);
      } else {
        // Both exist: raw file is forbidden in gzip-only mode
        violations.push(`FORBIDDEN_RAW  ${relRaw} — large uncompressed artefact must not exist in commit target`);
      }
    }
  }

  // Check 2: stale .gz files (no corresponding raw source).
  // In --check mode we report but do not delete.
  const compressPatterns = policy.compress || [];
  for (const pat of compressPatterns) {
    const gzPat = pat.endsWith('.gz') ? pat : `${pat}.gz`;
    for (const gzAbs of _expandGlob(gzPat)) {
      const rawAbs = gzAbs.slice(0, -3);
      if (!fs.existsSync(rawAbs)) {
        const relGz = path.relative(root, gzAbs).replace(/\\/g, '/');
        warnings.push(`STALE_GZ  ${relGz} — no corresponding raw source found`);
      }
    }
  }

  return { ok: violations.length === 0, violations, warnings };
}

/**
 * Returns glob-expand and match helpers bound to `root` and `policy`.
 * Extracted to avoid duplicating the glob logic between check and compress.
 */
function _internals(root, policy) {
  // Inline _expandGlob / _matchesAny from the library to keep this CLI
  // self-contained for the check path (no write dependencies).
  function _expandGlob(pattern) {
    const regexStr = pattern
      .replace(/\\/g, '/')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '\x00')
      .replace(/\*\*/g, '\x01')
      .replace(/\*/g, '[^/]*')
      .replace(/\x00/g, '(.*\/)?')
      .replace(/\x01/g, '.*');
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
          const rel = path.relative(root, abs).replace(/\\/g, '/');
          if (re.test(rel)) results.push(abs);
        }
      }
    }
    walk(root);
    return results;
  }

  return { _expandGlob };
}

// ---------------------------------------------------------------------------
// Summary report
// ---------------------------------------------------------------------------

function buildSummary(result, args) {
  return {
    generatedAt:   new Date().toISOString(),
    mode:          args.replaceRaw ? 'replace-raw' : args.check ? 'check' : 'unknown',
    dryRun:        args.dryRun,
    totalRaw:      result.totalRaw,
    totalGz:       result.totalGz,
    totalSaving:   result.totalSaving,
    savingPct:     result.savingPct,
    filesProcessed: result.entries.length,
    staleRemoved:  result.staleRemoved,
    top20: result.top20.map(e => ({
      path:       e.relPath,
      rawBytes:   e.rawBytes,
      gzBytes:    e.gzBytes,
      savingPct:  e.savingPct,
    })),
  };
}

function formatSummary(summary) {
  const mb = n => `${(n / 1024 / 1024).toFixed(2)} MB`;
  const lines = [
    `[gzip-static-data] Mode: ${summary.mode}${summary.dryRun ? ' (dry-run)' : ''}`,
    `  Files processed: ${summary.filesProcessed}`,
    `  Raw total:       ${mb(summary.totalRaw)} (${summary.totalRaw} bytes)`,
    `  GZ total:        ${mb(summary.totalGz)} (${summary.totalGz} bytes)`,
    `  Saving:          ${mb(summary.totalSaving)} (${summary.savingPct}%)`,
  ];
  if (summary.staleRemoved && summary.staleRemoved.length > 0) {
    lines.push(`  Stale .gz removed: ${summary.staleRemoved.length}`);
    for (const p of summary.staleRemoved) lines.push(`    - ${p}`);
  }
  if (summary.top20 && summary.top20.length > 0) {
    lines.push('  Top 20 largest compressed artefacts:');
    for (const e of summary.top20) {
      lines.push(`    ${e.path}  (${(e.gzBytes / 1024).toFixed(1)} KB gz, -${e.savingPct}%)`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const args = parseArgs(argv);

  // Load policy (custom or default)
  let policy;
  if (args.policyPath) {
    policy = require(path.resolve(args.policyPath));
  } else {
    policy = require('./static-data-policy');
  }

  // --check mode: read-only validation
  if (args.check) {
    const { ok, violations, warnings } = checkState(args.root, policy);
    const staleWarnings = warnings.filter(w => w.startsWith('STALE_GZ'));
    const hasStaleWarnings = staleWarnings.length > 0;

    for (const w of warnings) console.warn(w);

    if (args.gzipOnly) {
      for (const v of violations) console.error(v);
      if (!ok) {
        console.error(`\n[gzip-static-data] --check --gzip-only FAILED: ${violations.length} violation(s)`);
        process.exitCode = 1;
        return;
      }
      // In gzip-only mode, .gz files without raw sources are expected —
      // that is the whole point.  Only report STALE_GZ as informational.
      if (hasStaleWarnings) {
        console.log(`[gzip-static-data] --check --gzip-only: ${staleWarnings.length} .gz file(s) have no raw source (expected in gzip-only mode)`);
      }
      console.log('[gzip-static-data] --check --gzip-only passed ✓');
    } else {
      for (const v of violations) console.warn(v);
      if (!ok) {
        console.warn(`\n[gzip-static-data] --check: ${violations.length} warning(s) — use --gzip-only to fail on these`);
      }
      if (hasStaleWarnings) {
        console.error(`\n[gzip-static-data] --check FAILED: stale .gz artefacts detected (${staleWarnings.length})`);
        process.exitCode = 1;
      } else if (ok) {
        console.log('[gzip-static-data] --check passed ✓');
      }
    }
    return;
  }

  // --replace-raw / --delete-stale mode: compression + optional deletion
  if (!args.replaceRaw && !args.deleteStale) {
    console.error('[gzip-static-data] No action specified. Use --replace-raw, --check, or --delete-stale.');
    process.exitCode = 1;
    return;
  }

  const result = compressArtifacts(args.root, policy, {
    deleteRaw:   args.replaceRaw,
    dryRun:      args.dryRun,
    deleteStale: args.deleteStale,
  });

  const summary = buildSummary(result, args);
  console.log(formatSummary(summary));

  if (args.summaryJson) {
    const summaryPath = path.isAbsolute(args.summaryJson)
      ? args.summaryJson
      : path.join(args.root, args.summaryJson);
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`[gzip-static-data] Summary written to ${summaryPath}`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

// Export for testing
module.exports = { parseArgs, checkState, buildSummary, formatSummary, _internals };
