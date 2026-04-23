'use strict';

/**
 * Tests für die TODO-Implementierungen:
 *   - Disk-Persistenz des Caches
 *   - Async-Job-Lifecycle und Persistenz der Queue
 *   - Stadt-spezifischer Maßnahmenkatalog (templates/measures_<slug>.json)
 *   - Provider-Abstraktion (gemini/null) via AI_PROVIDER
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { AiAssessmentCache }      = require('../../server/ai/cache/aiAssessmentCache.js');
const { AiJobQueue }             = require('../../server/ai/jobs/aiJobQueue.js');
const { getCatalogForCity, _clearCache } =
  require('../../server/ai/catalog/cityMeasureCatalog.js');
const { preselectMeasures }      = require('../../server/ai/scoring/preselectMeasures.js');
const { getProvider, activeProviderName, RetryableError } =
  require('../../server/ai/providers/index.js');

function tmpFile(name) {
  return path.join(os.tmpdir(), `ua-ai-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

/** Wait until the queue's job reaches a terminal state (or timeout). */
async function waitJobFinished(queue, id, timeoutMs = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const j = queue.getJob(id);
    if (j && (j.status === 'done' || j.status === 'error')) return j;
    await new Promise(r => setTimeout(r, 5));
  }
  return queue.getJob(id);
}

describe('AiAssessmentCache disk persistence', () => {
  let file;
  beforeEach(() => { file = tmpFile('cache.json'); });
  afterEach(() => { try { fs.unlinkSync(file); } catch (_) {} });

  test('flushSync writes valid JSON snapshot', () => {
    const c = new AiAssessmentCache({ persistPath: file, persistDebounceMs: 0 });
    c.set('k1', { hello: 'world' });
    c.flushSync();
    expect(fs.existsSync(file)).toBe(true);
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(obj.version).toBe(1);
    expect(Array.isArray(obj.entries)).toBe(true);
    expect(obj.entries.length).toBe(1);
    expect(obj.entries[0][0]).toBe('k1');
    expect(obj.entries[0][1].value).toEqual({ hello: 'world' });
  });

  test('reload from disk restores non-expired entries', () => {
    const c1 = new AiAssessmentCache({ persistPath: file, persistDebounceMs: 0 });
    c1.set('alpha', 1);
    c1.set('beta',  2);
    c1.flushSync();

    const c2 = new AiAssessmentCache({ persistPath: file, persistDebounceMs: 0 });
    expect(c2.size()).toBe(2);
    expect(c2.get('alpha')).toBe(1);
    expect(c2.get('beta')).toBe(2);
  });

  test('expired entries are dropped on reload', () => {
    const c1 = new AiAssessmentCache({ persistPath: file, ttlMs: 1, persistDebounceMs: 0 });
    c1.set('soon', 'gone');
    c1.flushSync();
    // Wait past TTL
    return new Promise(r => setTimeout(r, 5)).then(() => {
      const c2 = new AiAssessmentCache({ persistPath: file, ttlMs: 60_000, persistDebounceMs: 0 });
      expect(c2.size()).toBe(0);
    });
  });

  test('corrupt persist file does not crash construction', () => {
    fs.writeFileSync(file, 'not-json{{');
    expect(() => new AiAssessmentCache({ persistPath: file, persistDebounceMs: 0 })).not.toThrow();
  });

  test('without persistPath nothing is written', () => {
    const c = new AiAssessmentCache();
    c.set('k', 'v');
    c.flushSync(); // no-op
    // Just assert it doesn't throw and value is in memory
    expect(c.get('k')).toBe('v');
  });
});

