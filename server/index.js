/**
 * Express-Server für die Docker-Distribution der Unfallwerkbank.
 *
 * Stellt die statischen Werkbank-Dateien bereit und bietet einen
 * `/api/export-video`-Endpunkt, der per Playwright ein GIF-Video
 * des kompletten Analyse-Ablaufs erzeugt.
 *
 * Start: node server/index.js
 * Port:  8000 (konfigurierbar über Umgebungsvariable PORT)
 */

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { exportVideo } = require('./video-export.js');

const app = express();
const PORT = process.env.PORT || 8000;
const ROOT = path.resolve(__dirname, '..');

// Parse JSON request bodies
app.use(express.json());

// In-memory rate limiting + concurrency guard for the video export endpoint.
// Video generation is expensive: limit to MAX_CONCURRENT parallel exports
// and MAX_PER_MINUTE requests per IP per minute.
const MAX_CONCURRENT = 2;
const MAX_PER_MINUTE = 3;
let activeExports = 0;
const exportRequests = new Map();

function videoExportRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 60_000; // 1 minute

  // Concurrency guard
  if (activeExports >= MAX_CONCURRENT) {
    return res.status(429).json({
      error: 'Server ist ausgelastet – bitte versuche es in Kürze erneut.'
    });
  }

  // Per-IP rate limit
  const history = (exportRequests.get(ip) || []).filter(t => now - t < windowMs);
  if (history.length >= MAX_PER_MINUTE) {
    return res.status(429).json({
      error: 'Zu viele Anfragen – bitte warte kurz und versuche es erneut.'
    });
  }
  history.push(now);
  exportRequests.set(ip, history);
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
app.post('/api/export-video', videoExportRateLimit, async (req, res) => {
  const params = req.body || {};

  // Note: activeExports is incremented in videoExportRateLimit (before next())
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

// ── Server starten ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Unfallwerkbank läuft auf http://localhost:${PORT}`);
  console.log(`Video-Export: POST http://localhost:${PORT}/api/export-video`);
});
