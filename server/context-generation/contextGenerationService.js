'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { resolveCanonicalCity } = require('../../scripts/generate-context-city');

const MAX_LOG_LINES = 300;
const TERMINAL_STATES = new Set(['succeeded', 'failed']);

function boolEnv(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function newJobId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
}

function appendLog(job, stream, chunk) {
  const text = String(chunk || '');
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    job.logs.push({ at: new Date().toISOString(), stream, line: line.slice(0, 2000) });
  }
  if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
}

function safeJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    city: job.city,
    slug: job.slug,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    exitCode: job.exitCode,
    error: job.error || null,
    logs: job.logs.slice(-80),
  };
}

class ContextGenerationService {
  constructor(options) {
    const opts = options || {};
    this.root = path.resolve(opts.root || path.join(__dirname, '..', '..'));
    this.enabled = opts.enabled !== undefined
      ? !!opts.enabled
      : boolEnv(process.env.CONTEXT_GENERATION_ENABLED, false);
    this.forceByDefault = opts.forceByDefault !== undefined
      ? !!opts.forceByDefault
      : boolEnv(process.env.CONTEXT_GENERATION_FORCE, true);
    this.token = opts.token !== undefined ? opts.token : (process.env.CONTEXT_GENERATION_TOKEN || '');
    this.jobs = new Map();
    this.activeJobId = null;
  }

  capabilities(city) {
    let canonical = null;
    let cityError = null;
    if (city) {
      try { canonical = resolveCanonicalCity(this.root, city); }
      catch (error) { cityError = error.message; }
    }
    const active = this.activeJobId ? this.jobs.get(this.activeJobId) : null;
    const latest = canonical
      ? [...this.jobs.values()].reverse().find(job => job.slug === canonical.slug)
      : null;
    return {
      available: this.enabled && !cityError,
      execution: 'local-docker',
      requiresToken: !!this.token,
      city: canonical ? canonical.city : (city || null),
      slug: canonical ? canonical.slug : null,
      reason: !this.enabled
        ? 'context_generation_disabled'
        : (cityError ? 'unknown_city' : null),
      reasonDetail: cityError,
      activeJob: safeJob(active),
      latestJob: safeJob(latest),
    };
  }

  isAuthorized(headerValue) {
    if (!this.token) return true;
    const raw = String(headerValue || '').replace(/^Bearer\s+/i, '');
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(raw);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  start(city, options) {
    if (!this.enabled) {
      const error = new Error('Context generation is disabled');
      error.code = 'DISABLED';
      throw error;
    }
    const canonical = resolveCanonicalCity(this.root, city);
    const active = this.activeJobId ? this.jobs.get(this.activeJobId) : null;
    if (active && !TERMINAL_STATES.has(active.status)) {
      const error = new Error(`Job ${active.id} for ${active.city} is already running`);
      error.code = 'BUSY';
      error.activeJob = safeJob(active);
      throw error;
    }

    const job = {
      id: newJobId(),
      city: canonical.city,
      slug: canonical.slug,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      error: null,
      logs: [],
    };
    this.jobs.set(job.id, job);
    this.activeJobId = job.id;

    const force = options && options.force !== undefined
      ? options.force === true
      : this.forceByDefault;
    const script = path.join(this.root, 'scripts', 'generate-context-city.js');
    if (!fs.existsSync(script)) {
      job.status = 'failed';
      job.error = `Generator script missing: ${script}`;
      job.finishedAt = new Date().toISOString();
      this.activeJobId = null;
      return safeJob(job);
    }

    const argv = [script, '--city', canonical.city];
    if (force) argv.push('--force');
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    const child = spawn(process.execPath, argv, {
      cwd: this.root,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    job.pid = child.pid;
    child.stdout.on('data', chunk => appendLog(job, 'stdout', chunk));
    child.stderr.on('data', chunk => appendLog(job, 'stderr', chunk));
    child.on('error', error => {
      job.status = 'failed';
      job.error = error.message;
      job.finishedAt = new Date().toISOString();
      this.activeJobId = null;
    });
    child.on('close', code => {
      job.exitCode = code;
      job.status = code === 0 ? 'succeeded' : 'failed';
      if (code !== 0 && !job.error) job.error = `Generator exited with code ${code}`;
      job.finishedAt = new Date().toISOString();
      if (this.activeJobId === job.id) this.activeJobId = null;
    });

    return safeJob(job);
  }

  get(jobId) {
    return safeJob(this.jobs.get(jobId));
  }
}

module.exports = {
  ContextGenerationService,
  appendLog,
  safeJob,
};
