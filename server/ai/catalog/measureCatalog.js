'use strict';

/**
 * Maßnahmenbibliothek für die KI-gestützte Bewertung.
 *
 * Die KI darf Maßnahmen primär aus dieser Bibliothek wählen, anstatt sie frei
 * zu erfinden.  Jede Maßnahme ist mit fachlichen Metadaten annotiert
 * (Kategorie, Zielunfalltypen, Aufwand, Kostenband), damit die Vorselektion
 * (`scoring/preselectMeasures.js`) deterministisch passende Kandidaten ziehen
 * kann.
 *
 * targetAccidentTypes verwendet semantische Tags, die zu Merkmalen aus
 * `features/deriveFeatures.js` passen:
 *   bike_alone, bike_car, bike_truck, ped_car, ped_alone,
 *   car_car, motorcycle, hgv, junction, crossing, surface,
 *   night, rush_hour, school_zone, transit, rail
 *
 * Quelle: gängige kommunale Maßnahmenkataloge (FGSV, ERA, BMVI etc.) –
 * verkürzt für den deutschen kommunalen Kontext.
 *
 * @module server/ai/catalog/measureCatalog
 */

/**
 * @typedef {object} CatalogMeasure
 * @property {string}   id
 * @property {string}   title
 * @property {string}   category   – quickWin | infrastructure | organizational | monitoring
 * @property {string[]} targetAccidentTypes
 * @property {string}   implementationEffort  – low | medium | high
 * @property {string}   costBand              – low | medium | high
 * @property {string}   description
 */