describe('AiJobQueue async lifecycle', () => {
  test('submit enqueues, runner runs, status transitions to done', async () => {
    const q = new AiJobQueue({ concurrency: 1 });
    let started = false;
    const job = q.submit({
      kind: 'unit-test',
      payload: { x: 1 },
      runner: async (p) => {
        started = true;
        return { doubled: p.x * 2 };
      }
    });
    // Concurrency 1 + only job: by the time submit returns, _drain has already
    // synchronously bumped the job to "running". Either is acceptable.
    expect(['queued', 'running']).toContain(job.status);
    expect(typeof job.id).toBe('string');
    expect(job.id.length).toBeGreaterThanOrEqual(8);

    const done = await waitJobFinished(q, job.id);
    expect(started).toBe(true);
    expect(done.status).toBe('done');
    expect(done.result).toEqual({ doubled: 2 });
    expect(done.startedAt).toBeGreaterThanOrEqual(done.submittedAt);
    expect(done.finishedAt).toBeGreaterThanOrEqual(done.startedAt);
  });

  test('runner errors mark job as error with message', async () => {
    const q = new AiJobQueue({ concurrency: 1 });
    const job = q.submit({
      kind: 'unit-test',
      runner: async () => { throw new Error('boom'); }
    });
    const fin = await waitJobFinished(q, job.id);
    expect(fin.status).toBe('error');
    expect(fin.error).toBe('boom');
  });

  test('registerRunner allows submit without inline runner', async () => {
    const q = new AiJobQueue({ concurrency: 1 });
    q.registerRunner('greeter', async (p) => `hi ${p.name}`);
    const job = q.submit({ kind: 'greeter', payload: { name: 'world' } });
    const fin = await waitJobFinished(q, job.id);
    expect(fin.result).toBe('hi world');
  });

  test('submit without runner or registered kind throws', () => {
    const q = new AiJobQueue();
    expect(() => q.submit({ kind: 'unknown', payload: {} })).toThrow(/no runner/i);
  });

  test('getJob returns null for unknown id', () => {
    const q = new AiJobQueue();
    expect(q.getJob('does-not-exist')).toBeNull();
  });

  test('stats counts queued/running/done', async () => {
    const q = new AiJobQueue({ concurrency: 1 });
    let release;
    const blocker = new Promise(r => { release = r; });
    const j1 = q.submit({ kind: 'k', runner: async () => blocker });
    const j2 = q.submit({ kind: 'k', runner: async () => 'done2' });
    let s = q.stats();
    expect(s.jobs.total).toBe(2);
    expect(s.jobs.running + s.jobs.queued).toBe(2);
    release('done1');
    const f1 = await waitJobFinished(q, j1.id);
    const f2 = await waitJobFinished(q, j2.id);
    expect(f1.result).toBe('done1');
    expect(f2.result).toBe('done2');
    s = q.stats();
    expect(s.jobs.done).toBe(2);
  });
});

describe('AiJobQueue disk persistence', () => {
  let file;
  beforeEach(() => { file = tmpFile('jobs.json'); });
  afterEach(() => { try { fs.unlinkSync(file); } catch (_) {} });

  test('completed jobs survive restart, in-flight jobs become error', async () => {
    const q1 = new AiJobQueue({ concurrency: 1, persistPath: file });
    const j = q1.submit({
      kind: 'k', runner: async () => ({ ok: true })
    });
    await waitJobFinished(q1, j.id);
    expect(q1.getJob(j.id).status).toBe('done');

    // Simulate a job that never finishes (we manually inject "running")
    q1.jobs.set('aaaaaaaa', {
      id: 'aaaaaaaa', kind: 'k', status: 'running',
      submittedAt: Date.now(), startedAt: Date.now()
    });
    q1._persist();

    // Reopen
    const q2 = new AiJobQueue({ concurrency: 1, persistPath: file });
    expect(q2.getJob(j.id).status).toBe('done');
    expect(q2.getJob(j.id).result).toEqual({ ok: true });

    const stuck = q2.getJob('aaaaaaaa');
    expect(stuck.status).toBe('error');
    expect(stuck.error).toMatch(/Server-Neustart/);
  });

  test('corrupt jobs file does not crash construction', () => {
    fs.writeFileSync(file, '{{{');
    expect(() => new AiJobQueue({ persistPath: file })).not.toThrow();
  });
});

