"use strict";

const vendorBuildLock = require("../../scripts/vendor-build-lock");
const binding = require("../../scripts/vendor-exact-copy-manifest");

function digest(character) {
  return character.repeat(64);
}

function operation(overrides = {}) {
  return {
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
      bytes: 1234,
      sha256: digest("a"),
    },
    auxiliaryInputs: [
      {
        path: "dist/index.iife.js.map",
        bytes: 321,
        sha256: digest("b"),
      },
    ],
    output: {
      path: "vendor/export/docx.js",
      bytes: 1234,
      sha256: digest("a"),
    },
    ...overrides,
  };
}

function lock(operations = [operation()]) {
  return {
    schemaVersion: vendorBuildLock.EXACT_COPY_LOCK_SCHEMA_VERSION,
    type: vendorBuildLock.EXACT_COPY_LOCK_TYPE,
    lockId: digest("c"),
    operations,
  };
}

function asset(overrides = {}) {
  return {
    package: "docx",
    version: "9.7.1",
    purl: "pkg:npm/docx@9.7.1",
    sourcePath: "dist/index.iife.js",
    path: "vendor/export/docx.js",
    bytes: 1234,
    sha256: digest("a"),
    ...overrides,
  };
}

describe("vendor exact-copy per-asset build-manifest binding", () => {
  test("binds a verified operation to the exact delivered asset", () => {
    const result = binding.bindOperationsToVendorAssets(
      { vendorAssets: [asset(), asset({
        package: "leaflet",
        version: "1.9.4",
        purl: "pkg:npm/leaflet@1.9.4",
        sourcePath: "dist/leaflet.js",
        path: "vendor/leaflet/leaflet.js",
        bytes: 900,
        sha256: digest("d"),
      })] },
      lock(),
    );

    expect(result.bindings).toEqual([{
      lockRef: "export.docx.iife",
      path: "vendor/export/docx.js",
      componentPurl: "pkg:npm/docx@9.7.1",
      inputSha256: digest("a"),
      outputSha256: digest("a"),
    }]);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.vendorAssets[0].exactCopy).toEqual({
      type: "vendor-exact-copy-lock-reference",
      schemaVersion: vendorBuildLock.EXACT_COPY_LOCK_SCHEMA_VERSION,
      lockId: digest("c"),
      lockRef: "export.docx.iife",
      method: "byte-for-byte-copy",
      componentPurl: "pkg:npm/docx@9.7.1",
      input: {
        path: "dist/index.iife.js",
        bytes: 1234,
        sha256: digest("a"),
      },
      auxiliaryInputs: [{
        path: "dist/index.iife.js.map",
        bytes: 321,
        sha256: digest("b"),
      }],
      output: {
        path: "vendor/export/docx.js",
        bytes: 1234,
        sha256: digest("a"),
      },
    });
    expect(result.vendorAssets[1].exactCopy).toBeUndefined();
  });

  test("is deterministic regardless of operation order", () => {
    const pdfOperation = operation({
      lockRef: "export.pdfmake.min",
      component: {
        ...operation().component,
        name: "pdfmake",
        version: "0.3.11",
        purl: "pkg:npm/pdfmake@0.3.11",
      },
      input: {
        path: "build/pdfmake.min.js",
        bytes: 5678,
        sha256: digest("e"),
      },
      auxiliaryInputs: [],
      output: {
        path: "vendor/export/pdfmake.js",
        bytes: 5678,
        sha256: digest("e"),
      },
    });
    const manifest = { vendorAssets: [
      asset(),
      asset({
        package: "pdfmake",
        version: "0.3.11",
        purl: "pkg:npm/pdfmake@0.3.11",
        sourcePath: "build/pdfmake.min.js",
        path: "vendor/export/pdfmake.js",
        bytes: 5678,
        sha256: digest("e"),
      }),
    ] };
    const first = binding.bindOperationsToVendorAssets(
      manifest,
      lock([operation(), pdfOperation]),
    );
    const second = binding.bindOperationsToVendorAssets(
      manifest,
      lock([pdfOperation, operation()]),
    );
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.bindings).toEqual(first.bindings);
  });

  test.each([
    ["package", asset({ package: "wrong" })],
    ["version", asset({ version: "9.8.0" })],
    ["purl", asset({ purl: "pkg:npm/docx@9.8.0" })],
    ["sourcePath", asset({ sourcePath: "dist/other.js" })],
    ["bytes", asset({ bytes: 1235 })],
    ["sha256", asset({ sha256: digest("f") })],
  ])("fails closed on %s drift", (_field, changedAsset) => {
    expect(() => binding.bindOperationsToVendorAssets(
      { vendorAssets: [changedAsset] },
      lock(),
    )).toThrow(/vendor_asset_drift/);
  });

  test("fails when a lock output is missing from the delivered asset inventory", () => {
    expect(() => binding.bindOperationsToVendorAssets(
      { vendorAssets: [] },
      lock(),
    )).toThrow(/missing_vendor_asset/);
  });

  test("rejects duplicate asset paths, lock refs and output paths", () => {
    expect(() => binding.bindOperationsToVendorAssets(
      { vendorAssets: [asset(), asset()] },
      lock(),
    )).toThrow(/duplicate_vendor_asset/);

    expect(() => binding.bindOperationsToVendorAssets(
      { vendorAssets: [asset()] },
      lock([operation(), operation()]),
    )).toThrow(/duplicate_lock_ref/);

    expect(() => binding.bindOperationsToVendorAssets(
      { vendorAssets: [asset()] },
      lock([operation(), operation({ lockRef: "other.ref" })]),
    )).toThrow(/duplicate_lock_output/);
  });

  test("keeps historical minimal manifest fixtures compatible when no asset inventory exists", () => {
    expect(binding.bindOperationsToVendorAssets({}, lock())).toEqual({
      vendorAssets: null,
      bindings: [],
      fingerprint: null,
    });
  });
});
