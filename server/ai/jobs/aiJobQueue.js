'use strict';

/**
 * Einfache In-Memory-Queue für KI-Bewertungsanfragen.
 *
 * Funktion:
 *   - begrenzt die Parallelität (concurrency, Standard 1)
 *   - bietet einen einheitlichen `enqueue(workFn)`-Einstieg
 *   - ermöglicht später eine Persistierung (Disk/Redis), ohne die Aufrufer zu ändern
 *
 * Diese erste Stufe hält die Queue absichtlich minimal:
 *   - keine Persistenz
 *   - keine Wiederaufnahme nach Server-Neustart
 *   - keine Prioritäten
 *
 * TODO (Folge-PR):
 *   - Persistenz (Disk/Redis), damit lange laufende Jobs überleben
 *   - Prioritäten (proposal-brief vor assessment?)
 *   - Job-Statusabfrage über Endpunkt /api/ai/jobs/:id
 *   - Cancellation
 *
 * @module server/ai/jobs/aiJobQueue
 */

const DEFAULT_CONCURRENCY = 1;

class AiJobQueue {
  /**
   * @param {object} [opts]
   * @param {number} [opts.concurrency]
   */
  constructor(opts = {}) {
    this.concurrency = Number.isFinite(opts.concurrency) && opts.concurrency > 0
      ? opts.concurrency
      : DEFAULT_CONCURRENCY;
    this.active  = 0;
    /** @type {Array<{work: Function, resolve: Function, reject: Function}>} */
    this.queue   = [];
  }

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
    while (this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      this.active++;
      Promise.resolve()
        .then(() => job.work())
        .then((value) => job.resolve(value))
        .catch((err)  => job.reject(err))
        .finally(() => {
          this.active--;
          this._drain();
        });
    }
  }

  /** Aktuelle Statistik – nützlich für Monitoring/Tests. */
  stats() {
    return {
      active: this.active,
      pending: this.queue.length,
      concurrency: this.concurrency
    };
  }
}

const sharedQueue = new AiJobQueue();

module.exports = { AiJobQueue, sharedQueue };
