'use strict';

const fs = require('fs');
const path = require('path');

describe('enrich workflow checkout pinning', () => {
  test('keeps workflow_run auto-enrichment on the trusted default branch', () => {
    const workflow = fs.readFileSync(
      path.resolve(__dirname, '../../.github/workflows/enrich.yml'),
      'utf8',
    );

    expect(workflow).toContain("github.event.workflow_run.head_branch == github.event.repository.default_branch");
    expect(workflow).toContain("ref: ${{ github.event_name == 'workflow_run' && github.event.repository.default_branch || github.ref }}");
  });
});
