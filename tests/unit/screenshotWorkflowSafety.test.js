const fs = require('fs');
const path = require('path');

describe('documentation screenshot publication safety', () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, '../../.github/workflows/generate-screenshots.yml'),
    'utf8'
  );
  const visualCheckWorkflow = fs.readFileSync(
    path.resolve(__dirname, '../../.github/workflows/visual-check.yml'),
    'utf8'
  );
  const testWorkflow = fs.readFileSync(
    path.resolve(__dirname, '../../.github/workflows/test.yml'),
    'utf8'
  );

  test('never grants write permission or pushes generated media directly', () => {
    expect(workflow).toMatch(/permissions:\s*\n\s+contents:\s*read\b/);
    expect(workflow).not.toMatch(/contents:\s*write\b/);
    expect(workflow).not.toMatch(/\bgit\s+push\b/);
    expect(workflow).toMatch(/persist-credentials:\s*false\b/);
  });

  test('uses the canonical Chromium project and uploads a review artifact', () => {
    expect(workflow).toContain(
      'playwright test tests/e2e/screenshots.spec.js --project=chromium'
    );
    expect(workflow).toMatch(/uses:\s*actions\/upload-artifact@/);
    expect(workflow).toMatch(/if-no-files-found:\s*error\b/);
  });

  test('starts from a clean PNG directory so stale media cannot pass through', () => {
    for (const [candidate, command] of [
      [workflow, 'playwright test tests/e2e/screenshots.spec.js'],
      [visualCheckWorkflow, 'playwright test tests/e2e/screenshots.spec.js'],
      [testWorkflow, 'npm run test:e2e'],
    ]) {
      const cleanup = candidate.indexOf("find docs/screenshots -maxdepth 1 -type f -name '*.png' -delete");
      const generation = candidate.indexOf(command);
      expect(cleanup).toBeGreaterThan(-1);
      expect(generation).toBeGreaterThan(cleanup);
    }
  });

  test('never uploads checked-in screenshots after a failed generation', () => {
    const visualUpload = visualCheckWorkflow.slice(
      visualCheckWorkflow.indexOf('- name: Upload PR screenshots as artifact'),
      visualCheckWorkflow.indexOf('- name: Write PR summary')
    );
    const testUpload = testWorkflow.slice(
      testWorkflow.indexOf('- name: Upload documentation screenshots'),
      testWorkflow.indexOf('firefox-smoke:')
    );
    expect(visualUpload).not.toMatch(/if:\s*always\(\)/);
    expect(visualUpload).toMatch(/path:\s*docs\/screenshots\/\*\.png/);
    expect(visualUpload).toMatch(/if-no-files-found:\s*error/);
    expect(testUpload).toMatch(/if:\s*success\(\)/);
    expect(testUpload).toMatch(/path:\s*docs\/screenshots\/\*\.png/);
    expect(testUpload).toMatch(/if-no-files-found:\s*error/);
  });
});
