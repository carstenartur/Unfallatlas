'use strict';

/**
 * In-Memory-Cache für KI-Bewertungsergebnisse, optional **persistent auf Disk**.
 *
 * Cache-Key wird aus einem deterministisch normalisierten Hash gebildet:
 *   sha256( JSON.stringify({ inputCanon, promptVersion, model, mode }) )
 *
 * Damit gehen identische Anfragen kein zweites Mal an Gemini.  Das schont das
 * kostenlose Kontingent und beschleunigt Wiederholungen (z. B. wenn der
 * Nutzer den gleichen Bereich noch einmal exportiert).
 *
 * Eigenschaften:
 *   - TTL (Standard 1h)
 *   - LRU-Verdrängung bei Überschreitung der Maximalgröße (Standard 200)
 *   - Optionale Disk-Persistenz: Aktivierung via `persistPath`-Option oder
 *     Umgebungsvariable `AI_CACHE_PATH`. Beim Konstruktor wird, sofern die Datei
 *     vorhanden und gültig ist, der bisherige Inhalt geladen (abgelaufene
 *     Einträge werden verworfen).  Schreibvorgänge werden gedrosselt
 *     (debounced, default 500 ms) und atomar (temp + rename) durchgeführt.
 *
 * @module server/ai/cache/aiAssessmentCache
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const DEFAULT_TTL_MS  = 60 * 60 * 1000; // 1h
const DEFAULT_MAX     = 200;
const DEFAULT_PERSIST_DEBOUNCE_MS = 500;

class AiAssessmentCache {
  /**
   * @param {object} [opts]
   * @param {number} [opts.ttlMs]
   * @param {number} [opts.max]
   * @param {string} [opts.persistPath]   Wenn gesetzt: Cache wird hier persistiert.
   *                                      Fällt sonst auf process.env.AI_CACHE_PATH zurück.
   * @param {number} [opts.persistDebounceMs]
   */
  constructor(opts = {}) {
    this.ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
    this.max   = Number.isFinite(opts.max)   && opts.max   > 0 ? opts.max   : DEFAULT_MAX;
    /** @type {Map<string, { value: any, expiresAt: number }>} */
    this.store = new Map();

    const envPath = process.env.AI_CACHE_PATH;
    this.persistPath = opts.persistPath || (envPath && envPath.trim()) || null;
    this.persistDebounceMs = Number.isFinite(opts.persistDebounceMs) && opts.persistDebounceMs >= 0
      ? opts.persistDebounceMs
      : DEFAULT_PERSIST_DEBOUNCE_MS;
    this._persistTimer = null;

    if (this.persistPath) {
      try { this._loadFromDisk(); } catch (e) { /* ignore corrupt file */ }
    }
  }

  /**
   * Liefert einen deterministischen Cache-Key aus den Bestandteilen.
   *
   * @param {object} parts
   * @param {object} parts.input          – kanonisch serialisierbarer Input
   * @param {string} parts.promptVersion  – z. B. "exportAssessmentPrompt.v2"
   * @param {string} parts.model          – z. B. "gemini-2.0-flash"
   * @param {string} parts.mode           – "assessment" | "proposal-brief"
   * @returns {string}
   */
  static buildKey(parts) {
    const canonical = canonicalize(parts.input);
    const payload   = JSON.stringify({
      input: canonical,
      promptVersion: String(parts.promptVersion || ''),
      model:         String(parts.model || ''),
      mode:          String(parts.mode || '')
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  /** @returns {any|undefined} */
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      this._schedulePersist();
      return undefined;
    }
    // Refresh LRU order: delete + re-insert
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    if (this.store.size > this.max) {
      // Evict oldest
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this._schedulePersist();
  }

  has(key) {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      this._schedulePersist();
      return false;
    }
    return true;
  }

  size() {
    return this.store.size;
  }

  clear() {
    this.store.clear();
    this._schedulePersist();
  }

  /**
   * Erzwingt sofortiges Schreiben des aktuellen Caches auf Disk.
   * Hauptsächlich für Tests bzw. graceful shutdown.
   */
  flushSync() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    if (!this.persistPath) return;
    this._writeToDisk();
  }

  // ── Persistenz ──────────────────────────────────────────────────────────────

  _schedulePersist() {
    if (!this.persistPath) return;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      try { this._writeToDisk(); } catch (e) { /* ignore disk errors */ }
    }, this.persistDebounceMs);
    // Don't keep the event loop alive only because of the cache flush
    if (this._persistTimer && typeof this._persistTimer.unref === 'function') {
      this._persistTimer.unref();
    }
  }

  _writeToDisk() {
    const now = Date.now();
    const entries = [];
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt > now) {
        entries.push([key, entry]);
      }
    }
    const payload = {
      version: 1,
      writtenAt: now,
      ttlMs: this.ttlMs,
      entries
    };
    const dir = path.dirname(this.persistPath);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
    const tmp = this.persistPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, this.persistPath);
  }

  _loadFromDisk() {
    if (!fs.existsSync(this.persistPath)) return;
    const raw = fs.readFileSync(this.persistPath, 'utf8');
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (!obj || obj.version !== 1 || !Array.isArray(obj.entries)) return;
    const now = Date.now();
    for (const item of obj.entries) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [key, entry] = item;
      if (typeof key !== 'string' || !entry || !Number.isFinite(entry.expiresAt)) continue;
      if (entry.expiresAt > now) {
        this.store.set(key, { value: entry.value, expiresAt: entry.expiresAt });
      }
    }
  }
}

/**
 * Erzeugt eine kanonische, deterministische Repräsentation eines Objekts:
 * Schlüssel werden alphabetisch sortiert, undefined entfernt.
 *
 * @param {unknown} obj
 * @returns {unknown}
 */
function canonicalize(obj) {
  if (obj === null) return null;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  if (typeof obj === 'object') {
    const out = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  return obj;
}

// Singleton instance for the server process
const sharedCache = new AiAssessmentCache();

module.exports = {
  AiAssessmentCache,
  sharedCache,
  canonicalize
};

