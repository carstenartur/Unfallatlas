'use strict';

const fs = require('fs');
const path = require('path');
const { buildLocationBrief } = require('../../server/location-brief');
const { toIngestPayload } = require('../../server/analysis-service/analysisServiceClient');
const { buildStructuredFromCase } = require('../../scripts/lib/location-brief-golden-case-data');
const { isDockerAvailable } = require('./lib/startUnfallatlasContainer');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ANALYSIS_SERVICE_DIR = path.resolve(REPO_ROOT, 'analysis-service');
const ANALYSIS_PORT = 8081;
const ANALYSIS_SERVICE_RUNTIME_IMAGE = 'eclipse-temurin:21-jre';
const ANALYSIS_SERVICE_IMAGE_TAG = 'unfallatlas-analysis-service:golden-test';
const PROFILE_RANK = { low: 0, medium: 1, high: 2 };
const PROFILE = JSON.parse(fs.readFileSync(
  path.resolve(REPO_ROOT, 'tests/fixtures/location-brief-golden-cases.json'),
  'utf8'
));

function dockerLikelyAvailable() {
  if (process.env.RUN_TESTCONTAINERS === '1') return true;
  if (process.env.DOCKER_HOST) return true;
  try { return fs.existsSync('/var/run/docker.sock'); } catch (_) { return false; }
}

const SUITE_DESCRIBE = dockerLikelyAvailable() ? describe : describe.skip;
if (SUITE_DESCRIBE === describe.skip) {
  // eslint-disable-next-line no-console
  console.warn('[locationBriefGoldenCases.testcontainers] Skipping suite — Docker not available.');
}

async function loadTestcontainers() {
  return import('testcontainers');
}

