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
  const pom = fs.readFileSync(path.resolve(__dirname, '../../pom.xml'), 'utf8');
  const prepareExtendedE2e = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/prepare-extended-e2e.js'),
    'utf8'
  );
  const packageJson = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../package.json'),
    'utf8'
  ));

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

  test('keeps hermetic E2E separate from publication candidates and behind Maven', () => {
    expect(testWorkflow).toContain('mvn -B -ntp clean verify -Pe2e,system-it,location-brief-golden');
    expect(testWorkflow).not.toContain('node scripts/run-live-documentation-screenshots.cjs');
    expect(testWorkflow).not.toContain('node scripts/validate-live-cartography-evidence.cjs');
    expect(testWorkflow).not.toContain('playwright test');
    expect(pom).toContain('<id>e2e</id>');
    expect(pom).toContain('<arguments>run qa:e2e:prepare</arguments>');
    expect(pom).toContain('<arguments>run qa:e2e:extended</arguments>');
    expect(pom).toContain('<arguments>run qa:e2e:evidence</arguments>');
  });

  test('starts from clean candidate directories so stale media cannot pass through', () => {
    for (const candidate of [workflow, visualCheckWorkflow]) {
      const cleanup = candidate.indexOf("find docs/screenshots -maxdepth 1 -type f -name '*.png' -delete");
      const generation = candidate.indexOf('node scripts/run-live-documentation-screenshots.cjs');
      expect(cleanup).toBeGreaterThan(-1);
      expect(generation).toBeGreaterThan(cleanup);
    }

    expect(prepareExtendedE2e).toContain("path.join(ROOT, 'docs', 'screenshots')");
    expect(prepareExtendedE2e).toContain("name.toLowerCase().endsWith('.png')");
    expect(prepareExtendedE2e).toContain("path.join(ROOT, 'out', 'qa', 'screenshot-readiness')");
    expect(packageJson.scripts['qa:e2e:prepare']).toContain('prepare-extended-e2e.js');
  });

  test('never uploads checked-in publication candidates after a failed live generation or QA gate', () => {
    const dispatchUpload = workflow.slice(
      workflow.indexOf('- name: Upload reviewed screenshot candidate'),
      workflow.indexOf('- name: Upload media QA report')
    );
    const visualUpload = visualCheckWorkflow.slice(
      visualCheckWorkflow.indexOf('- name: Upload PR screenshots as artifact'),
      visualCheckWorkflow.indexOf('- name: Upload media QA report')
    );

    expect(dispatchUpload).toMatch(
      /if:\s*\$\{\{\s*steps\.validate_media\.outcome\s*==\s*'success'\s*&&\s*steps\.validate_evidence\.outcome\s*==\s*'success'\s*&&\s*steps\.validate_cartography\.outcome\s*==\s*'success'\s*\}\}/
    );
    expect(visualUpload).toMatch(
      /if:\s*\$\{\{\s*steps\.validate_media\.outcome\s*==\s*'success'\s*&&\s*steps\.validate_evidence\.outcome\s*==\s*'success'\s*&&\s*steps\.validate_cartography\.outcome\s*==\s*'success'\s*&&\s*steps\.validate_live_links\.outcome\s*==\s*'success'\s*\}\}/
    );

    for (const upload of [dispatchUpload, visualUpload]) {
      expect(upload).toContain('docs/screenshots/*.png');
      expect(upload).toContain('out/qa/screenshot-readiness/*.json');
      expect(upload).toContain('out/qa/screenshot-evidence.json');
      expect(upload).toContain('out/qa/live-cartography-evidence.json');
      expect(upload).toContain('_site/build-manifest.json');
      expect(upload).toMatch(/if-no-files-found:\s*error/);
    }
    expect(visualUpload).toContain('out/qa/documentation-live-links/');
  });

  test('Maven validates evidence before candidate media and CI retains rejected evidence', () => {
    const prepare = pom.indexOf('<id>prepare-extended-browser-qa</id>');
    const browser = pom.indexOf('<id>extended-browser-qa</id>');
    const evidence = pom.indexOf('<id>validate-extended-browser-evidence</id>');
    expect(prepare).toBeGreaterThan(-1);
    expect(browser).toBeGreaterThan(prepare);
    expect(evidence).toBeGreaterThan(browser);

    const evidenceCommand = packageJson.scripts['qa:e2e:evidence'];
    expect(evidenceCommand.indexOf('validate-screenshot-evidence.js'))
      .toBeLessThan(evidenceCommand.indexOf('validate-doc-media.js --candidate-screenshots'));

    const upload = testWorkflow.slice(testWorkflow.indexOf('- name: Upload extended QA evidence'));
    expect(upload).toMatch(/if:\s*always\(\)/);
    expect(upload).toContain('out/qa/');
    expect(upload).toContain('docs/screenshots/');
    expect(upload).toContain('_site/build-manifest.json');
    expect(upload).toContain('playwright-report/');
    expect(upload).toContain('test-results/');
  });

  test('live publication workflows retain fail-closed readiness and provenance', () => {
    for (const candidate of [workflow, visualCheckWorkflow]) {
      expect(candidate).toContain('out/qa/screenshot-readiness/');
      expect(candidate).toContain('out/qa/screenshot-evidence.json');
      expect(candidate).toContain('_site/build-manifest.json');
      expect(candidate).toMatch(/always\(\)[\s\S]*hashFiles\(/);
      expect(candidate).toContain('npm run validate:screenshot-evidence');
      expect(candidate).toContain('out/qa/live-cartography-evidence.json');
      expect(candidate).toMatch(/id:\s*validate_cartography/);
      expect(candidate).toMatch(/id:\s*validate_media/);
      expect(candidate).toMatch(/id:\s*validate_evidence/);
    }
    expect(visualCheckWorkflow).toMatch(/id:\s*validate_live_links/);
    expect(visualCheckWorkflow).toContain('out/qa/documentation-live-links/');
  });
});
