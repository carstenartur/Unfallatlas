#!/usr/bin/env node
"use strict";

const path = require("path");
const siteBuild = require("./build-site");
const vendorBuildLock = require("./vendor-build-lock");
const vendorExactCopyManifest = require("./vendor-exact-copy-manifest");
const vendorExactCopyProvenance = require("./vendor-exact-copy-provenance");

function main(argv, runtime = {}) {
  const site = runtime.siteBuild || siteBuild;
  const lockWriter = runtime.vendorBuildLock || vendorBuildLock;
  const manifestBinder = runtime.vendorExactCopyManifest || vendorExactCopyManifest;
  const provenanceBinder = runtime.vendorExactCopyProvenance || vendorExactCopyProvenance;
  const write = runtime.write || ((text) => process.stdout.write(text));

  const args = site.parseArgs(argv);
  const initialManifest = site.buildSite(args);
  const repoRoot = path.resolve(args.root || path.join(__dirname, ".."));
  const outputRoot = path.resolve(repoRoot, args.outputDir || "_site");
  const buildLock = lockWriter.writeBuildLock({
    repoRoot,
    outputRoot,
  });
  const manifestBinding = manifestBinder.bindExactCopyLockToBuildManifest({
    outputRoot,
    buildLockResult: buildLock,
  });
  const provenanceBinding = provenanceBinder.bindExactCopyProvenance({
    outputRoot,
  });
  write(
    `[build-site] Bound ${buildLock.lock.operations.length} browser-export assets ` +
      `to exact-copy lock ${buildLock.lock.lockId}, build manifest, notices and CycloneDX ` +
      `${provenanceBinding.manifest.fingerprint}.\n`,
  );
  return Object.freeze({
    initialManifest,
    manifest: provenanceBinding.manifest,
    buildLock,
    binding: manifestBinding,
    provenanceBinding,
  });
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
