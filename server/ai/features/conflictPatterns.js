'use strict';

/**
 * Fachliche Konfliktmuster-Erkennung für die KI-Bewertung.
 *
 * Aufgabe:
 *   Aus den deterministisch berechneten Merkmalen
 *   (`features` aus deriveFeatures) und dem strukturierten Export wird
 *   eine Liste plausibler Konfliktmuster abgeleitet. Jedes Muster
 *   verweist auf konkrete Datenfelder, die es stützen, und auf
 *   semantische Tags / Kategorien, die später bei der
 *   Maßnahmenvorselektion verwendet werden.
 *
 * Entwurfsentscheidungen:
 *   - **Erklärbar statt magisch**: Jedes Muster muss mindestens eine
 *     Evidenzquelle nennen (Feldname + Wert). Wo das nicht möglich ist,
 *     wird das Muster nicht ausgegeben.
 *   - **Konservativ**: Im Zweifel `confidence: low` und Aufnahme in
 *     `secondary` statt `primary`. Lieber „Hypothese" als Scheinsicherheit.
 *   - **Datenarm-tauglich**: Bei sehr wenigen Unfällen (`< 5`) werden
 *     Muster automatisch auf maximal `medium` gedeckelt; bei `0`-Daten
 *     gibt es nur Hinweise mit explizitem `dataIssue`-Flag.
 *   - **Stabil benannt**: Die `id`s werden in Schema, Maßnahmenbibliothek
 *     und Tests benutzt – nicht ohne Migration ändern.
 *
 * Erkannte Muster (`id`):
 *   - kfz_rad_abbiegekonflikt
 *   - rad_alleinunfall_oberflaeche
 *   - schienenquerung_spitzwinkel
 *   - schulumfeld_querungsdruck
 *   - fussverkehr_konflikt
 *   - schwere_unfaelle_geringe_haeufigkeit
 *   - linearer_korridor_statt_punkt
 *   - sicht_park_konflikt
 *   - lkw_lieferverkehr_kontext
 *   - oepnv_haltestellenbereich
 *
 * @module server/ai/features/conflictPatterns
 */

/**
 * @typedef {object} ConflictPattern
 * @property {string}   id                 stabile Kennung
 * @property {string}   label              kurze deutsche Beschreibung
 * @property {string}   classification     "primary" | "secondary"
 * @property {string}   confidence         "high" | "medium" | "low"
 * @property {string[]} tags               Tags, die zur Maßnahmenauswahl genutzt werden
 * @property {string[]} evidence           Welche Datenfelder stützen das Muster?
 * @property {string}   rationale          Kurze fachliche Begründung
 * @property {string[]} requiresOnSiteCheck Hinweise, was vor Ort geprüft werden sollte
 * @property {boolean}  [dataIssue]        true, wenn nur aufgrund schwacher Daten genannt
 */

const LOW_DATA_THRESHOLD = 5;

/**
 * Leitet alle Konfliktmuster aus den vorberechneten Features + Hints ab.
 *
 * @param {object} features        – Output von `deriveFeatures`
 * @param {object} [contextHints]  – normalisierte Hints (knownHazards etc.)
 * @returns {ConflictPattern[]}    – sortiert: primary vor secondary, hohe vor niedriger confidence
 */
