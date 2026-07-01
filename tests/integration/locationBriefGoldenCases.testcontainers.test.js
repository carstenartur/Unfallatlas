'use strict';

const fs = require('fs');
const path = require('path');
const { buildLocationBrief } = require('../../server/location-brief');
const { toIngestPayload } = require('../../server/analysis-service/analysisServiceClient');
const { isDockerAvailable } = require('./lib/startUnfallatlasContainer');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ANALYSIS_PORT = 8081;
const PROFILE_RANK = { low: 0, medium: 1, high: 2 };
const PROFILE = JSON.parse(fs.readFileSync(
  path.resolve(REPO_ROOT, 'tests/fixtures/location-brief-golden-cases.json'),
  'utf8'
));

const BIT_MASK = Object.freeze({
  istrad: 1,
  istfuss: 2,
  istpkw: 4,
  istkrad: 8,
  istgkfz: 16,
  istsonstig: 32
});
const BIT_MASK_FIELDS = Object.freeze({
  istrad: ['istrad', 'IstRad'],
  istfuss: ['istfuss', 'IstFuss'],
  istpkw: ['istpkw', 'IstPKW'],
  istkrad: ['istkrad', 'IstKrad'],
  istgkfz: ['istgkfz', 'IstGkfz'],
  istsonstig: ['istsonstig', 'IstSonstig']
});
const CITY_GEOJSON_CACHE = new Map();

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

async function startAnalysisServiceContainer() {
  const { GenericContainer, Wait } = await loadTestcontainers();
  const allowInsecureMavenSsl = process.env.TESTCONTAINERS_MAVEN_INSECURE_SSL === '1';
  const mavenCommand = [
    'mvn -q',
    ...(allowInsecureMavenSsl ? [
      '-Dmaven.wagon.http.ssl.insecure=true',
      '-Dmaven.wagon.http.ssl.allowall=true'
    ] : []),
    '-DskipTests',
    'spring-boot:run',
    '-Dspring-boot.run.jvmArguments="-Dserver.port=8081 -Dspring.profiles.active=dev"'
  ].join(' ');
  const container = await new GenericContainer('maven:3.9-eclipse-temurin-21')
    .withBindMounts([{
      source: path.resolve(REPO_ROOT, 'analysis-service'),
      target: '/workspace',
      mode: 'rw'
    }])
    .withCommand([
      'bash',
      '-lc',
      [
        'cd /workspace',
        mavenCommand
      ].join(' ')
    ])
    .withExposedPorts(ANALYSIS_PORT)
    .withWaitStrategy(Wait.forHttp('/actuator/health', ANALYSIS_PORT).forStatusCode(200))
    .withStartupTimeout(300_000)
    .start();

  const baseUrl = `http://${container.getHost()}:${container.getMappedPort(ANALYSIS_PORT)}`;
  return {
    baseUrl,
    stop: async () => { try { await container.stop({ timeout: 10 }); } catch (_) {} }
  };
}

function asInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function getCaseInsensitiveProp(props, names) {
  if (!props || !Array.isArray(names) || names.length === 0) return undefined;
  for (const name of names) {
    if (props[name] !== undefined) return props[name];
  }
  const byLowerName = new Map(Object.entries(props).map(([k, v]) => [String(k).toLowerCase(), v]));
  for (const name of names) {
    const v = byLowerName.get(String(name).toLowerCase());
    if (v !== undefined) return v;
  }
  return undefined;
}

function loadCityGeoJson(citySlug) {
  if (!CITY_GEOJSON_CACHE.has(citySlug)) {
    const geo = JSON.parse(fs.readFileSync(
      path.resolve(REPO_ROOT, `out/output_all_years_${citySlug}.geojson`),
      'utf8'
    ));
    CITY_GEOJSON_CACHE.set(citySlug, geo);
  }
  return CITY_GEOJSON_CACHE.get(citySlug);
}

function buildStructuredFromCase(caseDef) {
  const citySlug = caseDef.city.toLowerCase();
  const geo = loadCityGeoJson(citySlug);

  const points = geo.features.filter((f) => {
    const [lon, lat] = f.geometry.coordinates;
    return lat >= caseDef.bbox.south
      && lat <= caseDef.bbox.north
      && lon >= caseDef.bbox.west
      && lon <= caseDef.bbox.east;
  });

  const byYear = new Map();
  const byMask = new Map();
  const details = [];
  let fatal = 0;
  let serious = 0;
  let slight = 0;

  for (const f of points) {
    const p = f.properties || {};
    const sev = asInt(getCaseInsensitiveProp(p, ['ukategorie', 'UKATEGORIE']));
    if (sev === 1) fatal++;
    else if (sev === 2) serious++;
    else slight++;

    const year = asInt(getCaseInsensitiveProp(p, ['year', 'UJAHR']));
    if (year > 0) byYear.set(year, (byYear.get(year) || 0) + 1);

    let mask = 0;
    for (const [k, bit] of Object.entries(BIT_MASK)) {
      if (asInt(getCaseInsensitiveProp(p, BIT_MASK_FIELDS[k])) > 0) mask |= bit;
    }
    if (mask > 0) {
      const row = byMask.get(mask) || {
        mask, label: String(mask), total: 0, sev1: 0, sev2: 0, sev3: 0
      };
      row.total++;
      if (sev === 1) row.sev1++;
      else if (sev === 2) row.sev2++;
      else row.sev3++;
      byMask.set(mask, row);
    }

    const [lon, lat] = f.geometry.coordinates;
    details.push({
      year,
      sevLabel: sev === 1 ? 'getötet' : sev === 2 ? 'schwer' : 'leicht',
      involved: String(mask),
      hour: asInt(getCaseInsensitiveProp(p, ['ustunde', 'USTUNDE'])),
      lat,
      lon
    });
  }

  const total = points.length;
  const crossRows = [...byMask.values()].sort((a, b) => b.total - a.total);
  return {
    meta: {
      city: caseDef.city,
      areaName: caseDef.description,
      date: '01.01.2026',
      filters: { severity: 'all', roadCondition: 'all' },
      involvementMode: 'or'
    },
    severity: { total, bySev: { '1': fatal, '2': serious, '3': slight, other: 0 } },
    deviations: {
      focus: crossRows.map((r) => ({
        mask: r.mask,
        label: r.label,
        localCount: r.total,
        baselineCount: 1,
        relativeDiff: 1
      })),
      rows: []
    },
    yearTable: [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([year, n]) => ({ year, total: n })),
    poi: {
      withinByType: caseDef.poiWithinByType || {},
      nearByType: caseDef.poiNearByType || {},
      totalWithin: Object.values(caseDef.poiWithinByType || {}).reduce((s, x) => s + Number(x || 0), 0),
      totalNear: Object.values(caseDef.poiNearByType || {}).reduce((s, x) => s + Number(x || 0), 0)
    },
    references: [],
    crossTable: {
      rows: crossRows,
      totals: { sev1: fatal, sev2: serious, sev3: slight, total }
    },
    accidentDetails: {
      rows: details.slice(0, 200),
      total: details.length,
      truncated: details.length > 200
    }
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
  }, 10 * 60 * 1000);

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
      fs.writeFileSync(process.env.GOLDEN_CASE_QA_ARTIFACT_PATH, JSON.stringify(artifact, null, 2), 'utf8');
    }
  }, 15 * 60 * 1000);
});
