'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '../..');
test('both exporters use the generated canonical text templates instead of independent handwritten defaults', () => {
  const generator = require('../../scripts/generate-export-template-defaults');
  const actual = fs.readFileSync(path.join(root, 'js/ua.export_template_defaults.js'), 'utf8');
  expect(actual).toBe(generator.render(root));
  const window = { UA: {} }; vm.runInNewContext(actual, { window });
  for (const [name, text] of Object.entries(window.UA.exportTemplateDefaults)) {
    expect(text).toBe(fs.readFileSync(path.join(root, 'templates', name + '.txt'), 'utf8'));
  }
  for (const file of ['ua.export.js', 'ua.export_v2.js']) {
    const source = fs.readFileSync(path.join(root, 'js', file), 'utf8');
    expect(source).toContain('UA.exportTemplateDefaults');
    expect(source).not.toContain('Auffälliger Unfallschwerpunkt im markierten Bereich');
  }
  expect(window.UA.exportTemplateDefaults.base_resolution).not.toMatch(/Bezirksrat/);
  expect(window.UA.exportTemplateDefaults.base_resolution).toContain('{{GREMIUM_QUALIFIER}}');
  expect(window.UA.exportTemplateDefaults.base_method).toMatch(/explorativ/);
});
