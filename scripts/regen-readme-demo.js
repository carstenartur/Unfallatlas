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

const DEMO_PATH = path.join(REPO_ROOT, 'docs', 'demo.gif');
const GIF_BUDGET_BYTES = 6 * 1024 * 1024;

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

async function fetchGif(baseUrl) {
  log(`POST ${baseUrl}/api/export-video`);
  const res = await fetch(`${baseUrl}/api/export-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(README_DEMO_BODY)
  });
  if (res.status !== 200) {
    throw new Error(`POST /api/export-video → HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function assertGifShape(gif) {
  if (gif.length < 7) {
    throw new Error(`GIF too short: ${gif.length} bytes`);
  }
  const magic = gif.subarray(0, 6).toString('ascii');
  if (magic !== 'GIF89a' && magic !== 'GIF87a') {
    throw new Error(`invalid GIF magic: ${magic}`);
  }
  if (gif[gif.length - 1] !== 0x3B) {
    throw new Error('invalid GIF trailer: expected 0x3B');
  }
  if (gif.length > GIF_BUDGET_BYTES) {
    throw new Error(`GIF too large: ${gif.length} bytes > budget ${GIF_BUDGET_BYTES} bytes`);
  }
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
    const gif = await fetchGif(handle.baseUrl);
    assertGifShape(gif);
    fs.writeFileSync(DEMO_PATH, gif);
    log(`wrote ${DEMO_PATH} (${gif.length} bytes)`);
  } finally {
    await handle.stop();
  }

  log('done.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[regen-readme-demo]', err);
  process.exit(1);
});
