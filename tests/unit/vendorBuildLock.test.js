"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const buildLock = require("../../scripts/vendor-build-lock");

function writeFile(root, relative, contents) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function writeJson(root, relative, value) {
  return writeFile(root, relative, `${JSON.stringify(value, null, 2)}\n`);
}

function recipe() {
  return {
    schemaVersion: 1,
    type: "unfallatlas-vendor-build-recipe",
    recipeId: "test-copy-lock-v1",
    packageLock: "package-lock.json",
    packageManager: "npm@11.9.0",
    operations: [
      {
        lockRef: "export.docx.iife",
        package: "docx",
        expectedVersion: "9.7.1",
        sourcePath: "dist/index.iife.js",
        outputPath: "vendor/export/docx.js",
        method: "byte-for-byte-copy",
      },
      {
        lockRef: "export.pdfmake.min",
        package: "pdfmake",
        expectedVersion: "0.3.11",
        sourcePath: "build/pdfmake.min.js",
        outputPath: "vendor/export/pdfmake.js",
        method: "byte-for-byte-copy",
        auxiliaryInputs: ["build/pdfmake.min.js.map"],
      },
    ],
    knownGaps: [
      "Upstream bundles are not yet decomposed into every transitive module.",
    ],
  };
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ua-vendor-lock-"));
  const outputRoot = path.join(root, "_site");
  fs.mkdirSync(outputRoot, { recursive: true });
  writeJson(root, "package-lock.json", {
    name: "fixture",
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture" },
      "node_modules/docx": {
        version: "9.7.1",
        resolved: "https://registry.npmjs.org/docx/-/docx-9.7.1.tgz",
        integrity: "sha512-docx-fixture",
      },
      "node_modules/pdfmake": {
        version: "0.3.11",
        resolved: "https://registry.npmjs.org/pdfmake/-/pdfmake-0.3.11.tgz",
        integrity: "sha512-pdfmake-fixture",
      },
    },
  });
  writeJson(root, "vendor/build-lock.recipe.json", recipe());
  writeJson(root, "node_modules/docx/package.json", {
    name: "docx",
    version: "9.7.1",
  });
  writeJson(root, "node_modules/pdfmake/package.json", {
    name: "pdfmake",
    version: "0.3.11",
  });
  writeFile(root, "node_modules/docx/dist/index.iife.js", "docx-browser-bytes\n");
  writeFile(
    root,
    "node_modules/pdfmake/build/pdfmake.min.js",
    "pdfmake-browser-bytes\n",
  );
  writeFile(
    root,
    "node_modules/pdfmake/build/pdfmake.min.js.map",
    '{"version":3}\n',
  );
  writeFile(outputRoot, "vendor/export/docx.js", "docx-browser-bytes\n");
  writeFile(
    outputRoot,
    "vendor/export/pdfmake.js",
    "pdfmake-browser-bytes\n",
  );
  return { root, outputRoot };
}

