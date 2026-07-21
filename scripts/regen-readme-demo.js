#!/usr/bin/env node
/**
 * Regenerate the canonical `docs/demo.gif` from the real Docker
 * video-export pipeline.
 *
 * Source of truth:
 * - same testcontainers helper as `videoExport.testcontainers.test.js`
 * - same container image resolution (`UNFALLATLAS_IMAGE`, else local build)
 *
 * Run with: `npm run regen:demo`
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
  startUnfallatlasContainer,
  isDockerAvailable,
  REPO_ROOT
} = require('../tests/integration/lib/startUnfallatlasContainer');
const { inspectMedia, validate } = require('./validate-doc-media');
const { capGifDuration, parseGifTimeline } = require('./gif-timeline');

const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const MEDIA_MANIFEST_PATH = path.join(DOCS_DIR, 'media-manifest.json');
const DEMO_ASSET_PATH = path.join(DOCS_DIR, 'demo.gif');
const ALTERNATIVE_DEMO_PATHS = Object.freeze([
  path.join(DOCS_DIR, 'demo.webp'),
  path.join(DOCS_DIR, 'demo.apng'),
]);
const README_DEMO_BODY = Object.freeze({
  city: 'Bonn',
  includeCyclist: '1',
  includePedestrian: '0',
  includeCar: '1',
  includeMotorcycle: '0',
  involvementMode: 'and',
  showHeatmap: '1',
  showCluster: '0',
  severity: 'all',
  hourFrom: '0',
  hourTo: '23',
  centerLat: '50.7326',
  centerLon: '7.0963',
  zoom: '16',
  selSouth: '50.7300',
  selWest: '7.0910',
  selNorth: '50.7355',
  selEast: '7.1010'
});

function log(...args) {
  // eslint-disable-next-line no-console
  console.log('[regen-readme-demo]', ...args);
}

async function fetchExport(baseUrl, format) {
  const fmt = String(format || 'gif').toLowerCase();
  log(`POST ${baseUrl}/api/export-video (format=${fmt})`);
  const body = { ...README_DEMO_BODY };
  if (fmt !== 'gif') body.format = fmt;
  const res = await fetch(`${baseUrl}/api/export-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const responseText = await res.text().catch(() => '');
    const detail = responseText ? `, body=${responseText.slice(0, 600)}` : '';
    throw new Error(`POST /api/export-video → HTTP ${res.status} ${res.statusText}${detail}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function assertAnimatedShape(buf, format) {
  if (String(format).toLowerCase() !== 'gif') {
    throw new Error(`unsupported animation format without a timeline decoder: ${format}`);
  }
  const timeline = parseGifTimeline(buf, 'generated GIF');
  if (!timeline.animated) throw new Error(`GIF is not animated: found ${timeline.frames} image frame(s)`);
  return timeline;
}

function loadDemoPolicy() {
  const manifest = JSON.parse(fs.readFileSync(MEDIA_MANIFEST_PATH, 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets)) {
    throw new Error('docs/media-manifest.json has an unsupported schema');
  }
  const matches = manifest.assets.filter(asset =>
    asset && /^docs\/demo\.(?:gif|webp|apng)$/.test(String(asset.path || ''))
  );
  if (matches.length !== 1 || matches[0].path !== 'docs/demo.gif') {
    throw new Error('media manifest must declare exactly one canonical docs/demo.gif asset');
  }
  const policy = matches[0];
  const maxBytes = Number(policy.maxBytes);
  const target = policy.target;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 ||
      !target || !Number.isInteger(target.width) || !Number.isInteger(target.height) ||
      target.width <= 0 || target.height <= 0) {
    throw new Error('canonical demo needs positive integer target dimensions and byte budget');
  }
  for (const reference of ['README.md', 'docs/DOKUMENTATION.md', 'scripts/regen-readme-demo.js']) {
    if (!Array.isArray(policy.references) || !policy.references.includes(reference)) {
      throw new Error(`canonical demo manifest entry is missing reference ${reference}`);
    }
  }
  const maxDurationMs = Number(policy.maxDurationMs);
  if (!Number.isInteger(maxDurationMs) || maxDurationMs <= 0) {
    throw new Error('canonical demo needs a positive integer maxDurationMs budget');
  }
  return { maxBytes, maxDurationMs, target };
}

function assertNoAlternativeDemoAssets() {
  const stale = ALTERNATIVE_DEMO_PATHS.filter(candidate => fs.existsSync(candidate));
  if (stale.length) {
    throw new Error(
      `undeclared alternative demo asset(s) found: ${stale.map(file => path.relative(REPO_ROOT, file)).join(', ')}; ` +
      'promote a format only together with an intentional manifest and Markdown-reference change'
    );
  }
}

function atomicWrite(file, contents) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, contents);
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function inspectDemoCandidate(contents, policy) {
  const candidateDirectory = path.join(REPO_ROOT, '.build', 'doc-media');
  const candidate = path.join(candidateDirectory, `.readme-demo-${process.pid}-${Date.now()}.gif`);
  fs.mkdirSync(candidateDirectory, { recursive: true });
  try {
    fs.writeFileSync(candidate, contents);
    const inspected = inspectMedia(candidate);
    if (inspected.animated !== true) throw new Error('generated GIF contains fewer than two frames');
    if (inspected.width !== policy.target.width || inspected.height !== policy.target.height) {
      throw new Error(
        `generated GIF dimensions ${inspected.width}x${inspected.height} do not match manifest target ` +
        `${policy.target.width}x${policy.target.height}`
      );
    }
    if (contents.length > policy.maxBytes) {
      throw new Error(`generated GIF exceeds manifest budget (${contents.length} > ${policy.maxBytes} bytes)`);
    }
    return inspected;
  } finally {
    if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  }
}

async function chooseDemoAsset(baseUrl, opts = {}) {
  const fetchExportFn = typeof opts.fetchExportFn === 'function' ? opts.fetchExportFn : fetchExport;
  const gifBudgetBytes = Number(opts.gifBudgetBytes);
  if (!Number.isInteger(gifBudgetBytes) || gifBudgetBytes <= 0) {
    throw new Error('chooseDemoAsset requires the explicit positive manifest gifBudgetBytes');
  }
  const gif = await fetchExportFn(baseUrl, 'gif');
  const duration = opts.maxDurationMs
    ? capGifDuration(gif, Number(opts.maxDurationMs), 'generated README demo GIF')
    : { buffer: gif, beforeMs: null, afterMs: null, changed: false };
  const shape = assertAnimatedShape(duration.buffer, 'gif');
  if (opts.expectedDimensions &&
      (shape.width !== Number(opts.expectedDimensions.width) || shape.height !== Number(opts.expectedDimensions.height))) {
    throw new Error(
      `GIF dimensions ${shape.width}x${shape.height} do not match manifest target ` +
      `${opts.expectedDimensions.width}x${opts.expectedDimensions.height}; no files were changed`
    );
  }
  if (duration.buffer.length > gifBudgetBytes) {
    throw new Error(
      `GIF exceeds canonical budget (${duration.buffer.length} bytes > ${gifBudgetBytes} bytes); ` +
      'automatic format fallback is disabled because it would require an atomic manifest and documentation migration; no files were changed'
    );
  }
  return {
    format: 'gif',
    buffer: duration.buffer,
    dimensions: { width: shape.width, height: shape.height },
    duration: { beforeMs: duration.beforeMs, afterMs: duration.afterMs, shortened: duration.changed },
  };
}

async function main() {
  const policy = loadDemoPolicy();
  assertNoAlternativeDemoAssets();
  const before = validate({ root: REPO_ROOT, manifest: 'docs/media-manifest.json' });
  if (!before.valid) {
    throw new Error(`existing documentation media policy is invalid:\n${before.errors.join('\n')}`);
  }
  const probe = await isDockerAvailable();
  if (!probe.available) {
    // eslint-disable-next-line no-console
    console.error(`[regen-readme-demo] Docker not available: ${probe.reason}`);
    process.exit(2);
  }

  const handle = await startUnfallatlasContainer();
  try {
    const chosen = await chooseDemoAsset(handle.baseUrl, {
      gifBudgetBytes: policy.maxBytes,
      maxDurationMs: policy.maxDurationMs,
      expectedDimensions: policy.target,
    });
    inspectDemoCandidate(chosen.buffer, policy);
    const original = fs.readFileSync(DEMO_ASSET_PATH);
    atomicWrite(DEMO_ASSET_PATH, chosen.buffer);
    const after = validate({ root: REPO_ROOT, manifest: 'docs/media-manifest.json' });
    if (!after.valid) {
      atomicWrite(DEMO_ASSET_PATH, original);
      throw new Error(`generated demo failed documentation media validation:\n${after.errors.join('\n')}`);
    }
    log(
      `wrote ${DEMO_ASSET_PATH} (${chosen.buffer.length} bytes, ${chosen.dimensions.width}x${chosen.dimensions.height}, ` +
      `${chosen.duration.afterMs} ms)`
    );
  } finally {
    await handle.stop();
  }

  log('done.');
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[regen-readme-demo]', err);
    process.exit(1);
  });
}

module.exports = {
  assertAnimatedShape,
  assertNoAlternativeDemoAssets,
  chooseDemoAsset,
  capGifDuration,
  inspectDemoCandidate,
  loadDemoPolicy,
  main,
};
