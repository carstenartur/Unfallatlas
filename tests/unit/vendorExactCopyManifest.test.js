"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const vendorBuildLock = require("../../scripts/vendor-build-lock");
const binding = require("../../scripts/vendor-exact-copy-manifest");

function sha256File(file) {
  return vendorBuildLock.sha256Buffer(fs.readFileSync(file));
}

function write(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
  return file;
}

function digest(character) {
  return character.repeat(64);
}

function fixture() {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ua-exact-copy-manifest-"));
  write(outputRoot, "index.html", "<!doctype html><title>fixture</title>\n");
  write(outputRoot, "js/app.js", "console.log('fixture');\n");
  const lock = {
    schemaVersion: vendorBuildLock.EXACT_COPY_LOCK_SCHEMA_VERSION,
    type: vendorBuildLock.EXACT_COPY_LOCK_TYPE,
    lockId: digest("a"),
    operations: [
      { lockRef: "export.docx.iife" },
      { lockRef: "export.pdfmake.min" },
    ],
  };
  const lockText = `${JSON.stringify(lock, null, 2)}\n`;
  const lockFile = write(outputRoot, "vendor/exact-copy-lock.json", lockText);
  const buildLockResult = {
    lock,
    path: "vendor/exact-copy-lock.json",
    sha256: sha256File(lockFile),
  };
  const manifest = {
    schemaVersion: 1,
    application: { files: ["index.html", "js/app.js"], fingerprint: digest("b") },
    dependencies: { docx: "9.4.2", pdfmake: "0.2.20" },
    thirdPartyNotices: { path: "vendor/third-party-notices.json", sha256: digest("d") },
    data: { files: [], fingerprint: digest("e") },
    networkPolicy: { runtimeLibraries: "local-only", offlineCore: ".", optionalRemoteServices: [] },
    fingerprint: digest("0"),
  };
  write(outputRoot, "build-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return { outputRoot, lock, lockFile, buildLockResult, manifest };
}

describe("vendor exact-copy build-manifest binding", () => {
  const roots = [];

  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
  });

  test("includes the exact-copy lock in the application tree and overall fingerprint", () => {
    const value = fixture();
    roots.push(value.outputRoot);
    const result = binding.bindExactCopyLockToBuildManifest({
      outputRoot: value.outputRoot,
      buildLockResult: value.buildLockResult,
    });

    expect(result.manifest.application.files).toEqual([
      "index.html",
      "js/app.js",
      "vendor/exact-copy-lock.json",
    ]);
    expect(result.manifest.application.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifest.application.fingerprint).not.toBe(
      value.manifest.application.fingerprint,
    );
    expect(result.manifest.vendorExactCopyLock).toEqual({
      schemaVersion: 1,
      type: "unfallatlas-vendor-exact-copy-manifest-binding",
      path: "vendor/exact-copy-lock.json",
      sha256: value.buildLockResult.sha256,
      lockId: value.lock.lockId,
      operationCount: 2,
    });
    expect(result.manifest.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifest.fingerprint).not.toBe(
      value.manifest.fingerprint,
    );
    expect(result.manifest.application.files).not.toContain("build-manifest.json");
    expect(result.manifestSha256).toBe(
      sha256File(result.manifestPath),
    );
  });

  test("is deterministic for an unchanged site tree", () => {
    const first = fixture();
    const second = fixture();
    roots.push(first.outputRoot, second.outputRoot);
    const firstResult = binding.bindExactCopyLockToBuildManifest({
      outputRoot: first.outputRoot,
      buildLockResult: first.buildLockResult,
    });
    const secondResult = binding.bindExactCopyLockToBuildManifest({
      outputRoot: second.outputRoot,
      buildLockResult: second.buildLockResult,
    });
    expect(secondResult.manifest.application.fingerprint).toBe(
      firstResult.manifest.application.fingerprint,
    );
    expect(secondResult.manifest.fingerprint).toBe(
      firstResult.manifest.fingerprint,
    );
  });

  test("changes both fingerprints when the exact-copy lock bytes change", () => {
    const first = fixture();
    roots.push(first.outputRoot);
    const before = binding.bindExactCopyLockToBuildManifest({
      outputRoot: first.outputRoot,
      buildLockResult: first.buildLockResult,
    });

    const changedLock = {
      ...first.lock,
      lockId: digest("9"),
      operations: [...first.lock.operations, { lockRef: "export.pdfmake.font-container" }],
    };
    const changedText = `${JSON.stringify(changedLock, null, 2)}\n`;
    fs.writeFileSync(first.lockFile, changedText);
    const after = binding.bindExactCopyLockToBuildManifest({
      outputRoot: first.outputRoot,
      buildLockResult: {
        lock: changedLock,
        path: first.buildLockResult.path,
        sha256: sha256File(first.lockFile),
      },
    });

    expect(after.manifest.application.fingerprint).not.toBe(
      before.manifest.application.fingerprint,
    );
    expect(after.manifest.fingerprint).not.toBe(
      before.manifest.fingerprint,
    );
    expect(after.manifest.vendorExactCopyLock.operationCount).toBe(3);
  });

  test("fails closed when the lock file drifts after the writer result", () => {
    const value = fixture();
    roots.push(value.outputRoot);
    fs.appendFileSync(value.lockFile, "\n");
    expect(() =>
      binding.bindExactCopyLockToBuildManifest({
        outputRoot: value.outputRoot,
        buildLockResult: value.buildLockResult,
      }),
    ).toThrow(/exact_copy_lock_drift/);
  });

  test("fails closed when the written lock identity differs from the result", () => {
    const value = fixture();
    roots.push(value.outputRoot);
    const altered = {
      ...value.lock,
      lockId: digest("8"),
    };
    fs.writeFileSync(value.lockFile, `${JSON.stringify(altered, null, 2)}\n`);
    const sha256 = sha256File(value.lockFile);
    expect(() =>
      binding.bindExactCopyLockToBuildManifest({
        outputRoot: value.outputRoot,
        buildLockResult: {
          ...value.buildLockResult,
          sha256,
        },
      }),
    ).toThrow(/exact_copy_lock_identity_mismatch/);
  });

  test("rejects incomplete build-manifest fingerprint inputs", () => {
    const value = fixture();
    roots.push(value.outputRoot);
    const manifestFile = path.join(value.outputRoot, "build-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    delete manifest.dependencies;
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() =>
      binding.bindExactCopyLockToBuildManifest({
        outputRoot: value.outputRoot,
        buildLockResult: value.buildLockResult,
      }),
    ).toThrow(/manifest\.dependencies/);
  });

  test("reports missing site roots and manifests as domain errors", () => {
    expect(() =>
      binding.bindExactCopyLockToBuildManifest({
        outputRoot: path.join(os.tmpdir(), `missing-${Date.now()}`),
        buildLockResult: {},
      }),
    ).toThrow(/missing_root/);

    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ua-empty-site-"));
    roots.push(outputRoot);
    expect(() =>
      binding.bindExactCopyLockToBuildManifest({
        outputRoot,
        buildLockResult: {},
      }),
    ).toThrow(/missing_build_manifest/);
  });
});
