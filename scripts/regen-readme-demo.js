#!/usr/bin/env node
/**
 * Regenerate `docs/demo.gif` from the real Docker video-export pipeline.
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

const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const README_PATH = path.join(REPO_ROOT, 'README.md');
const DEMO_ASSET_PATHS = Object.freeze({
  gif: path.join(DOCS_DIR, 'demo.gif'),
  webp: path.join(DOCS_DIR, 'demo.webp'),
  apng: path.join(DOCS_DIR, 'demo.apng')
});
const GIF_BUDGET_BYTES = 10 * 1024 * 1024;

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
  if (!buf || buf.length < 12) {
    throw new Error(`${format.toUpperCase()} too short: ${buf ? buf.length : 0} bytes`);
  }
  if (format === 'gif') {
    const magic = buf.subarray(0, 6).toString('ascii');
    if (magic !== 'GIF89a' && magic !== 'GIF87a') {
      throw new Error(`invalid GIF magic: ${magic}`);
    }
    if (buf[buf.length - 1] !== 0x3B) {
      throw new Error('invalid GIF trailer: expected 0x3B');
    }
    return;
  }
  if (format === 'webp') {
    if (buf.slice(0, 4).toString('ascii') !== 'RIFF' || buf.slice(8, 12).toString('ascii') !== 'WEBP') {
      throw new Error('invalid WEBP RIFF magic');
    }
    if (!buf.includes(Buffer.from('ANIM', 'ascii'))) {
      throw new Error('invalid WEBP animation marker (ANIM missing)');
    }
    return;
  }
  if (format === 'apng') {
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!buf.subarray(0, 8).equals(pngSig)) {
      throw new Error('invalid APNG signature');
    }
    if (!buf.includes(Buffer.from('acTL', 'ascii'))) {
      throw new Error('invalid APNG animation marker (acTL missing)');
    }
    return;
  }
  throw new Error(`unsupported format for shape assertion: ${format}`);
}

function syncReadmeDemoSrc(relAssetPath) {
  const readme = fs.readFileSync(README_PATH, 'utf8');
  const next = readme.replace(
    /!\[Demo-Ablauf der Unfallwerkbank V2\]\(docs\/demo\.(?:gif|webp|apng)\)/g,
    `![Demo-Ablauf der Unfallwerkbank V2](${relAssetPath})`
  );
  if (next !== readme) fs.writeFileSync(README_PATH, next);
}

async function chooseDemoAsset(baseUrl, opts = {}) {
  const fetchExportFn = typeof opts.fetchExportFn === 'function' ? opts.fetchExportFn : fetchExport;
  const gifBudgetBytes = Number.isFinite(Number(opts.gifBudgetBytes)) ? Number(opts.gifBudgetBytes) : GIF_BUDGET_BYTES;
  const gif = await fetchExportFn(baseUrl, 'gif');
  assertAnimatedShape(gif, 'gif');
  if (gif.length <= gifBudgetBytes) {
    return { format: 'gif', buffer: gif };
  }
  log(`GIF too large (${gif.length} bytes > ${gifBudgetBytes} bytes), trying fallback formats`);
  for (const fmt of ['webp', 'apng']) {
    try {
      const candidate = await fetchExportFn(baseUrl, fmt);
      assertAnimatedShape(candidate, fmt);
      return { format: fmt, buffer: candidate };
    } catch (err) {
      log(`fallback format ${fmt} failed: ${err && err.message ? err.message : err}`);
    }
  }
  throw new Error(`GIF too large and no fallback could be generated (gif=${gif.length} bytes)`);
}

async function main() {
  const probe = await isDockerAvailable();
  if (!probe.available) {
    // eslint-disable-next-line no-console
    console.error(`[regen-readme-demo] Docker not available: ${probe.reason}`);
    process.exit(2);
  }

  const handle = await startUnfallatlasContainer();
  try {
    const chosen = await chooseDemoAsset(handle.baseUrl);
    const chosenFormat = chosen.format;
    const chosenBuffer = chosen.buffer;

    const outPath = DEMO_ASSET_PATHS[chosenFormat];
    fs.writeFileSync(outPath, chosenBuffer);
    log(`wrote ${outPath} (${chosenBuffer.length} bytes)`);

    // Keep only the currently referenced README asset to avoid stale demos.
    for (const [fmt, p] of Object.entries(DEMO_ASSET_PATHS)) {
      if (fmt !== chosenFormat && fs.existsSync(p)) fs.unlinkSync(p);
    }
    syncReadmeDemoSrc(`docs/demo.${chosenFormat}`);
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
  chooseDemoAsset,
  syncReadmeDemoSrc,
  main,
};
