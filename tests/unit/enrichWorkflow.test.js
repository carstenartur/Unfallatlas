'use strict';

const fs = require('fs');
const path = require('path');

describe('enrich workflow checkout pinning', () => {
  test('pins workflow_run checkouts to the triggering head SHA', () => {
    const workflow = fs.readFileSync(
      path.resolve(__dirname, '../../.github/workflows/enrich.yml'),
      'utf8',
    );

    expect(workflow).toContain("ref: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}");
  });
});
