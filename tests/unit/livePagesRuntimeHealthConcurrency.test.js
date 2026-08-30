'use strict';

const fs = require('fs');
const path = require('path');

const WORKFLOW = path.resolve(
  __dirname,
  '../..',
  '.github',
  'workflows',
  'live-pages-runtime-health.yml'
);

describe('Live Pages Runtime Health concurrency', () => {
  test('isolates pull-request runs while still cancelling superseded runs for the same source', () => {
    const source = fs.readFileSync(WORKFLOW, 'utf8');

    expect(source).toContain(
      'group: live-pages-runtime-health-${{ github.event_name }}-${{ github.event.pull_request.number || github.event.workflow_run.workflow_id || github.ref }}'
    );
    expect(source).toContain('cancel-in-progress: true');
    expect(source).not.toMatch(
      /group:\s*live-pages-runtime-health-\$\{\{\s*github\.event_name\s*\}\}\s*$/
    );
  });
});
