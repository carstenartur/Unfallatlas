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

  test('uses the fail-closed live-map runner for every reviewable candidate', () => {
    for (const candidate of [workflow, visualCheckWorkflow]) {
      expect(candidate).toContain('node scripts/run-live-documentation-screenshots.cjs');
      expect(candidate).not.toContain(
        'playwright test tests/e2e/screenshots.spec.js --project=chromium'
      );
      expect(candidate).toContain('node scripts/validate-live-cartography-evidence.cjs');
      expect(candidate).toContain('out/qa/live-cartography-evidence.json');
      expect(candidate).toMatch(/uses:\s*actions\/upload-artifact@/);
      expect(candidate).toMatch(/if-no-files-found:\s*error\b/);
      expect(candidate).toMatch(/real cartographic basemaps|echten Karten/i);
      expect(candidate).toMatch(/Provider-URL/);
    }
    expect(workflow).toContain('documentation-screenshots-live-map-${{ github.sha }}');
    expect(visualCheckWorkflow).toContain('pr-live-map-screenshots-${{ github.event.pull_request.number }}');
  });

  test('keeps the hermetic E2E suite separate from publication candidates', () => {
    expect(testWorkflow).toContain('npm run test:e2e');
    expect(testWorkflow).not.toContain('node scripts/run-live-documentation-screenshots.cjs');
    expect(testWorkflow).not.toContain('node scripts/validate-live-cartography-evidence.cjs');
  });

  test('starts from a clean PNG directory so stale media cannot pass through', () => {
    for (const [candidate, command] of [
      [workflow, 'node scripts/run-live-documentation-screenshots.cjs'],
      [visualCheckWorkflow, 'node scripts/run-live-documentation-screenshots.cjs'],
      [testWorkflow, 'npm run test:e2e'],
    ]) {
      const cleanup = candidate.indexOf("find docs/screenshots -maxdepth 1 -type f -name '*.png' -delete");
      const generation = candidate.indexOf(command);
      expect(cleanup).toBeGreaterThan(-1);
      expect(generation).toBeGreaterThan(cleanup);
    }
  });

  test('never uploads checked-in screenshots after a failed generation', () => {
    const dispatchUpload = workflow.slice(
      workflow.indexOf('- name: Upload reviewed screenshot candidate'),
      workflow.indexOf('- name: Upload media QA report')
    );
    const visualUpload = visualCheckWorkflow.slice(
      visualCheckWorkflow.indexOf('- name: Upload PR screenshots as artifact'),
      visualCheckWorkflow.indexOf('- name: Upload media QA report')
    );
    const testUpload = testWorkflow.slice(
      testWorkflow.indexOf('- name: Upload documentation screenshots'),
      testWorkflow.indexOf('- name: Upload generated media QA report')
    );
    for (const upload of [dispatchUpload, visualUpload]) {
      expect(upload).toMatch(
        /if:\s*\$\{\{\s*steps\.validate_media\.outcome\s*==\s*'success'\s*&&\s*steps\.validate_evidence\.outcome\s*==\s*'success'\s*&&\s*steps\.validate_cartography\.outcome\s*==\s*'success'\s*\}\}/
      );
      expect(upload).toContain('docs/screenshots/*.png');
      expect(upload).toContain('out/qa/screenshot-readiness/*.json');
      expect(upload).toContain('out/qa/screenshot-evidence.json');
      expect(upload).toContain('out/qa/live-cartography-evidence.json');
      expect(upload).toContain('_site/build-manifest.json');
      expect(upload).toMatch(/if-no-files-found:\s*error/);
    }
    expect(testUpload).toMatch(
      /if:\s*\$\{\{\s*steps\.validate_media\.outcome\s*==\s*'success'\s*&&\s*steps\.validate_evidence\.outcome\s*==\s*'success'\s*\}\}/
    );
  });

  test('publishes fail-closed readiness and build provenance even for rejected candidates', () => {
    for (const candidate of [workflow, visualCheckWorkflow, testWorkflow]) {
      expect(candidate).toContain('out/qa/screenshot-readiness/');
      expect(candidate).toContain('out/qa/screenshot-evidence.json');
      expect(candidate).toContain('_site/build-manifest.json');
      expect(candidate).toMatch(/always\(\)[\s\S]*hashFiles\(/);
      expect(candidate).toContain('npm run validate:screenshot-evidence');
    }
    for (const candidate of [workflow, visualCheckWorkflow]) {
      expect(candidate).toContain('out/qa/live-cartography-evidence.json');
      expect(candidate).toMatch(/id:\s*validate_cartography/);
    }
    expect(workflow).toMatch(/id:\s*validate_media/);
    expect(workflow).toMatch(/id:\s*validate_evidence/);
    expect(visualCheckWorkflow).toMatch(/id:\s*validate_media/);
    expect(visualCheckWorkflow).toMatch(/id:\s*validate_evidence/);
    expect(testWorkflow).toMatch(/id:\s*validate_media/);
    expect(testWorkflow).toMatch(/id:\s*validate_evidence/);
  });
});
