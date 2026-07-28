"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const unicode = require("../../scripts/check-hidden-unicode");

function write(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
  return file;
}

function baseline(pathName, count) {
  return {
    schemaVersion: 1,
    allowances: [{ path: pathName, codePoint: "U+00AD", count }],
  };
}

describe("hidden Unicode soft-hyphen baseline", () => {
  const roots = [];

  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
  });

  test("classifies content soft hyphens as reviewable but path soft hyphens as forbidden", () => {
    expect(unicode.scanText("auto\u00admatisch", "docs/text.md")).toEqual([
      expect.objectContaining({
        codePoint: "U+00AD",
        category: "reviewable",
        reason: "SOFT HYPHEN",
      }),
    ]);
    expect(
      unicode.scanText("bad\u00adname.js", "<file-name>", {
        allowLeadingBom: false,
        pathScan: true,
      }),
    ).toEqual([
      expect.objectContaining({
        codePoint: "U+00AD",
        category: "forbidden",
        reason: "SOFT HYPHEN IN PATH",
      }),
    ]);
  });

  test("accepts only the exact reviewed content count", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ua-unicode-baseline-"));
    roots.push(root);
    write(root, "docs/text.md", "auto\u00admatisch\n");
    write(
      root,
      unicode.BASELINE_RELATIVE_PATH,
      `${JSON.stringify(baseline("docs/text.md", 1), null, 2)}\n`,
    );
    expect(unicode.scanRepository(root)).toEqual([]);

    write(root, "docs/text.md", "auto\u00admatisch und sicher\u00adheitsrelevant\n");
    expect(unicode.scanRepository(root)).toEqual([
      expect.objectContaining({
        path: "docs/text.md",
        codePoint: "U+00AD",
        category: "baseline-excess",
        baselineExpected: 1,
        baselineActual: 2,
      }),
    ]);
  });

  test("fails on stale allowances after a reviewed soft hyphen is removed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ua-unicode-stale-"));
    roots.push(root);
    write(root, "docs/text.md", "automatic\n");
    write(
      root,
      unicode.BASELINE_RELATIVE_PATH,
      `${JSON.stringify(baseline("docs/text.md", 1), null, 2)}\n`,
    );
    expect(unicode.scanRepository(root)).toEqual([
      expect.objectContaining({
        path: "docs/text.md",
        codePoint: "U+00AD",
        category: "stale-baseline",
        baselineExpected: 1,
        baselineActual: 0,
      }),
    ]);
  });

  test("rejects unsupported baseline fields, duplicate entries and code points", () => {
    expect(() =>
      unicode.normalizeBaseline({
        schemaVersion: 1,
        allowances: [],
        trustMe: true,
      }),
    ).toThrow(/invalid_baseline_fields/);
    expect(() =>
      unicode.normalizeBaseline({
        schemaVersion: 1,
        allowances: [
          { path: "one.md", codePoint: "U+200B", count: 1 },
        ],
      }),
    ).toThrow(/unsupported_baseline_code_point/);
    expect(() =>
      unicode.normalizeBaseline({
        schemaVersion: 1,
        allowances: [
          { path: "one.md", codePoint: "U+00AD", count: 1 },
          { path: "one.md", codePoint: "U+00AD", count: 1 },
        ],
      }),
    ).toThrow(/duplicate_baseline_entry/);
  });
});
