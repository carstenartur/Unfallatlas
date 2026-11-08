/** @jest-environment node */
'use strict';
const { composeHannoverCatalogue } = require('../../server/political-context/providers/hannoverCatalogueComposition');
const { sourceProjectionFingerprint, collectionProvenance } = require('../../server/political-context/services/risProvenance');
const { REGION_CATALOGUE_STATUS } = require('../../server/political-context/providers/hannoverAdditionalSources');
const { parseLandtagCatalogue } = require('../../server/political-context/providers/hannoverAdditionalFormats');
const fs = require('node:fs');
const path = require('node:path');
const NOW = new Date('2026-11-08T12:00:00.000Z');
const local = () => parseLandtagCatalogue(fs.readFileSync(path.join(__dirname, '../fixtures/political-sources/landtag-catalogue.html'), 'utf8'), 'https://www.landtag-niedersachsen.de/dokumentensuche/').records[0];
const sim = () => ({ records: [{ id: 'sim1', title: 'Radverkehr Eilenriede', type: 'Antrag', number: '12/2026', date: '2026-03-01', gremium: 'Rat',
  url: 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/12-2026', source: 'hannover-sim' }],
  generatedAt: '2026-11-08T11:00:00.000Z', sources: ['https://e-government.hannover-stadt.de/lhhsimwebre.nsf/Suche.xsp'],
  coverage: { from: '2014-01-01', to: '2026-11-08', complete: true, scope: 'citywide', bodies: ['Rat'], warnings: [] },
  history: { pending: 1, interrupted: true }, provenance: { rights: { status: 'not-specified', license: null, attribution: [] }, collection: { pages: 4, rawItems: 10 } } });

test('build composition preserves SIM history and adds usable records with isolated coverage and oldest verified source clock', () => {
  const status = { source: 'landtag-catalogue', status: 'partial', url: 'https://www.landtag-niedersachsen.de/dokumentensuche/',
    retrievedAt: '2026-11-07T10:00:00.000Z', from: null, to: null, recordCount: 1, message: 'A single partition only' };
  const result = composeHannoverCatalogue(sim(), { records: [local()], sources: [status.url, REGION_CATALOGUE_STATUS.url], sourceStatuses: [status, REGION_CATALOGUE_STATUS],
    generatedAt: status.retrievedAt }, { now: NOW });
  expect(result.records).toHaveLength(2);
  expect(result.records[1]).toMatchObject({ number: '19/8980', type: 'Verwaltungsantwort', sourceContext: { level: 'state', status: 'answer' } });
  expect(result.records[0]).toMatchObject({ sourceContext: { level: 'city' } });
  expect(result.generatedAt).toBe('2026-11-07T10:00:00.000Z');
  expect(result.history).toEqual({ pending: 1, interrupted: true });
  expect(result.coverage.complete).toBe(false);
  expect(result.coverage.scope).toBe('citywide');
  expect(result.sourceStatuses).toEqual(expect.arrayContaining([status, REGION_CATALOGUE_STATUS, expect.objectContaining({ source: 'hannover-sim', status: 'available', recordCount: 1 })]));
  const provenance = collectionProvenance({ catalogue: result, city: 'hannover', records: result.records, sourceRecords: result.records, sourceVerifiedAt: result.generatedAt, now: NOW });
  expect(provenance.provider).toBe('hannover-official-sources');
});

test('source identity and date-role changes alter provenance independently of derived geometry', () => {
  const first = local();
  const altered = { ...first, sourceContext: { ...first.sourceContext, issuer: 'Landesregierung', documentDate: '2025-11-10' } };
  expect(sourceProjectionFingerprint([first]).sha256).not.toBe(sourceProjectionFingerprint([altered]).sha256);
  expect(sourceProjectionFingerprint([first]).sha256).toBe(sourceProjectionFingerprint([{ ...first, geometry: { type: 'Point', coordinates: [9,52] } }]).sha256);
  expect(sourceProjectionFingerprint([first]).sha256).not.toBe(sourceProjectionFingerprint([{ ...first, originalPdfUrl: 'https://www.landtag-niedersachsen.de/updated.pdf' }]).sha256);
});

test('a failed empty supplementary checkpoint cannot expire a fresh city catalogue', () => {
  const status = { source: 'landtag-rss', status: 'failed', url: 'https://www.landtag-niedersachsen.de/rss/drucksachen.xml',
    retrievedAt: '2026-01-01T00:00:00.000Z', from: null, to: null, recordCount: 0, message: 'Retained empty checkpoint; refresh failed' };
  const result = composeHannoverCatalogue(sim(), { records: [], sourceStatuses: [status] }, { now: NOW });
  expect(result.generatedAt).toBe(sim().generatedAt);
  expect(result.sourceStatuses).toContainEqual(status);
  expect(result.coverage.complete).toBe(false);
});


test('public event and relationship evidence participates in the source projection', () => {
  const first = local();
  const events = [{ date: '2025-11-10', body: null, outcome: null, url: first.url, evidence: 'Original public event row' }];
  const relationships = [{ type: 'related', targetId: null, targetUrl: first.url, label: 'Anfrage 19/8641', targetRole: 'proposal', evidence: 'Official related document link' }];
  const base = sourceProjectionFingerprint([first]).sha256;
  expect(sourceProjectionFingerprint([{ ...first, events }]).sha256).not.toBe(base);
  expect(sourceProjectionFingerprint([{ ...first, relationships }]).sha256).not.toBe(base);
});
