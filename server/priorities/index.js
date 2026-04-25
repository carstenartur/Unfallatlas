'use strict';

/**
 * Prioritäten-/Ranking-Sicht auf gespeicherte Location Action Briefs.
 *
 * Dieses Modul verdichtet die Antworten des Analysis Service (Spring Boot)
 * zu einer kompakten, vergleichbaren **Decision-Card-Form**, die in der
 * bestehenden Werkbank ohne UI-Neuerfindung als „Welche Stelle ist
 * wichtig, warum, mit welcher Maßnahme?" gezeigt werden kann.
 *
 * Bewusst **rein funktional** gehalten: keine HTTP-Calls, keine
 * Express-Abhängigkeit, keine Seiteneffekte.  Damit ist die Logik
 * vollständig testbar (siehe `tests/unit/priorities.test.js`) und kann
 * vom Express-Server über dünne Wrapper aufgerufen werden.
 *
 * Stabile Vokabular-Konvention für `dataStatus`:
 *   - `freshly_computed`  – frisch berechnet, nichts persistiert
 *   - `loaded_from_store` – aus dem Analysis Service gelesen
 *   - `persisted`         – berechnet UND erfolgreich persistiert
 *   - `fallback_result`   – Persistenz/Lesen war gewünscht, aber nicht
 *                           möglich; das Ergebnis stammt aus dem
 *                           Fallback-Pfad (Live-Compute oder leerer
 *                           Standard).  Carrier für UI-Hinweise und
 *                           Telemetrie.
 *
 * @module server/priorities
 */

/** Erlaubte Werte für `dataStatus` (eingefroren, stabiler API-Vertrag). */
const DATA_STATUS = Object.freeze({
  FRESHLY_COMPUTED:  'freshly_computed',
  LOADED_FROM_STORE: 'loaded_from_store',
  PERSISTED:         'persisted',
  FALLBACK_RESULT:   'fallback_result'
});

/**
 * Liste der unterstützten dataStatus-Werte als einfache Liste.  Wird im
 * Capability-/Status-Endpunkt mitgeliefert, damit Clients nicht
 * raten müssen, welche Strings stabil unterstützt werden.
 *
 * @type {ReadonlyArray<string>}
 */
const DATA_STATUS_VALUES = Object.freeze(Object.values(DATA_STATUS));

/**
 * Bildet `persistence.status` (aus `POST /api/location-brief`) auf den
 * stabilen `dataStatus` ab.  Erweitert das vorhandene Persistenz-Vokabular
 * **additiv**, ohne `persistence.status` selbst zu ändern, damit
 * bestehende Tests/Clients unverändert bleiben.
 *
 * @param {string|undefined|null} persistenceStatus
 * @returns {string} dataStatus
 */
function mapPersistenceStatusToDataStatus(persistenceStatus) {
  switch (persistenceStatus) {
    case 'persisted':         return DATA_STATUS.PERSISTED;
    case 'loaded_from_store': return DATA_STATUS.LOADED_FROM_STORE;
    case 'persist_skipped':   return DATA_STATUS.FALLBACK_RESULT;
    case 'freshly_computed':  return DATA_STATUS.FRESHLY_COMPUTED;
    default:
      // Unbekannter Status: konservativ als „frisch berechnet"
      // klassifizieren – kein Fallback-Hinweis ohne tatsächlichen Anlass.
      return DATA_STATUS.FRESHLY_COMPUTED;
  }
}

// ── Decision-Card-Normalisierung ─────────────────────────────────────────────

/**
 * Liefert die zwei wichtigsten Konfliktmuster (primary zuerst, dann
 * andere) in kompakter Form.  Nicht aussagekräftige Muster werden
 * gefiltert, damit die Karte kurz bleibt.
 *
 * @param {Array} patterns
 * @returns {Array<{id:string, label:string, classification:string, confidence:string}>}
 */
