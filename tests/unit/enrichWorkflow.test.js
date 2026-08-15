'use strict';

const fs = require('fs');
const path = require('path');

describe('enrich workflow checkout pinning and resilience', () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, '../../.github/workflows/enrich.yml'),
    'utf8',
  );

  test('keeps workflow_run auto-enrichment on the trusted default branch', () => {
    expect(workflow).toContain("github.event.workflow_run.head_branch == github.event.repository.default_branch");
    expect(workflow).toContain("ref: ${{ github.event_name == 'workflow_run' && github.event.repository.default_branch || github.ref }}");
  });

  test('keeps manual and push runs strict while tolerating verified stale data for scheduled/provider-chained runs', () => {
    expect(workflow).toContain('allow_stale_on_transient:');
    expect(workflow).toContain('default: false');
    expect(workflow).toContain(
      "CONTEXT_ALLOW_STALE_ON_TRANSIENT: ${{ inputs.allow_stale_on_transient == true || github.event_name == 'workflow_run' || github.event_name == 'schedule' }}",
    );
  });

  test('restores and saves the expensive provider cache without deprecated save-always behavior', () => {
    expect(workflow).toContain('uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9');
    expect(workflow).toContain('uses: actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9');
    expect(workflow).not.toContain('save-always:');
    expect(workflow).toContain("if: always() && steps.context-cache.outputs.cache-hit != 'true'");
  });

  test('publishes the QA summary and commits the rebound accident release oracle with context data', () => {
    expect(workflow).toContain('.build/context-provider/');
    expect(workflow).toContain('out/qa/');
    expect(workflow).toContain('git add -A -- out/ data/accident-data-release.json');
  });
});
