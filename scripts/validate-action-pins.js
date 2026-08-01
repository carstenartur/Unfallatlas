#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');
const IMMUTABLE_REF = /^[0-9a-f]{40}$/;

function inspectWorkflow(file) {
  const text = fs.readFileSync(file, 'utf8');
  const issues = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#\s*(.+))?\s*$/);
    if (!match) return;
    const target = match[1];
    if (target.startsWith('./') || target.startsWith('docker://')) return;
    const separator = target.lastIndexOf('@');
    if (separator <= 0) {
      issues.push(`${path.relative(ROOT, file)}:${index + 1}: action has no ref: ${target}`);
      return;
    }
    const ref = target.slice(separator + 1);
    if (!IMMUTABLE_REF.test(ref)) {
      issues.push(`${path.relative(ROOT, file)}:${index + 1}: action ref is mutable: ${target}`);
    }
    if (!match[2] || !/\bv?\d/.test(match[2])) {
      issues.push(`${path.relative(ROOT, file)}:${index + 1}: pinned action lacks a readable version comment`);
    }
  });
  return issues;
}

function validateActionPins() {
  const files = fs.readdirSync(WORKFLOW_DIR)
    .filter(name => /\.ya?ml$/i.test(name))
    .map(name => path.join(WORKFLOW_DIR, name))
    .sort();
  return files.flatMap(inspectWorkflow);
}

function main() {
  const issues = validateActionPins();
  if (issues.length) {
    process.stderr.write(`${issues.join('\n')}\n`);
    return 1;
  }
  process.stdout.write('[action-pins] PASS: every external workflow action uses an immutable commit SHA.\n');
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { inspectWorkflow, validateActionPins, main };
