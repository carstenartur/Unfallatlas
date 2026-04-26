/**
 * Unit tests for the byTimePattern accident-view strategy.
 */

describe('UA.accidentViews.byTimePattern', () => {
  let UA;

  beforeEach(() => {
    const mockWindow = { UA: {} };
    const fs = require('fs');
    const path = require('path');

    const load = (rel) => {
      const code = fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
      const fn = new Function('window', code);
      fn(mockWindow);
    };

    load('../../js/ua.utils.js');
    load('../../js/ua.filters.js');
    load('../../js/ua.time_clusters.js');
    load('../../js/ua.accident_views.js');

    UA = mockWindow.UA;
    if (UA.timeClusters && UA.timeClusters._resetCache) UA.timeClusters._resetCache();
  });

  function item({ severity = "2", year = 2022, hour = 10, minute = 0, mask = 1, lat = 52.0, lon = 9.7,
                  weekday = "Mo", weekdayGroup = "Werktag" } = {}) {
    const sevLabelMap = { "1": "Getötet", "2": "Schwerverletzt", "3": "Leichtverletzt" };
    const involved = (UA.COMBO_LABEL && UA.COMBO_LABEL[mask]) || ("Mask " + mask);
    return {
      lat, lon, year,
      severity: String(severity), sevLabel: sevLabelMap[String(severity)] || "?",
      involved, hour, minute,
      weekday, weekdayGroup,
      roadCondition: "trocken",
      mask
    };
  }

  test('byTimePattern is registered', () => {
    expect(UA.accidentViews.byTimePattern).toBeDefined();
    expect(UA.accidentViews.byTimePattern.id).toBe('byTimePattern');
  });

  test('classifies items into Schule / Berufsverkehr / Tag / Nacht buckets (deterministic)', () => {
    const items = [
      item({ hour: 7, minute: 30, weekdayGroup: 'Werktag' }), // schule_morgens
      item({ hour: 9,             weekdayGroup: 'Werktag' }), // berufs_morgens (>= 08:30, < 09:30)
      item({ hour: 13,            weekdayGroup: 'Werktag' }), // schule_nachmittag
      item({ hour: 15,            weekdayGroup: 'Werktag' }), // werktag_tag
      item({ hour: 18,            weekdayGroup: 'Werktag' }), // berufs_abends
      item({ hour: 23,            weekdayGroup: 'Werktag' }), // werktag_nacht
      item({ hour: 12,            weekdayGroup: 'Wochenende' }), // wochenende_tag
      item({ hour: 2,             weekdayGroup: 'Wochenende' }), // wochenende_nacht
    ];
    const r = UA.applyAccidentView(items, 'byTimePattern');
    const ids = new Set(r.groups.map(g => g.key));
    expect(ids.has('werktag_schule_morgens')).toBe(true);
    expect(ids.has('werktag_berufsverkehr_morgens')).toBe(true);
    expect(ids.has('werktag_schule_nachmittags')).toBe(true);
    expect(ids.has('werktag_tag')).toBe(true);
    expect(ids.has('werktag_berufsverkehr_abends')).toBe(true);
    expect(ids.has('werktag_nacht')).toBe(true);
    expect(ids.has('wochenende_tag')).toBe(true);
    expect(ids.has('wochenende_nacht')).toBe(true);
  });

  test('items with unknown hour land in "andere" (NOT Mittag-Slot)', () => {
    const items = [
      item({ hour: null, weekdayGroup: 'Werktag' }),
      item({ hour: null, weekdayGroup: 'Werktag' })
    ];
    const r = UA.applyAccidentView(items, 'byTimePattern');
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].key).toBe('andere');
    expect(r.groups[0].count).toBe(2);
  });

  test('Schule wins over Berufsverkehr for items in the overlap window (07:30 Werktag)', () => {
    const items = [item({ hour: 7, minute: 30, weekdayGroup: 'Werktag' })];
    const r = UA.applyAccidentView(items, 'byTimePattern');
    expect(r.groups[0].key).toBe('werktag_schule_morgens');
  });

  test('city-supplied cluster set is used when passed via opts.clusters', () => {
    const customClusters = [
      { id: 'frueh',  label: 'Sehr früh',  weekdayGroup: 'Werktag', hours: [[5, 0],  [7, 0]] },
      { id: 'spaet',  label: 'Sehr spät',  weekdayGroup: 'Werktag', hours: [[20, 0], [23, 0]] }
    ];
    const items = [
      item({ hour: 6,  weekdayGroup: 'Werktag' }), // frueh
      item({ hour: 21, weekdayGroup: 'Werktag' }), // spaet
      item({ hour: 12, weekdayGroup: 'Werktag' })  // andere
    ];
    const r = UA.applyAccidentView(items, 'byTimePattern', { clusters: customClusters });
    const keys = r.groups.map(g => g.key);
    expect(keys).toContain('frueh');
    expect(keys).toContain('spaet');
    expect(keys).toContain('andere');
  });

  test('groups sort by totalCount desc (most frequent cluster first)', () => {
    const items = [
      item({ hour: 7, minute: 30, weekdayGroup: 'Werktag' }), // schule
      item({ hour: 23, weekdayGroup: 'Werktag' }), // nacht
      item({ hour: 23, weekdayGroup: 'Werktag' }), // nacht
      item({ hour: 23, weekdayGroup: 'Werktag' })  // nacht
    ];
    const r = UA.applyAccidentView(items, 'byTimePattern');
    expect(r.groups[0].key).toBe('werktag_nacht');
    expect(r.groups[0].count).toBe(3);
  });

  test('header text contains label, condition (Mo–Fr 07:00–08:30) and counts', () => {
    const items = [item({ hour: 7, minute: 30, weekdayGroup: 'Werktag', mask: 1, severity: "3" })];
    const r = UA.applyAccidentView(items, 'byTimePattern');
    const text = r.groups[0].headers.text;
    expect(text).toContain('Schulverkehr');
    expect(text).toContain('Mo–Fr');
    expect(text).toContain('07:00');
    expect(text).toContain('n=1');
  });

  test('empty input → empty groups', () => {
    const r = UA.applyAccidentView([], 'byTimePattern');
    expect(r.groups).toEqual([]);
  });
});
