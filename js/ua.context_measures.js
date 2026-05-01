/**
 * UA.contextMeasures — orts- und musterbezogene Maßnahmen-Empfehlungen.
 *
 * Hintergrund (QA-Befund):
 *   Die generische `recommendMeasures`-Engine in `js/ua.measures.js` matched
 *   Maßnahmen ausschließlich über `effect.targetPatterns` (Bit-Masken der
 *   überrepräsentierten Beteiligungsmuster) und kennt keinen Ortskontext.
 *   Deshalb erschien z. B. „Sichtbeziehungen herstellen (Bewuchs/Parken)"
 *   als Hauptmaßnahme im Umfeld eines Hauptbahnhofs/Busbahnhofs mit
 *   Schienenverkehr — fachlich nicht plausibel.
 *
 * Lösung:
 *   Dieses Modul fügt eine **regelbasierte Maßnahmenmatrix** hinzu, die
 *   das Tupel (Unfallmuster × Ortskontext) auf konkrete Prüfaufträge,
 *   kurzfristige und mittelfristige Maßnahmen abbildet (Spec-Items 4A-E
 *   und 8). Die Engine läuft **zusätzlich** zur bestehenden Katalog-Engine,
 *   überschreibt sie nicht — der Renderer kann beide Listen ausgeben und
 *   priorisiert die kontext-spezifischen Vorschläge.
 *
 * Drei Funktionen:
 *
 *   1. `classifyPatterns(structured)` — übersetzt detektierte Bit-Masken
 *      und Schweregrad-Statistik in Pattern-Keys (z. B.
 *      `rad_alleinunfall_schwer`, `rad_pkw_kollision`, `rad_fuss_konflikt`).
 *
 *   2. `detectContexts(osmContext, override)` — leitet Kontext-Keys (z. B.
 *      `bahnhof`, `busbahnhof`, `tram_tracks`, `kopfsteinpflaster`,
 *      `gemeinsame_fuss_rad_flaeche`) aus dem OSM-Aggregat ab. Akzeptiert
 *      einen expliziten Override (Liste oder Set), der OSM-Erkennung
 *      übergeht — gedacht für UI-Schalter und Tests.
 *
 *   3. `deriveContextualMeasures(patternKeys, contextKeys)` — wendet die
 *      eingebettete Matrix RULES an und liefert
 *      `{ kurzfristig:[], mittelfristig:[], pruefauftraege:[],
 *         rationale:string, matchedRules:[{pattern,context,id}] }`.
 *      Deduplikation pro Bucket (gleicher Wortlaut nur einmal).
 *
 * Die Matrix basiert wörtlich auf dem User-Goldstandard (Problem-
 * Statement Items 4A-E + Beispieltext 8) und ist daher als
 * Konstanten-Tabelle ausgelegt — kein KI-Aufruf, keine Heuristik, voll
 * deterministisch und auditierbar.
 */
