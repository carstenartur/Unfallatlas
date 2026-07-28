#!/usr/bin/env node
"use strict";

const path = require("path");
const siteBuild = require("./build-site");
const vendorBuildLock = require("./vendor-build-lock");

function main(argv) {
  const args = siteBuild.parseArgs(argv);
  const manifest = siteBuild.buildSite(args);
  const repoRoot = path.resolve(args.root || path.join(__dirname, ".."));
  const outputRoot = path.resolve(repoRoot, args.outputDir || "_site");
  const buildLock = vendorBuildLock.writeBuildLock({
    repoRoot,
    outputRoot,
  });
  process.stdout.write(
    `[build-site] Bound ${buildLock.lock.operations.length} browser-export assets ` +
      `to vendor build lock ${buildLock.lock.lockId}.\n`,
  );
  return Object.freeze({ manifest, buildLock });
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({ main });