function detectConflictPatterns(features, contextHints) {
  const f = features || {};
  const inv = f.involvement || {};
  const counts = f.counts || {};
  const tags = new Set(Array.isArray(f.tags) ? f.tags : []);
  const sp = f.spatialDensity || {};
  const trend = f.trend || {};
  const hints = mergeHints(features, contextHints);

  const total = Number(counts.total || 0);
  const lowData = total > 0 && total < LOW_DATA_THRESHOLD;
  const noData = total === 0;

  const out = [];

  // ── 1) Kfz-Rad-Abbiegekonflikt ─────────────────────────────────────────────
  if (inv.bike >= 0.20 && inv.car >= 0.20 && (tags.has('junction') || (f.ksiShare || 0) >= 0.20)) {
    const conf = pickConfidence({ base: 'high', lowData, hasJunctionTag: tags.has('junction') });
    out.push({
      id: 'kfz_rad_abbiegekonflikt',
      label: 'Kfz/Rad-Abbiegekonflikt am Knotenpunkt',
      classification: 'primary',
      confidence: conf,
      tags: ['bike_car', 'junction'],
      evidence: [
        `involvement.bike=${pct(inv.bike)}`,
        `involvement.car=${pct(inv.car)}`,
        tags.has('junction') ? 'features.tags=junction' : `ksiShare=${pct(f.ksiShare)}`
      ],
      rationale: 'Erhöhter Anteil von Rad+Kfz mit Knotenpunkt-/Schwereindikatoren weist auf typische Abbiege-/Einbiegekonflikte hin.',
      requiresOnSiteCheck: [
        'Sichtverhältnisse aus Sicht von Kfz-Fahrenden auf Radverkehr prüfen',
        'Furtmarkierungen und Aufstellbereiche prüfen'
      ]
    });
  }

  // ── 2) Rad-Alleinunfall / Oberflächenproblem ───────────────────────────────
  if ((tags.has('bike_alone') || (inv.bike >= 0.40 && inv.car < 0.20)) || tags.has('surface')) {
    const conf = pickConfidence({
      base: tags.has('surface') ? 'medium' : 'low',
      lowData,
      boost: hints.surfaceMatch
    });
    out.push({
      id: 'rad_alleinunfall_oberflaeche',
      label: 'Rad-Alleinunfälle / Oberflächen- oder Belagsproblem',
      classification: tags.has('surface') ? 'primary' : 'secondary',
      confidence: conf,
      tags: ['bike_alone', 'surface'],
      evidence: [
        `involvement.bike=${pct(inv.bike)}`,
        `involvement.car=${pct(inv.car)}`,
        tags.has('surface') ? 'features.tags=surface' : 'tags=bike_alone'
      ].concat(hints.surfaceEvidence),
      rationale: 'Hoher Radanteil ohne nennenswerte Kfz-Beteiligung deutet auf Belags-, Spurrillen- oder Oberflächenprobleme hin.',
      requiresOnSiteCheck: [
        'Belag (Spurrillen, Pflaster, Schienen) bei Nässe begutachten',
        'Übergänge zwischen Asphalt/Pflaster und zu Schienen prüfen'
      ]
    });
  }

  // ── 3) Schienenquerung / spitzer Winkel / Rutschrisiko ─────────────────────
  if (tags.has('rail') || hints.railMatch) {
    out.push({
      id: 'schienenquerung_spitzwinkel',
      label: 'Schienenquerung im spitzen Winkel / Rutschrisiko',
      classification: 'primary',
      confidence: pickConfidence({ base: 'medium', lowData, boost: hints.railMatch }),
      tags: ['rail', 'surface', 'bike_alone'],
      evidence: [
        tags.has('rail') ? 'features.tags=rail' : 'contextHints.rail',
        ...hints.railEvidence
      ],
      rationale: 'Schienen, die im spitzen Winkel zur Fahrlinie verlaufen, sind eine bekannte Sturzursache, vor allem bei Nässe.',
      requiresOnSiteCheck: [
        'Querungswinkel der Schienen messen (Ziel ≥ 60°)',
        'Sicherungsmaßnahmen (Hilfslinien, Markierung) prüfen'
      ]
    });
  }

  // ── 4) Schulumfeld / Querungsdruck ────────────────────────────────────────
  if (tags.has('school_zone')) {
    out.push({
      id: 'schulumfeld_querungsdruck',
      label: 'Schulumfeld mit Querungsdruck',
      classification: 'primary',
      confidence: pickConfidence({ base: 'medium', lowData, boost: tags.has('ped_car') }),
      tags: ['school_zone', 'crossing', 'ped_car'],
      evidence: ['features.tags=school_zone', 'poiSummary'].concat(
        tags.has('ped_car') ? ['tags=ped_car'] : []
      ),
      rationale: 'Schul-/Kita-Umfeld mit erhöhter Fußverkehrsbeteiligung erzeugt typischen Querungsdruck zu Bring-/Holzeiten.',
      requiresOnSiteCheck: [
        'Querungsanlagen, Halteverbote und Sichtbeziehungen vor Schule/Kita aufnehmen',
        'Bring-/Holzeiten beobachten'
      ]
    });
  }

  // ── 5) Fußverkehrskonflikt ─────────────────────────────────────────────────
  if (inv.ped >= 0.15 || tags.has('ped_car')) {
    out.push({
      id: 'fussverkehr_konflikt',
      label: 'Fußverkehrskonflikt (Querung/Aufenthalt)',
      classification: 'primary',
      confidence: pickConfidence({ base: 'medium', lowData }),
      tags: ['ped_car', 'crossing'],
      evidence: [`involvement.ped=${pct(inv.ped)}`, ...(tags.has('crossing') ? ['tags=crossing'] : [])],
      rationale: 'Erhöhter Fußverkehrsanteil mit Kfz-Konflikten weist auf fehlende oder unsichere Querungen hin.',
      requiresOnSiteCheck: [
        'Querungsangebote, Wartebereiche und Sichtfelder prüfen',
        'Wege parallel zu Hauptachsen begehen'
      ]
    });
  }

  // ── 6) Schwere Unfälle bei geringer Häufigkeit ─────────────────────────────
  if ((counts.fatal + counts.serious) >= 1 && total > 0 && total < 10 && (f.ksiShare || 0) >= 0.30) {
    out.push({
      id: 'schwere_unfaelle_geringe_haeufigkeit',
      label: 'Geringe Fallzahl, aber überproportional schwere Folgen',
      classification: 'primary',
      confidence: 'medium',
      tags: ['junction', 'crossing'],
      evidence: [
        `counts.total=${total}`,
        `counts.fatal=${counts.fatal || 0}`,
        `counts.serious=${counts.serious || 0}`,
        `ksiShare=${pct(f.ksiShare)}`
      ],
      rationale: 'Auch bei kleiner Stichprobe erfordert ein hoher Anteil schwerer Unfälle eine fachliche Vertiefung statt rein statistischer Bewertung.',
      requiresOnSiteCheck: [
        'Einzelvorfälle mit Polizeibericht abgleichen',
        'Unfallkommission befassen, da statistische Einordnung unsicher bleibt'
      ],
      dataIssue: true
    });
  }

  // ── 7) Linearer Streckenmangel statt Punktproblem ─────────────────────────
  if (sp.hint === 'distributed' || sp.hint === 'localized') {
    out.push({
      id: 'linearer_korridor_statt_punkt',
      label: 'Korridor- statt Punktproblem (linearer Streckenmangel)',
      classification: 'secondary',
      confidence: pickConfidence({ base: 'medium', lowData }),
      tags: ['bike_car', 'crossing'],
      evidence: [`spatialDensity.hint=${sp.hint}`, `spatialDensity.spanMeters=${sp.spanMeters || 0}`],
      rationale: 'Wenn Unfälle nicht eng gruppiert sind, deutet dies auf einen Streckenmangel auf einer Achse statt auf einen einzelnen Knotenpunkt hin.',
      requiresOnSiteCheck: [
        'Achse als Ganzes befahren (Rad-/Fußperspektive)',
        'Wiederkehrende Mängel (Markierung, Belag, Radführung) dokumentieren'
      ]
    });
  }

  // ── 8) Sichtbeziehungs- / Parkkonflikt ────────────────────────────────────
  if (hints.sightMatch || tags.has('junction') || tags.has('crossing')) {
    out.push({
      id: 'sicht_park_konflikt',
      label: 'Sichtbeziehungs- oder Parkkonflikt',
      classification: hints.sightMatch ? 'primary' : 'secondary',
      confidence: pickConfidence({ base: hints.sightMatch ? 'medium' : 'low', lowData }),
      tags: ['junction', 'crossing', 'ped_car', 'bike_car'],
      evidence: [
        ...(hints.sightMatch ? hints.sightEvidence : []),
        ...(tags.has('junction') ? ['features.tags=junction'] : []),
        ...(tags.has('crossing') ? ['features.tags=crossing'] : [])
      ],
      rationale: 'Knotenpunkte mit Parkdruck oder Bewuchs erzeugen typischerweise Sichtprobleme – vor allem für Rad- und Fußverkehr.',
      requiresOnSiteCheck: [
        'Sichtachsen aus Augenhöhe Kind/Rad prüfen',
        'Parken vor Querungen / im Knotenbereich aufnehmen'
      ]
    });
  }

  // ── 9) Hoher Lkw-/Lieferverkehrskontext ───────────────────────────────────
  if (tags.has('hgv') || tags.has('bike_truck') || hints.truckMatch) {
    out.push({
      id: 'lkw_lieferverkehr_kontext',
      label: 'Lkw-/Lieferverkehrskontext',
      classification: tags.has('bike_truck') ? 'primary' : 'secondary',
      confidence: pickConfidence({ base: tags.has('bike_truck') ? 'high' : 'medium', lowData }),
      tags: ['hgv', 'bike_truck', 'junction'],
      evidence: [
        `involvement.truck=${pct(inv.truck)}`,
        ...(tags.has('bike_truck') ? ['tags=bike_truck'] : []),
        ...hints.truckEvidence
      ],
      rationale: 'Lkw-/Lieferverkehrsanteil erhöht Risiko schwerer Abbiegeunfälle und erfordert besondere Aufmerksamkeit für Sicht/Routing.',
      requiresOnSiteCheck: [
        'Lkw-Routen und Lieferzeiten erfassen',
        'Toter-Winkel-Risiken an Knotenpunkten dokumentieren'
      ]
    });
  }

  // ── 10) Problematischer ÖPNV-/Haltestellenbereich ────────────────────────
  if (tags.has('transit')) {
    out.push({
      id: 'oepnv_haltestellenbereich',
      label: 'ÖPNV-/Haltestellenbereich mit Konfliktpotenzial',
      classification: 'secondary',
      confidence: pickConfidence({ base: 'medium', lowData }),
      tags: ['transit', 'ped_car', 'bike_car'],
      evidence: ['features.tags=transit', 'poiSummary.transit'],
      rationale: 'Haltestellen erzeugen typische Konflikte zwischen Aussteigenden, Fußgängern und Rad-/Kfz-Verkehr.',
      requiresOnSiteCheck: [
        'Querungsangebote in Haltestellennähe prüfen',
        'Wartebereiche und Verkehrsführung am Halt aufnehmen'
      ]
    });
  }

  // ── Fallback: zu wenige Daten ─────────────────────────────────────────────
  if (out.length === 0 && noData) {
    out.push({
      id: 'datenlage_unzureichend',
      label: 'Datenlage zu schwach für belastbares Konfliktmuster',
      classification: 'secondary',
      confidence: 'low',
      tags: [],
      evidence: ['counts.total=0'],
      rationale: 'Im Auswertungszeitraum wurden keine Unfälle im Bereich erfasst.',
      requiresOnSiteCheck: [
        'Ortsbegehung mit Polizei',
        'Erweiterung des Auswertungszeitraums prüfen'
      ],
      dataIssue: true
    });
  }

  // Stable sort: primary first, then by confidence rank (high>medium>low)
  const rankCls = c => (c === 'primary' ? 0 : 1);
  const rankConf = c => (c === 'high' ? 0 : c === 'medium' ? 1 : 2);
  out.sort((a, b) => {
    if (rankCls(a.classification) !== rankCls(b.classification)) return rankCls(a.classification) - rankCls(b.classification);
    return rankConf(a.confidence) - rankConf(b.confidence);
  });

  return out;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function mergeHints(features, contextHints) {
  const fromFeatures = features?.normalizedHints || {};
  const safe = contextHints && typeof contextHints === 'object' ? contextHints : {};
  const all = []
    .concat(arr(fromFeatures.knownHazards), arr(fromFeatures.surfaceHints), arr(fromFeatures.locationHints), arr(fromFeatures.notes))
    .concat(arr(safe.knownHazards),         arr(safe.surfaceHints),         arr(safe.locationHints),         arr(safe.notes));
  const lower = all.map(h => String(h || '').toLowerCase());

  const railMatch    = lower.some(h => h.includes('schiene') || h.includes('gleis') || h.includes('tram'));
  const surfaceMatch = lower.some(h => h.includes('belag') || h.includes('pflaster') || h.includes('kopfstein') || h.includes('spurrille') || h.includes('rutsch') || h.includes('nässe'));
  const truckMatch   = lower.some(h => h.includes('lkw') || h.includes('truck') || h.includes('schwerverkehr') || h.includes('liefer'));
  const sightMatch   = lower.some(h => h.includes('sicht') || h.includes('park') || h.includes('bewuchs'));

  return {
    railMatch,
    railEvidence: railMatch ? lower.filter(h => /schiene|gleis|tram/.test(h)).slice(0, 2).map(s => `contextHints:"${s}"`) : [],
    surfaceMatch,
    surfaceEvidence: surfaceMatch ? lower.filter(h => /belag|pflaster|kopfstein|spurrille|rutsch|nässe/.test(h)).slice(0, 2).map(s => `contextHints:"${s}"`) : [],
    truckMatch,
    truckEvidence:   truckMatch ? lower.filter(h => /lkw|truck|schwerverkehr|liefer/.test(h)).slice(0, 2).map(s => `contextHints:"${s}"`) : [],
    sightMatch,
    sightEvidence:   sightMatch ? lower.filter(h => /sicht|park|bewuchs/.test(h)).slice(0, 2).map(s => `contextHints:"${s}"`) : []
  };
}

function arr(x) { return Array.isArray(x) ? x : []; }

function pct(x) {
  if (!Number.isFinite(x)) return '0';
  return `${Math.round(x * 100)}%`;
}

function pickConfidence({ base, lowData, hasJunctionTag, boost }) {
  let levels = ['low', 'medium', 'high'];
  let idx = levels.indexOf(base) >= 0 ? levels.indexOf(base) : 1;
  if (boost) idx = Math.min(idx + 1, 2);
  if (hasJunctionTag === false) idx = Math.max(idx - 1, 0);
  if (lowData) idx = Math.min(idx, 1); // cap at medium when low data
  return levels[idx];
}

module.exports = {
  detectConflictPatterns,
  // exposed for tests
  LOW_DATA_THRESHOLD
};
