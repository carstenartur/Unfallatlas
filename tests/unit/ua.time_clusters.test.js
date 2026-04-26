/**
 * Unit tests for ua.time_clusters.js
 */

describe('UA.timeClusters', () => {
  let UA;

  beforeEach(() => {
    const mockWindow = { UA: {} };
    const fs = require('fs');
    const path = require('path');
    const code = fs.readFileSync(path.resolve(__dirname, '../../js/ua.time_clusters.js'), 'utf8');
    const fn = new Function('window', code);
    fn(mockWindow);
    UA = mockWindow.UA;
    if (UA.timeClusters && UA.timeClusters._resetCache) UA.timeClusters._resetCache();
  });

  describe('DEFAULT_CLUSTERS', () => {
    test('contains all expected cluster ids', () => {
      const ids = UA.timeClusters.DEFAULT_CLUSTERS.map(c => c.id);
      expect(ids).toContain('werktag_schule_morgens');
      expect(ids).toContain('werktag_berufsverkehr_morgens');
      expect(ids).toContain('werktag_nacht');
      expect(ids).toContain('wochenende_tag');
      expect(ids).toContain('wochenende_nacht');
    });

    test('Schule appears before Berufsverkehr (Schule wins on collision)', () => {
      const ids = UA.timeClusters.DEFAULT_CLUSTERS.map(c => c.id);
      expect(ids.indexOf('werktag_schule_morgens'))
        .toBeLessThan(ids.indexOf('werktag_berufsverkehr_morgens'));
    });
  });

  describe('matchesCluster', () => {
    const schule = { weekdayGroup: 'Werktag', hours: [[7, 0], [8, 30]] };
    const beruf  = { weekdayGroup: 'Werktag', hours: [[6, 30], [9, 30]] };
    const nacht  = { weekdayGroup: 'Werktag', hours: [[22, 0], [29, 0]] };

    test('07:30 Werktag matches Schule', () => {
      expect(UA.timeClusters.matchesCluster({ hour: 7, minute: 30, weekdayGroup: 'Werktag' }, schule)).toBe(true);
    });

    test('06:00 Werktag does NOT match Schule (before 07:00)', () => {
      expect(UA.timeClusters.matchesCluster({ hour: 6, weekdayGroup: 'Werktag' }, schule)).toBe(false);
    });

    test('09:00 Werktag matches Berufsverkehr but not Schule (after end)', () => {
      expect(UA.timeClusters.matchesCluster({ hour: 9, weekdayGroup: 'Werktag' }, schule)).toBe(false);
      expect(UA.timeClusters.matchesCluster({ hour: 9, weekdayGroup: 'Werktag' }, beruf)).toBe(true);
    });

    test('Wochenende item does NOT match Werktag cluster', () => {
      expect(UA.timeClusters.matchesCluster({ hour: 7, weekdayGroup: 'Wochenende' }, schule)).toBe(false);
    });

    test('null hour never matches', () => {
      expect(UA.timeClusters.matchesCluster({ hour: null, weekdayGroup: 'Werktag' }, schule)).toBe(false);
    });

    test('Cross-midnight cluster (22:00–05:00) — 23:00 matches', () => {
      expect(UA.timeClusters.matchesCluster({ hour: 23, weekdayGroup: 'Werktag' }, nacht)).toBe(true);
    });

    test('Cross-midnight cluster — 03:00 matches', () => {
      expect(UA.timeClusters.matchesCluster({ hour: 3, weekdayGroup: 'Werktag' }, nacht)).toBe(true);
    });

    test('Cross-midnight cluster — 12:00 does NOT match', () => {
      expect(UA.timeClusters.matchesCluster({ hour: 12, weekdayGroup: 'Werktag' }, nacht)).toBe(false);
    });
  });

  describe('classify', () => {
    const clusters = UA?.timeClusters?.DEFAULT_CLUSTERS;

    test('Schule wins over Berufsverkehr on overlap (07:30 Werktag → Schule)', () => {
      const c = UA.timeClusters.DEFAULT_CLUSTERS;
      const id = UA.timeClusters.classify({ hour: 7, minute: 30, weekdayGroup: 'Werktag' }, c);
      expect(id).toBe('werktag_schule_morgens');
    });

    test('Berufsverkehr wins for items NOT in Schule slot', () => {
      const c = UA.timeClusters.DEFAULT_CLUSTERS;
      // 09:00 → not in 07:00-08:30 Schule → falls into Berufsverkehr 06:30-09:30
      const id = UA.timeClusters.classify({ hour: 9, weekdayGroup: 'Werktag' }, c);
      expect(id).toBe('werktag_berufsverkehr_morgens');
    });

    test('15:00 Werktag → werktag_tag (Mittagsslot, not Schule-Nachmittag, not Berufsverkehr-Abend)', () => {
      const c = UA.timeClusters.DEFAULT_CLUSTERS;
      const id = UA.timeClusters.classify({ hour: 15, weekdayGroup: 'Werktag' }, c);
      expect(id).toBe('werktag_tag');
    });

    test('null hour → returns null (will be bucketed as andere)', () => {
      const c = UA.timeClusters.DEFAULT_CLUSTERS;
      const id = UA.timeClusters.classify({ hour: null, weekdayGroup: 'Werktag' }, c);
      expect(id).toBeNull();
    });

    test('15:00 Wochenende → wochenende_tag (NOT werktag_tag)', () => {
      const c = UA.timeClusters.DEFAULT_CLUSTERS;
      const id = UA.timeClusters.classify({ hour: 15, weekdayGroup: 'Wochenende' }, c);
      expect(id).toBe('wochenende_tag');
    });

    test('02:00 Wochenende → wochenende_nacht', () => {
      const c = UA.timeClusters.DEFAULT_CLUSTERS;
      const id = UA.timeClusters.classify({ hour: 2, weekdayGroup: 'Wochenende' }, c);
      expect(id).toBe('wochenende_nacht');
    });
  });

  describe('loadTimeClusters fallback chain', () => {
    test('returns FALLBACK when no fetch', async () => {
      const cfg = await UA.timeClusters.loadTimeClusters('hannover');
      expect(cfg.clusters.length).toBeGreaterThan(0);
    });

    test('city-specific config wins over generic and default', async () => {
      UA.timeClusters._resetCache();
      const fakeCity = { version: 1, source: 'test', clusters: [{ id: 'city_only', label: 'City', weekdayGroup: 'Beide', hours: [[0,0],[24,0]] }] };
      const fakeGeneric = { version: 1, source: 'generic', clusters: [{ id: 'generic_only', label: 'Generic', weekdayGroup: 'Beide', hours: [[0,0],[24,0]] }] };
      global.fetch = async (url) => {
        if (url.includes('time_clusters_hannover.json')) return { ok: true, json: async () => fakeCity };
        if (url.endsWith('time_clusters.json'))            return { ok: true, json: async () => fakeGeneric };
        return { ok: false };
      };
      try {
        const cfg = await UA.timeClusters.loadTimeClusters('hannover');
        expect(cfg.clusters[0].id).toBe('city_only');
      } finally {
        delete global.fetch;
      }
    });

    test('generic config used when city-specific missing', async () => {
      UA.timeClusters._resetCache();
      const fakeGeneric = { version: 1, source: 'generic', clusters: [{ id: 'generic_only', label: 'Generic', weekdayGroup: 'Beide', hours: [[0,0],[24,0]] }] };
      global.fetch = async (url) => {
        if (url.includes('time_clusters_')) return { ok: false };
        if (url.endsWith('time_clusters.json')) return { ok: true, json: async () => fakeGeneric };
        return { ok: false };
      };
      try {
        const cfg = await UA.timeClusters.loadTimeClusters('unknowncity');
        expect(cfg.clusters[0].id).toBe('generic_only');
      } finally {
        delete global.fetch;
      }
    });

    test('falls back to DEFAULT when neither city nor generic available', async () => {
      UA.timeClusters._resetCache();
      global.fetch = async () => ({ ok: false });
      try {
        const cfg = await UA.timeClusters.loadTimeClusters('hannover');
        expect(cfg).toBe(UA.timeClusters.FALLBACK);
      } finally {
        delete global.fetch;
      }
    });

    test('Hannover example template loads (json structure valid)', () => {
      const fs = require('fs');
      const path = require('path');
      const p = path.resolve(__dirname, '../../templates/time_clusters_hannover.json');
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      expect(data.clusters.length).toBeGreaterThan(0);
      // Schule must come before Berufsverkehr
      const ids = data.clusters.map(c => c.id);
      expect(ids.indexOf('werktag_schule_morgens'))
        .toBeLessThan(ids.indexOf('werktag_berufsverkehr_morgens'));
    });
  });
});
