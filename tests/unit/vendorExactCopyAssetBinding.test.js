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
    path: "vendor/export/docx.js",
    bytes: 1234,
    sha256: digest("a"),
    ...overrides,
  };
}

function enrichedAsset(overrides = {}) {
  return asset({
    version: "9.7.1",
    purl: "pkg:npm/docx@9.7.1",
    sourcePath: "dist/index.iife.js",
    ...overrides,
  });
}

function manifest(vendorAssets, dependencies = {}) {
  return {
    dependencies: {
      docx: "9.7.1",
      leaflet: "1.9.4",
      pdfmake: "0.3.11",
      ...dependencies,
    },
    vendorAssets,
  };
}

describe("vendor exact-copy per-asset build-manifest binding", () => {
  test("binds the real minimal asset inventory and enriches it with verified lock metadata", () => {
    const result = binding.bindOperationsToVendorAssets(
      manifest([
        asset(),
        asset({
          package: "leaflet",
          path: "vendor/leaflet/leaflet.js",
          bytes: 900,
          sha256: digest("d"),
        }),
      ]),
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
    expect(result.vendorAssets[0]).toEqual(expect.objectContaining({
      package: "docx",
      version: "9.7.1",
      purl: "pkg:npm/docx@9.7.1",
      sourcePath: "dist/index.iife.js",
      exactCopy: {
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
      },
    }));
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
    const value = manifest([
      asset(),
      asset({
        package: "pdfmake",
        path: "vendor/export/pdfmake.js",
        bytes: 5678,
        sha256: digest("e"),
      }),
    ]);
    const first = binding.bindOperationsToVendorAssets(
      value,
      lock([operation(), pdfOperation]),
    );
    const second = binding.bindOperationsToVendorAssets(
      value,
      lock([pdfOperation, operation()]),
    );
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.bindings).toEqual(first.bindings);
  });

  test.each([
    ["package", enrichedAsset({ package: "wrong" }), { wrong: "9.7.1" }],
    ["version", enrichedAsset({ version: "9.8.0" }), {}],
    ["purl", enrichedAsset({ purl: "pkg:npm/docx@9.8.0" }), {}],
    ["sourcePath", enrichedAsset({ sourcePath: "dist/other.js" }), {}],
    ["bytes", enrichedAsset({ bytes: 1235 }), {}],
    ["sha256", enrichedAsset({ sha256: digest("f") }), {}],
  ])("fails closed on %s drift", (_field, changedAsset, dependencies) => {
    expect(() => binding.bindOperationsToVendorAssets(
      manifest([changedAsset], dependencies),
      lock(),
    )).toThrow(/vendor_asset_drift/);
  });

  test("fails when package-lock dependencies disagree with the operation version", () => {
    expect(() => binding.bindOperationsToVendorAssets(
      manifest([asset()], { docx: "9.8.0" }),
      lock(),
    )).toThrow(/vendor_asset_drift/);
  });

  test.each([
    ["bytes", operation({ input: { ...operation().input, bytes: 1235 } })],
    ["sha256", operation({ input: { ...operation().input, sha256: digest("f") } })],
  ])("rejects a non-exact copy operation with different input %s", (_field, changedOperation) => {
    expect(() => binding.bindOperationsToVendorAssets(
      manifest([asset()]),
      lock([changedOperation]),
    )).toThrow(/vendor_asset_drift/);
  });

  test("fails when a lock output is missing from the delivered asset inventory", () => {
    expect(() => binding.bindOperationsToVendorAssets(
      manifest([]),
      lock(),
    )).toThrow(/missing_vendor_asset/);
  });

  test("rejects duplicate asset paths, lock refs and output paths", () => {
    expect(() => binding.bindOperationsToVendorAssets(
      manifest([asset(), asset()]),
      lock(),
    )).toThrow(/duplicate_vendor_asset/);

    expect(() => binding.bindOperationsToVendorAssets(
      manifest([asset()]),
      lock([operation(), operation()]),
    )).toThrow(/duplicate_lock_ref/);

    expect(() => binding.bindOperationsToVendorAssets(
      manifest([asset()]),
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
