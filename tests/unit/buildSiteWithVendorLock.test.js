"use strict";

const path = require("path");
const wrapper = require("../../scripts/build-site-with-vendor-lock");

describe("canonical site build exact-copy manifest integration", () => {
  test("writes the lock and binds it into the build manifest before succeeding", () => {
    const calls = [];
    const initialManifest = { fingerprint: "1".repeat(64) };
    const finalManifest = { fingerprint: "2".repeat(64) };
    const buildLock = {
      path: "vendor/exact-copy-lock.json",
      sha256: "3".repeat(64),
      lock: {
        lockId: "4".repeat(64),
        operations: [{ lockRef: "a" }, { lockRef: "b" }, { lockRef: "c" }],
      },
    };
    const binding = {
      manifest: finalManifest,
      manifestPath: "/repo/_site/build-manifest.json",
      manifestSha256: "5".repeat(64),
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
          calls.push(["bind", options]);
          return binding;
        },
      },
      write(text) {
        output += text;
      },
    });

    expect(calls).toEqual([
      ["parse", ["--output-dir", "_site"]],
      ["build", { root: "/repo", outputDir: "_site" }],
      ["lock", { repoRoot: path.resolve("/repo"), outputRoot: path.resolve("/repo/_site") }],
      ["bind", { outputRoot: path.resolve("/repo/_site"), buildLockResult: buildLock }],
    ]);
    expect(result).toEqual({
      initialManifest,
      manifest: finalManifest,
      buildLock,
      binding,
    });
    expect(output).toContain("3 browser-export assets");
    expect(output).toContain(buildLock.lock.lockId);
    expect(output).toContain(finalManifest.fingerprint);
  });

  test("does not report success or return an unbound manifest when binding fails", () => {
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
        bindExactCopyLockToBuildManifest: () => {
          throw new Error("binding failed");
        },
      },
      write,
    })).toThrow(/binding failed/);
    expect(write).not.toHaveBeenCalled();
  });
});
