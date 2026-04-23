/**
 * Express-Server für die Docker-Distribution der Unfallwerkbank.
 *
 * Stellt die statischen Werkbank-Dateien bereit und bietet folgende Endpunkte:
 *   POST /api/export-video          – GIF-Video-Export (Playwright/ffmpeg)
 *   POST /api/ai/export-assessment  – optionale KI-gestützte Bewertung (Gemini)
 *   GET  /api/ai-assessment-available – Feature-Flag (GEMINI_API_KEY vorhanden?)
 *
 * Start: node server/index.js
 * Port:  8000 (konfigurierbar über Umgebungsvariable PORT)
 */

'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const { exportVideo }   = require('./video-export.js');
const { runAssessment, isAvailable } = require('./ai/aiAssessmentService.js');

const app = express();
const PORT = process.env.PORT || 8000;
const ROOT = path.resolve(__dirname, '..');

// Parse JSON request bodies
app.use(express.json());

// Rate limiter for the video export endpoint (3 requests/minute per IP).
// Video generation is expensive; this guards against unintentional hammering.
const videoExportRateLimit = rateLimit({
  windowMs: 60_000,      // 1 minute window
  max: 3,                // max 3 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen – bitte warte kurz und versuche es erneut.' }
});

// Rate limiter for the AI assessment endpoint (10 requests/minute per IP).
const aiAssessmentRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen – bitte warte kurz und versuche es erneut.' }
});

// Concurrency guard: at most MAX_CONCURRENT Playwright/ffmpeg jobs at once.
const MAX_CONCURRENT = 2;
let activeExports = 0;

function concurrencyGuard(req, res, next) {
  if (activeExports >= MAX_CONCURRENT) {
    return res.status(429).json({
      error: 'Server ist ausgelastet – bitte versuche es in Kürze erneut.'
    });
  }
  activeExports++;
  next();
}

// Statische Werkbank-Dateien aus dem Repository-Root ausliefern
app.use(express.static(ROOT, {
  index: 'werkbank_v2.html',
  extensions: ['html']
}));

// ── Health-Check ──────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Feature-Flag: Video-Export verfügbar? ─────────────────────────────────────
app.get('/api/video-export-available', (_req, res) => {
  res.json({ available: true });
});

// ── Video-Export ──────────────────────────────────────────────────────────────
/**
 * POST /api/export-video
 *
 * Body (JSON): aktuelle URL-Parameter der Werkbank (alle optional):
 *   city, severity, includeCyclist, includePedestrian, includeCar,
 *   includeMotorcycle, involvementMode, hourFrom, hourTo, dayType,
 *   roadCondition, showCluster, showHeatmap, showOnlyAboveAverage,
 *   centerLat, centerLon, zoom, selSouth, selWest, selNorth, selEast,
 *   maxPoints, viewportPaddingPct, heatRadius
 *
 * Antwort: GIF-Datei als Download
 */
app.post('/api/export-video', videoExportRateLimit, concurrencyGuard, async (req, res) => {
  const params = req.body || {};

  // Note: activeExports is incremented in concurrencyGuard (before next())
  let gifPath = null;
  try {
    gifPath = await exportVideo(params);

    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Content-Disposition', 'attachment; filename="unfallatlas-analyse.gif"');
    res.sendFile(gifPath, (err) => {
      activeExports--;
      if (err && !res.headersSent) {
        res.status(500).json({ error: 'Fehler beim Senden der Datei' });
      }
      // Temporäre GIF-Datei aufräumen
      try { fs.unlinkSync(gifPath); } catch (_) { /* ignore */ }
    });
  } catch (err) {
    activeExports--;
    console.error('[export-video] Fehler:', err);
    // Temporäre GIF-Datei aufräumen falls vorhanden
    if (gifPath) {
      try { fs.unlinkSync(gifPath); } catch (_) { /* ignore */ }
    }
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Interner Fehler beim Video-Export' });
    }
  }
});

// ── Feature-Flag: KI-Bewertung verfügbar? ─────────────────────────────────────
/**
 * GET /api/ai-assessment-available
 *
 * Gibt { available: true } zurück, wenn GEMINI_API_KEY gesetzt ist, sonst
 * { available: false }.  Ermöglicht dem Frontend, die KI-Option aus- oder
 * einzublenden ohne einen vollen Request zu schicken.
 */
app.get('/api/ai-assessment-available', (_req, res) => {
  res.json({ available: isAvailable() });
});

// ── KI-Bewertung ──────────────────────────────────────────────────────────────
/**
 * POST /api/ai/export-assessment
 *
 * Body (JSON):
 *   structured    – strukturiertes Export-Objekt aus computeExportReport()
 *   contextHints  – (optional) manuelle Kontext-Hinweise
 *     { knownHazards: string[], locationHints: string[], surfaceHints: string[], notes: string[] }
 *
 * Antwort (JSON):
 *   { assessment: ExportAssessmentOutput }
 *
 * Fehler:
 *   503 – KI nicht konfiguriert (GEMINI_API_KEY fehlt)
 *   400 – Pflichtfelder im Body fehlen
 *   500 – Interner Fehler
 */
app.post('/api/ai/export-assessment', aiAssessmentRateLimit, async (req, res) => {
  if (!isAvailable()) {
    return res.status(503).json({ error: 'KI-Bewertung ist nicht konfiguriert (GEMINI_API_KEY fehlt).' });
  }

  const { structured, contextHints } = req.body || {};
  if (!structured || typeof structured !== 'object') {
    return res.status(400).json({ error: 'Pflichtfeld "structured" fehlt oder ist kein Objekt.' });
  }

  try {
    const assessment = await runAssessment(structured, contextHints);
    return res.json({ assessment });
  } catch (err) {
    // Log without sensitive data (no API key, no raw prompt)
    console.error('[ai/export-assessment] Fehler:', err.message);
    return res.status(500).json({ error: err.message || 'Interner Fehler bei der KI-Bewertung.' });
  }
});

// ── Server starten ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Unfallwerkbank läuft auf http://localhost:${PORT}`);
  console.log(`Video-Export: POST http://localhost:${PORT}/api/export-video`);
  console.log(`KI-Bewertung: POST http://localhost:${PORT}/api/ai/export-assessment (verfügbar: ${isAvailable()})`);
});
