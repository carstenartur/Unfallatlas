'use strict';

/**
 * In-Memory-Cache für KI-Bewertungsergebnisse.
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
 *   - Keine Persistenz (TODO: für Folge-PR auf Disk/Redis erweitern)
 *
 * @module server/ai/cache/aiAssessmentCache
 */

const crypto = require('crypto');

const DEFAULT_TTL_MS  = 60 * 60 * 1000; // 1h
const DEFAULT_MAX     = 200;

class AiAssessmentCache {
  /**
   * @param {object} [opts]
   * @param {number} [opts.ttlMs]
   * @param {number} [opts.max]
   */
  constructor(opts = {}) {
    this.ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
    this.max   = Number.isFinite(opts.max)   && opts.max   > 0 ? opts.max   : DEFAULT_MAX;
    /** @type {Map<string, { value: any, expiresAt: number }>} */
    this.store = new Map();
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
  }

  has(key) {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  size() {
    return this.store.size;
  }

  clear() {
    this.store.clear();
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