function pickTopPatterns(patterns) {
  if (!Array.isArray(patterns)) return [];
  const seen = new Set();
  const compact = [];
  // Primary-Muster zuerst (wichtige Information für Entscheider).
  const ordered = patterns.slice().sort((a, b) => {
    const ap = String(a && (a.classification || '')).toLowerCase() === 'primary' ? 0 : 1;
    const bp = String(b && (b.classification || '')).toLowerCase() === 'primary' ? 0 : 1;
    return ap - bp;
  });
  for (const p of ordered) {
    if (!p || typeof p !== 'object') continue;
    const id = String(p.id || p.patternId || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    compact.push({
      id,
      aliasId:        String(p.aliasId || '').trim() || null,
      label:          String(p.label || id).trim(),
      classification: String(p.classification || '').toLowerCase() || null,
      confidence:     String(p.confidence || '').toLowerCase() || null
    });
    if (compact.length >= 3) break;
  }
  return compact;
}

/**
 * Liefert die zwei wichtigsten Maßnahmen (höchster fitScore zuerst).
 * Bevorzugt explizit empfohlene Maßnahmen vor reinen Kandidaten.
 *
 * @param {Array} recommended  – `recommendedMeasures` aus dem Brief (optional)
 * @param {Array} candidates   – `candidateMeasures` (Fallback)
 * @returns {Array<{id:string, title:string, costBand:string|null, effort:string|null, fitScore:number|null}>}
 */
function pickTopMeasures(recommended, candidates) {
  const list = (Array.isArray(recommended) && recommended.length > 0)
    ? recommended
    : (Array.isArray(candidates) ? candidates : []);
  if (list.length === 0) return [];

  const score = (m) => {
    if (!m || typeof m !== 'object') return -1;
    const fit = Number(m.fitScore);
    if (Number.isFinite(fit)) return fit;
    // Position als Ersatz, wenn fitScore fehlt (kleinere Position = wichtiger).
    const pos = Number(m.position);
    return Number.isFinite(pos) ? -pos : 0;
  };

  return list
    .slice()
    .sort((a, b) => score(b) - score(a))
    .slice(0, 2)
    .map((m) => ({
      id:        String((m && (m.id || m.measureId)) || '').trim(),
      title:     String((m && m.title) || '').trim(),
      category:  m && m.category ? String(m.category) : null,
      costBand:  m && m.costBand ? String(m.costBand) : null,
      effort:    m && (m.implementationEffort || m.effort)
                   ? String(m.implementationEffort || m.effort) : null,
      fitScore:  Number.isFinite(Number(m && m.fitScore)) ? Number(m.fitScore) : null
    }));
}

/**
 * Findet den Profil-Score-Eintrag zum gewünschten Profil.  Akzeptiert
 * sowohl die Java-Service-Struktur (`profileScores: [{profileKey,total,...}]`)
 * als auch die Node-Brief-Struktur (`profileScores.byProfile[profile].total`).
 *
 * @param {object} brief
 * @param {string} preferredProfile
 * @returns {{profileKey:string, total:number|null, subScores:object|null}}
 */
function pickProfileScore(brief, preferredProfile) {
  const wanted = String(preferredProfile || '').trim();

  // Variante A: Liste (Analysis Service)
  if (Array.isArray(brief && brief.profileScores)) {
    const list = brief.profileScores;
    const match = list.find(s => s && String(s.profileKey || '') === wanted)
               || list[0] || {};
    return {
      profileKey: String(match.profileKey || wanted || ''),
      total:      Number.isFinite(Number(match.total)) ? Number(match.total) : null,
      subScores:  match.subScores && typeof match.subScores === 'object' ? match.subScores : null
    };
  }
  // Variante B: Objekt (Node-Brief – `profileScores.byProfile`)
  if (brief && brief.profileScores && typeof brief.profileScores === 'object') {
    const byProfile = brief.profileScores.byProfile || brief.profileScores;
    const entry = (byProfile && typeof byProfile === 'object')
      ? (byProfile[wanted] || Object.values(byProfile)[0] || null)
      : null;
    if (entry && typeof entry === 'object') {
      return {
        profileKey: String(entry.profile || wanted || ''),
        total:      Number.isFinite(Number(entry.total)) ? Number(entry.total) : null,
        subScores:  entry.subScores && typeof entry.subScores === 'object' ? entry.subScores : null
      };
    }
  }
  return { profileKey: wanted || '', total: null, subScores: null };
}

/**
 * Verdichtet einen (gespeicherten oder frisch berechneten) Brief zu einer
 * kompakten **Decision-Card** für die Prioritätenansicht.  Felder sind
 * absichtlich kurz und stabil benannt, damit sie 1:1 in der UI gezeigt
 * werden können (Ort, Profil, zentrale Scores, Konfliktmuster,
 * empfohlene Maßnahmen, politischer Kontext-Hinweis).
 *
 * @param {object} brief                 – LocationBriefResponseDto (Java) oder Node-Brief
 * @param {{preferredProfile?:string}} [opts]
 * @returns {object}                     – kompakte Karte
 */
function normalizeBriefCard(brief, opts) {
  const o = opts || {};
  const profileFromBrief = brief && (brief.profileKey
    || (brief.meta && brief.meta.profile));
  const preferredProfile = String(o.preferredProfile || profileFromBrief || '').trim();

  const score = pickProfileScore(brief, preferredProfile);
  const patterns = pickTopPatterns(brief && brief.conflictPatterns);
  const measures = pickTopMeasures(brief && brief.recommendedMeasures, brief && brief.candidateMeasures);

  // Politischer Kontext: einheitlicher Hinweis (Anzahl + Topflag), keine
  // vollständige Liste – die Karte soll überfliegbar bleiben.
  const polRefs = (brief && brief.politicalReferences) || [];
  const polSummary = (brief && brief.politicalContext) || null;
  const politicalCount = Array.isArray(polRefs)
    ? polRefs.length
    : (polSummary && Number.isFinite(Number(polSummary.totalFound))
        ? Number(polSummary.totalFound) : 0);
  const politicalHasHighRelevance = Array.isArray(polRefs) && polRefs.some(r =>
    r && (Number(r.relevance) >= 0.7 || String(r.relevanceLevel || '').toLowerCase() === 'high')
  );

  const city = String((brief && brief.city)
    || (brief && brief.meta && brief.meta.city) || '').trim();
  const title = String((brief && brief.title)
    || (brief && brief.meta && brief.meta.areaName)
    || (brief && brief.locationKey)
    || 'Unbekannte Stelle').trim();

  return {
    id:           String((brief && brief.id) || '') || null,
    locationKey:  String((brief && (brief.locationKey || brief.locationId)) || '') || null,
    city:         city || null,
    title,
    profileKey:   score.profileKey || null,
    confidence:   Number.isFinite(Number(brief && brief.confidence))
                    ? Number(brief.confidence) : null,
    score: {
      total:     score.total,
      subScores: score.subScores
    },
    conflictPatterns: patterns,
    recommendedMeasures: measures,
    political: {
      count:            politicalCount,
      hasHighRelevance: Boolean(politicalHasHighRelevance)
    },
    schemaVersion: String((brief && brief.schemaVersion) || '') || null,
    createdAt:     (brief && brief.createdAt) || null,
    sourceFingerprint: String((brief && brief.sourceFingerprint) || '') || null
  };
}

// ── Sortier-/Auswahl-Helfer ──────────────────────────────────────────────────

/**
 * Sortiert eine Liste gespeicherter Briefs zu einer Stelle so, dass der
 * passendste Eintrag zuerst steht: bevorzugt das gewünschte Profil,
 * danach den jüngsten Eintrag (höchstes `createdAt`).
 *
 * @param {Array} briefs
 * @param {string} [preferredProfile]
 * @returns {Array}
 */
function pickLatestPersistedFirst(briefs, preferredProfile) {
  if (!Array.isArray(briefs)) return [];
  const wanted = String(preferredProfile || '').trim();
  const ts = (b) => {
    const t = b && b.createdAt;
    if (!t) return 0;
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : 0;
  };
  return briefs.slice().sort((a, b) => {
    if (wanted) {
      const ap = String((a && a.profileKey) || '') === wanted ? 0 : 1;
      const bp = String((b && b.profileKey) || '') === wanted ? 0 : 1;
      if (ap !== bp) return ap - bp;
    }
    return ts(b) - ts(a);
  });
}

// ── Antwort-Envelope ─────────────────────────────────────────────────────────

/**
 * Baut die einheitliche Prioritäten-Antwort.  Für leere Resultate wird
 * **kein 404** ausgelöst – stattdessen ein klar markiertes leeres
 * Envelope mit `empty: true`, damit die UI eindeutig zwischen „kein
 * Ranking vorhanden" und „Service nicht erreichbar" unterscheiden kann.
 *
 * @param {object} args
 * @param {string} args.mode             – z. B. `'top'`, `'by-location'`
 * @param {Array}  args.items            – schon normalisierte Karten
 * @param {string} args.dataStatus       – einer von `DATA_STATUS_VALUES`
 * @param {object} [args.query]          – zur Verifikation in der UI
 * @param {string} [args.fallbackReason] – nur bei `dataStatus = fallback_result`
 * @returns {object}
 */
function buildPrioritiesResponse(args) {
  const a = args || {};
  if (!DATA_STATUS_VALUES.includes(a.dataStatus)) {
    throw new Error(`buildPrioritiesResponse: unbekannter dataStatus "${a.dataStatus}". Erlaubt: ${DATA_STATUS_VALUES.join(', ')}`);
  }
  const items = Array.isArray(a.items) ? a.items : [];
  const out = {
    mode:       String(a.mode || ''),
    dataStatus: a.dataStatus,
    count:      items.length,
    empty:      items.length === 0,
    items
  };
  if (a.query && typeof a.query === 'object') out.query = a.query;
  if (a.dataStatus === DATA_STATUS.FALLBACK_RESULT && a.fallbackReason) {
    out.fallbackReason = String(a.fallbackReason);
  }
  return out;
}

module.exports = {
  DATA_STATUS,
  DATA_STATUS_VALUES,
  mapPersistenceStatusToDataStatus,
  normalizeBriefCard,
  pickLatestPersistedFirst,
  pickTopPatterns,
  pickTopMeasures,
  pickProfileScore,
  buildPrioritiesResponse
};
