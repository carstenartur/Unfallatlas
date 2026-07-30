"use strict";

const vendorBuildLock = require("../../scripts/vendor-build-lock");
const binding = require("../../scripts/vendor-exact-copy-manifest");

function digest(character) {
  return character.repeat(64);
}

describe("vendor exact-copy drift diagnostics", () => {
  test("reports dependency-version and optional asset-version drift independently", () => {
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
        },
        input: {
          path: "dist/index.iife.js",
          bytes: 1234,
          sha256: digest("b"),
        },
        auxiliaryInputs: [],
        output: {
          path: "vendor/export/docx.js",
          bytes: 1234,
          sha256: digest("b"),
        },
      }],
    };
    const manifest = {
      dependencies: { docx: "9.8.0" },
      vendorAssets: [{
        package: "docx",
        version: "9.9.0",
        path: "vendor/export/docx.js",
        bytes: 1234,
        sha256: digest("b"),
      }],
    };

    let error;
    try {
      binding.bindOperationsToVendorAssets(manifest, lock);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(binding.VendorExactCopyManifestError);
    expect(error.code).toBe("vendor_asset_drift");
    expect(error.details.mismatches).toEqual({
      dependencyVersion: { expected: "9.7.1", actual: "9.8.0" },
      assetVersion: { expected: "9.7.1", actual: "9.9.0" },
    });
  });
});
