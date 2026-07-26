'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const PAGE_WORKFLOWS = [
  '.github/workflows/deploy-pages-current-data.yml',
  '.github/workflows/generate-data-deploy-pages.yml',
];

describe('Pages deployment workflow safety', () => {
  test.each(PAGE_WORKFLOWS)('%s publishes artifacts without mutating repository settings', workflowPath => {
    const workflow = fs.readFileSync(path.join(ROOT, workflowPath), 'utf8');

    expect(workflow).toContain('actions/configure-pages@v6');
    expect(workflow).toContain('actions/deploy-pages@v5');
    expect(workflow).toContain('pages: write');
    expect(workflow).toContain('id-token: write');

    expect(workflow).not.toContain('gh api');
    expect(workflow).not.toContain('build_type=workflow');
    expect(workflow).not.toContain('GH_TOKEN:');
    expect(workflow).not.toContain('administration: write');
  });
});
