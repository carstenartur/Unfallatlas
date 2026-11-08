#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
function render(root = path.resolve(__dirname, '..')) {
  const directory = path.join(root, 'templates');
  const defaults = Object.fromEntries(fs.readdirSync(directory).filter(f => f.endsWith('.txt')).sort()
    .map(file => [file.slice(0, -4), fs.readFileSync(path.join(directory, file), 'utf8')]));
  return '// Generated from templates/*.txt by scripts/generate-export-template-defaults.js. Do not edit.\n' +
    '(() => {\n  const UA = window.UA = window.UA || {};\n  UA.exportTemplateDefaults = Object.freeze(' + JSON.stringify(defaults, null, 2) + ');\n})();\n';
}
function main(args = process.argv.slice(2)) {
  const root = path.resolve(__dirname, '..'), target = path.join(root, 'js/ua.export_template_defaults.js');
  const expected = render(root);
  if (args.includes('--check')) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== expected) throw new Error('Canonical export template defaults drifted; run node scripts/generate-export-template-defaults.js');
  } else fs.writeFileSync(target, expected);
}
if (require.main === module) { try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; } }
module.exports = { render, main };