describe("vendor build lock pilot", () => {
  let fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("normalizes the checked-in browser-export recipe", () => {
    const value = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "../../vendor/build-lock.recipe.json"),
        "utf8",
      ),
    );
    const normalized = buildLock.normalizeRecipe(value);
    expect(normalized.recipeId).toBe("browser-export-exact-copy-pilot-v1");
    expect(normalized.operations.map((operation) => operation.lockRef)).toEqual([
      "export.docx.iife",
      "export.pdfmake.min",
      "export.pdfmake.font-container",
    ]);
    expect(normalized.knownGaps).toHaveLength(3);
  });

  test("binds package-lock metadata, package inputs and delivered bytes deterministically", () => {
    const first = buildLock.createBuildLock({
      repoRoot: fixture.root,
      outputRoot: fixture.outputRoot,
    });
    const second = buildLock.createBuildLock({
      repoRoot: fixture.root,
      outputRoot: fixture.outputRoot,
    });

    expect(second).toEqual(first);
    expect(first.type).toBe("unfallatlas-vendor-build-lock");
    expect(first.lockId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.operations).toHaveLength(2);
    expect(first.operations[0]).toEqual(
      expect.objectContaining({
        lockRef: "export.docx.iife",
        method: "byte-for-byte-copy",
        component: expect.objectContaining({
          name: "docx",
          version: "9.7.1",
          purl: "pkg:npm/docx@9.7.1",
          integrity: "sha512-docx-fixture",
        }),
        input: expect.objectContaining({
          path: "dist/index.iife.js",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        output: expect.objectContaining({
          path: "vendor/export/docx.js",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
    expect(first.operations[0].input.sha256).toBe(
      first.operations[0].output.sha256,
    );
    expect(first.operations[1].auxiliaryInputs).toEqual([
      expect.objectContaining({
        path: "build/pdfmake.min.js.map",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
  });

  test("creates strict references for delivered assets", () => {
    const lock = buildLock.createBuildLock({
      repoRoot: fixture.root,
      outputRoot: fixture.outputRoot,
    });
    expect(buildLock.buildLockReference(lock, "export.pdfmake.min")).toEqual({
      type: "vendor-build-lock-reference",
      schemaVersion: 1,
      lockId: lock.lockId,
      lockRef: "export.pdfmake.min",
    });
    expect(() => buildLock.buildLockReference(lock, "missing.ref")).toThrow(
      /unknown_lock_ref/,
    );
  });

  test("writes the generated attestation inside the built site", () => {
    const result = buildLock.writeBuildLock({
      repoRoot: fixture.root,
      outputRoot: fixture.outputRoot,
    });
    const written = path.join(fixture.outputRoot, result.path);
    expect(fs.existsSync(written)).toBe(true);
    expect(result.sha256).toBe(buildLock.sha256Buffer(fs.readFileSync(written)));
    expect(JSON.parse(fs.readFileSync(written, "utf8")).lockId).toBe(
      result.lock.lockId,
    );
  });

  test("fails when delivered bytes drift from the exact locked package input", () => {
    writeFile(fixture.outputRoot, "vendor/export/docx.js", "mutated\n");
    expect(() =>
      buildLock.createBuildLock({
        repoRoot: fixture.root,
        outputRoot: fixture.outputRoot,
      }),
    ).toThrow(/output_drift/);
  });

  test("fails when package-lock metadata is incomplete or version-drifted", () => {
    const lock = JSON.parse(
      fs.readFileSync(path.join(fixture.root, "package-lock.json"), "utf8"),
    );
    delete lock.packages["node_modules/docx"].integrity;
    writeJson(fixture.root, "package-lock.json", lock);
    expect(() =>
      buildLock.createBuildLock({
        repoRoot: fixture.root,
        outputRoot: fixture.outputRoot,
      }),
    ).toThrow(/missing_locked_package/);

    lock.packages["node_modules/docx"].integrity = "sha512-restored";
    lock.packages["node_modules/docx"].version = "9.8.0";
    writeJson(fixture.root, "package-lock.json", lock);
    expect(() =>
      buildLock.createBuildLock({
        repoRoot: fixture.root,
        outputRoot: fixture.outputRoot,
      }),
    ).toThrow(/version_mismatch/);
  });

  test("rejects duplicate outputs and traversal in the checked-in recipe", () => {
    const duplicate = recipe();
    duplicate.operations[1].outputPath = duplicate.operations[0].outputPath;
    expect(() => buildLock.normalizeRecipe(duplicate)).toThrow(/invalid_output/);

    const escaping = recipe();
    escaping.operations[0].sourcePath = "../secrets.js";
    expect(() => buildLock.normalizeRecipe(escaping)).toThrow(/unsafe_path/);
  });

  test("rejects symlinked package inputs", () => {
    const outside = writeFile(fixture.root, "outside.js", "outside\n");
    const source = path.join(
      fixture.root,
      "node_modules/docx/dist/index.iife.js",
    );
    fs.rmSync(source);
    fs.symlinkSync(outside, source);
    expect(() =>
      buildLock.createBuildLock({
        repoRoot: fixture.root,
        outputRoot: fixture.outputRoot,
      }),
    ).toThrow(/unsafe_path/);
  });
});
