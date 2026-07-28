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

describe("hidden Unicode review boundaries", () => {
  const roots = [];

  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
  });

  test("recognizes common configuration dotfiles as text", () => {
    expect(unicode.shouldScan(".gitignore")).toBe(true);
    expect(unicode.shouldScan("config/.env")).toBe(true);
    expect(unicode.shouldScan(".gitattributes")).toBe(true);
  });

  test("allows a BOM only at the start of file content, never in paths", () => {
    expect(unicode.scanText("\uFEFFcontent", "content.txt")).toEqual([]);
    expect(
      unicode.scanText("\uFEFFname.js", "<file-name>", {
        allowLeadingBom: false,
      }),
    ).toEqual([
      expect.objectContaining({
        index: 0,
        line: 1,
        column: 1,
        codePoint: "U+FEFF",
      }),
    ]);
  });

  test("finds hidden controls inside dotfiles during repository scans", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ua-unicode-dotfile-"));
    roots.push(root);
    write(root, ".gitignore", "target/\u2066hidden\n");
    const findings = unicode.scanRepository(root);
    expect(findings).toEqual([
      expect.objectContaining({
        path: ".gitignore",
        codePoint: "U+2066",
        reason: "LEFT-TO-RIGHT ISOLATE",
      }),
    ]);
  });

  test("tracks many findings in one linear pass with exact positions", () => {
    const count = 2000;
    const text = `${"\u200B".repeat(count)}\n${"\u2066".repeat(count)}`;
    const findings = unicode.scanText(text, "many.txt");
    expect(findings).toHaveLength(count * 2);
    expect(findings[0]).toEqual(
      expect.objectContaining({ line: 1, column: 1, codePoint: "U+200B" }),
    );
    expect(findings[count - 1]).toEqual(
      expect.objectContaining({ line: 1, column: count, codePoint: "U+200B" }),
    );
    expect(findings[count]).toEqual(
      expect.objectContaining({ line: 2, column: 1, codePoint: "U+2066" }),
    );
    expect(findings.at(-1)).toEqual(
      expect.objectContaining({ line: 2, column: count, codePoint: "U+2066" }),
    );
  });
});
