"use strict";

const path = require("path");
const wrapper = require("../../scripts/build-site-with-vendor-lock");

describe("canonical site build exact-copy provenance integration", () => {
  test("binds lock, manifest, notices and CycloneDX before succeeding", () => {
    const calls = [];
    const initialManifest = { fingerprint: "1".repeat(64) };
    const manifestBound = { fingerprint: "2".repeat(64) };
    const finalManifest = { fingerprint: "6".repeat(64) };
    const buildLock = {
      path: "vendor/exact-copy-lock.json",
      sha256: "3".repeat(64),
      lock: {
        lockId: "4".repeat(64),
        operations: [{ lockRef: "a" }, { lockRef: "b" }, { lockRef: "c" }],
      },
    };
    const binding = {
      manifest: manifestBound,
      manifestPath: "/repo/_site/build-manifest.json",
      manifestSha256: "5".repeat(64),
    };
    const provenanceBinding = {
      manifest: finalManifest,
      manifestPath: "/repo/_site/build-manifest.json",
      manifestSha256: "7".repeat(64),
      bindingCount: 3,
    };
    let output = "";

    const result = wrapper.main(["--output-dir", "_site"], {
      siteBuild: {
        parseArgs(argv) {
          calls.push(["parse", argv]);
          return { root: "/repo", outputDir: "_site" };
        },
        buildSite(args) {
          calls.push(["build", args]);
          return initialManifest;
        },
      },
      vendorBuildLock: {
        writeBuildLock(options) {
          calls.push(["lock", options]);
          return buildLock;
        },
      },
      vendorExactCopyManifest: {
        bindExactCopyLockToBuildManifest(options) {
          calls.push(["bind-manifest", options]);
          return binding;
        },
      },
      vendorExactCopyProvenance: {
        bindExactCopyProvenance(options) {
          calls.push(["bind-provenance", options]);
          return provenanceBinding;
        },
      },
      write(text) {
        output += text;
      },
    });

    const outputRoot = path.resolve("/repo/_site");
    expect(calls).toEqual([
      ["parse", ["--output-dir", "_site"]],
      ["build", { root: "/repo", outputDir: "_site" }],
      ["lock", { repoRoot: path.resolve("/repo"), outputRoot }],
      ["bind-manifest", { outputRoot, buildLockResult: buildLock }],
      ["bind-provenance", { outputRoot }],
    ]);
    expect(result).toEqual({
      initialManifest,
      manifest: finalManifest,
      buildLock,
      binding,
      provenanceBinding,
    });
    expect(output).toContain("3 browser-export assets");
    expect(output).toContain(buildLock.lock.lockId);
    expect(output).toContain("notices and CycloneDX");
    expect(output).toContain(finalManifest.fingerprint);
  });

  test("does not run the provenance stage when manifest binding fails", () => {
    const write = jest.fn();
    const provenance = jest.fn();
    expect(() => wrapper.main([], {
      siteBuild: {
        parseArgs: () => ({ root: "/repo", outputDir: "_site" }),
        buildSite: () => ({ fingerprint: "1".repeat(64) }),
      },
      vendorBuildLock: {
        writeBuildLock: () => ({
          path: "vendor/exact-copy-lock.json",
          sha256: "2".repeat(64),
          lock: { lockId: "3".repeat(64), operations: [] },
        }),
      },
      vendorExactCopyManifest: {
        bindExactCopyLockToBuildManifest: () => {
          throw new Error("binding failed");
        },
      },
      vendorExactCopyProvenance: { bindExactCopyProvenance: provenance },
      write,
    })).toThrow(/binding failed/);
    expect(provenance).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  test("does not report success when notice or SBOM propagation fails", () => {
    const write = jest.fn();
    expect(() => wrapper.main([], {
      siteBuild: {
        parseArgs: () => ({ root: "/repo", outputDir: "_site" }),
        buildSite: () => ({ fingerprint: "1".repeat(64) }),
      },
      vendorBuildLock: {
        writeBuildLock: () => ({
          path: "vendor/exact-copy-lock.json",
          sha256: "2".repeat(64),
          lock: { lockId: "3".repeat(64), operations: [] },
        }),
      },
      vendorExactCopyManifest: {
        bindExactCopyLockToBuildManifest: () => ({ manifest: { fingerprint: "4".repeat(64) } }),
      },
      vendorExactCopyProvenance: {
        bindExactCopyProvenance: () => {
          throw new Error("SBOM binding failed");
        },
      },
      write,
    })).toThrow(/SBOM binding failed/);
    expect(write).not.toHaveBeenCalled();
  });
});
