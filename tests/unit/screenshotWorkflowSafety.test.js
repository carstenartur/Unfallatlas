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
  const liveRunner = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/run-live-documentation-qa.js'),
    'utf8'
  );
  const prepareExtendedE2e = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/prepare-extended-e2e.js'),
    'utf8'
  );
  const packageJson = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../package.json'),
    'utf8'
  ));

  test('never grants write permission or pushes generated media directly', () => {
    for (const candidate of [workflow, visualCheckWorkflow]) {
      expect(candidate).toMatch(/permissions:\s*\n\s+contents:\s*read\b/);
      expect(candidate).not.toMatch(/contents:\s*write\b/);
      expect(candidate).not.toMatch(/\bgit\s+push\b/);
      expect(candidate).toMatch(/persist-credentials:\s*false\b/);
    }
  });

  test('uses one Maven profile for every reviewable live-map candidate', () => {
    expect(workflow).toContain(
      'mvn -B -ntp verify -Pdocumentation-live -Ddocumentation.liveLinks=false'
    );
    expect(visualCheckWorkflow).toContain(
      'mvn -B -ntp verify -Pdocumentation-live -Ddocumentation.liveLinks=true'
    );
    for (const candidate of [workflow, visualCheckWorkflow]) {
      expect(candidate).not.toContain('node scripts/');
      expect(candidate).not.toContain('npm run');
      expect(candidate).not.toContain('playwright test');
      expect(candidate).toContain('out/qa/live-cartography-evidence.json');
      expect(candidate).toMatch(/uses:\s*actions\/upload-artifact@/);
      expect(candidate).toMatch(/if-no-files-found:\s*error\b/);
      expect(candidate).toMatch(/Provider-URL/);
    }
    expect(workflow).toContain('documentation-screenshots-live-map-${{ github.sha }}');
    expect(visualCheckWorkflow).toContain('pr-live-map-screenshots-${{ github.event.pull_request.number }}');
  });

  test('Maven profile delegates the fail-closed sequence to the repository runner', () => {
    expect(pom).toContain('<id>documentation-live</id>');
    expect(pom).toContain('<arguments>run qa:documentation-live</arguments>');
    expect(packageJson.scripts['qa:documentation-live']).toBe(
      'node scripts/run-live-documentation-qa.js'
    );
    const cleanup = liveRunner.indexOf('cleanCandidates();');
    const generation = liveRunner.indexOf('run-live-documentation-screenshots.cjs');
    const evidence = liveRunner.indexOf('validate-screenshot-evidence.js');
    const cartography = liveRunner.indexOf('validate-live-cartography-evidence.cjs');
    const media = liveRunner.indexOf('validate-doc-media.js');
    expect(cleanup).toBeGreaterThan(-1);
    expect(generation).toBeGreaterThan(cleanup);
    expect(evidence).toBeGreaterThan(generation);
    expect(cartography).toBeGreaterThan(evidence);
    expect(media).toBeGreaterThan(cartography);
    expect(liveRunner).toContain('DOCUMENTATION_LIVE_LINKS');
    expect(liveRunner).toContain('run-live-documentation-links.cjs');
  });

  test('keeps hermetic E2E separate from publication candidates and behind Maven', () => {
    expect(testWorkflow).toContain('mvn -B -ntp clean verify -Pe2e,system-it,location-brief-golden');
    expect(testWorkflow).not.toContain('run-live-documentation-screenshots.cjs');
    expect(testWorkflow).not.toContain('validate-live-cartography-evidence.cjs');
    expect(testWorkflow).not.toContain('playwright test');
    expect(pom).toContain('<id>e2e</id>');
    expect(pom).toContain('<arguments>run qa:e2e:prepare</arguments>');
    expect(pom).toContain('<arguments>run qa:e2e:extended</arguments>');
    expect(pom).toContain('<arguments>run qa:e2e:evidence</arguments>');
  });

  test('starts every candidate run from clean media and readiness directories', () => {
    expect(liveRunner).toContain("path.join(ROOT, 'docs', 'screenshots')");
    expect(liveRunner).toContain("path.join(ROOT, 'out', 'qa', 'screenshot-readiness')");
    expect(liveRunner).toContain("entry.toLowerCase().endsWith('.png')");
    expect(liveRunner).toContain("entry.toLowerCase().endsWith('.json')");

    expect(prepareExtendedE2e).toContain("path.join(ROOT, 'docs', 'screenshots')");
    expect(prepareExtendedE2e).toContain("name.toLowerCase().endsWith('.png')");
    expect(prepareExtendedE2e).toContain("path.join(ROOT, 'out', 'qa', 'screenshot-readiness')");
    expect(packageJson.scripts['qa:e2e:prepare']).toContain('prepare-extended-e2e.js');
  });

  test('candidate artifacts are uploaded only after the Maven gate succeeds', () => {
    const dispatchUpload = workflow.slice(
      workflow.indexOf('- name: Upload reviewed screenshot candidate'),
      workflow.indexOf('- name: Upload media QA report')
    );
    const visualUpload = visualCheckWorkflow.slice(
      visualCheckWorkflow.indexOf('- name: Upload PR screenshots as artifact'),
      visualCheckWorkflow.indexOf('- name: Upload media QA report')
    );

    for (const upload of [dispatchUpload, visualUpload]) {
      expect(upload).not.toMatch(/if:\s*always\(\)/);
      expect(upload).toContain('docs/screenshots/*.png');
      expect(upload).toContain('out/qa/screenshot-readiness/*.json');
      expect(upload).toContain('out/qa/screenshot-evidence.json');
      expect(upload).toContain('out/qa/live-cartography-evidence.json');
      expect(upload).toContain('_site/build-manifest.json');
      expect(upload).toMatch(/if-no-files-found:\s*error/);
    }
    expect(visualUpload).toContain('out/qa/documentation-live-links/');
  });

  test('Maven validates evidence before candidate media and CI retains diagnostics', () => {
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

  test('live publication workflows retain durable readiness and provenance artifacts', () => {
    for (const candidate of [workflow, visualCheckWorkflow]) {
      expect(candidate).toContain('out/qa/screenshot-readiness/');
      expect(candidate).toContain('out/qa/screenshot-evidence.json');
      expect(candidate).toContain('out/qa/live-cartography-evidence.json');
      expect(candidate).toContain('_site/build-manifest.json');
      expect(candidate).toMatch(/always\(\)[\s\S]*hashFiles\(/);
      expect(candidate).toContain('out/qa/live-documentation-screenshots.log');
    }
    expect(visualCheckWorkflow).toContain('out/qa/documentation-live-links/');
  });
});
