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
 * @property {string[]} [useCases]            – typische Einsatzfälle
 * @property {string[]} [cautions]            – typische Ausschluss-/Vorsichtsfälle
 * @property {string[]} [conflictPatterns]    – Pattern-IDs aus features/conflictPatterns
 * @property {string}   [effectDirection]     – z. B. "reduziert Schwere", "reduziert Häufigkeit"
 * @property {string}   [implementationDuration] – "weeks" | "months" | "year_plus"
 * @property {string}   [measureClass]        – quickWin | operational | marking | signal | structural | major_rebuild
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
    description: 'Sichtbare Schutzstreifen verbessern die Spurführung und reduzieren Konflikte mit Kfz beim Überholen und Abbiegen.',
    useCases: [
      'Hauptstraße mit Mischverkehr und sichtbarem Konflikt zwischen Rad- und Kfz-Verkehr',
      'Strecke ohne baulich getrennte Radführung'
    ],
    cautions: [
      'Bei sehr schmalen Querschnitten kann Schutzstreifen Scheinsicherheit erzeugen',
      'Nicht ausreichend, wenn hoher Lkw-/Schwerverkehrsanteil vorhanden ist'
    ],
    conflictPatterns: ['kfz_rad_abbiegekonflikt', 'rad_alleinunfall_oberflaeche', 'linearer_korridor_statt_punkt'],
    effectDirection: 'reduziert Konflikthäufigkeit (Spurführung)',
    implementationDuration: 'weeks',
    measureClass: 'marking'
  },
  {
    id: 'qw_sight_clearance',
    title: 'Sichtbeziehungen herstellen (Bewuchs zurückschneiden, parkende Fahrzeuge zurücksetzen)',
    category: 'quickWin',
    targetAccidentTypes: ['junction', 'crossing', 'ped_car', 'bike_car'],
    implementationEffort: 'low',
    costBand: 'low',
    description: 'Verbesserte Sichtachsen an Knotenpunkten und Querungen senken Konfliktrisiken bei Abbiege- und Überquerungsvorgängen.',
    useCases: [
      'Knotenpunkt mit Sichtbehinderung durch Bewuchs',
      'Querung mit parkenden Fahrzeugen unmittelbar davor'
    ],
    cautions: [
      'Allein selten ausreichend bei strukturellem Sichtproblem',
      'Pflege muss langfristig sichergestellt sein'
    ],
    conflictPatterns: ['sicht_park_konflikt', 'kfz_rad_abbiegekonflikt', 'fussverkehr_konflikt'],
    effectDirection: 'reduziert Konflikthäufigkeit (Wahrnehmbarkeit)',
    implementationDuration: 'weeks',
    measureClass: 'operational'
  },
  {
    id: 'qw_speed_signage',
    title: 'Tempoanpassung prüfen (Tempo 30 / 20, ggf. mit StVO-Anordnung)',
    category: 'quickWin',
    targetAccidentTypes: ['ped_car', 'bike_car', 'school_zone'],
    implementationEffort: 'low',
    costBand: 'low',
    description: 'Geringere Geschwindigkeit reduziert sowohl Unfallhäufigkeit als auch -schwere, besonders an sensiblen Stellen.',
    useCases: [
      'Schul-/Kita-Umfeld mit Querungsdruck',
      'Wohnstraße mit Durchgangsverkehr'
    ],
    cautions: [
      'Reine Beschilderung wirkt ohne flankierende Maßnahmen oft nur begrenzt',
      'Rechtliche Voraussetzungen nach StVO/VwV-StVO prüfen'
    ],
    conflictPatterns: ['schulumfeld_querungsdruck', 'fussverkehr_konflikt'],
    effectDirection: 'reduziert Schwere',
    implementationDuration: 'weeks',
    measureClass: 'signal'
  },
  {
    id: 'qw_warning_signs',
    title: 'Warnhinweise / Gefahrzeichen ergänzen (z. B. Achtung Radverkehr, Schule, Gleis)',
    category: 'quickWin',
    targetAccidentTypes: ['rail', 'school_zone', 'bike_car', 'ped_car'],
    implementationEffort: 'low',
    costBand: 'low',
    description: 'Aufmerksamkeitssteigerung in besonders konfliktträchtigen Abschnitten.',
    useCases: [
      'Punktuelle Gefahrenstelle (Schienenquerung, plötzlicher Konfliktpunkt)',
      'Übergang von übersichtlichem zu unübersichtlichem Bereich'
    ],
    cautions: [
      'Über-Beschilderung kann Wirkung mindern',
      'Ersetzt keine bauliche Lösung bei strukturellem Problem'
    ],
    conflictPatterns: ['schienenquerung_spitzwinkel', 'schulumfeld_querungsdruck'],
    effectDirection: 'reduziert Konflikthäufigkeit (Aufmerksamkeit)',
    implementationDuration: 'weeks',
    measureClass: 'signal'
  },
  {
    id: 'qw_lighting',
    title: 'Beleuchtung im Konfliktbereich verbessern',
    category: 'quickWin',
    targetAccidentTypes: ['night', 'ped_car', 'bike_car'],
    implementationEffort: 'medium',
    costBand: 'medium',
    description: 'Besonders bei nächtlicher Häufung oder schlechter Sichtbarkeit der schwächeren Verkehrsteilnehmenden.',
    useCases: [
      'Querung mit dokumentierter nächtlicher Unfallhäufung',
      'Haltestelle ohne ausreichende Ausleuchtung'
    ],
    cautions: [
      'Lichtimmissionen für Anwohnende beachten',
      'Wirkt nur bei tatsächlich beleuchtungsabhängigem Konflikt'
    ],
    conflictPatterns: ['fussverkehr_konflikt', 'oepnv_haltestellenbereich'],
    effectDirection: 'reduziert Konflikthäufigkeit (Sichtbarkeit)',
    implementationDuration: 'months',
    measureClass: 'structural'
  },

  // ── Infrastruktur (baulich) ─────────────────────────────────────────────────
  {
    id: 'inf_protected_bike_lane',
    title: 'Geschützter Radfahrstreifen / baulich getrennte Radführung',
    category: 'infrastructure',
    targetAccidentTypes: ['bike_car', 'bike_truck', 'bike_alone'],
    implementationEffort: 'high',
    costBand: 'high',
    description: 'Bauliche Trennung minimiert Konflikte mit dem Kfz-Verkehr und schafft attraktive, sichere Radinfrastruktur.',
    useCases: [
      'Strecke mit hohem Kfz-/Lkw-Aufkommen und nennenswertem Radverkehr',
      'Korridor mit wiederkehrenden Konflikten Rad/Kfz'
    ],
    cautions: [
      'Knotenpunkte und Anschlüsse müssen mitgeplant werden, sonst Verlagerung der Konflikte',
      'Flächenbedarf prüfen (Parken, Lieferzonen, Bäume)'
    ],
    conflictPatterns: ['kfz_rad_abbiegekonflikt', 'lkw_lieferverkehr_kontext', 'linearer_korridor_statt_punkt'],
    effectDirection: 'reduziert Häufigkeit und Schwere',
    implementationDuration: 'year_plus',
    measureClass: 'major_rebuild'
  },
  {
    id: 'inf_safe_crossing',
    title: 'Sichere Querungsanlage (Mittelinsel, FGÜ, Lichtsignal, Aufpflasterung)',
    category: 'infrastructure',
    targetAccidentTypes: ['ped_car', 'crossing', 'school_zone'],
    implementationEffort: 'medium',
    costBand: 'medium',
    description: 'Reduziert Konfliktpunkte für Fußverkehr und schafft definierte Querungsstellen.',
    useCases: [
      'Hauptachse mit erkennbarem Querungsbedarf (Schule, Haltestelle, Geschäfte)',
      'Längere Strecke ohne sicheres Querungsangebot'
    ],
    cautions: [
      'Wahl der Querungsform (FGÜ vs. Lichtsignal) hängt von Geschwindigkeit/Kfz-Stärke ab',
      'Rechtliche Voraussetzungen (R-FGÜ) beachten'
    ],
    conflictPatterns: ['fussverkehr_konflikt', 'schulumfeld_querungsdruck'],
    effectDirection: 'reduziert Häufigkeit und Schwere',
    implementationDuration: 'months',
    measureClass: 'structural'
  },
  {
    id: 'inf_junction_redesign',
    title: 'Knotenpunktgestaltung umbauen (kompakter, übersichtlicher, Rad-/Fußführung integriert)',
    category: 'infrastructure',
    targetAccidentTypes: ['junction', 'bike_car', 'car_car'],
    implementationEffort: 'high',
    costBand: 'high',
    description: 'Senkung von Abbiege- und Einbiegekonflikten durch klarere Geometrie.',
    useCases: [
      'Knotenpunkt mit wiederkehrenden Abbiege-/Einbiegekonflikten',
      'Großer/unübersichtlicher Knotenpunkt mit Schwereindikatoren'
    ],
    cautions: [
      'Hoher Planungs- und Abstimmungsaufwand',
      'Zwischenlösung kurzfristig erwägen (Markierung, Verkehrsführung)'
    ],
    conflictPatterns: ['kfz_rad_abbiegekonflikt', 'lkw_lieferverkehr_kontext'],
    effectDirection: 'reduziert Häufigkeit und Schwere',
    implementationDuration: 'year_plus',
    measureClass: 'major_rebuild'
  },
  {
    id: 'inf_surface_repair',
    title: 'Belagssanierung (Spurrillen, Schlaglöcher, Schienenführung im spitzen Winkel)',
    category: 'infrastructure',
    targetAccidentTypes: ['bike_alone', 'motorcycle', 'surface', 'rail'],
    implementationEffort: 'medium',
    costBand: 'medium',
    description: 'Schlechte Beläge und Schienenkreuzungen sind häufige Ursachen für Alleinunfälle, vor allem bei Nässe.',
    useCases: [
      'Strecke mit Häufung von Rad-Alleinunfällen ohne Kfz-Beteiligung',
      'Schienenquerung mit ungünstigem Winkel'
    ],
    cautions: [
      'Bei Schienen mit Bahnträger abstimmen',
      'Übergänge zwischen Materialien (Pflaster/Asphalt) sauber ausbilden'
    ],
    conflictPatterns: ['rad_alleinunfall_oberflaeche', 'schienenquerung_spitzwinkel'],
    effectDirection: 'reduziert Häufigkeit',
    implementationDuration: 'months',
    measureClass: 'structural'
  },
  {
    id: 'inf_truck_routing',
    title: 'Lkw-Routing / Lkw-Abbiege-Sicherheit (Abbiegeassistenten-Kampagne, Lkw-Sperrungen)',
    category: 'infrastructure',
    targetAccidentTypes: ['bike_truck', 'hgv', 'junction'],
    implementationEffort: 'medium',
    costBand: 'medium',
    description: 'Abbiegeunfälle Lkw-Rad gehören zu den schwersten Konfliktarten – Routing und technische Hilfen wirken stark.',
    useCases: [
      'Knotenpunkt mit wiederkehrenden Lkw-Abbiegekonflikten',
      'Liefer-/Industrieanbindung über sensible Korridore'
    ],
    cautions: [
      'Verlagerung in Wohnstraßen vermeiden',
      'Mit Wirtschaft/Logistik abstimmen, sonst geringe Akzeptanz'
    ],
    conflictPatterns: ['lkw_lieferverkehr_kontext', 'kfz_rad_abbiegekonflikt'],
    effectDirection: 'reduziert Schwere stark',
    implementationDuration: 'months',
    measureClass: 'operational'
  },
  {
    id: 'inf_bus_stop_redesign',
    title: 'ÖPNV-Haltestellengestaltung (Bus-Kap, Wartebereiche, Querungen am Halt)',
    category: 'infrastructure',
    targetAccidentTypes: ['transit', 'ped_car', 'bike_car'],
    implementationEffort: 'medium',
    costBand: 'medium',
    description: 'Sichere Querungen und Wartebereiche an Haltestellen senken Konflikte mit dem Fahrverkehr.',
    useCases: [
      'Haltestelle ohne sicheres Querungsangebot in der Nähe',
      'Bushalt mit Konflikten zwischen Rad-, Kfz- und Fußverkehr'
    ],
    cautions: [
      'Konflikt Bus/Rad bei Bus-Kap mitdenken',
      'Barrierefreiheit (DIN 18040-3) berücksichtigen'
    ],
    conflictPatterns: ['oepnv_haltestellenbereich', 'fussverkehr_konflikt'],
    effectDirection: 'reduziert Häufigkeit',
    implementationDuration: 'months',
    measureClass: 'structural'
  },
  {
    id: 'inf_school_route',
    title: 'Schulwegsicherung (Schulweg-Kampagne, Lotsen, Querungen, Halteverbote vor Schulen)',
    category: 'infrastructure',
    targetAccidentTypes: ['school_zone', 'ped_car', 'bike_car'],
    implementationEffort: 'medium',
    costBand: 'low',
    description: 'Gerade nahe Schulen/Kitas wirkt eine Kombination aus baulichen und organisatorischen Maßnahmen.',
    useCases: [
      'Schul-/Kita-Umfeld mit Querungsdruck',
      'Schulweg mit dokumentierten Konflikten'
    ],
    cautions: [
      'Reine Kampagnen ohne bauliche Komponente wirken oft nur kurzfristig',
      'Schulgemeinschaft frühzeitig einbinden'
    ],
    conflictPatterns: ['schulumfeld_querungsdruck', 'fussverkehr_konflikt'],
    effectDirection: 'reduziert Häufigkeit',
    implementationDuration: 'months',
    measureClass: 'operational'
  },

  // ── NEU: Spezifischere Maßnahmen ───────────────────────────────────────────
  {
    id: 'inf_protected_corner',
    title: 'Geschützte Knotenpunktecke / Aufstellbereich für Radverkehr (vorgezogene Haltlinie, Schutzecke)',
    category: 'infrastructure',
    targetAccidentTypes: ['bike_car', 'bike_truck', 'junction'],
    implementationEffort: 'medium',
    costBand: 'medium',
    description: 'Bauliche Schutzecken und vorgezogene Haltlinien ("ARAS") senken Sichtprobleme für Lkw-/Kfz-Abbieger und schützen Radverkehr im Konfliktbereich.',
    useCases: [
      'Signalisierter Knotenpunkt mit dokumentiertem Lkw-/Kfz-Abbiegekonflikt',
      'Knotenpunkt mit hohem Radverkehrsaufkommen, ohne separate Radsignalisierung'
    ],
    cautions: [
      'Setzt baulich umsetzbare Geometrie und ggf. Signalanpassung voraus',
      'Wirkung hängt von Aufstellfläche und Sichtachsen ab'
    ],
    conflictPatterns: ['kfz_rad_abbiegekonflikt', 'lkw_lieferverkehr_kontext'],
    effectDirection: 'reduziert Häufigkeit und Schwere',
    implementationDuration: 'months',
    measureClass: 'structural'
  },
  {
    id: 'qw_advance_green_bike',
    title: 'Vorgezogene Grünphase / separate Radsignalisierung prüfen',
    category: 'quickWin',
    targetAccidentTypes: ['bike_car', 'bike_truck', 'junction'],
    implementationEffort: 'medium',
    costBand: 'medium',
    description: 'Vorgezogene Räumung des Radverkehrs vor abbiegenden Kfz reduziert klassische Abbiegekonflikte.',
    useCases: [
      'Signalisierter Knotenpunkt mit Rad-/Kfz-Abbiegekonflikt',
      'Knotenpunkt mit Lkw-Anteil und Radverkehrsdurchfluss'
    ],
    cautions: [
      'Steigert Komplexität für Kfz-Fahrende, klare Signalbilder erforderlich',
      'Auswirkungen auf Leistungsfähigkeit prüfen'
    ],
    conflictPatterns: ['kfz_rad_abbiegekonflikt', 'lkw_lieferverkehr_kontext'],
    effectDirection: 'reduziert Häufigkeit',
    implementationDuration: 'months',
    measureClass: 'signal'
  },
  {
    id: 'inf_rail_crossing_realign',
    title: 'Schienenquerung entschärfen (Winkel begradigen, Hilfslinien, Belagstausch)',
    category: 'infrastructure',
    targetAccidentTypes: ['rail', 'bike_alone', 'surface'],
    implementationEffort: 'medium',
    costBand: 'medium',
    description: 'Schienen, die spitz zur Fahrlinie verlaufen, verursachen typische Stürze. Querungen mit Hilfslinien, größerem Querungswinkel oder veränderten Schienenführungen entschärfen das Risiko.',
    useCases: [
      'Querung mit Schienenführung im spitzen Winkel und Rad-Alleinunfällen',
      'Bekannte Sturzstelle bei Nässe'
    ],
    cautions: [
      'Mit Bahnträger / ÖPNV abstimmen',
      'Provisorien (Markierung) ersetzen keine bauliche Lösung dauerhaft'
    ],
    conflictPatterns: ['schienenquerung_spitzwinkel', 'rad_alleinunfall_oberflaeche'],
    effectDirection: 'reduziert Häufigkeit (Sturz)',
    implementationDuration: 'months',
    measureClass: 'structural'
  },
  {
    id: 'qw_raised_crossing',
    title: 'Aufpflasterung / niveaugleiche Aufmerksamkeitsstelle an Querung',
    category: 'quickWin',
    targetAccidentTypes: ['ped_car', 'crossing', 'school_zone'],
    implementationEffort: 'medium',
    costBand: 'medium',
    description: 'Aufpflasterungen senken Geschwindigkeiten an Querungen punktuell und verbessern die Aufmerksamkeit an konfliktträchtigen Stellen.',
    useCases: [
      'Schulumfeld mit Querungsdruck und nachgewiesenen Konflikten',
      'Wohnstraße mit dokumentiertem Fußverkehrskonflikt'
    ],
    cautions: [
      'Auswirkungen auf Busverkehr / Rettungsdienst prüfen',
      'Entwässerung berücksichtigen'
    ],
    conflictPatterns: ['fussverkehr_konflikt', 'schulumfeld_querungsdruck'],
    effectDirection: 'reduziert Schwere',
    implementationDuration: 'months',
    measureClass: 'structural'
  },
  {
    id: 'qw_parking_setback',
    title: 'Parken vor Querungen / Knotenpunkten zurücksetzen (5-m-Regel konsequent)',
    category: 'quickWin',
    targetAccidentTypes: ['junction', 'crossing', 'ped_car', 'bike_car'],
    implementationEffort: 'low',
    costBand: 'low',
    description: 'Konsequente Freihaltung des Sichtbereichs vor Knotenpunkten und Querungen schafft sofortige Wirkung – allein durch Markierung/Beschilderung und Kontrolle.',
    useCases: [
      'Knotenpunkt mit Sichtproblem durch parkende Fahrzeuge',
      'Querung mit verstellten Sichtachsen'
    ],
    cautions: [
      'Verlust von Stellplätzen muss politisch tragbar sein',
      'Ohne Kontrolle (Ordnungsamt) verpufft die Wirkung'
    ],
    conflictPatterns: ['sicht_park_konflikt', 'fussverkehr_konflikt'],
    effectDirection: 'reduziert Häufigkeit (Wahrnehmbarkeit)',
    implementationDuration: 'weeks',
    measureClass: 'operational'
  },

  // ── Organisatorisch ─────────────────────────────────────────────────────────
  {
    id: 'org_unfallkommission',
    title: 'Befassung der Unfallkommission anregen',
    category: 'organizational',
    targetAccidentTypes: ['junction', 'crossing', 'bike_car', 'ped_car'],
    implementationEffort: 'low',
    costBand: 'low',
    description: 'Formales Verfahren auf Basis der Unfalltypensteckkarte – rechtlich vorgesehene Stelle für auffällige Häufungen.',
    useCases: [
      'Auffällige Unfallhäufung im Sinne der MUK / Verwaltungsvorschrift',
      'Bereich mit schweren Unfällen, der bislang nicht behandelt wurde'
    ],
    cautions: [
      'Unfallkommission entscheidet selbst über Maßnahmen – Antrag muss faktisch belegt sein'
    ],
    conflictPatterns: ['schwere_unfaelle_geringe_haeufigkeit', 'kfz_rad_abbiegekonflikt'],
    effectDirection: 'aktiviert formales Verfahren',
    implementationDuration: 'weeks',
    measureClass: 'operational'
  },
  {
    id: 'org_site_inspection',
    title: 'Verkehrsschau / Ortstermin mit Polizei und Verwaltung anregen',
    category: 'organizational',
    targetAccidentTypes: ['junction', 'crossing', 'school_zone'],
    implementationEffort: 'low',
    costBand: 'low',
    description: 'Klärt vor Ort, welche der hypothetischen Risikofaktoren tatsächlich greifen.',
    useCases: [
      'Hypothesen aus den Daten müssen vor Ort verifiziert werden',
      'Vorbereitung weiterer Maßnahmen'
    ],
    cautions: [
      'Allein noch keine Maßnahme – muss ein konkreter Auftrag folgen'
    ],
    conflictPatterns: ['linearer_korridor_statt_punkt', 'sicht_park_konflikt', 'datenlage_unzureichend'],
    effectDirection: 'verbessert Faktenbasis',
    implementationDuration: 'weeks',
    measureClass: 'operational'
  },

  // ── Monitoring ──────────────────────────────────────────────────────────────
  {
    id: 'mon_followup',
    title: 'Monitoring nach Umsetzung (Nachher-Vergleich Unfallatlas-Daten der Folgejahre)',
    category: 'monitoring',
    targetAccidentTypes: [],
    implementationEffort: 'low',
    costBand: 'low',
    description: 'Wirkungskontrolle aller umgesetzten Maßnahmen anhand der amtlichen Daten.',
    useCases: [
      'Begleitend zu jeder umgesetzten Maßnahme',
      'Eigene Messung 2–4 Jahre nach Umsetzung'
    ],
    cautions: [
      'Geringe Fallzahlen ergeben unsichere Vergleiche – ggf. längere Beobachtungszeit'
    ],
    // Monitoring is generic for implemented measures, but for an explicitly
    // insufficient data basis it also has a concrete diagnostic purpose:
    // extend the observation period before recommending infrastructure.
    conflictPatterns: ['datenlage_unzureichend'],
    effectDirection: 'verbessert Lernen über Zeit',
    implementationDuration: 'year_plus',
    measureClass: 'operational'
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
