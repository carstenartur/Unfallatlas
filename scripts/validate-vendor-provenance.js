#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {
    manifest: '_site/vendor/third-party-notices.json',
    requireComplete: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--manifest') args.manifest = argv[++index] || '';
    else if (argument === '--require-complete') args.requireComplete = true;
    else throw new Error(`[validate-vendor-provenance] Unknown argument: ${argument}`);
  }
  if (!args.manifest) throw new Error('[validate-vendor-provenance] --manifest requires a path');
  return args;
}

function validateVendorProvenance(manifestPath, options = {}) {
  const absolute = path.resolve(manifestPath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`[validate-vendor-provenance] Manifest does not exist: ${absolute}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`[validate-vendor-provenance] Invalid JSON: ${error.message}`);
  }
  if (!manifest || manifest.schemaVersion !== 2 || !Array.isArray(manifest.dependencies) ||
      typeof manifest.complete !== 'boolean' || typeof manifest.inventoryScope !== 'string') {
    throw new Error('[validate-vendor-provenance] Unsupported or incomplete notice schema');
  }
  if (options.requireComplete && manifest.complete !== true) {
    throw new Error(
      '[validate-vendor-provenance] Release/deployment blocked: browser vendor provenance is incomplete. ' +
      `Resolve ${manifest.trackingIssue || 'the tracked vendor-provenance issue'} or deliberately remove the opaque assets.`
    );
  }
  return manifest;
}

function main(argv) {
  const args = parseArgs(argv);
  const manifest = validateVendorProvenance(args.manifest, { requireComplete: args.requireComplete });
  process.stdout.write(
    `[validate-vendor-provenance] ${manifest.complete ? 'complete' : 'INCOMPLETE'} ` +
    `(${manifest.inventoryScope})\n`
  );
  return manifest;
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error && error.message ? error.message : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs, validateVendorProvenance };
