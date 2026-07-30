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

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
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
  const relative = String(buildLockResult.path).replace(/\\/g, "/");
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
  const actualSha256 = sha256File(file);
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
        !relative.startsWith("out/"),
    )
    .sort();
  const fingerprint = sha256Buffer(
    Buffer.from(
      files
        .map((relative) => {
          const absolute = path.join(outputRoot, relative);
          return `${relative}\0${sha256File(absolute)}`;
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

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_manifest", `${label} must be an object`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    fail("invalid_asset_binding", `${label} must be a non-empty string`);
  }
  return value.trim();
}

function requiredHash(value, label) {
  const hash = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    fail("invalid_asset_binding", `${label} must be a lowercase SHA-256 digest`);
  }
  return hash;
}

function requiredBytes(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    fail("invalid_asset_binding", `${label} must be a positive safe integer`, {
      value,
    });
  }
  return number;
}

function optionalMatchingString(value, expected, label, mismatches, field) {
  if (value == null) return expected;
  const actual = requiredString(value, label);
  if (actual !== expected) mismatches[field] = { expected, actual };
  return actual;
}

function bindOperationsToVendorAssets(manifest, lockValue) {
  if (manifest.vendorAssets == null) {
    return Object.freeze({ vendorAssets: null, bindings: Object.freeze([]), fingerprint: null });
  }
  if (!Array.isArray(manifest.vendorAssets)) {
    fail("invalid_vendor_assets", "manifest.vendorAssets must be an array");
  }
  if (!Array.isArray(lockValue.operations) || lockValue.operations.length === 0) {
    fail("invalid_exact_copy_lock", "exact-copy lock operations must be non-empty");
  }
  const dependencies = requireObject(manifest.dependencies, "manifest.dependencies");

  const assets = manifest.vendorAssets.map((asset, index) => {
    const value = requireObject(asset, `manifest.vendorAssets[${index}]`);
    return {
      index,
      value,
      path: requiredString(value.path, `manifest.vendorAssets[${index}].path`).replace(/\\/g, "/"),
    };
  });
  const assetsByPath = new Map();
  for (const asset of assets) {
    if (assetsByPath.has(asset.path)) {
      fail("duplicate_vendor_asset", "manifest contains a duplicate vendor asset path", {
        path: asset.path,
      });
    }
    assetsByPath.set(asset.path, asset);
  }

  const seenRefs = new Set();
  const seenOutputs = new Set();
  const replacements = new Map();
  const bindings = [];
  for (let index = 0; index < lockValue.operations.length; index += 1) {
    const operation = requireObject(lockValue.operations[index], `lock.operations[${index}]`);
    const lockRef = requiredString(operation.lockRef, `lock.operations[${index}].lockRef`);
    if (seenRefs.has(lockRef)) {
      fail("duplicate_lock_ref", "exact-copy lock contains a duplicate lockRef", { lockRef });
    }
    seenRefs.add(lockRef);
    if (operation.method !== "byte-for-byte-copy") {
      fail("invalid_asset_binding", "only byte-for-byte-copy operations can bind vendor assets", {
        lockRef,
        method: operation.method,
      });
    }
    const component = requireObject(operation.component, `${lockRef}.component`);
    const input = requireObject(operation.input, `${lockRef}.input`);
    const output = requireObject(operation.output, `${lockRef}.output`);
    const outputPath = requiredString(output.path, `${lockRef}.output.path`).replace(/\\/g, "/");
    if (seenOutputs.has(outputPath)) {
      fail("duplicate_lock_output", "exact-copy lock contains a duplicate output path", {
        outputPath,
      });
    }
    seenOutputs.add(outputPath);
    const asset = assetsByPath.get(outputPath);
    if (!asset) {
      fail("missing_vendor_asset", "exact-copy output is not present in manifest.vendorAssets", {
        lockRef,
        outputPath,
      });
    }

    const packageName = requiredString(component.name, `${lockRef}.component.name`);
    const componentVersion = requiredString(component.version, `${lockRef}.component.version`);
    const componentPurl = requiredString(component.purl, `${lockRef}.component.purl`);
    const outputBytes = requiredBytes(output.bytes, `${lockRef}.output.bytes`);
    const outputSha256 = requiredHash(output.sha256, `${lockRef}.output.sha256`);
    const assetPackage = requiredString(asset.value.package, `vendor asset ${outputPath}.package`);
    const lockedDependencyVersion = requiredString(
      dependencies[assetPackage],
      `manifest.dependencies.${assetPackage}`,
    );
    const assetBytes = requiredBytes(asset.value.bytes, `vendor asset ${outputPath}.bytes`);
    const assetSha256 = requiredHash(asset.value.sha256, `vendor asset ${outputPath}.sha256`);
    const inputPath = requiredString(input.path, `${lockRef}.input.path`);
    const inputBytes = requiredBytes(input.bytes, `${lockRef}.input.bytes`);
    const inputSha256 = requiredHash(input.sha256, `${lockRef}.input.sha256`);

    const mismatches = {};
    if (assetPackage !== packageName) mismatches.package = { expected: packageName, actual: assetPackage };
    if (lockedDependencyVersion !== componentVersion) {
      mismatches.dependencyVersion = { expected: componentVersion, actual: lockedDependencyVersion };
    }
    optionalMatchingString(
      asset.value.version,
      componentVersion,
      `vendor asset ${outputPath}.version`,
      mismatches,
      "assetVersion",
    );
    optionalMatchingString(
      asset.value.purl,
      componentPurl,
      `vendor asset ${outputPath}.purl`,
      mismatches,
      "assetPurl",
    );
    optionalMatchingString(
      asset.value.sourcePath,
      inputPath,
      `vendor asset ${outputPath}.sourcePath`,
      mismatches,
      "assetSourcePath",
    );
    if (assetBytes !== outputBytes) mismatches.bytes = { expected: outputBytes, actual: assetBytes };
    if (assetSha256 !== outputSha256) mismatches.sha256 = { expected: outputSha256, actual: assetSha256 };
    if (inputBytes !== outputBytes) {
      mismatches.copyBytes = { expected: outputBytes, actual: inputBytes };
    }
    if (inputSha256 !== outputSha256) {
      mismatches.copySha256 = { expected: outputSha256, actual: inputSha256 };
    }
    if (Object.keys(mismatches).length) {
      fail("vendor_asset_drift", "vendor asset differs from its exact-copy operation", {
        lockRef,
        outputPath,
        mismatches,
      });
    }

    const reference = vendorBuildLock.buildLockReference(lockValue, lockRef);
    const exactCopy = Object.freeze({
      ...reference,
      method: operation.method,
      componentPurl,
      input: Object.freeze({
        path: inputPath,
        bytes: inputBytes,
        sha256: inputSha256,
      }),
      auxiliaryInputs: Object.freeze(
        Array.isArray(operation.auxiliaryInputs)
          ? operation.auxiliaryInputs.map((item, auxiliaryIndex) => {
              const auxiliary = requireObject(item, `${lockRef}.auxiliaryInputs[${auxiliaryIndex}]`);
              return Object.freeze({
                path: requiredString(auxiliary.path, `${lockRef}.auxiliaryInputs[${auxiliaryIndex}].path`),
                bytes: requiredBytes(auxiliary.bytes, `${lockRef}.auxiliaryInputs[${auxiliaryIndex}].bytes`),
                sha256: requiredHash(auxiliary.sha256, `${lockRef}.auxiliaryInputs[${auxiliaryIndex}].sha256`),
              });
            })
          : [],
      ),
      output: Object.freeze({
        path: outputPath,
        bytes: outputBytes,
        sha256: outputSha256,
      }),
    });
    replacements.set(asset.index, Object.freeze({
      ...asset.value,
      version: componentVersion,
      purl: componentPurl,
      sourcePath: inputPath,
      exactCopy,
    }));
    bindings.push(Object.freeze({
      lockRef,
      path: outputPath,
      componentPurl,
      inputSha256,
      outputSha256,
    }));
  }

  const normalizedBindings = bindings.slice().sort((left, right) =>
    left.lockRef.localeCompare(right.lockRef));
  return Object.freeze({
    vendorAssets: Object.freeze(
      manifest.vendorAssets.map((asset, index) => replacements.get(index) || Object.freeze({ ...asset })),
    ),
    bindings: Object.freeze(normalizedBindings),
    fingerprint: sha256Buffer(Buffer.from(stableJson(normalizedBindings))),
  });
}

