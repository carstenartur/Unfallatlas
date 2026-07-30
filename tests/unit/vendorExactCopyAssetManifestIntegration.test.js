"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const vendorBuildLock = require("../../scripts/vendor-build-lock");
const binding = require("../../scripts/vendor-exact-copy-manifest");

function digest(character) {
  return character.repeat(64);
}

function write(root, relative, contents) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

describe("exact-copy asset references in final build manifest", () => {
  test("enriches the real minimal asset inventory and binds its fingerprint into the build", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ua-exact-copy-asset-manifest-"));
    try {
      write(root, "index.html", "<!doctype html><title>fixture</title>\n");
      write(root, "vendor/export/docx.js", "delivered-docx\n");
      const outputBytes = fs.statSync(path.join(root, "vendor/export/docx.js")).size;
      const outputSha256 = vendorBuildLock.sha256Buffer(
        fs.readFileSync(path.join(root, "vendor/export/docx.js")),
      );
      const lock = {
        schemaVersion: vendorBuildLock.EXACT_COPY_LOCK_SCHEMA_VERSION,
        type: vendorBuildLock.EXACT_COPY_LOCK_TYPE,
        lockId: digest("a"),
        operations: [{
          lockRef: "export.docx.iife",
          method: "byte-for-byte-copy",
          component: {
            name: "docx",
            version: "9.7.1",
            purl: "pkg:npm/docx@9.7.1",
            integrity: "sha512-fixture",
            resolved: "https://registry.npmjs.org/docx/-/docx-9.7.1.tgz",
            lockPath: "node_modules/docx",
          },
          input: {
            path: "dist/index.iife.js",
            bytes: outputBytes,
            sha256: outputSha256,
          },
          auxiliaryInputs: [],
          output: {
            path: "vendor/export/docx.js",
            bytes: outputBytes,
            sha256: outputSha256,
          },
        }],
      };
      const lockFile = write(
        root,
        "vendor/exact-copy-lock.json",
        `${JSON.stringify(lock, null, 2)}\n`,
      );
      const manifest = {
        schemaVersion: 1,
        application: { name: "fixture", version: "1", fingerprint: digest("b") },
        dependencies: { docx: "9.7.1" },
        vendorAssets: [{
          package: "docx",
          path: "vendor/export/docx.js",
          bytes: outputBytes,
          sha256: outputSha256,
        }],
        thirdPartyNotices: {
          path: "vendor/third-party-notices.json",
          sha256: digest("c"),
        },
        data: { fingerprint: digest("d") },
        networkPolicy: { runtimeLibraries: "local-only" },
        fingerprint: digest("e"),
      };
      write(root, "build-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

      const result = binding.bindExactCopyLockToBuildManifest({
        outputRoot: root,
        buildLockResult: {
          lock,
          path: "vendor/exact-copy-lock.json",
          sha256: vendorBuildLock.sha256Buffer(fs.readFileSync(lockFile)),
        },
      });

      expect(result.manifest.vendorExactCopyLock).toEqual(expect.objectContaining({
        operationCount: 1,
        coveredAssetCount: 1,
        assetBindingFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        assetBindings: [{
          lockRef: "export.docx.iife",
          path: "vendor/export/docx.js",
          componentPurl: "pkg:npm/docx@9.7.1",
          inputSha256: outputSha256,
          outputSha256,
        }],
      }));
      expect(result.manifest.vendorAssets[0]).toEqual(expect.objectContaining({
        package: "docx",
        version: "9.7.1",
        purl: "pkg:npm/docx@9.7.1",
        sourcePath: "dist/index.iife.js",
        exactCopy: expect.objectContaining({
          lockRef: "export.docx.iife",
          lockId: lock.lockId,
        }),
      }));
      expect(result.manifest.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(result.manifest.fingerprint).not.toBe(manifest.fingerprint);
      expect(JSON.parse(fs.readFileSync(result.manifestPath, "utf8")))
        .toEqual(result.manifest);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