function findAnalysisServiceJar() {
  if (process.env.ANALYSIS_SERVICE_JAR) {
    const configured = path.resolve(process.env.ANALYSIS_SERVICE_JAR);
    if (!fs.existsSync(configured)) {
      throw new Error(`ANALYSIS_SERVICE_JAR does not exist: ${configured}`);
    }
    return configured;
  }

  const targetDir = path.resolve(ANALYSIS_SERVICE_DIR, 'target');
  if (!fs.existsSync(targetDir)) return null;
  const candidates = fs.readdirSync(targetDir)
    .filter((name) => /^unfallatlas-analysis-service-.*\.jar$/.test(name))
    .filter((name) => !/-(?:sources|javadoc)\.jar$/.test(name))
    .map((name) => {
      const filePath = path.resolve(targetDir, name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.filePath || null;
}

async function createAnalysisServiceBuilder(GenericContainer) {
  if (process.env.ANALYSIS_SERVICE_IMAGE) {
    return {
      builder: new GenericContainer(process.env.ANALYSIS_SERVICE_IMAGE),
      source: `image ${process.env.ANALYSIS_SERVICE_IMAGE}`
    };
  }

  const jarPath = findAnalysisServiceJar();
  if (jarPath) {
    return {
      builder: new GenericContainer(ANALYSIS_SERVICE_RUNTIME_IMAGE)
        .withBindMounts([{
          source: jarPath,
          target: '/app/app.jar',
          mode: 'ro'
        }])
        .withCommand(['java', '-jar', '/app/app.jar']),
      source: `prebuilt JAR ${jarPath}`
    };
  }

  return {
    builder: await GenericContainer.fromDockerfile(ANALYSIS_SERVICE_DIR).build(
      ANALYSIS_SERVICE_IMAGE_TAG,
      { deleteOnExit: false }
    ),
    source: `local Dockerfile ${path.resolve(ANALYSIS_SERVICE_DIR, 'Dockerfile')}`
  };
}

async function startAnalysisServiceContainer() {
  const { GenericContainer, Wait } = await loadTestcontainers();
  const { builder, source } = await createAnalysisServiceBuilder(GenericContainer);
  let serviceLogs = '';
  let container;
  try {
    container = await builder
      .withEnvironment({
        SPRING_PROFILES_ACTIVE: 'dev',
        PORT: String(ANALYSIS_PORT)
      })
      .withExposedPorts(ANALYSIS_PORT)
      .withWaitStrategy(Wait.forHttp('/actuator/health', ANALYSIS_PORT).forStatusCode(200))
      .withLogConsumer((stream) => {
        stream.on('data', (chunk) => {
          serviceLogs = `${serviceLogs}${Buffer.from(chunk).toString('utf8')}`.slice(-40_000);
        });
      })
      .withStartupTimeout(180_000)
      .start();
  } catch (error) {
    throw new Error([
      `Analysis Service failed to start from ${source}: ${error.message}`,
      '--- Analysis Service log tail ---',
      serviceLogs.trim() || '(no container logs captured)'
    ].join('\n'), { cause: error });
  }

  const baseUrl = `http://${container.getHost()}:${container.getMappedPort(ANALYSIS_PORT)}`;
  return {
    baseUrl,
    stop: async () => { try { await container.stop({ timeout: 10 }); } catch (_) {} }
  };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

async function getJson(url) {
  const res = await fetch(url);
  const json = await res.json();
  return { status: res.status, body: json };
}

async function waitForCompleted(baseUrl, executionId) {
  for (let i = 0; i < 40; i++) {
    const status = await getJson(`${baseUrl}/api/batch/jobs/${executionId}`);
    expect(status.status).toBe(200);
    if (status.body.status === 'COMPLETED') return status.body;
    if (status.body.status === 'FAILED' || status.body.status === 'STOPPED') {
      throw new Error(`batch job ${executionId} failed with status=${status.body.status}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`batch job ${executionId} did not finish in time`);
}

SUITE_DESCRIBE('Golden-Case QA: Location Brief + Persistenz + City Ranking', () => {
  let handle;

  beforeAll(async () => {
    const probe = await isDockerAvailable();
    if (!probe.available) throw new Error(`Docker unavailable: ${probe.reason}`);
    handle = await startAnalysisServiceContainer();
  }, 20 * 60 * 1000);

  afterAll(async () => {
    if (handle) await handle.stop();
  });

  test('prüft reale Bonn/Hannover-Cases inkl. Ranking, Evidenz und Stub-Transparenz', async () => {
    const artifact = {
      profile: PROFILE.profile,
      generatedAt: new Date().toISOString(),
      pipelineRoles: {
        nodeComputesLocationBriefs: true,
        analysisServiceComputeAndStoreIsStub: true,
        analysisServicePersistsAndRanks: true
      },
      cities: []
    };

    for (const cityDef of PROFILE.cities) {
      const scored = [];
      let stubCheckDone = false;

      for (const c of cityDef.cases) {
        const fullCase = { ...c, city: cityDef.city };
        const structured = buildStructuredFromCase(fullCase);
        expect(structured.severity.total).toBeGreaterThanOrEqual(c.expectedMinAccidents);

        const brief = buildLocationBrief({
          structured,
          locationId: `${cityDef.city.toLowerCase()}::${c.caseId}`,
          profile: PROFILE.profile,
          contextHints: c.contextHints,
          politicalContext: c.politicalContext
        });

        const allText = [
          brief.problemSummary,
          ...(brief.uncertainties?.notes || []),
          ...brief.conflictPatterns.map((p) => p.rationale || '')
        ].join(' ');
        for (const forbidden of (c.mustNotContainClaims || [])) {
          expect(allText).not.toContain(forbidden);
        }

        const patternIds = brief.conflictPatterns.map((p) => p.id);
        for (const expectedPattern of (c.expectedPatterns || [])) {
          expect(patternIds).toContain(expectedPattern);
          const pat = brief.conflictPatterns.find((p) => p.id === expectedPattern);
          expect(Array.isArray(pat.evidence)).toBe(true);
          expect(pat.evidence.length).toBeGreaterThan(0);
        }

        if (Array.isArray(c.expectedMeasureIdsAnyOf) && c.expectedMeasureIdsAnyOf.length > 0) {
          const measureIds = [
            ...brief.recommendedMeasures.map((m) => m.id),
            ...brief.candidateMeasures.map((m) => m.id)
          ];
          expect(c.expectedMeasureIdsAnyOf.some((id) => measureIds.includes(id))).toBe(true);
        }

        for (const forbiddenMeasure of (c.mustNotHaveMeasureIds || [])) {
          const measureIds = brief.recommendedMeasures.map((m) => m.id);
          expect(measureIds).not.toContain(forbiddenMeasure);
        }

        for (const m of brief.recommendedMeasures) {
          expect(typeof m.whyPreselected).toBe('string');
          expect(m.whyPreselected.length).toBeGreaterThan(0);
          const hasSpecificReason = (m.matchedConflictPatterns || []).length > 0 || (m.matchedRiskFactors || []).length > 0;
          expect(hasSpecificReason || /datenlage|vor[- ]?ort|monitoring/i.test(m.whyPreselected)).toBe(true);
        }

        if (c.expectedWeakDataBasis) {
          expect(brief.uncertainties.weakDataBasis).toBe(true);
          expect(brief.confidence.overall).toBe('low');
        }

        if (c.expectPolicyReadiness) {
          expect(brief.politicalContext.policyReadiness).toBe(c.expectPolicyReadiness);
        }
        if (c.expectPolicyReadinessMin) {
          expect(PROFILE_RANK[brief.politicalContext.policyReadiness]).toBeGreaterThanOrEqual(
            PROFILE_RANK[c.expectPolicyReadinessMin]
          );
        }

        const ingestPayload = toIngestPayload(brief, {
          locationId: `${cityDef.city.toLowerCase()}::${c.caseId}`,
          city: cityDef.city,
          areaName: c.description,
          profile: PROFILE.profile
        });

        if (!stubCheckDone) {
          const stubResp = await postJson(`${handle.baseUrl}/api/location-briefs/compute-and-store`, ingestPayload);
          expect(stubResp.status).toBe(201);
          expect(stubResp.body.problemSummary).toBe(ingestPayload.problemSummary);
          expect(stubResp.body.locationKey).toBe(`${cityDef.city.toLowerCase()}::${c.caseId}`);
          stubCheckDone = true;
        } else {
          const ingestResp = await postJson(`${handle.baseUrl}/api/location-briefs`, ingestPayload);
          expect(ingestResp.status).toBe(201);
          expect(ingestResp.body.locationKey).toBe(`${cityDef.city.toLowerCase()}::${c.caseId}`);
        }

        scored.push({
          caseId: c.caseId,
          kind: c.kind,
          locationKey: `${cityDef.city.toLowerCase()}::${c.caseId}`,
          score: brief.deterministicFindings.activeProfileScore.total,
          patterns: patternIds,
          measures: brief.recommendedMeasures.map((m) => m.id)
        });
      }

      const start = await postJson(`${handle.baseUrl}/api/batch/jobs/city-prioritization`, {
        city: cityDef.city,
        profile: PROFILE.profile,
        recomputeExisting: false,
        limit: 20,
        runLabel: `golden-case-${cityDef.city.toLowerCase()}`
      });
      expect(start.status).toBe(202);
      const executionId = start.body.executionId;
      expect(executionId).toBeTruthy();

      await waitForCompleted(handle.baseUrl, executionId);
      const rankingResp = await getJson(`${handle.baseUrl}/api/batch/jobs/${executionId}/ranking`);
      expect(rankingResp.status).toBe(200);

      const rankByKey = new Map(rankingResp.body.items.map((it) => [it.locationKey, it.rankPosition]));
      const positiveRanks = [];
      const cityArtifact = { city: cityDef.city, executionId, cases: [] };

      for (const c of cityDef.cases) {
        const locationKey = `${cityDef.city.toLowerCase()}::${c.caseId}`;
        const rank = rankByKey.get(locationKey);
        expect(Number.isFinite(rank)).toBe(true);

        if (c.kind === 'positive') {
          expect(rank).toBeLessThanOrEqual(c.expectedTopN);
          positiveRanks.push(rank);
        }

        cityArtifact.cases.push({
          caseId: c.caseId,
          kind: c.kind,
          rank,
          score: scored.find((s) => s.caseId === c.caseId).score,
          patterns: scored.find((s) => s.caseId === c.caseId).patterns,
          measures: scored.find((s) => s.caseId === c.caseId).measures,
          passed: true,
          notes: []
        });
      }

      for (const c of cityDef.cases.filter((x) => x.kind === 'negative')) {
        const negRank = rankByKey.get(`${cityDef.city.toLowerCase()}::${c.caseId}`);
        expect(negRank).toBeGreaterThan(Math.max(...positiveRanks));
      }

      artifact.cities.push(cityArtifact);
    }

    if (process.env.GOLDEN_CASE_QA_ARTIFACT_PATH) {
      const artifactPath = path.resolve(process.env.GOLDEN_CASE_QA_ARTIFACT_PATH);
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    }
  }, 15 * 60 * 1000);
});
