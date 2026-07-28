#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { TextDecoder } = require("util");

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
  [0x00ad, "SOFT HYPHEN"],
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

function codePointLabel(codePoint) {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

function dangerousCodePoint(codePoint, index) {
  if (codePoint === 0xfeff && index === 0) return null;
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

function positionAt(text, index) {
  let line = 1;
  let column = 1;
  for (let offset = 0; offset < index; ) {
    const codePoint = text.codePointAt(offset);
    const width = codePoint > 0xffff ? 2 : 1;
    if (codePoint === 0x0a) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    offset += width;
  }
  return { line, column };
}

function scanText(text, relativePath) {
  const findings = [];
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index);
    const width = codePoint > 0xffff ? 2 : 1;
    const reason = dangerousCodePoint(codePoint, index);
    if (reason) {
      findings.push({
        path: relativePath,
        index,
        ...positionAt(text, index),
        codePoint: codePointLabel(codePoint),
        reason,
      });
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
  return TEXT_EXTENSIONS.has(path.extname(base).toLowerCase());
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

function scanRepository(rootValue) {
  const root = fs.realpathSync(path.resolve(rootValue));
  const findings = [];
  for (const segment of path.relative(path.parse(root).root, root).split(path.sep)) {
    findings.push(...scanText(segment, `<repository-path>/${segment}`));
  }
  for (const file of listTextFiles(root)) {
    findings.push(...scanText(file.relative, `<file-name>/${file.relative}`));
    const buffer = fs.readFileSync(file.absolute);
    if (buffer.includes(0)) continue;
    const text = decodeUtf8(buffer, file.relative);
    findings.push(...scanText(text, file.relative));
  }
  return Object.freeze(findings.map((finding) => Object.freeze(finding)));
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
  else process.stdout.write("[hidden-unicode] PASS: no dangerous invisible controls found.\n");
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
  SKIPPED_DIRECTORIES,
  TEXT_EXTENSIONS,
  NAMED_DANGEROUS_CODE_POINTS,
  codePointLabel,
  dangerousCodePoint,
  scanText,
  shouldScan,
  listTextFiles,
  decodeUtf8,
  scanRepository,
  formatFindings,
  parseArgs,
  main,
});
