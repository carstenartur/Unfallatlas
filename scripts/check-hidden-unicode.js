#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { TextDecoder } = require("util");

const BASELINE_SCHEMA_VERSION = 1;
const BASELINE_RELATIVE_PATH = "security/hidden-unicode-baseline.json";

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".build",
  ".idea",
  ".vscode",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "_site",
]);

const TEXT_EXTENSIONS = new Set([
  "",
  ".cjs",
  ".conf",
  ".css",
  ".csv",
  ".env",
  ".gitattributes",
  ".gitignore",
  ".graphql",
  ".htm",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".md",
  ".mjs",
  ".properties",
  ".sh",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const NAMED_DANGEROUS_CODE_POINTS = new Map([
  [0x034f, "COMBINING GRAPHEME JOINER"],
  [0x061c, "ARABIC LETTER MARK"],
  [0x180e, "MONGOLIAN VOWEL SEPARATOR"],
  [0x200b, "ZERO WIDTH SPACE"],
  [0x200c, "ZERO WIDTH NON-JOINER"],
  [0x200d, "ZERO WIDTH JOINER"],
  [0x200e, "LEFT-TO-RIGHT MARK"],
  [0x200f, "RIGHT-TO-LEFT MARK"],
  [0x202a, "LEFT-TO-RIGHT EMBEDDING"],
  [0x202b, "RIGHT-TO-LEFT EMBEDDING"],
  [0x202c, "POP DIRECTIONAL FORMATTING"],
  [0x202d, "LEFT-TO-RIGHT OVERRIDE"],
  [0x202e, "RIGHT-TO-LEFT OVERRIDE"],
  [0x2060, "WORD JOINER"],
  [0x2061, "FUNCTION APPLICATION"],
  [0x2062, "INVISIBLE TIMES"],
  [0x2063, "INVISIBLE SEPARATOR"],
  [0x2064, "INVISIBLE PLUS"],
  [0x2066, "LEFT-TO-RIGHT ISOLATE"],
  [0x2067, "RIGHT-TO-LEFT ISOLATE"],
  [0x2068, "FIRST STRONG ISOLATE"],
  [0x2069, "POP DIRECTIONAL ISOLATE"],
  [0xfeff, "ZERO WIDTH NO-BREAK SPACE/BOM"],
]);

const REVIEWABLE_CODE_POINTS = new Map([[0x00ad, "SOFT HYPHEN"]]);

class HiddenUnicodePolicyError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = "HiddenUnicodePolicyError";
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new HiddenUnicodePolicyError(code, message, details);
}

function codePointLabel(codePoint) {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

function dangerousCodePoint(codePoint, options = {}) {
  if (codePoint === 0xfeff && options.allowBomAtStart === true) return null;
  if (NAMED_DANGEROUS_CODE_POINTS.has(codePoint)) {
    return NAMED_DANGEROUS_CODE_POINTS.get(codePoint);
  }
  if (codePoint >= 0x202a && codePoint <= 0x202e) return "BIDI FORMAT CONTROL";
  if (codePoint >= 0x2066 && codePoint <= 0x2069) return "BIDI ISOLATE CONTROL";
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return "UNICODE TAG CHARACTER";
  if (
    (codePoint >= 0 && codePoint <= 0x08 && codePoint !== 0x09) ||
    codePoint === 0x0b ||
    codePoint === 0x0c ||
    (codePoint >= 0x0e && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f)
  ) {
    return "CONTROL CHARACTER";
  }
  return null;
}

function classifyCodePoint(codePoint, options = {}) {
  const forbidden = dangerousCodePoint(codePoint, options);
  if (forbidden) return { category: "forbidden", reason: forbidden };
  if (REVIEWABLE_CODE_POINTS.has(codePoint)) {
    return {
      category: options.pathScan ? "forbidden" : "reviewable",
      reason: options.pathScan
        ? `${REVIEWABLE_CODE_POINTS.get(codePoint)} IN PATH`
        : REVIEWABLE_CODE_POINTS.get(codePoint),
    };
  }
  return null;
}

function scanText(text, relativePath, options = {}) {
  const findings = [];
  const allowLeadingBom = options.allowLeadingBom !== false;
  const pathScan = options.pathScan === true;
  let line = 1;
  let column = 1;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index);
    const width = codePoint > 0xffff ? 2 : 1;
    const classification = classifyCodePoint(codePoint, {
      allowBomAtStart: allowLeadingBom && index === 0,
      pathScan,
    });
    if (classification) {
      findings.push({
        path: relativePath,
        index,
        line,
        column,
        codePoint: codePointLabel(codePoint),
        category: classification.category,
        reason: classification.reason,
      });
    }
    if (codePoint === 0x0a) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    index += width;
  }
  return findings;
}

