'use strict';

const path = require('path');
const { rateLimit } = require('express-rate-limit');
const { ContextGenerationService } = require('./contextGenerationService');

const capabilityRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'context_generation_status_rate_limited' },
});

// Starting a producer run can trigger OSM and SRTM downloads. Keep this limit
// deliberately low even though the service also enforces a single active job.
const startJobRateLimit = rateLimit({
  windowMs: 60 * 60_000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'context_generation_start_rate_limited',
    message: 'Zu viele Generierungsstarts. Bitte den laufenden Auftrag weiterverwenden.',
  },
});

// The UI polls every two seconds, so allow a normal browser session sufficient
// headroom while still bounding brute-force token attempts and accidental loops.
const jobStatusRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'context_generation_status_rate_limited' },
});

function requestToken(req) {
  return req.get('authorization') || req.get('x-context-generation-token') || '';
}

function registerContextGenerationRoutes(app, options) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('Express app required');
  }
  if (app.locals.contextGenerationService) return app.locals.contextGenerationService;

  const service = new ContextGenerationService({
    root: path.resolve((options && options.root) || path.join(__dirname, '..', '..')),
  });
  app.locals.contextGenerationService = service;

  app.get('/api/context-generation/status', capabilityRateLimit, (req, res) => {
    res.json(service.capabilities(String(req.query.city || '').trim()));
  });

  app.post('/api/context-generation/jobs', startJobRateLimit, (req, res) => {
    if (!service.isAuthorized(requestToken(req))) {
      return res.status(401).json({
        error: 'context_generation_unauthorized',
        message: 'Für die lokale Datengenerierung ist ein Administrations-Token erforderlich.',
      });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const city = String(body.city || '').trim();
    if (!city) {
      return res.status(400).json({ error: 'city_required', message: 'Pflichtfeld "city" fehlt.' });
    }
    try {
      const job = service.start(city, { force: body.force });
      return res.status(job.status === 'failed' ? 500 : 202).json({ job });
    } catch (error) {
      if (error.code === 'DISABLED') {
        return res.status(503).json({ error: 'context_generation_disabled', message: error.message });
      }
      if (error.code === 'BUSY') {
        return res.status(409).json({ error: 'context_generation_busy', message: error.message, job: error.activeJob });
      }
      return res.status(400).json({ error: 'context_generation_rejected', message: error.message });
    }
  });

  app.get('/api/context-generation/jobs/:jobId', jobStatusRateLimit, (req, res) => {
    if (!service.isAuthorized(requestToken(req))) {
      return res.status(401).json({
        error: 'context_generation_unauthorized',
        message: 'Für die lokale Datengenerierung ist ein Administrations-Token erforderlich.',
      });
    }
    const job = service.get(String(req.params.jobId || ''));
    if (!job) return res.status(404).json({ error: 'context_generation_job_not_found' });
    return res.json({ job });
  });

  return service;
}

module.exports = { registerContextGenerationRoutes };
