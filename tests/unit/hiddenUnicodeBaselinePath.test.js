"use strict";

const unicode = require("../../scripts/check-hidden-unicode");

describe("hidden Unicode baseline path confinement", () => {
  test.each([
    "../outside.md",
    "docs/../outside.md",
    "docs/./inside.md",
    "docs//inside.md",
    "/absolute.md",
    "C:\\absolute.md",
    ".",
    "..",
  ])("rejects unsafe baseline path %s", (filePath) => {
    expect(() =>
      unicode.normalizeBaseline({
        schemaVersion: 1,
        allowances: [
          { path: filePath, codePoint: "U+00AD", count: 1 },
        ],
      }),
    ).toThrow(/invalid_baseline_path/);
  });

  test("normalizes Windows separators for a repository-relative path", () => {
    expect(
      unicode.normalizeRepositoryRelativePath(
        "docs\\nested\\text.md",
        "allowance.path",
      ),
    ).toBe("docs/nested/text.md");
  });
});