/** @type {CatalogMeasure[]} */
const MEASURE_CATALOG = [
  // ── Quick Wins (Markierung, Beschilderung, Sicht) ───────────────────────────
  {
    id: 'qw_marking_bike_lane',
    title: 'Fahrbahnmarkierung Schutzstreifen / Radfahrstreifen erneuern oder ergänzen',
    category: 'quickWin',
    targetAccidentTypes: ['bike_alone', 'bike_car', 'junction'],
    implementationEffort: 'low',
    costBand: 'low',
    description: 'Sichtbare Schutzstreifen verbessern die Spurführung und reduzieren Konflikte mit Kfz beim Überholen und Abbiegen.'
  },
  {
    id: 'qw_sight_clearance',
    title: 'Sichtbeziehungen herstellen (Bewuchs zurückschneiden, parkende Fahrzeuge zurücksetzen)',
    category: 'quickWin',
    targetAccidentTypes: ['junction', 'crossing', 'ped_car', 'bike_car'],
    implementationEffort: 'low',
    costBand: 'low',
    description: 'Verbesserte Sichtachsen an Knotenpunkten und Querungen senken Konfliktrisiken bei Abbiege- und Überquerungsvorgängen.'
  },
  {
    id: 'qw_speed_signage',
    title: 'Tempoanpassung prüfen (Tempo 30 / 20, ggf. mit StVO-Anordnung)',
    category: 'quickWin',
    targetAccidentTypes: ['ped_car', 'bike_car', 'school_zone'],
    implementationEffort: 'low',
    costBand: 'low',
    description: 'Geringere Geschwindigkeit reduziert sowohl Unfallhäufigkeit als auch -schwere, besonders an sensiblen Stellen.'
  },
  {
    id: 'qw_warning_signs',
    title: 'Warnhinweise / Gefahrzeichen ergänzen (z. B. Achtung Radverkehr, Schule, Gleis)',
    category: 'quickWin',
    targetAccidentTypes: ['rail', 'school_zone', 'bike_car', 'ped_car'],
    implementationEffort: 'low',
    costBand: 'low',
    description: 'Aufmerksamkeitssteigerung in besonders konfliktträchtigen Abschnitten.'
  },
  {
    id: 'qw_lighting',
    title: 'Beleuchtung im Konfliktbereich verbessern',
    category: 'quickWin',
    targetAccidentTypes: ['night', 'ped_car', 'bike_car'],
    implementationEffort: 'medium',
    costBand: 'medium',
    description: 'Besonders bei nächtlicher Häufung oder schlechter Sichtbarkeit der schwächeren Verkehrsteilnehmenden.'
  },

  // ── Infrastruktur (baulich) ─────────────────────────────────────────────────
  {
    id: 'inf_protected_bike_lane',
    title: 'Geschützter Radfahrstreifen / baulich getrennte Radführung',
    category: 'infrastructure',
    targetAccidentTypes: ['bike_car', 'bike_truck', 'bike_alone'],
    implementationEffort: 'high',
    costBand: 'high',
    description: 'Bauliche Trennung minimiert Konflikte mit dem Kfz-Verkehr und schafft attraktive, sichere Radinfrastruktur.'
  },
  {
    id: 'inf_safe_crossing',
    title: 'Sichere Querungsanlage (Mittelinsel, FGÜ, Lichtsignal, Aufpflasterung)',
    category: 'infrastructure',
    targetAccidentTypes: ['ped_car', 'crossing', 'school_zone'],
    implementationEffort: 'medium',
    costBand: 'medium',
    description: 'Reduziert Konfliktpunkte für Fußverkehr und schafft definierte Querungsstellen.'
  },
  {
    id: 'inf_junction_redesign',
    title: 'Knotenpunktgestaltung umbauen (kompakter, übersichtlicher, Rad-/Fußführung integriert)',
    category: 'infrastructure',
    targetAccidentTypes: ['junction', 'bike_car', 'car_car'],
    implementationEffort: 'high',
    costBand: 'high',
    description: 'Senkung von Abbiege- und Einbiegekonflikten durch klarere Geometrie.'
  },
  {
    id: 'inf_surface_repair',
    title: 'Belagssanierung (Spurrillen, Schlaglöcher, Schienenführung im spitzen Winkel)',
    category: 'infrastructure',
    targetAccidentTypes: ['bike_alone', 'motorcycle', 'surface', 'rail'],
    implementationEffort: 'medium',
    costBand: 'medium',
    description: 'Schlechte Beläge und Schienenkreuzungen sind häufige Ursachen für Alleinunfälle, vor allem bei Nässe.'
  },
  {
    id: 'inf_truck_routing',
    title: 'Lkw-Routing / Lkw-Abbiege-Sicherheit (Abbiegeassistenten-Kampagne, Lkw-Sperrungen)',
    category: 'infrastructure',
    targetAccidentTypes: ['bike_truck', 'hgv', 'junction'],
    implementationEffort: 'medium',
    costBand: 'medium',
    description: 'Abbiegeunfälle Lkw-Rad gehören zu den schwersten Konfliktarten – Routing und technische Hilfen wirken stark.'
  },
  {
    id: 'inf_bus_stop_redesign',
    title: 'ÖPNV-Haltestellengestaltung (Bus-Kap, Wartebereiche, Querungen am Halt)',
    category: 'infrastructure',
    targetAccidentTypes: ['transit', 'ped_car', 'bike_car'],
    implementationEffort: 'medium',
    costBand: 'medium',
    description: 'Sichere Querungen und Wartebereiche an Haltestellen senken Konflikte mit dem Fahrverkehr.'
  },
  {
    id: 'inf_school_route',
    title: 'Schulwegsicherung (Schulweg-Kampagne, Lotsen, Querungen, Halteverbote vor Schulen)',
    category: 'infrastructure',
    targetAccidentTypes: ['school_zone', 'ped_car', 'bike_car'],
    implementationEffort: 'medium',
    costBand: 'low',
    description: 'Gerade nahe Schulen/Kitas wirkt eine Kombination aus baulichen und organisatorischen Maßnahmen.'
  },

  // ── Organisatorisch ─────────────────────────────────────────────────────────
  {
    id: 'org_unfallkommission',
    title: 'Befassung der Unfallkommission anregen',
    category: 'organizational',
    targetAccidentTypes: ['junction', 'crossing', 'bike_car', 'ped_car'],
    implementationEffort: 'low',
    costBand: 'low',
    description: 'Formales Verfahren auf Basis der Unfalltypensteckkarte – rechtlich vorgesehene Stelle für auffällige Häufungen.'
  },
  {
    id: 'org_site_inspection',
    title: 'Verkehrsschau / Ortstermin mit Polizei und Verwaltung anregen',
    category: 'organizational',
    targetAccidentTypes: ['junction', 'crossing', 'school_zone'],
    implementationEffort: 'low',
    costBand: 'low',
    description: 'Klärt vor Ort, welche der hypothetischen Risikofaktoren tatsächlich greifen.'
  },

  // ── Monitoring ──────────────────────────────────────────────────────────────
  {
    id: 'mon_followup',
    title: 'Monitoring nach Umsetzung (Nachher-Vergleich Unfallatlas-Daten der Folgejahre)',
    category: 'monitoring',
    targetAccidentTypes: [],
    implementationEffort: 'low',
    costBand: 'low',
    description: 'Wirkungskontrolle aller umgesetzten Maßnahmen anhand der amtlichen Daten.'
  }
];

/**
 * Map id → measure for fast lookup.
 */
const MEASURE_BY_ID = Object.freeze(
  MEASURE_CATALOG.reduce((acc, m) => { acc[m.id] = m; return acc; }, {})
);

module.exports = {
  MEASURE_CATALOG,
  MEASURE_BY_ID,
  /** All measure ids exposed for tests / external consumers. */
  MEASURE_IDS: MEASURE_CATALOG.map(m => m.id)
};
