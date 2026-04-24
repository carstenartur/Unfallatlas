'use strict';

/**
 * Kleine Persistenz-Abstraktion: in-memory Key-Value-Store mit TTL & LRU,
 * optional als JSON-Datei persistiert.
 *
 * Zweck dieser Schicht ist *nicht*, einen weiteren Cache einzuführen, sondern
 * eine einheitliche Schnittstelle bereitzustellen, an der spätere
 * Persistenz-Implementierungen (Redis, SQLite, …) andocken können – ohne
 * dass die Aufrufer (AI-Cache, political-context-Cache, Job-Persistenz)
 * ihre Logik ändern müssen.
 *
 * Eigenschaften:
 *   - synchrone API (`get`/`set`/`has`/`delete`/`size`/`clear`/`keys`)
 *   - TTL pro Eintrag, abgelaufene Einträge werden lazy verworfen
 *   - LRU-Verdrängung bei Überschreitung der Maximalgröße
 *   - optionale Disk-Persistenz (atomar geschrieben, debounced)
 *   - keine externen Abhängigkeiten
 *
 * Bestehende Module (`server/ai/cache/aiAssessmentCache.js`,
 * `server/ai/jobs/aiJobQueue.js`) bleiben unverändert – diese Klasse ist
 * eine Vorbereitung für künftige Konsolidierung und wird zunächst nur vom
 * neuen `portalSearchCache` genutzt.
 *
 * @module server/lib/keyValueStore
 */

const fs   = require('fs');
const path = require('path');

const DEFAULT_TTL_MS                = 10 * 60 * 1000; // 10 min
const DEFAULT_MAX                   = 200;
const DEFAULT_PERSIST_DEBOUNCE_MS   = 500;

/**
 * @typedef {object} KeyValueStoreOptions
 * @property {number} [ttlMs]               Standard-TTL für `set` ohne expliziten Wert
 * @property {number} [max]                 Maximale Anzahl Einträge (LRU)
 * @property {string} [persistPath]         Wenn gesetzt: JSON-Persistenz aktiv
 * @property {number} [persistDebounceMs]   Debounce für Disk-Schreibvorgänge
 * @property {string} [name]                Optionaler Anzeigename (Logs/Tests)
 */

class KeyValueStore {
  /**
   * @param {KeyValueStoreOptions} [opts]
   */
  constructor(opts = {}) {
    this.ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
    this.max   = Number.isFinite(opts.max)   && opts.max   > 0 ? opts.max   : DEFAULT_MAX;
    this.persistPath = (typeof opts.persistPath === 'string' && opts.persistPath.trim())
      ? opts.persistPath
      : null;
    this.persistDebounceMs = Number.isFinite(opts.persistDebounceMs) && opts.persistDebounceMs >= 0
      ? opts.persistDebounceMs
      : DEFAULT_PERSIST_DEBOUNCE_MS;
    this.name = String(opts.name || 'kv');

    /** @type {Map<string, { value: any, expiresAt: number }>} */
    this.store = new Map();
    this._persistTimer = null;

    if (this.persistPath) {
      try { this._loadFromDisk(); } catch (_) { /* ignore corrupt file */ }
    }
  }

  /** @returns {any|undefined} */
  get(key) {
    const entry = this.store.get(String(key));
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(String(key));
      this._schedulePersist();
      return undefined;
    }
    // LRU: re-insert
    this.store.delete(String(key));
    this.store.set(String(key), entry);
    return entry.value;
  }

  /**
   * @param {string} key
   * @param {any}    value
   * @param {number} [ttlMs]   Optional override für diesen Eintrag
   */
  set(key, value, ttlMs) {
    const k = String(key);
    if (this.store.has(k)) this.store.delete(k);
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : this.ttlMs;
    this.store.set(k, { value, expiresAt: Date.now() + ttl });
    if (this.store.size > this.max) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this._schedulePersist();
  }

  has(key) {
    const entry = this.store.get(String(key));
    if (!entry) return false;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(String(key));
      this._schedulePersist();
      return false;
    }
    return true;
  }

  delete(key) {
    const existed = this.store.delete(String(key));
    if (existed) this._schedulePersist();
    return existed;
  }

  size()  { return this.store.size; }
  keys()  { return [...this.store.keys()]; }
  clear() { this.store.clear(); this._schedulePersist(); }

  /**
   * Erzwingt sofortiges Schreiben (für Tests / graceful shutdown).
   */
  flushSync() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    if (this.persistPath) this._writeToDisk();
  }

  // ── Persistenz ──────────────────────────────────────────────────────────────

  _schedulePersist() {
    if (!this.persistPath) return;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      try { this._writeToDisk(); } catch (_) { /* ignore disk errors */ }
    }, this.persistDebounceMs);
    if (this._persistTimer && typeof this._persistTimer.unref === 'function') {
      this._persistTimer.unref();
    }
  }

  _writeToDisk() {
    const now = Date.now();
    const entries = [];
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt > now) entries.push([key, entry]);
    }
    const payload = {
      version: 1,
      name:    this.name,
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

module.exports = {
  KeyValueStore,
  DEFAULT_TTL_MS,
  DEFAULT_MAX
};