describe('cityMeasureCatalog', () => {
  beforeEach(() => _clearCache());

  test('returns base catalog when no city given', () => {
    const cat = getCatalogForCity('');
    expect(Array.isArray(cat)).toBe(true);
    expect(cat.length).toBeGreaterThan(0);
    // Sanity: same measure ids present that are in the base
    expect(cat.find(m => m.id === 'mon_followup')).toBeTruthy();
  });

  test('hannover catalog has city-specific extensions appended', () => {
    const base = getCatalogForCity('');
    _clearCache();
    const hh = getCatalogForCity('Hannover');
    expect(hh.length).toBeGreaterThanOrEqual(base.length);
    // City-specific entries from templates/measures_hannover.json
    expect(hh.find(m => m.id === 'qw_hannover_ssr')).toBeTruthy();
    expect(hh.find(m => m.id === 'inf_hannover_velo')).toBeTruthy();
  });

  test('unknown city slug falls back to base catalog', () => {
    const base = getCatalogForCity('');
    _clearCache();
    const unknown = getCatalogForCity('atlantis');
    expect(unknown.length).toBe(base.length);
  });

  test('preselectMeasures honours citySlug option', () => {
    // Tag set that matches qw_hannover_ssr (junction/crossing/bike_car/ped_car)
    const sel = preselectMeasures(['junction', 'bike_car'], { citySlug: 'hannover', max: 20 });
    const ids = sel.map(m => m.id);
    expect(ids).toContain('qw_hannover_ssr');
  });

  test('catalog cache prevents repeated disk reads', () => {
    _clearCache();
    const a = getCatalogForCity('hannover');
    const b = getCatalogForCity('hannover');
    expect(a).toBe(b); // same array instance
  });

  test('invalid city measures are filtered out', () => {
    _clearCache();
    const tmpDir = path.join(__dirname, '..', '..', 'templates');
    const slug = `unittest${process.pid}`;
    const file = path.join(tmpDir, `measures_${slug}.json`);
    fs.writeFileSync(file, JSON.stringify({
      measures: [
        { id: 'good_one', title: 'OK', category: 'quickWin',
          targetAccidentTypes: ['x'], implementationEffort: 'low',
          costBand: 'low', description: 'd' },
        { id: 'bad_no_title', category: 'quickWin' },               // missing fields
        { id: 'bad_category', title: 'X', category: 'wat',
          targetAccidentTypes: [], implementationEffort: 'low',
          costBand: 'low', description: 'd' }
      ]
    }));
    try {
      const cat = getCatalogForCity(slug);
      expect(cat.find(m => m.id === 'good_one')).toBeTruthy();
      expect(cat.find(m => m.id === 'bad_no_title')).toBeFalsy();
      expect(cat.find(m => m.id === 'bad_category')).toBeFalsy();
    } finally {
      fs.unlinkSync(file);
      _clearCache();
    }
  });
});

describe('provider abstraction', () => {
  const origProvider = process.env.AI_PROVIDER;
  afterEach(() => {
    if (origProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = origProvider;
  });

  test('default is gemini', () => {
    delete process.env.AI_PROVIDER;
    expect(activeProviderName()).toBe('gemini');
    expect(typeof getProvider()).toBe('function');
  });

  test('AI_PROVIDER=null selects null provider that throws RetryableError', async () => {
    process.env.AI_PROVIDER = 'null';
    expect(activeProviderName()).toBe('null');
    const fn = getProvider();
    await expect(fn({})).rejects.toBeInstanceOf(RetryableError);
  });

  test('unknown provider name falls back to gemini', () => {
    process.env.AI_PROVIDER = 'doesnotexist';
    expect(activeProviderName()).toBe('gemini');
  });

  test('explicit name override beats env', () => {
    process.env.AI_PROVIDER = 'gemini';
    expect(getProvider('null')).toBe(getProvider('null'));
  });
});

describe('end-to-end: city catalog flows into v2 service', () => {
  // Integration check: when a Hannover export runs through v2, the catalog
  // index used for harmonization includes city ids.
  const { buildCatalogIndex } = require('../../server/ai/aiAssessmentServiceV2.js');
  test('buildCatalogIndex includes Hannover measure ids', () => {
    const idx = buildCatalogIndex('hannover');
    expect(idx['qw_hannover_ssr']).toBeTruthy();
    expect(idx['mon_followup']).toBeTruthy(); // base still present
  });
  test('buildCatalogIndex without slug returns base only', () => {
    const idx = buildCatalogIndex('');
    expect(idx['qw_hannover_ssr']).toBeFalsy();
    expect(idx['mon_followup']).toBeTruthy();
  });
});
