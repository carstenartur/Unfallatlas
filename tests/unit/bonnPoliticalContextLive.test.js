/** @jest-environment node */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { collectBonnCatalogue } = require('../../server/political-context/providers/bonnOparlClient.js');
const { writeRisSnapshot } = require('../../server/political-context/services/risSnapshot.js');
const { createRisSnapshotSearch } = require('../../server/political-context/services/risSnapshotSearch.js');

const ROOT = path.resolve(__dirname, '../..');
const QA_DIR = path.join(ROOT, 'out', 'qa');
const OUTPUT = path.join(QA_DIR, 'bonn-political-context-live.json');
const LIVE_ENABLED = process.env.BONN_OPARL_LIVE === '1';
const LIVE_SCOPE = process.env.BONN_OPARL_LIVE_SCOPE || 'archive';
const archiveTest = LIVE_ENABLED && LIVE_SCOPE === 'archive' ? test : test.skip;
const snapshotTest = LIVE_ENABLED && LIVE_SCOPE === 'snapshot' ? test : test.skip;
const LIVE_TERMS = ['Adenauerallee', 'Radverkehr'];
const SNAPSHOT_MAX_PAGES = 2;
const ARCHIVE_TIMEOUT_MS = 20 * 60_000;

if (LIVE_ENABLED && !['archive', 'snapshot'].includes(LIVE_SCOPE)) {
  throw new Error(`Unknown Bonn live QA scope: ${LIVE_SCOPE}`);
}

describe('official Bonn political-context live evidence', () => {
  snapshotTest('publishes and searches a bounded sample of official Bonn records', async () => {
    const options = { maxPages: SNAPSHOT_MAX_PAGES, requestOptions: { timeoutMs: 35_000 } };
    let catalogue = await collectBonnCatalogue(options);
    if (!catalogue.records.length) {
      console.warn('[bonn-ris-snapshot-live] Retrying empty catalogue:', catalogue.coverage.warnings);
      await delay(3000);
      catalogue = await collectBonnCatalogue(options);
    }
    expect(catalogue.coverage).toMatchObject({
      complete: false,
      from: expect.any(String),
      to: expect.any(String),
      warnings: expect.arrayContaining([expect.stringMatching(/Paper-Liste.*Seitenlimit/)])
    });
    const example = catalogue.records.find(record => record.number && record.date);
    expect(example).toBeDefined();

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bonn-ris-live-'));
    try {
      const manifest = await writeRisSnapshot(directory, 'bonn', catalogue);
      const search = createRisSnapshotSearch(directory);
      const result = await search({ city: 'Bonn', searchTerms: [example.number] });
      const reference = result.references.find(record => record.id === example.id);
      expect(reference).toMatchObject({ number: example.number, title: example.title, url: example.url });
      expect(result.meta).toMatchObject({
        sourceType: 'ris-snapshot', sourceFingerprint: manifest.records.sha256, searchStatus: 'partial-results'
      });
      const missing = await search({
        city: 'Bonn', searchTerms: [`ris-live-coverage-${manifest.records.sha256}`]
      });
      expect(missing).toMatchObject({ references: [], meta: { searchStatus: 'incomplete' } });

      fs.mkdirSync(QA_DIR, { recursive: true });
      fs.writeFileSync(path.join(QA_DIR, 'bonn-ris-snapshot-live.json'), JSON.stringify({
        scope: LIVE_SCOPE, maxPages: SNAPSHOT_MAX_PAGES, manifest, reference,
        searchStatus: result.meta.searchStatus, missingSearchStatus: missing.meta.searchStatus
      }, null, 2) + '\n');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);

  archiveTest('traverses OParl first and returns direct official references', () => {
    fs.mkdirSync(QA_DIR, { recursive: true });
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'qa-bonn-political-context-live.js'),
      '--terms', LIVE_TERMS.join(','),
      '--attempts', '2',
      '--retry-delay-ms', '3000',
      '--require-results',
      '--output', OUTPUT,
    ], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: ARCHIVE_TIMEOUT_MS,
    });

    const diagnostics = [result.stdout, result.stderr].filter(Boolean).join('\n');
    if (result.error || result.status !== 0) {
      throw new Error(
        `Bonn live QA process failed (status=${result.status}): `
        + `${result.error?.message || ''}\n${diagnostics}`
      );
    }
    expect(fs.existsSync(OUTPUT)).toBe(true);
    const evidence = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
    expect(evidence.passed).toBe(true);
    expect(evidence.attempts.length).toBeGreaterThan(0);
    const finalAttempt = evidence.attempts[evidence.attempts.length - 1];
    expect(finalAttempt.validationErrors).toEqual([]);
    expect(finalAttempt.result.references.length).toBeGreaterThan(0);
    const queryLog = finalAttempt.result.meta.queryLog;
    for (const term of LIVE_TERMS) {
      const entry = queryLog.find(item => item.query === term && Number(item.count) > 0);
      expect(entry).toEqual(expect.objectContaining({
        query: term,
        status: 'results-found',
      }));
    }
    expect(diagnostics).toContain('[bonn-political-context-live] PASS');
  }, ARCHIVE_TIMEOUT_MS + 60_000);
});