function recomputeOverallFingerprint(manifest) {
  const exactCopyFingerprint = manifest.vendorExactCopyLock.assetBindingFingerprint;
  return sha256Buffer(
    Buffer.from(
      JSON.stringify({
        application: requireFingerprint(manifest.application, "manifest.application"),
        dependencies: requireObject(manifest.dependencies, "manifest.dependencies"),
        thirdPartyNotices: requireSha256(
          manifest.thirdPartyNotices,
          "manifest.thirdPartyNotices",
        ),
        data: requireFingerprint(manifest.data, "manifest.data"),
        networkPolicy: requireObject(manifest.networkPolicy, "manifest.networkPolicy"),
        vendorExactCopyLock: {
          lockId: manifest.vendorExactCopyLock.lockId,
          sha256: manifest.vendorExactCopyLock.sha256,
          ...(exactCopyFingerprint
            ? { assetBindingFingerprint: exactCopyFingerprint }
            : {}),
        },
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
  const assetBinding = bindOperationsToVendorAssets(manifest, lock.value);
  if (assetBinding.vendorAssets) manifest.vendorAssets = assetBinding.vendorAssets;
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
    ...(assetBinding.fingerprint
      ? {
          coveredAssetCount: assetBinding.bindings.length,
          assetBindingFingerprint: assetBinding.fingerprint,
          assetBindings: assetBinding.bindings,
        }
      : {}),
  };
  manifest.fingerprint = recomputeOverallFingerprint(manifest);
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return Object.freeze({
    manifest: Object.freeze(manifest),
    manifestPath: manifestFile,
    manifestSha256: sha256File(manifestFile),
  });
}

module.exports = Object.freeze({
  MANIFEST_BINDING_SCHEMA_VERSION,
  MANIFEST_BINDING_TYPE,
  VendorExactCopyManifestError,
  sha256Buffer,
  sha256File,
  stableJson,
  readJson,
  resolveOutputRoot,
  validateLockResult,
  fingerprintApplicationFiles,
  requireFingerprint,
  requireSha256,
  requireObject,
  requiredString,
  requiredHash,
  requiredBytes,
  optionalMatchingString,
  bindOperationsToVendorAssets,
  recomputeOverallFingerprint,
  bindExactCopyLockToBuildManifest,
});
