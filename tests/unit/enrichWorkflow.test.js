'use strict';

const fs = require('fs');
const path = require('path');

describe('enrich workflow checkout pinning and resilience', () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, '../../.github/workflows/enrich.yml'),
    'utf8',
  );
  const policy = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../config/context-data-git-budget.json'),
    'utf8',
  ));

  test('keeps every mutating trigger on the trusted default branch', () => {
    expect(workflow).toContain("github.event.workflow_run.head_branch == github.event.repository.default_branch");
    expect(workflow).toContain('ref: ${{ github.event.repository.default_branch }}');
    expect(workflow).not.toContain("ref: ${{ github.event_name == 'workflow_run' && github.event.repository.default_branch || github.ref }}");
  });

  test('allows verified stale data on all automatic runs and keeps manual runs strict by default', () => {
    expect(workflow).toMatch(/allow_stale_on_transient:\n(?:[^\n]*\n){3} +default: false/);
    expect(workflow).toContain(
      "CONTEXT_ALLOW_STALE_ON_TRANSIENT: ${{ github.event_name != 'workflow_dispatch' || inputs.allow_stale_on_transient == true }}",
    );
  });

  test('passes the selected stale policy through the Maven profile', () => {
    expect(workflow).toContain('-Dcontext.allowStaleOnTransient="${CONTEXT_ALLOW_STALE_ON_TRANSIENT:-false}"');
  });

  test('requires the pinned Hannover DGM1 by default in automated and manual refreshes', () => {
    expect(workflow).toMatch(/require_hannover_dgm1:\n(?:[^\n]*\n){3} *default: true/);
    expect(workflow).toContain(
      "CONTEXT_REQUIRE_HANNOVER_DGM1: ${{ github.event_name != 'workflow_dispatch' || inputs.require_hannover_dgm1 == true || vars.CONTEXT_REQUIRE_HANNOVER_DGM1 == 'true' }}",
    );
    expect(workflow).toContain("if: env.CONTEXT_REQUIRE_HANNOVER_DGM1 == 'true'");
    expect(workflow).toContain('slugify(city) === "hannover"');
    expect(workflow.match(/steps\.hannover-city\.outputs\.selected == 'true'/g)).toHaveLength(2);
  });

  test('restores and saves the expensive provider cache without deprecated save-always behavior', () => {
    expect(workflow).toContain('uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9');
    expect(workflow).toContain('uses: actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9');
    expect(workflow).not.toContain('save-always:');
    expect(workflow).toContain("if: always() && steps.context-cache.outputs.cache-hit != 'true'");
  });

  test('publishes hidden QA evidence and includes the release oracle in the reviewed data index', () => {
    expect(workflow).toContain('.build/context-provider/');
    expect(workflow).toContain('.build/context-selected-cities.txt');
    expect(workflow).toContain('include-hidden-files: true');
    expect(workflow).toContain('out/qa/');
    expect(workflow).toContain("CONTEXT_REVIEW_GIT_DELTA: 'true'");
    expect(policy.allowedPathPrefixes).toContain('out/');
    expect(policy.allowedExactPaths).toContain('data/accident-data-release.json');
    expect(workflow).not.toContain('git add -A -- out/ data/accident-data-release.json');
  });
});
