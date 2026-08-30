'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'enrich.yml');

function step(source, name) {
  const marker = `      - name: ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const next = source.indexOf('\n      - name: ', start + marker.length);
  return source.slice(start, next < 0 ? source.length : next);
}

describe('automatic context-data commit budget', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  const review = step(workflow, 'Review staged public-data delta before any commit');
  const upload = step(workflow, 'Upload context QA evidence');
  const commit = step(workflow, 'Commit and push');

  test('reviews the exact staged public-data bytes before upload and commit', () => {
    expect(review).not.toBe('');
    expect(workflow.indexOf('Review staged public-data delta before any commit'))
      .toBeLessThan(workflow.indexOf('Upload context QA evidence'));
    expect(workflow.indexOf('Upload context QA evidence'))
      .toBeLessThan(workflow.indexOf('Commit and push'));
    expect(review).toContain('git add -A -- out/ data/accident-data-release.json');
    expect(review).toContain("report='out/qa/context-data-git-delta.txt'");
    expect(upload).toContain('out/qa/');
  });

  test('accounts for every staged path and preserves patch blockers in the report', () => {
    expect(review).toContain("git diff --cached --name-only -z)");
    expect(review).toContain("git diff --cached --diff-filter=A --name-only -z)");
    expect(review).toContain("git diff --cached --diff-filter=D --name-only -z)");
    expect(review).not.toContain('git diff --cached --name-only -z -- out/');
    expect(review).toContain('if ! git diff --cached --check >"$check_output" 2>&1; then');
    expect(review).toContain('errors+=("git diff --check: $line")');
    expect(review).toContain("echo 'GIT DIFF CHECK'");
    expect(review).toContain('errors+=("unexpected staged path: $path")');
  });

  test('blocks excessive file counts, single blobs and aggregate Git churn', () => {
    for (const contract of [
      "MAX_CHANGED_FILES: '2000'",
      "MAX_ADDED_FILES: '500'",
      "MAX_DELETED_FILES: '500'",
      "MAX_SINGLE_FILE_BYTES: '16777216'",
      "MAX_REWRITTEN_BYTES: '134217728'",
      "MAX_POSITIVE_GROWTH_BYTES: '67108864'",
      "MAX_NET_GROWTH_BYTES: '33554432'",
      'git cat-file -s ":$path"',
      'unsupported staged file mode',
      'Context data delta exceeds the automatic-commit budget',
    ]) {
      expect(review).toContain(contract);
    }
  });

  test('does not restage after review and refuses to push from a stale source head', () => {
    expect(commit).not.toContain('git add');
    expect(commit).toContain('source_head="$(git rev-parse HEAD)"');
    expect(commit).toContain('git fetch --no-tags origin "refs/heads/${target_branch}"');
    expect(commit).toContain('remote_head="$(git rev-parse FETCH_HEAD)"');
    expect(commit).toContain('Refusing stale context-data push');
    expect(commit).toContain('git push origin "HEAD:${target_branch}"');
  });

  test('changes to the mutation workflow retrigger its guarded validation path', () => {
    expect(workflow).toContain("- '.github/workflows/enrich.yml'");
  });
});
