'use strict';

/**
 * In-Memory-Queue für KI-Bewertungsanfragen, mit optionaler Disk-Persistenz
 * und asynchroner Job-Verwaltung (status/result für `GET /api/ai/jobs/:id`).
 *
 * Zwei Nutzungsweisen:
 *
 *   1) Synchron-style (wie bisher): `enqueue(workFn)` reiht eine asynchrone
 *      Arbeit ein und gibt ein Promise zurück.  Nutzt Concurrency-Limit, hat
 *      aber keinen abrufbaren Job-Status.  Für interne Aufrufe (z. B.
 *      sequenzielle Provider-Calls).
 *
 *   2) Async Job (neu): `submit({ kind, payload, runner })` legt einen Job an,
 *      gibt sofort `{ id, status: 'queued' }` zurück und führt `runner(payload)`
 *      später aus.  Status- und Result-Änderungen werden persistiert (sofern
 *      `persistPath`/`AI_JOBS_PATH` gesetzt).  Über `getJob(id)` kann man den
 *      Stand abfragen.  Abgeschlossene Jobs werden nach `jobTtlMs` (default 1h)
 *      automatisch verworfen, damit der Speicher nicht unbeschränkt wächst.
 *
 * Persistenz:
 *   Jobs werden bei Statuswechsel atomar (temp + rename) auf Disk geschrieben.
 *   Beim Konstruieren wird die Datei eingelesen; nicht abgeschlossene Jobs
 *   (status `queued` oder `running`) werden defensiv auf `error` gesetzt
 *   (Server-Neustart führt nicht zu „ewig laufendem" Job).
 *
 * @module server/ai/jobs/aiJobQueue
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_JOB_TTL_MS  = 60 * 60 * 1000; // 1h
const DEFAULT_MAX_JOBS    = 200;

/** @typedef {'queued'|'running'|'done'|'error'} JobStatus */

/**
 * @typedef {object} Job
 * @property {string}    id
 * @property {string}    kind
 * @property {JobStatus} status
 * @property {number}    submittedAt
 * @property {number}    [startedAt]
 * @property {number}    [finishedAt]
 * @property {object}    [payload]
 * @property {object}    [result]
 * @property {string}    [error]
 */

class AiJobQueue {
  /**
   * @param {object}   [opts]
   * @param {number}   [opts.concurrency]
   * @param {string}   [opts.persistPath]   – fällt sonst auf process.env.AI_JOBS_PATH zurück
   * @param {number}   [opts.jobTtlMs]      – wie lange abgeschlossene Jobs aufbewahrt werden
   * @param {number}   [opts.maxJobs]
   */
  constructor(opts = {}) {
    this.concurrency = Number.isFinite(opts.concurrency) && opts.concurrency > 0
      ? opts.concurrency
      : DEFAULT_CONCURRENCY;
    this.jobTtlMs = Number.isFinite(opts.jobTtlMs) && opts.jobTtlMs > 0
      ? opts.jobTtlMs : DEFAULT_JOB_TTL_MS;
    this.maxJobs  = Number.isFinite(opts.maxJobs)  && opts.maxJobs  > 0
      ? opts.maxJobs  : DEFAULT_MAX_JOBS;
    this.active  = 0;
    /** @type {Array<{work: Function, resolve: Function, reject: Function}>} */
    this.queue   = [];

    /** @type {Map<string, Job>} */
    this.jobs = new Map();
    /** @type {Array<{ id: string, runner: Function }>} */
    this._jobQueue = [];
    /** @type {Map<string, Function>} dynamic runner registrations by kind */
    this._kindRunners = new Map();

    const envPath = process.env.AI_JOBS_PATH;
    this.persistPath = opts.persistPath || (envPath && envPath.trim()) || null;
    if (this.persistPath) {
      try { this._loadFromDisk(); } catch (_) { /* ignore */ }
    }
  }

  // ── Sync-style (legacy/internal) ───────────────────────────────────────────

  /**
   * Stellt eine asynchrone Arbeit in die Queue.
   * @template T
   * @param {() => Promise<T>} workFn
   * @returns {Promise<T>}
   */
  enqueue(workFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ work: workFn, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    while (this.active < this.concurrency && (this.queue.length > 0 || this._jobQueue.length > 0)) {
      // Prefer FIFO between the two lists by submission order:
      // Sync enqueue() does not register jobs, so we just alternate – sync first if present.
      if (this.queue.length > 0) {
        const job = this.queue.shift();
        this.active++;
        Promise.resolve()
          .then(() => job.work())
          .then((value) => job.resolve(value))
          .catch((err)  => job.reject(err))
          .finally(() => { this.active--; this._drain(); });
      } else {
        const j = this._jobQueue.shift();
        if (!j) break;
        this._runJob(j.id, j.runner);
      }
    }
  }

  // ── Async Job API ──────────────────────────────────────────────────────────

