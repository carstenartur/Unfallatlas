'use strict';

const fs = require('fs');
const path = require('path');
const { buildLocationBrief } = require('../server/location-brief');
const { toIngestPayload } = require('../server/analysis-service/analysisServiceClient');
const { buildStructuredFromCase } = require('./lib/location-brief-golden-case-data');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.resolve(ROOT, process.env.GOLDEN_CASE_FIXTURE_DIR || '.build/location-brief-golden');
const PROFILE = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'tests/fixtures/location-brief-golden-cases.json'),
  'utf8'
));

fs.rmSync(OUTPUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUTPUT, 'payloads'), { recursive: true });

const index = {
  schemaVersion: 1,
  profile: PROFILE.profile,
  generatedAt: new Date().toISOString(),
  producer: 'server/location-brief + analysisServiceClient.toIngestPayload',
  cities: [],
};

for (const cityDefinition of PROFILE.cities) {
  const city = { city: cityDefinition.city, cases: [] };
  for (const goldenCase of cityDefinition.cases) {
    const fullCase = { ...goldenCase, city: cityDefinition.city };
    const structured = buildStructuredFromCase(fullCase);
    const locationKey = `${cityDefinition.city.toLowerCase()}::${goldenCase.caseId}`;
    const brief = buildLocationBrief({
      structured,
      locationId: locationKey,
      profile: PROFILE.profile,
      contextHints: goldenCase.contextHints,
      politicalContext: goldenCase.politicalContext,
    });
    const payload = toIngestPayload(brief, {
      locationId: locationKey,
      city: cityDefinition.city,
      areaName: goldenCase.description,
      profile: PROFILE.profile,
    });
    const fileName = `${cityDefinition.city}-${goldenCase.caseId}`
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') + '.json';
    const relativePayload = `payloads/${fileName}`;
    fs.writeFileSync(
      path.join(OUTPUT, relativePayload),
      `${JSON.stringify(payload, null, 2)}\n`,
      'utf8'
    );
    city.cases.push({
      caseId: goldenCase.caseId,
      kind: goldenCase.kind,
      expectedTopN: goldenCase.expectedTopN || null,
      locationKey,
      payload: relativePayload,
      score: brief.deterministicFindings.activeProfileScore.total,
      patterns: brief.conflictPatterns.map(pattern => pattern.id),
      measures: brief.recommendedMeasures.map(measure => measure.id),
    });
  }
  index.cities.push(city);
}

fs.writeFileSync(path.join(OUTPUT, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
console.log(`[location-brief-golden] Prepared ${index.cities.reduce((sum, city) => sum + city.cases.length, 0)} payloads in ${path.relative(ROOT, OUTPUT)}`);
