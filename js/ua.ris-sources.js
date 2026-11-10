/* Shared presentation of independently sourced political levels. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) (root.UA = root.UA || {}).RisSources = api;
})(typeof window === 'object' ? window : null, () => {
  'use strict';

  const levels = Object.freeze([
    { id: 'city', label: 'Stadt' },
    { id: 'region', label: 'Region' },
    { id: 'state', label: 'Land' },
    { id: 'federal', label: 'Deutschland' },
    { id: 'eu', label: 'EU' },
  ].map(Object.freeze));
  const knownLevels = new Set(levels.map(level => level.id));
  const sources = new Map([
    ['hannover-sim', ['city', 'Landeshauptstadt Hannover · SIM']],
    ['region-hannover-ris', ['region', 'Region Hannover · ALLRIS']],
    ['region-hannover-bekanntmachungen', ['region', 'Region Hannover · Bekanntmachungen']],
    ['niedersachsen-landtag', ['state', 'Niedersächsischer Landtag']],
    ['landtag-catalogue', ['state', 'Niedersächsischer Landtag']],
    ['landtag-rss-drucksachen', ['state', 'Niedersächsischer Landtag']],
    ['landtag-rss-steno', ['state', 'Niedersächsischer Landtag']],
    ['bonn-oparl', ['city', 'Bundesstadt Bonn · Ratsinformationssystem']],
    ['bonn-allris', ['city', 'Bundesstadt Bonn · Ratsinformationssystem']],
    ['bonn-sitzung-online', ['city', 'Bundesstadt Bonn · Ratsinformationssystem']],
    ['bonn-legacy-buergerinfo', ['city', 'Bundesstadt Bonn · Bürgerinformation']],
    ['berlin-allris', ['city', 'Berlin · Bezirksverordnetenversammlung']],
    ['hamburg-parldok', ['state', 'Hamburgische Bürgerschaft']],
    ['bielefeld-sessionnet', ['city', 'Stadt Bielefeld · Ratsinformationssystem']],
    ['chemnitz-sessionnet', ['city', 'Stadt Chemnitz · Ratsinformationssystem']],
    ['halle-sessionnet', ['city', 'Stadt Halle (Saale) · Ratsinformationssystem']],
    ['magdeburg-sessionnet', ['city', 'Landeshauptstadt Magdeburg · Ratsinformationssystem']],
    ['nuernberg-sessionnet', ['city', 'Stadt Nürnberg · Ratsinformationssystem']],
  ]);

  function normalizeLevels(value) {
    if (!Array.isArray(value)) return [];
    const selected = new Set(value);
    return levels.map(level => level.id).filter(id => selected.has(id));
  }

  function parseLevels(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > levels.length || value.some(id => !knownLevels.has(id))) {
      throw Object.assign(new Error('Ungültige Auswahl der politischen Ebenen.'), { code: 'RIS_SOURCE_LEVELS_INVALID' });
    }
    return normalizeLevels(value);
  }

  function levelOf(record) {
    const level = record?.sourceContext?.level;
    return knownLevels.has(level) ? level : sources.get(record?.source)?.[0] || null;
  }

  function sourceLabel(record) {
    const publisher = record?.sourceContext?.publisher;
    return sources.get(record?.source)?.[1]
      || (typeof publisher === 'string' && publisher.trim() ? publisher.trim() : '')
      || (typeof record?.source === 'string' && record.source.trim() ? record.source.trim() : '')
      || 'Quelle nicht angegeben';
  }

  return { levels, levelOf, sourceLabel, normalizeLevels, parseLevels };
});
