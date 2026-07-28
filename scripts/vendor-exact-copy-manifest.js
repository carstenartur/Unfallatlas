#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const siteBuild = require("./build-site");
const vendorBuildLock = require("./vendor-build-lock");

const MANIFEST_BINDING_SCHEMA_VERSION = 1;
const MANIFEST_BINDING_TYPE = "unfallatlas-vendor-exact-copy-manifest-binding";

class VendorExactCopyManifestError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = "VendorExactCopyManifestError";
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new VendorExactCopyManifestError(code, message, details);
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function readJson(file, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail("invalid_json", `${label} is not valid JSON`, {
      file,
      message: error && error.message ? error.message : String(error),
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_manifest", `${label} must be an object`, { file });
  }
  return value;
}

function resolveOutputRoot(value) {
  const requested = path.resolve(String(value || ""));
  let root;
  try {
    root = fs.realpathSync(requested);
  } catch (error) {
    fail("missing_root", "outputRoot does not exist", {
      requested,
      systemCode: error && error.code ? error.code : null,
    });
  }
  if (!fs.statSync(root).isDirectory()) {
    fail("invalid_root", "outputRoot must be a directory", { root });
  }
  return root;
}

function validateLockResult(outputRoot, buildLockResult) {
  if (
    !buildLockResult ||
    typeof buildLockResult !== "object" ||
    !buildLockResult.lock ||
    buildLockResult.lock.type !== vendorBuildLock.EXACT_COPY_LOCK_TYPE ||
    buildLockResult.lock.schemaVersion !==
      vendorBuildLock.EXACT_COPY_LOCK_SCHEMA_VERSION ||
    typeof buildLockResult.lock.lockId !== "string" ||
    !/^[a-f0-9]{64}$/.test(buildLockResult.lock.lockId) ||
    typeof buildLockResult.path !== "string" ||
    typeof buildLockResult.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(buildLockResult.sha256)
  ) {
    fail("invalid_exact_copy_lock", "a written vendor exact-copy lock is required");
  }
  const relative = siteBuild.normalizeRelativePath(buildLockResult.path);
  const file = path.resolve(outputRoot, relative);
  const rel = path.relative(outputRoot, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    fail("unsafe_lock_path", "exact-copy lock path escapes the output root", {
      path: buildLockResult.path,
    });
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    fail("missing_exact_copy_lock", "written exact-copy lock file is missing", {
      file,
    });
  }
  const actualSha256 = siteBuild.hashFile(file);
  if (actualSha256 !== buildLockResult.sha256) {
    fail("exact_copy_lock_drift", "exact-copy lock bytes differ from the writer result", {
      expected: buildLockResult.sha256,
      actual: actualSha256,
    });
  }
  const value = readJson(file, "vendor exact-copy lock");
  if (
    value.type !== vendorBuildLock.EXACT_COPY_LOCK_TYPE ||
    value.schemaVersion !== vendorBuildLock.EXACT_COPY_LOCK_SCHEMA_VERSION ||
    value.lockId !== buildLockResult.lock.lockId
  ) {
    fail("exact_copy_lock_identity_mismatch", "exact-copy lock file identity differs from the writer result", {
      expectedLockId: buildLockResult.lock.lockId,
      actualLockId: value.lockId || null,
    });
  }
  return Object.freeze({ relative, file, actualSha256, value });
}

function fingerprintApplicationFiles(outputRoot) {
  const files = siteBuild
    .listFiles(outputRoot)
    .map((file) => path.relative(outputRoot, file).replace(/\\/g, "/"))
    .filter(
      (relative) =>
        relative !== "build-manifest.json" &&
        !siteBuild.isExcludedOutputPath(relative),
    )
    .sort();
  const fingerprint = sha256Buffer(
    Buffer.from(
      files
        .map((relative) => {
          const absolute = path.join(outputRoot, relative);
          return `${relative}\0${siteBuild.hashFile(absolute)}`;
        })
        .join("\n"),
    ),
  );
  return Object.freeze({ files: Object.freeze(files), fingerprint });
}

function requireFingerprint(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_manifest", `${label} must be an object`);
  }
  if (typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)) {
    fail("invalid_manifest", `${label}.fingerprint must be a SHA-256 digest`);
  }
  return value.fingerprint;
}

function requireSha256(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_manifest", `${label} must be an object`);
  }
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    fail("invalid_manifest", `${label}.sha256 must be a SHA-256 digest`);
  }
  return value.sha256;
}

function recomputeOverallFingerprint(manifest) {
  return sha256Buffer(
    Buffer.from(
      stableJson({
        application: requireFingerprint(manifest.application, "manifest.application"),
        dependencies: requireFingerprint(manifest.dependencies, "manifest.dependencies"),
        thirdPartyNotices: requireSha256(
          manifest.thirdPartyNotices,
          "manifest.thirdPartyNotices",
        ),
        vendorExactCopyLock: {
          lockId: manifest.vendorExactCopyLock.lockId,
          sha256: manifest.vendorExactCopyLock.sha256,
        },
        data: requireFingerprint(manifest.data, "manifest.data"),
        networkPolicy: requireFingerprint(
          manifest.networkPolicy,
          "manifest.networkPolicy",
        ),
      }),
    ),
  );
}

function bindExactCopyLockToBuildManifest(options) {
  const opts = options || {};
  const outputRoot = resolveOutputRoot(opts.outputRoot);
  const manifestFile = path.join(outputRoot, "build-manifest.json");
  if (!fs.existsSync(manifestFile) || !fs.statSync(manifestFile).isFile()) {
    fail("missing_build_manifest", "build-manifest.json is missing", {
      manifestFile,
    });
  }
  const lock = validateLockResult(outputRoot, opts.buildLockResult);
  const manifest = readJson(manifestFile, "build manifest");
  const application = fingerprintApplicationFiles(outputRoot);
  if (!application.files.includes(lock.relative)) {
    fail("lock_not_in_application_tree", "exact-copy lock is not part of the application file tree", {
      path: lock.relative,
    });
  }
  manifest.application = {
    ...(manifest.application || {}),
    files: application.files,
    fingerprint: application.fingerprint,
  };
  manifest.vendorExactCopyLock = {
    schemaVersion: MANIFEST_BINDING_SCHEMA_VERSION,
    type: MANIFEST_BINDING_TYPE,
    path: lock.relative,
    sha256: lock.actualSha256,
    lockId: lock.value.lockId,
    operationCount: Array.isArray(lock.value.operations)
      ? lock.value.operations.length
      : 0,
  };
  manifest.overallFingerprint = recomputeOverallFingerprint(manifest);
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return Object.freeze({
    manifest: Object.freeze(manifest),
    manifestPath: manifestFile,
    manifestSha256: siteBuild.hashFile(manifestFile),
  });
}

module.exports = Object.freeze({
  MANIFEST_BINDING_SCHEMA_VERSION,
  MANIFEST_BINDING_TYPE,
  VendorExactCopyManifestError,
  sha256Buffer,
  stableJson,
  readJson,
  resolveOutputRoot,
  validateLockResult,
  fingerprintApplicationFiles,
  requireFingerprint,
  requireSha256,
  recomputeOverallFingerprint,
  bindExactCopyLockToBuildManifest,
});