(() => {
  const UA = (window.UA = window.UA || {});

  // ----------------------------------------------------------------
  // Mask → Pattern-Key. Die Masken kommen aus `dev.focus[].mask` in
  // `js/ua.export_v2.js` PATTERN_MAP (Bit 1=Rad, 2=Fuß, 4=PKW, 8=Bus,
  // 16=Gkfz). „Schwer" wird zusätzlich anhand der Schweregrad-Statistik
  // (`structured.severity.bySev.sev2 = Schwerverletzte`) markiert.
  // ----------------------------------------------------------------
  const MASK_TO_BASE_PATTERN = Object.freeze({
    1:  "rad_alleinunfall",
    3:  "rad_fuss_konflikt",
    5:  "rad_pkw_kollision",
    6:  "fuss_pkw_kollision",
    9:  "rad_bus_konflikt",
    17: "lkw_rad_abbiegen",
    18: "lkw_fuss_abbiegen"
  });

  /**
   * Convert the detected-pattern masks + severity stats into a flat Set
   * of pattern keys understood by the rule matrix. Returns a `Set<string>`
   * so callers can do efficient `.has(...)` membership tests.
   *
   * Severity escalation: when the focus row for mask 1 (rad_alleinunfall)
   * carries a high share of severely injured people (KSI → mostly sev2),
   * we additionally emit `rad_alleinunfall_schwer`. „Hoher Anteil" =
   * mindestens 1 KSI in der Kohorte, was für die Antrags-Sprache reicht
   * (der Antrag spricht nicht von Frequenzen, sondern von „schweren
   * Unfällen"). Pure Häufigkeit ohne KSI bleibt `rad_alleinunfall`.
   *
   * @param {object|null} structured  `report.structured` aus computeExportReport
   * @returns {Set<string>}
   */
  function classifyPatterns(structured) {
    const out = new Set();
    if (!structured) return out;

    const focus = (structured.deviations && Array.isArray(structured.deviations.focus))
      ? structured.deviations.focus
      : [];
    const masks = focus.map(r => Number(r && r.mask)).filter(Number.isFinite);

    for (const m of masks) {
      const base = MASK_TO_BASE_PATTERN[m];
      if (base) out.add(base);
    }

    // Severity escalation: KSI = sev1 (Getötete) + sev2 (Schwerverletzte).
    // Wenn KSI ≥ 1 UND ein Rad-Alleinunfall-Muster da ist, gilt das als
    // „rad_alleinunfall_schwer" (Antragssprache). Wir leiten KSI aus
    // structured.severity.bySev ab, das computeExportReport immer setzt.
    const bySev = (structured.severity && structured.severity.bySev) || {};
    const ksi = Number(bySev.sev1 || 0) + Number(bySev.sev2 || 0);
    if (out.has("rad_alleinunfall") && ksi >= 1) {
      out.add("rad_alleinunfall_schwer");
    }

    // Conditions-Eskalation (Spec-Item 3): Häufung bei Nässe / Dunkelheit /
    // Stoßzeiten lassen sich aus heatmap/wetter ableiten — wenn
    // computeExportReport die Felder liefert. Defensives Lesen: fehlende
    // Felder schweigen, statt zu raten.
    const wx = structured.weather || structured.wetter || null;
    if (wx && Number(wx.wetShare || 0) >= 0.30) out.add("haeufung_bei_naesse");
    if (wx && Number(wx.darkShare || 0) >= 0.40) out.add("haeufung_bei_dunkelheit");

    const hm = structured.heatmap || null;
    if (hm && Number(hm.peakHourShare || 0) >= 0.25) out.add("haeufung_stosszeiten");

    return out;
  }
  // ----------------------------------------------------------------
  // Kontext-Erkennung. Akzeptiert sowohl einen expliziten Override
  // (Spec-Item 2: „Erkenne ODER übergib im Exportmodell Kontexttypen")
  // als auch — wenn `osmContext` Felder dazu trägt — eine OSM-basierte
  // Detektion. Override gewinnt: wenn der Caller eine Liste
  // mitgibt, übernehmen wir sie 1:1, ohne weitere Inferenz.
  //
  // Erkannte Keys (Spec-Item 2):
  //   bahnhof, busbahnhof, straßenbahn_schienen, gleisquerung,
  //   gemeinsame_fuss_rad_flaeche, hohe_fussgaengerfrequenz, busverkehr,
  //   taxi_lieferverkehr, kopfsteinpflaster, unuebersichtliche_kreuzung,
  //   schulweg, lkw_abbiegekonflikt
  //
  // OSM-Heuristik (best-effort, nutzt `osmContext.summary` falls von
  // js/ua.osm_context.js dort befüllt):
  //   - station.train > 0           → bahnhof
  //   - station.bus   > 0           → busbahnhof
  //   - tramTrackWays > 0           → straßenbahn_schienen, gleisquerung
  //   - cobblestoneWays > 0         → kopfsteinpflaster
  //   - mixedFootCycleWays > 0      → gemeinsame_fuss_rad_flaeche
  // Heutige `js/ua.osm_context.js` exportiert diese Felder noch nicht;
  // dort ist eine eigene PR geplant. Solange bleibt die Heuristik leer
  // und der Override-Pfad trägt die Kontexte (Spec-Item 2 erlaubt das
  // explizit).
  // ----------------------------------------------------------------
  const KNOWN_CONTEXT_KEYS = Object.freeze(new Set([
    "bahnhof", "busbahnhof", "straßenbahn_schienen", "gleisquerung",
    "gemeinsame_fuss_rad_flaeche", "hohe_fussgaengerfrequenz", "busverkehr",
    "taxi_lieferverkehr", "kopfsteinpflaster", "unuebersichtliche_kreuzung",
    "schulweg", "lkw_abbiegekonflikt",
    // Sicht-Kontexte (Spec-Item 7: „Bewuchs zurückschneiden" nur dann
    // vorschlagen, wenn ein Sicht-Hinweis explizit vorliegt).
    "sichtbehinderung", "bewuchs"
  ]));

  function detectContexts(osmContext, override) {
    const out = new Set();
    // Override hat Vorrang. Akzeptiert Set, Array oder Komma-getrennten String.
    if (override) {
      const arr = (override instanceof Set) ? Array.from(override)
        : Array.isArray(override) ? override
        : (typeof override === "string") ? override.split(/[,;\s]+/).map(s => s.trim())
        : [];
      for (const key of arr) {
        if (typeof key !== "string" || !key) continue;
        if (KNOWN_CONTEXT_KEYS.has(key)) out.add(key);
      }
      return out;
    }

    // OSM-basierte Heuristik. Liest defensiv aus `osmContext.summary`;
    // unbekannte Felder werden ignoriert. Heutige Aggregator-Felder
    // (highway/maxspeed/cycle/signals/crossings) liefern keine direkten
    // Kontext-Keys, daher bleibt die Menge meistens leer — bis OSM-Query
    // erweitert wird.
    const s = (osmContext && osmContext.summary) || null;
    if (!s) return out;
    const ctx = (osmContext && osmContext.contexts) || {};

    if (Number(ctx.trainStations || 0) > 0) out.add("bahnhof");
    if (Number(ctx.busStations || 0)   > 0) out.add("busbahnhof");
    if (Number(ctx.tramTrackWays || 0) > 0) {
      out.add("straßenbahn_schienen");
      out.add("gleisquerung");
    }
    if (Number(ctx.cobblestoneWays || 0)    > 0) out.add("kopfsteinpflaster");
    if (Number(ctx.mixedFootCycleWays || 0) > 0) out.add("gemeinsame_fuss_rad_flaeche");

    return out;
  }

  // ----------------------------------------------------------------
  // Regelmatrix. Jede Regel beschreibt:
  //   - id           : eindeutiger Schlüssel (für matchedRules)
  //   - patterns     : ANY of these triggers
  //   - contexts     : ANY of these triggers; leer = kontextfrei (gilt
  //                    immer wenn pattern matched)
  //   - kurzfristig  : Liste sofort prüfbarer Maßnahmen
  //   - mittelfristig: Liste baulich/organisatorischer Maßnahmen
  //   - pruefauftraege: Liste expliziter Vor-Ort-Prüfaufträge
  //
  // Reihenfolge ist signifikant — frühere Regeln liefern den ersten
  // Eintrag in jedem Bucket; spätere Regeln ergänzen ohne Duplikate.
  // ----------------------------------------------------------------
  const RULES = Object.freeze([
    // 4A: rad_alleinunfall_schwer + straßenbahn_schienen
    {
      id: "rad_solo_schwer__schienen",
      patterns: ["rad_alleinunfall_schwer", "rad_alleinunfall"],
      contexts: ["straßenbahn_schienen", "gleisquerung"],
      pruefauftraege: [
        "Prüfung, ob Radfahrende Gleise in spitzem Winkel queren müssen.",
        "Prüfung der Oberfläche im Schienenbereich, insbesondere Rillen, Fugen, Niveauversätze und Rutschigkeit bei Nässe."
      ],
      kurzfristig: [
        "Kurzfristig: Gefahrenstelle markieren und temporäre Leitführung testen."
      ],
      mittelfristig: [
        "Prüfung einer geänderten Radführung mit möglichst rechtwinkliger Schienenquerung.",
        "Mittelfristig: bauliche Anpassung der Radführung oder der Querungsstelle."
      ]
    },
    // 4B: rad_alleinunfall_schwer + bahnhof/busbahnhof
    {
      id: "rad_solo_schwer__bahnhof",
      patterns: ["rad_alleinunfall_schwer", "rad_alleinunfall"],
      contexts: ["bahnhof", "busbahnhof"],
      pruefauftraege: [
        "Vor-Ort-Sicherheitsaudit zu Stoßzeiten.",
        "Beobachtung von Rad-/Fuß-/Bus-Konflikten morgens, nachmittags und abends.",
        "Prüfung, ob wartende Fußgänger, Bushaltestellen, Taxiverkehr oder Lieferverkehr die Radführung blockieren.",
        "Prüfung von Oberflächenqualität, Kanten, Bordübergängen und Sichtbeziehungen."
      ],
      mittelfristig: [
        "Prüfung einer klareren Trennung oder Führung von Rad- und Fußverkehr."
      ]
    },
    // 4C: rad_fuss_konflikt + hohe_fussgaengerfrequenz
    {
      id: "rad_fuss__hohefrequenz",
      patterns: ["rad_fuss_konflikt"],
      contexts: ["hohe_fussgaengerfrequenz", "gemeinsame_fuss_rad_flaeche"],
      pruefauftraege: [
        "Prüfung getrennter Führungen oder eindeutig markierter Konfliktflächen."
      ],
      kurzfristig: [
        "Geschwindigkeitsdämpfung für Radverkehr in Konfliktbereichen."
      ],
      mittelfristig: [
        "Verbesserung von Querungsstellen.",
        "Reduzierung unklarer Mischflächen."
      ]
    },
    // 4D: rad_bus_konflikt + busbahnhof
    {
      id: "rad_bus__busbahnhof",
      patterns: ["rad_bus_konflikt"],
      contexts: ["busbahnhof", "busverkehr"],
      pruefauftraege: [
        "Prüfung der Busspur- und Haltestellenführung.",
        "Prüfung von Sichtbeziehungen zwischen Busfahrern und Radfahrenden.",
        "Prüfung von Querungen an Haltestellenausfahrten."
      ],
      mittelfristig: [
        "Prüfung getrennter Radführung außerhalb von Busmanövrierflächen."
      ]
    },
    // 4E: haeufung_bei_naesse + rad_alleinunfall
    {
      id: "naesse__rad_solo",
      patterns: ["rad_alleinunfall", "rad_alleinunfall_schwer"],
      contexts: ["haeufung_bei_naesse"], // virtueller Kontext: kommt aus classifyPatterns
      pruefauftraege: [
        "Prüfung rutschiger Beläge, Pflaster, Markierungen, Metallflächen und Schienenbereiche."
      ],
      kurzfristig: [
        "Kurzfristige Beseitigung von Niveauversätzen und beschädigten Oberflächen."
      ],
      mittelfristig: [
        "Prüfung griffigerer Beläge."
      ]
    },
    // Bonus: Kopfsteinpflaster + Rad-Alleinunfall — Oberfläche ist häufig die Ursache.
    {
      id: "kopfstein__rad_solo",
      patterns: ["rad_alleinunfall", "rad_alleinunfall_schwer"],
      contexts: ["kopfsteinpflaster"],
      pruefauftraege: [
        "Prüfung der Oberfläche (Kopfsteinpflaster, Fugen, Niveauversätze) im Bereich der Häufungsstelle."
      ],
      mittelfristig: [
        "Prüfung eines griffigeren Belags oder einer Belags-Sanierung im Radführungsbereich."
      ]
    }
  ]);

  /**
   * Apply the rule matrix to (patterns × contexts).
   *
   * The naesse/dunkelheit/stosszeiten escalations from classifyPatterns
   * are themselves “contexts” for matrix purposes (a temporal context
   * rather than a spatial one). To keep the matrix self-contained we
   * treat them uniformly: every classified pattern key is offered
   * **both** as a pattern AND as a context. That lets a rule like
   * „naesse__rad_solo" trigger from purely classified patterns without
   * a separate spatial OSM hint.
   *
   * @param {Iterable<string>} patternKeys   from classifyPatterns
   * @param {Iterable<string>} contextKeys   from detectContexts
   * @returns {{
   *   kurzfristig: string[],
   *   mittelfristig: string[],
   *   pruefauftraege: string[],
   *   rationale: string,
   *   matchedRules: Array<{id:string, pattern:string, context:string|null}>
   * }}
   */
  function deriveContextualMeasures(patternKeys, contextKeys) {
    const pSet = new Set(patternKeys || []);
    const cSet = new Set(contextKeys || []);
    // Temporale Pattern-Keys sind gleichzeitig „Kontexte" (siehe Doku oben).
    for (const tp of ["haeufung_bei_naesse", "haeufung_bei_dunkelheit", "haeufung_stosszeiten"]) {
      if (pSet.has(tp)) cSet.add(tp);
    }

    const buckets = { kurzfristig: [], mittelfristig: [], pruefauftraege: [] };
    const seen = { kurzfristig: new Set(), mittelfristig: new Set(), pruefauftraege: new Set() };
    const matchedRules = [];

    for (const rule of RULES) {
      const patternHits = rule.patterns.filter(p => pSet.has(p));
      if (patternHits.length === 0) continue;
      const contextHits = (rule.contexts && rule.contexts.length > 0)
        ? rule.contexts.filter(c => cSet.has(c))
        : [null];
      if (contextHits.length === 0) continue;
      // Push measures into buckets, deduplicating by exact wording.
      for (const bucket of ["kurzfristig", "mittelfristig", "pruefauftraege"]) {
        const items = rule[bucket] || [];
        for (const item of items) {
          if (seen[bucket].has(item)) continue;
          seen[bucket].add(item);
          buckets[bucket].push(item);
        }
      }
      // Record which pattern × context fired this rule (for QA/debug).
      for (const p of patternHits) for (const c of contextHits) {
        matchedRules.push({ id: rule.id, pattern: p, context: c });
      }
    }

    // Spec-Item 6: Unsicherheits-Disclaimer — nur wenn überhaupt eine
    // Empfehlung fällt. Vermeidet falsche Pseudo-Sicherheit ("Die
    // Ursache ist…") und macht die kontextuelle Inferenz transparent.
    let rationale = "";
    if (matchedRules.length > 0) {
      const ctxList = Array.from(cSet)
        .filter(k => k && !["haeufung_bei_naesse","haeufung_bei_dunkelheit","haeufung_stosszeiten"].includes(k))
        .join(", ");
      const ctxSentence = ctxList
        ? `Aufgrund des Ortskontexts (${ctxList}) sind insbesondere folgende Ursachen zu prüfen.`
        : "Aufgrund der erkannten Unfallmuster sind folgende Ursachen zu prüfen.";
      rationale = "Die Unfalldaten belegen die Häufung, nicht jedoch abschließend die konkrete Ursache. " + ctxSentence;
    }

    return { ...buckets, rationale, matchedRules };
  }

  UA.contextMeasures = {
    classifyPatterns,
    detectContexts,
    deriveContextualMeasures,
    MASK_TO_BASE_PATTERN,
    KNOWN_CONTEXT_KEYS,
    RULES
  };
})();