  /**
   * Registriert einen "kind"-spezifischen Runner.
   * Nützlich, wenn submit() von einem HTTP-Handler nur kind+payload kennt.
   *
   * @param {string} kind
   * @param {(payload: object) => Promise<object>} runner
   */
  registerRunner(kind, runner) {
    this._kindRunners.set(kind, runner);
  }

  /**
   * Legt einen async Job an.
   * @param {object} args
   * @param {string} args.kind
   * @param {object} [args.payload]
   * @param {(payload: object) => Promise<object>} [args.runner]
   * @returns {Job}
   */
  submit({ kind, payload, runner }) {
    if (typeof kind !== 'string' || !kind) throw new Error('submit: kind required');
    const effectiveRunner = runner || this._kindRunners.get(kind);
    if (typeof effectiveRunner !== 'function') {
      throw new Error(`submit: no runner registered for kind "${kind}"`);
    }
    const id = crypto.randomBytes(12).toString('hex');
    /** @type {Job} */
    const job = {
      id, kind, status: 'queued',
      submittedAt: Date.now(),
      payload
    };
    this.jobs.set(id, job);
    this._jobQueue.push({ id, runner: effectiveRunner });
    this._reapOldJobs();
    this._persist();
    this._drain();
    return { ...job };
  }

  /**
   * @param {string} id
   * @returns {Job|null}
   */
  getJob(id) {
    const j = this.jobs.get(id);
    return j ? { ...j } : null;
  }

  async _runJob(id, runner) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'running';
    job.startedAt = Date.now();
    this._persist();
    this.active++;
    try {
      const result = await runner(job.payload);
      const fresh = this.jobs.get(id);
      if (fresh) {
        fresh.status = 'done';
        fresh.result = result;
        fresh.finishedAt = Date.now();
      }
    } catch (err) {
      const fresh = this.jobs.get(id);
      if (fresh) {
        fresh.status = 'error';
        fresh.error  = err && err.message ? err.message : String(err);
        fresh.finishedAt = Date.now();
      }
    } finally {
      this.active--;
      this._persist();
      this._drain();
    }
  }

  _reapOldJobs() {
    const now = Date.now();
    const ids = [...this.jobs.keys()];
    // Purge expired finished jobs
    for (const id of ids) {
      const j = this.jobs.get(id);
      if ((j.status === 'done' || j.status === 'error') &&
          j.finishedAt && (now - j.finishedAt) > this.jobTtlMs) {
        this.jobs.delete(id);
      }
    }
    // Hard cap on total
    while (this.jobs.size > this.maxJobs) {
      // Drop oldest finished first; if none, drop oldest queued
      let victim = null;
      let victimT = Infinity;
      for (const [id, j] of this.jobs) {
        if (j.status !== 'done' && j.status !== 'error') continue;
        if (j.submittedAt < victimT) { victim = id; victimT = j.submittedAt; }
      }
      if (!victim) {
        for (const [id, j] of this.jobs) {
          if (j.submittedAt < victimT) { victim = id; victimT = j.submittedAt; }
        }
      }
      if (!victim) break;
      this.jobs.delete(victim);
    }
  }

  /** Aktuelle Statistik – nützlich für Monitoring/Tests. */
  stats() {
    let queued = 0, running = 0, done = 0, error = 0;
    for (const j of this.jobs.values()) {
      if (j.status === 'queued')  queued++;
      else if (j.status === 'running') running++;
      else if (j.status === 'done')    done++;
      else if (j.status === 'error')   error++;
    }
    return {
      active: this.active,
      pending: this.queue.length + this._jobQueue.length,
      concurrency: this.concurrency,
      jobs: { total: this.jobs.size, queued, running, done, error }
    };
  }

  // ── Persistenz ─────────────────────────────────────────────────────────────

  _persist() {
    if (!this.persistPath) return;
    try {
      const dir = path.dirname(this.persistPath);
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
      const payload = {
        version: 1,
        writtenAt: Date.now(),
        jobs: [...this.jobs.values()]
      };
      const tmp = this.persistPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, this.persistPath);
    } catch (_) {
      // Ignore disk errors; persistence is best-effort.
    }
  }

  _loadFromDisk() {
    if (!fs.existsSync(this.persistPath)) return;
    const raw = fs.readFileSync(this.persistPath, 'utf8');
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (!obj || obj.version !== 1 || !Array.isArray(obj.jobs)) return;
    for (const j of obj.jobs) {
      if (!j || typeof j.id !== 'string') continue;
      const job = { ...j };
      // Defensive: jobs that were running/queued before restart cannot be resumed
      // (their runner function is gone). Mark as error so callers see a clean state.
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'error';
        job.error  = 'Job konnte nach Server-Neustart nicht fortgesetzt werden.';
        job.finishedAt = Date.now();
      }
      this.jobs.set(job.id, job);
    }
    this._reapOldJobs();
  }
}

const sharedQueue = new AiJobQueue();

module.exports = { AiJobQueue, sharedQueue };

