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

describe("hidden Unicode safety gate", () => {
  const roots = [];

  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
  });

  test("reports bidi overrides, invisible separators and exact positions", () => {
    const findings = unicode.scanText(
      "safe\nconst role = 'user';\u202E // hidden\nA\u200BB",
      "fixture.js",
    );
    expect(findings).toEqual([
      expect.objectContaining({
        path: "fixture.js",
        line: 2,
        column: 21,
        codePoint: "U+202E",
        reason: "RIGHT-TO-LEFT OVERRIDE",
      }),
      expect.objectContaining({
        path: "fixture.js",
        line: 3,
        column: 2,
        codePoint: "U+200B",
        reason: "ZERO WIDTH SPACE",
      }),
    ]);
  });

  test("allows a single UTF-8 BOM only at the start of a file", () => {
    expect(unicode.scanText("\uFEFFnormal", "bom.txt")).toEqual([]);
    expect(unicode.scanText("normal\uFEFFhidden", "bom.txt")).toEqual([
      expect.objectContaining({ codePoint: "U+FEFF", line: 1, column: 7 }),
    ]);
  });

  test("scans source/config files and ignores generated or binary trees", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ua-unicode-"));
    roots.push(root);
    write(root, "src/good.js", "const value = 'sichtbar';\n");
    write(root, "src/bad.yml", "role: user\u2066admin\n");
    write(root, "node_modules/ignored.js", "\u202E\n");
    write(root, "out/ignored.json", "\u200B\n");
    write(root, "assets/image.png", Buffer.from([0, 1, 2, 3]));

    const findings = unicode.scanRepository(root);
    expect(findings).toEqual([
      expect.objectContaining({
        path: "src/bad.yml",
        codePoint: "U+2066",
        reason: "LEFT-TO-RIGHT ISOLATE",
      }),
    ]);
  });

  test("rejects invalid UTF-8 in files declared as text", () => {
    expect(() => unicode.decodeUtf8(Buffer.from([0xc3, 0x28]), "broken.js")).toThrow(
      /invalid_utf8/,
    );
  });

  test("keeps ordinary German text, punctuation and emoji visible and valid", () => {
    const text = "Straßenlängsneigung – geprüft: äöü ÄÖÜ ß 🚲 ✅\n";
    expect(unicode.scanText(text, "docs/example.md")).toEqual([]);
  });

  test("the repository contains no dangerous hidden Unicode controls", () => {
    const root = path.resolve(__dirname, "../..");
    const findings = unicode.scanRepository(root);
    expect(findings).toEqual([]);
  });
});