function shouldScan(relativePath) {
  const base = path.basename(relativePath);
  if (["Dockerfile", "Jenkinsfile", "LICENSE", "NOTICE"].includes(base)) {
    return true;
  }
  const lowerBase = base.toLowerCase();
  if (TEXT_EXTENSIONS.has(lowerBase)) return true;
  return TEXT_EXTENSIONS.has(path.extname(lowerBase));
}

function listTextFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, "/");
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && shouldScan(relative)) files.push({ absolute, relative });
    }
  };
  visit(root);
  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

function decodeUtf8(buffer, relativePath) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    const wrapped = new Error(`invalid_utf8: ${relativePath} is not valid UTF-8`);
    wrapped.code = "invalid_utf8";
    wrapped.cause = error;
    throw wrapped;
  }
}

function normalizeRepositoryRelativePath(value, label) {
  const original = String(value || "");
  const normalized = original.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.includes("\0") ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(original) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    fail("invalid_baseline_path", `${label} must be a normalized repository-relative path`, {
      value,
    });
  }
  return normalized;
}

function normalizeBaseline(value) {
  const actual = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  const expected = ["allowances", "schemaVersion"].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("invalid_baseline_fields", "hidden Unicode baseline has invalid fields", {
      actual,
      expected,
    });
  }
  if (Number(value.schemaVersion) !== BASELINE_SCHEMA_VERSION) {
    fail(
      "unsupported_baseline_schema",
      `baseline.schemaVersion must be ${BASELINE_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(value.allowances)) {
    fail("invalid_baseline", "baseline.allowances must be an array");
  }
  const seen = new Set();
  const allowances = value.allowances.map((entry, index) => {
    const label = `baseline.allowances[${index}]`;
    const fields = entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.keys(entry).sort()
      : [];
    const required = ["codePoint", "count", "path"].sort();
    if (JSON.stringify(fields) !== JSON.stringify(required)) {
      fail("invalid_baseline_fields", `${label} has invalid fields`, {
        fields,
        required,
      });
    }
    const filePath = normalizeRepositoryRelativePath(entry.path, `${label}.path`);
    if (entry.codePoint !== "U+00AD") {
      fail("unsupported_baseline_code_point", `${label}.codePoint must be U+00AD`);
    }
    const count = Number(entry.count);
    if (!Number.isInteger(count) || count <= 0) {
      fail("invalid_baseline_count", `${label}.count must be a positive integer`);
    }
    const key = `${filePath}\0${entry.codePoint}`;
    if (seen.has(key)) fail("duplicate_baseline_entry", `${label} duplicates ${key}`);
    seen.add(key);
    return Object.freeze({ path: filePath, codePoint: entry.codePoint, count });
  });
  return Object.freeze({
    schemaVersion: BASELINE_SCHEMA_VERSION,
    allowances: Object.freeze(allowances.sort((left, right) =>
      left.path.localeCompare(right.path) || left.codePoint.localeCompare(right.codePoint))),
  });
}

function loadBaseline(root, baselineRelativePath = BASELINE_RELATIVE_PATH) {
  const file = path.resolve(root, baselineRelativePath);
  if (!fs.existsSync(file)) {
    return Object.freeze({ schemaVersion: BASELINE_SCHEMA_VERSION, allowances: Object.freeze([]) });
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail("invalid_baseline_json", "hidden Unicode baseline is not valid JSON", {
      file,
      message: error.message,
    });
  }
  return normalizeBaseline(value);
}

function applyReviewBaseline(findings, baseline) {
  const violations = findings.filter((finding) => finding.category === "forbidden");
  const reviewable = findings.filter((finding) => finding.category === "reviewable");
  const actualByKey = new Map();
  for (const finding of reviewable) {
    const key = `${finding.path}\0${finding.codePoint}`;
    if (!actualByKey.has(key)) actualByKey.set(key, []);
    actualByKey.get(key).push(finding);
  }
  const expectedByKey = new Map(
    baseline.allowances.map((entry) => [`${entry.path}\0${entry.codePoint}`, entry]),
  );
  const keys = new Set([...actualByKey.keys(), ...expectedByKey.keys()]);
  for (const key of [...keys].sort()) {
    const actual = actualByKey.get(key) || [];
    const expected = expectedByKey.get(key);
    const expectedCount = expected ? expected.count : 0;
    if (actual.length === expectedCount) continue;
    if (actual.length > expectedCount) {
      for (const finding of actual.slice(expectedCount)) {
        violations.push({
          ...finding,
          category: "baseline-excess",
          reason: `${finding.reason} exceeds baseline (${actual.length} present, ${expectedCount} allowed)`,
          baselineExpected: expectedCount,
          baselineActual: actual.length,
        });
      }
    } else {
      const [filePath, codePoint] = key.split("\0");
      violations.push({
        path: filePath,
        index: 0,
        line: 1,
        column: 1,
        codePoint,
        category: "stale-baseline",
        reason: `baseline expects ${expectedCount} occurrences but repository contains ${actual.length}`,
        baselineExpected: expectedCount,
        baselineActual: actual.length,
      });
    }
  }
  return violations.sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.column - right.column ||
    left.codePoint.localeCompare(right.codePoint));
}

function scanRepository(rootValue, options = {}) {
  const root = fs.realpathSync(path.resolve(rootValue));
  const findings = [];
  for (const segment of path.relative(path.parse(root).root, root).split(path.sep)) {
    findings.push(
      ...scanText(segment, `<repository-path>/${segment}`, {
        allowLeadingBom: false,
        pathScan: true,
      }),
    );
  }
  for (const file of listTextFiles(root)) {
    findings.push(
      ...scanText(file.relative, `<file-name>/${file.relative}`, {
        allowLeadingBom: false,
        pathScan: true,
      }),
    );
    const buffer = fs.readFileSync(file.absolute);
    if (buffer.includes(0)) continue;
    const text = decodeUtf8(buffer, file.relative);
    findings.push(
      ...scanText(text, file.relative, {
        allowLeadingBom: true,
        pathScan: false,
      }),
    );
  }
  const baseline = options.baseline || loadBaseline(
    root,
    options.baselineRelativePath || BASELINE_RELATIVE_PATH,
  );
  return Object.freeze(
    applyReviewBaseline(findings, baseline).map((finding) => Object.freeze(finding)),
  );
}

function formatFindings(findings) {
  return findings
    .map(
      (finding) =>
        `${finding.path}:${finding.line}:${finding.column}: ` +
        `${finding.codePoint} ${finding.reason}`,
    )
    .join("\n");
}

function parseArgs(argv) {
  const options = { root: path.resolve(__dirname, ".."), json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") options.root = path.resolve(argv[++index]);
    else if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown_argument: ${argument}`);
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    "Usage: node scripts/check-hidden-unicode.js [--root <repository>] [--json]\n",
  );
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const findings = scanRepository(options.root);
  if (options.json) process.stdout.write(`${JSON.stringify({ findings }, null, 2)}\n`);
  else if (findings.length) process.stderr.write(`${formatFindings(findings)}\n`);
  else {
    process.stdout.write(
      "[hidden-unicode] PASS: no forbidden controls or unbaselined soft hyphens found.\n",
    );
  }
  return findings.length ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 2;
  }
}

module.exports = Object.freeze({
  BASELINE_SCHEMA_VERSION,
  BASELINE_RELATIVE_PATH,
  SKIPPED_DIRECTORIES,
  TEXT_EXTENSIONS,
  NAMED_DANGEROUS_CODE_POINTS,
  REVIEWABLE_CODE_POINTS,
  HiddenUnicodePolicyError,
  codePointLabel,
  dangerousCodePoint,
  classifyCodePoint,
  scanText,
  shouldScan,
  listTextFiles,
  decodeUtf8,
  normalizeRepositoryRelativePath,
  normalizeBaseline,
  loadBaseline,
  applyReviewBaseline,
  scanRepository,
  formatFindings,
  parseArgs,
  main,
});
