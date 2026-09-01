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
  const visualCandidateJob = visualCheckWorkflow.slice(
    visualCheckWorkflow.indexOf('  pr-screenshots:'),
    visualCheckWorkflow.indexOf('  accept-reviewed-screenshots:')
  );
  const visualAcceptanceJob = visualCheckWorkflow.slice(
    visualCheckWorkflow.indexOf('  accept-reviewed-screenshots:')
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

  test('candidate generation remains read-only and never pushes generated media', () => {
    expect(workflow).toMatch(/permissions:\s*\n\s+contents:\s*read\b/);
    expect(visualCheckWorkflow).toMatch(/permissions:\s*\n\s+contents:\s*read\b/);
    for (const candidate of [workflow, visualCandidateJob]) {
      expect(candidate).not.toMatch(/contents:\s*write\b/);
      expect(candidate).not.toMatch(/\bgit\s+push\b/);
      expect(candidate).toMatch(/persist-credentials:\s*false\b/);
    }
  });

  test('reviewed acceptance is explicit, owner-scoped, immutable and race-safe', () => {
    expect(visualAcceptanceJob).toContain("github.event_name == 'pull_request'");
    expect(visualAcceptanceJob).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    expect(visualAcceptanceJob).toContain("github.event.pull_request.user.login == 'carstenartur'");
    expect(visualAcceptanceJob).toMatch(/permissions:\s*\n\s+contents:\s*write\b/);
    expect(visualAcceptanceJob).toContain('qa/accept-screenshot-candidate.json');
    expect(visualAcceptanceJob).toContain('actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c');
    expect(visualAcceptanceJob).toContain('ARTIFACT_ID');
    expect(visualAcceptanceJob).toContain('ARTIFACT_DIGEST');
    expect(visualAcceptanceJob).toContain("marker.get('accept') is not True");
    expect(visualAcceptanceJob).toContain("summary.get('revision') != os.environ['EVIDENCE_REVISION']");
    expect(visualAcceptanceJob).toContain("cartography.get('revision') != summary['revision']");
    expect(visualAcceptanceJob).toContain('candidate build manifest is not internally consistent');
    expect(visualAcceptanceJob).not.toContain('candidate build manifest differs from the reviewed repository build');
    expect(visualAcceptanceJob).toContain("sidecar_data.get('build') != build");
    expect(visualAcceptanceJob).toContain("'pullRequestHeadRevision': os.environ['EXPECTED_HEAD_SHA']");
    expect(visualAcceptanceJob).toContain('candidate screenshot hash/size mismatch');
    expect(visualAcceptanceJob).toContain('mvn -B -ntp verify -Prelease-site -DskipTests=true');
    expect(visualAcceptanceJob).not.toContain('node scripts/');
    expect(visualAcceptanceJob).not.toContain('validateCartographyRecord');
    expect(visualAcceptanceJob).toContain('git fetch --no-tags origin');
    expect(visualAcceptanceJob).toContain('remote_head" != "$EXPECTED_HEAD_SHA');
    expect(visualAcceptanceJob).toContain('git rm "$ACCEPTANCE_MARKER"');
    expect(visualAcceptanceJob).toContain('git diff --cached --check');
    expect(visualAcceptanceJob).toContain('git push origin "HEAD:${HEAD_REF}"');
  });

  test('uses one Maven invocation for every reviewable candidate and accepted-media gate', () => {
    expect(workflow).toContain(
      'mvn -B -ntp verify -Pdocumentation-live -Ddocumentation.liveLinks=false'
    );
    expect(visualCandidateJob).toContain(
      'mvn -B -ntp verify -Pdocumentation-live -Ddocumentation.liveLinks=true'
    );
    for (const candidate of [workflow, visualCandidateJob]) {
      expect(candidate).not.toContain('node scripts/');
      expect(candidate).not.toContain('npm run');
      expect(candidate).not.toContain('playwright test');
      expect(candidate).toContain('out/qa/live-cartography-evidence.json');
      expect(candidate).toMatch(/uses:\s*actions\/upload-artifact@/);
      expect(candidate).toMatch(/if-no-files-found:\s*error\b/);
      expect(candidate).toMatch(/Provider-URL/);
    }
    expect(visualAcceptanceJob).toContain('actions/setup-java@dd06d9cba3e5552c54d9f8ea23572deb30010f7c');
    expect(visualAcceptanceJob.match(/^\s*run:\s*mvn\b/gm) || []).toHaveLength(1);
    expect(workflow).toContain('documentation-screenshots-live-map-${{ github.sha }}');
    expect(visualCandidateJob).toContain('pr-live-map-screenshots-${{ github.event.pull_request.number }}');
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

  test('cleans publication candidates but preserves reviewed media before hermetic E2E', () => {
    expect(liveRunner).toContain("path.join(ROOT, 'docs', 'screenshots')");
    expect(liveRunner).toContain("path.join(ROOT, 'out', 'qa', 'screenshot-readiness')");
    expect(liveRunner).toContain("entry.toLowerCase().endsWith('.png')");
    expect(liveRunner).toContain("entry.toLowerCase().endsWith('.json')");

    expect(prepareExtendedE2e).not.toContain("path.join(ROOT, 'docs', 'screenshots')");
    expect(prepareExtendedE2e).not.toContain("name.toLowerCase().endsWith('.png')");
    expect(prepareExtendedE2e).toContain("path.join(root, 'out', 'qa', 'screenshot-readiness')");
    expect(prepareExtendedE2e).toContain("name.toLowerCase().endsWith('.json')");
    expect(packageJson.scripts['qa:e2e:prepare']).toContain('prepare-extended-e2e.js');
    expect(packageJson.scripts['qa:e2e:extended'])
      .toBe('node scripts/run-extended-e2e-isolated.js');
  });

  test('candidate artifacts are uploaded only after the Maven gate succeeds', () => {
    const dispatchUpload = workflow.slice(
      workflow.indexOf('- name: Upload reviewed screenshot candidate'),
      workflow.indexOf('- name: Upload media QA report')
    );
    const visualUpload = visualCandidateJob.slice(
      visualCandidateJob.indexOf('- name: Upload PR screenshots as artifact'),
      visualCandidateJob.indexOf('- name: Upload media QA report')
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
    for (const candidate of [workflow, visualCandidateJob]) {
      expect(candidate).toContain('out/qa/screenshot-readiness/');
      expect(candidate).toContain('out/qa/screenshot-evidence.json');
      expect(candidate).toContain('out/qa/live-cartography-evidence.json');
      expect(candidate).toContain('_site/build-manifest.json');
      expect(candidate).toMatch(/always\(\)[\s\S]*hashFiles\(/);
      expect(candidate).toContain('out/qa/live-documentation-screenshots.log');
    }
    expect(visualCandidateJob).toContain('out/qa/documentation-live-links/');
  });
});
