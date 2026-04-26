(() => {
  const UA = (window.UA = window.UA || {});

  // --------------------
  // Export templates (optional)
  // --------------------
  const TEMPLATE_DIR = "templates";
  const DEFAULT_TEMPLATES = {
    intro: `Bezirksratsantrag (Entwurf) – Unfallwerkbank\n\nBetreff: Verbesserung der Verkehrssicherheit – Auffälliger Unfallschwerpunkt im markierten Bereich\n`,
    sachverhalt: `Sachverhalt:\nIm markierten Kartenausschnitt wurden {{local_total}} Unfälle ausgewertet. Im Vergleich zum Stadtdurchschnitt ({{baseline_total}} Unfälle, gleiche Filter für Schwere/Zeit/Zustand) zeigen sich Abweichungen in den Beteiligungskombinationen.\n\nVerletzungsschwere (Ausschnitt):\n{{severity_summary}}`,
    beschluss: `Beschlussvorschlag:\nDer Bezirksrat bittet die Verwaltung, den markierten Bereich verkehrssicherheitsfachlich zu prüfen und kurzfristig umsetzbare Maßnahmen vorzuschlagen bzw. umzusetzen.\n\n1) Sofortmaßnahmen (Quick Wins): Markierungen/Warnhinweise, Sichtbeziehungen herstellen, konfliktärmere Führung, Signalisierung prüfen, ggf. Tempoanpassung.\n2) Infrastrukturmaßnahmen: sichere Rad- und Fußführung, sichere Querungen, Oberflächen-/Kantenprüfung, Knotenpunktgestaltung.\n3) Monitoring: Nach Umsetzung Evaluation anhand Unfallatlas-Daten der Folgejahre.\n`,
    hinweis: `Hinweis (intern, vor Versand entfernen): Dieser Text wurde automatisiert erzeugt. Link zur Überarbeitung: {{link}}\n`,
    lizenz: `Datenquelle/Lizenzhinweis: Unfallatlas / Open-Data-Downloads. Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0).\n`
  };

  async function loadTemplate(name, stadtSlug) {
    // Fallback chain:
    // 1. templates/{stadtSlug}/{name}.txt  (city-specific)
    // 2. templates/{name}.txt              (generic)
    // 3. DEFAULT_TEMPLATES[name]           (hardcoded fallback)
    if (stadtSlug) {
      const cityUrl = `${TEMPLATE_DIR}/${stadtSlug}/${name}.txt`;
      try {
        const r = await fetch(cityUrl, { cache: "no-store" });
        if (r.ok) return await r.text();
        // city-specific not found – fall through to generic
      } catch { /* city-specific unavailable – fall through to generic */ }
    }
    const url = `${TEMPLATE_DIR}/${name}.txt`;
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return DEFAULT_TEMPLATES[name] || "";
      return await r.text();
    } catch {
      return DEFAULT_TEMPLATES[name] || "";
    }
  }

  function tpl(str, vars) {
    return String(str).replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, k) => String(vars[k] ?? ""));
  }

  function fmtPct(x) {
    return (x * 100).toFixed(1).replace(".", ",") + " %";
  }

  // --------------------
  // Dunkelziffer / Erfassungsgrenzen (#C3)
  // Pflicht-Hinweisblock in allen Antrags-Ausgaben (Text/HTML/DOCX/PDF), damit
  // Adressaten verstehen, dass die offiziellen Zahlen nur einen Ausschnitt der
  // tatsächlichen Verkehrssicherheitsbelastung abbilden. Quelle/Faktor sind in
  // docs/DOKUMENTATION.md hinterlegt.
  // --------------------
  const DARK_FIGURE_NOTE = Object.freeze({
    title: "Datenerfassung – Dunkelziffer und Erfassungsgrenzen",
    body: "Erfasst sind ausschließlich polizeilich aufgenommene Verkehrsunfälle mit Personenschaden. Reine Sachschäden, Beinaheunfälle und nicht gemeldete Unfälle (Dunkelziffer) sind nicht enthalten. Studien schätzen, dass insbesondere bei Radunfällen ohne Fremdverschulden sowie bei leichten Verletzungen ein erheblicher Anteil der Vorfälle nicht in der amtlichen Statistik landet — die tatsächliche Belastung kann je nach Verkehrsart um den Faktor 2–10 höher liegen.",
    sourceLabel: "Quelle: BASt – Bundesanstalt für Straßenwesen; Unfallforschung der Versicherer (UDV).",
    sourceUrl: "https://www.bast.de/"
  });
  // Exportieren, damit Tests und andere Module (Doku-Generator) die selbe
  // Definition wiederverwenden können.
  UA.DARK_FIGURE_NOTE = DARK_FIGURE_NOTE;

  // --------------------
  // Unfallklassen / Masken (robust, unabhängig von anderen Modulen)
  // --------------------
  // 6-Bit-Maske: Rad=1, Fuß=2, PKW=4, Krad=8, Gkfz=16, Sonstig=32
  const COMBO_BITS = [[1,"🚲"],[2,"🚶"],[4,"🚗"],[8,"🏍️"],[16,"🚛"],[32,"🚌"]];
  const COMBO_LABEL = {};
  for (let m = 1; m <= 63; m++) {
    COMBO_LABEL[m] = COMBO_BITS.filter(([b]) => m & b).map(([,e]) => e).join("+");
  }

  function maskFromProps(pr) {
    // sowohl lower-case als auch Originalfelder tolerieren
    const get = (k) => {
      if (!pr) return "";
      if (pr[k] !== undefined) return pr[k];
      const lk = String(k).toLowerCase();
      if (pr[lk] !== undefined) return pr[lk];
      return "";
    };

    const isBike = String(get("IstRad")) === "1" || String(get("istrad")) === "1";
    const isPed  = String(get("IstFuss")) === "1" || String(get("istfuss")) === "1";
    const isCar  = String(get("IstPKW")) === "1" || String(get("istpkw")) === "1";
    const isMoto = String(get("IstKrad")) === "1" || String(get("istkrad")) === "1";
    const isGkfz = String(get("IstGkfz")) === "1" || String(get("istgkfz")) === "1";
    const isSon  = String(get("IstSonstig")) === "1" || String(get("istsonstig")) === "1";

    return (isBike ? 1 : 0) | (isPed ? 2 : 0) | (isCar ? 4 : 0) | (isMoto ? 8 : 0) | (isGkfz ? 16 : 0) | (isSon ? 32 : 0);
  }

  function interpretMask(mask) {
    if (mask === 1) return "Überrepräsentation von 🚲-Alleinunfällen kann auf Infrastruktur-Risiken (z. B. Schienenquerungen, Kanten/Spurrinnen, Belagswechsel, Engstellen) hindeuten.";
    if (mask === 2) return "Überrepräsentation von 🚶-Alleinunfällen kann auf Querungsdefizite, Sichtbehinderungen oder Stolperstellen hinweisen.";
    if (mask === 5) return "Überrepräsentation von 🚲+🚗 deutet häufig auf Konflikte an Knotenpunkten/Abbiegesituationen, Sichtbeziehungen und Führung des Radverkehrs hin.";
    if (mask === 6) return "Überrepräsentation von 🚗+🚶 weist oft auf Querungsdefizite, Sichtbeziehungen oder hohes Geschwindigkeitsniveau hin.";
    if (mask === 3) return "Überrepräsentation von 🚲+🚶 kann auf enge Führungen, gemeinsame Flächen oder fehlende Trennung hinweisen.";
    if (mask === 7) return "Überrepräsentation von 🚲+🚗+🚶 spricht für komplexe Konfliktlagen an Knotenpunkten bzw. stark frequentierten Querungen.";
    if (mask === 16) return "Überrepräsentation von 🚛-Alleinunfällen (Gkfz) kann auf ungeeignete Straßengeometrie, Schleppkurven-Probleme oder Ladungssicherungsdefizite hinweisen.";
    if (mask === 17) return "Überrepräsentation von 🚲+🚛 (Rad+Gkfz) ist besonders gefährlich – häufig Abbiegeunfälle mit totem Winkel. Maßnahmen: Abbiegeassistent, Spiegel, getrennte Signalphasen, Radwegeführung an Knotenpunkten prüfen.";
    if (mask === 18) return "Überrepräsentation von 🚶+🚛 (Fuß+Gkfz) ist besonders gefährlich – häufig Abbiege-/Rangierunfälle. Maßnahmen: Sichtfelder, Schleppkurven, Fußgängerführung und separate Signalphasen prüfen.";
    if (mask === 20) return "Überrepräsentation von 🚗+🚛 kann auf Engstellen, ungeeignete Fahrbahnbreiten oder Überholprobleme hinweisen.";
    if (mask === 21) return "Überrepräsentation von 🚲+🚗+🚛 spricht für komplexe Konflikte an Knotenpunkten mit Schwerverkehr – Radverkehrsführung und Abbiegesicherung prüfen.";
    if (mask === 22) return "Überrepräsentation von 🚶+🚗+🚛 weist auf komplexe Querungssituationen mit Schwerverkehr hin – Sichtbeziehungen und Signalisierung prüfen.";
    return "Auffälligkeit kann auf lokale Führungs-/Sicht-/Querungsprobleme hinweisen; eine Ortsbegehung und Unfallkommissionsprüfung ist angezeigt.";
  }

  // --------------------
  // Pattern template matching
  // --------------------
  const PATTERN_MAP = {
    1: {
      template: "pattern_rad_solo",
      vars: (r) => ({ RAD_SOLO_FACTOR: r.factor.toFixed(2), RAD_SOLO_LOCAL: String(r.locCnt) })
    },
    3: {
      template: "pattern_rad_fuss",
      vars: (r) => ({ RAD_FUSS_FACTOR: r.factor.toFixed(2), RAD_FUSS_LOCAL: String(r.locCnt) })
    },
    5: {
      template: "pattern_rad_pkw",
      vars: (r) => ({ RAD_PKW_FACTOR: r.factor.toFixed(2), RAD_PKW_LOCAL: String(r.locCnt) })
    },
    6: {
      template: "pattern_pkw_fuss",
      vars: (r) => ({ PKW_FUSS_FACTOR: r.factor.toFixed(2), PKW_FUSS_LOCAL: String(r.locCnt) })
    },
    17: {
      template: "pattern_rad_gkfz",
      vars: (r) => ({ RAD_GKFZ_FACTOR: r.factor.toFixed(2), RAD_GKFZ_LOCAL: String(r.locCnt) })
    },
    18: {
      template: "pattern_fuss_gkfz",
      vars: (r) => ({ FUSS_GKFZ_FACTOR: r.factor.toFixed(2), FUSS_GKFZ_LOCAL: String(r.locCnt) })
    },
    20: {
      template: "pattern_pkw_gkfz",
      vars: (r) => ({ PKW_GKFZ_FACTOR: r.factor.toFixed(2), PKW_GKFZ_LOCAL: String(r.locCnt) })
    }
  };

  async function matchPatterns(dev, stadtSlug) {
    const matched = [];
    for (const r of dev.focus) {
      const mapping = PATTERN_MAP[r.mask];
      if (!mapping) continue;
      const content = await loadTemplate(mapping.template, stadtSlug);
      if (!content) continue;
      const filled = tpl(content, mapping.vars(r));
      matched.push({ mask: r.mask, template: mapping.template, content: filled, row: r });
    }
    return matched;
  }

  // --------------------
  // POI loading and analysis
  // --------------------
  async function loadPOIData(citySlug) {
    const poiPath = `out/poi_${citySlug}.geojson`;
    try {
      const r = await fetch(poiPath, { cache: "no-store" });
      if (!r.ok) return null;
      const data = await r.json();
      return data;
    } catch (e) {
      console.warn(`POI data not available for ${citySlug}:`, e);
      return null;
    }
  }

  function analyzePOIs(poiData, bounds) {
    if (!poiData || !poiData.features) return null;

    const withinArea = [];
    const nearArea = [];
    const BUFFER_METERS = 200; // Define "near" as 200m from bounds

    for (const feature of poiData.features) {
      if (!feature.geometry || feature.geometry.type !== "Point") continue;
      const [lon, lat] = feature.geometry.coordinates;
      const props = feature.properties || {};

      const isWithin = bounds.contains([lat, lon]);
      
      if (isWithin) {
        withinArea.push({
          lat, lon,
          type: props.type || "unknown",
          name: props.name || "Unbenannt",
          id: props.id
        });
      } else {
        // Simple distance check (approximate)
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const center = bounds.getCenter();
        
        // Rough check if within buffer distance
        const distToCenter = center.distanceTo([lat, lon]);
        const boundsRadius = center.distanceTo(sw);
        
        if (distToCenter < boundsRadius + BUFFER_METERS) {
          nearArea.push({
            lat, lon,
            type: props.type || "unknown",
            name: props.name || "Unbenannt",
            id: props.id
          });
        }
      }
    }

    // Count by type
    const withinByType = {};
    const nearByType = {};
    
    for (const poi of withinArea) {
      withinByType[poi.type] = (withinByType[poi.type] || 0) + 1;
    }
    for (const poi of nearArea) {
      nearByType[poi.type] = (nearByType[poi.type] || 0) + 1;
    }

    return {
      withinArea,
      nearArea,
      withinByType,
      nearByType,
      totalWithin: withinArea.length,
      totalNear: nearArea.length
    };
  }

  // --------------------
  // Reference documents loading
  // --------------------
  async function loadReferenceDocuments(citySlug) {
    const refPath = `templates/references_${citySlug}.json`;
    try {
      const r = await fetch(refPath, { cache: "no-store" });
      if (!r.ok) return null;
      const data = await r.json();
      return data;
    } catch (e) {
      console.warn(`Reference documents not available for ${citySlug}:`, e);
      return null;
    }
  }

  // --------------------
  // Gremien (committee) loading and matching
  // --------------------
  async function loadGremienData(citySlug) {
    const gremienPath = `${TEMPLATE_DIR}/gremien_${citySlug}.json`;
    try {
      const r = await fetch(gremienPath, { cache: "no-store" });
      if (!r.ok) return null;
      const data = await r.json();
      return data;
    } catch (e) {
      console.warn(`Gremien data not available for ${citySlug}:`, e);
      return null;
    }
  }

  /**
   * Match admin fields from Nominatim against a city's Gremien config.
   * Returns the best matching committee, or a fallback hint.
   *
   * @param {Object} adminData - Fields from Nominatim (suburb, city_district, borough, quarter, postcode)
   * @param {Object} gremienConfig - Config from gremien_{city}.json
   * @returns {{ gremium: string|null, typ: string|null, kontakt: string|null, confidence: string, hinweis: string }}
   */
  function matchGremium(adminData, gremienConfig) {
    if (!gremienConfig || !adminData) {
      return { gremium: null, typ: null, kontakt: null, confidence: "unbekannt", hinweis: "" };
    }

    const zuordnung = gremienConfig.zuordnung || [];
    for (const z of zuordnung) {
      const match = z.match || {};
      for (const [field, values] of Object.entries(match)) {
        const adminVal = adminData[field];
        // Support both string and array for match values
        const valArray = Array.isArray(values) ? values : [values];
        if (adminVal && valArray.includes(adminVal)) {
          return {
            gremium: z.gremium || null,
            typ: gremienConfig.gremiumTyp || null,
            kontakt: z.kontakt || null,
            confidence: "hoch",
            hinweis: gremienConfig.hinweis || ""
          };
        }
      }
    }

    return {
      gremium: null,
      typ: gremienConfig.gremiumTyp || null,
      kontakt: null,
      confidence: "unbekannt",
      hinweis: gremienConfig.fallback || "Zuständiges Gremium bitte lokal ermitteln."
    };
  }

  // --------------------
  // Bounds helpers
  // --------------------
  function boundsForExport(ctx) {
    return ctx.selectionBounds ? ctx.selectionBounds : ctx.map.getBounds();
  }

  function inBounds(p, b) {
    return b.contains([p.lat, p.lon]);
  }

  function yearsRange(points) {
    let minY = Infinity, maxY = -Infinity;
    for (const p of points || []) {
      const y = parseInt(p.props?.year, 10);
      if (!Number.isFinite(y)) continue;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return null;
    return { minY, maxY };
  }

  function severityStats(ctx, bounds) {
    const b = bounds || ctx.map.getBounds();
    const res = { total: 0, bySev: { "1": 0, "2": 0, "3": 0, "other": 0 } };

    for (const p of ctx.allPts || []) {
      if (!p?.props) continue;

      // Wenn es ein Filter-Modul gibt, nutzen wir es (damit ist es konsistent mit der UI)
      if (typeof UA.matchesNonInvolvementFilters === "function") {
        if (!UA.matchesNonInvolvementFilters(ctx, p.props)) continue;
      }

      if (!b.contains([p.lat, p.lon])) continue;
      res.total++;

      const k = String(p.props.ukategorie ?? "");
      if (k === "1" || k === "2" || k === "3") res.bySev[k] = (res.bySev[k] || 0) + 1;
      else res.bySev.other++;
    }
    return res;
  }

  function yearTable(ctx, bounds) {
    const rows = new Map(); // year -> {total, byMask}
    const yearsSet = new Set();

    for (const p of ctx.allPts || []) {
      const y = parseInt(p.props?.year, 10);
      if (Number.isFinite(y)) yearsSet.add(y);
    }
    const years = [...yearsSet].sort((a, b) => a - b);

    for (const p of ctx.allPts || []) {
      const pr = p.props || {};

      if (typeof UA.matchesNonInvolvementFilters === "function") {
        if (!UA.matchesNonInvolvementFilters(ctx, pr)) continue;
      }

      const y = parseInt(pr.year, 10);
      if (!Number.isFinite(y)) continue;
      if (!inBounds(p, bounds)) continue;

      const m = maskFromProps(pr);
      if (m === 0) continue;

      if (!rows.has(y)) rows.set(y, { total: 0, byMask: {} });
      const r = rows.get(y);
      r.total++;
      r.byMask[m] = (r.byMask[m] || 0) + 1;
    }

    const out = [];
    for (const y of years) {
      const r = rows.get(y) || { total: 0, byMask: {} };
      const classes = Object.entries(r.byMask)
        .map(([m, c]) => ({ m: Number(m), c }))
        .sort((a, b) => b.c - a.c)
        .map(e => `${COMBO_LABEL[e.m] || ("Mask " + e.m)}=${e.c}`);
      out.push({ year: y, total: r.total, classes });
    }
    return out;
  }

  function topDeviations(ctx, bounds) {
    // Baseline: entweder ctx.baselineCounts (ideal) oder wir bauen eine einfache Baseline aus allPts nach Non-Involvement-Filtern
    let baseline = ctx.baselineCounts;

    if (!baseline || !baseline.total) {
      const bc = { total: 0, byMask: {} };
      for (const p of ctx.allPts || []) {
        const pr = p.props || {};
        if (typeof UA.matchesNonInvolvementFilters === "function") {
          if (!UA.matchesNonInvolvementFilters(ctx, pr)) continue;
        }
        const m = maskFromProps(pr);
        if (m === 0) continue;
        bc.total++;
        bc.byMask[m] = (bc.byMask[m] || 0) + 1;
      }
      baseline = bc;
    }

    const local = { total: 0, byMask: {} };
    for (const p of ctx.allPts || []) {
      const pr = p.props || {};
      if (typeof UA.matchesNonInvolvementFilters === "function") {
        if (!UA.matchesNonInvolvementFilters(ctx, pr)) continue;
      }
      if (!inBounds(p, bounds)) continue;
      const m = maskFromProps(pr);
      if (m === 0) continue;
      local.total++;
      local.byMask[m] = (local.byMask[m] || 0) + 1;
    }

    const rows = [];
    for (const [mStr, locCnt] of Object.entries(local.byMask)) {
      const m = Number(mStr);
      const baseCnt = baseline.byMask[m] || 0;
      const locR = local.total ? (locCnt / local.total) : 0;
      const baseR = baseline.total ? (baseCnt / baseline.total) : 0;
      const factor = (baseR > 0) ? (locR / baseR) : Infinity;

      // Wilson-Score-Konfidenzintervall (95 %) für den lokalen Anteil
      const ci = (typeof UA.wilsonScoreInterval === "function")
        ? UA.wilsonScoreInterval(locCnt, local.total)
        : { low: 0, high: 1 };
      // Signifikant überrepräsentiert: untere CI-Grenze liegt über baseR.
      // Auch korrekt wenn baseR === 0: jeder lokale Treffer (locCnt > 0) führt
      // dann zu ci.low > 0 = baseR und damit zu Signifikanz, was fachlich
      // gewollt ist (Stadt-Baseline kennt das Muster nicht, lokal tritt es auf).
      const isSignificant = local.total > 0 && ci.low > baseR;

      rows.push({ mask: m, label: COMBO_LABEL[m] || ("Mask " + m), locCnt, baseCnt, locR, baseR, factor, ciLow: ci.low, ciHigh: ci.high, isSignificant });
    }
    rows.sort((a, b) => (b.factor - a.factor));

    const focus = rows
      .filter(r => Number.isFinite(r.factor))
      .filter(r => r.baseR > 0)
      .filter(r => r.locCnt >= 3)
      .filter(r => r.factor >= 1.35)
      .slice(0, 6);

    return { local, baseline, rows, focus };
  }

  // --------------------
  // crossTableSeverityByMask: Kreuztabelle Beteiligungskombination × Schweregrad
  // Accepts a pre-filtered list of points (already in-bounds, already passing non-involvement filters).
  // --------------------
  function crossTableSeverityByMask(filteredPts) {
    const byMask = {};

    for (const p of filteredPts) {
      const pr = p.props || {};
      const m = maskFromProps(pr);
      if (m === 0) continue;

      if (!byMask[m]) byMask[m] = { sev1: 0, sev2: 0, sev3: 0 };
      const k = String(pr.ukategorie ?? "");
      if (k === "1") byMask[m].sev1++;
      else if (k === "2") byMask[m].sev2++;
      else if (k === "3") byMask[m].sev3++;
    }

    const rows = Object.entries(byMask).map(([mStr, v]) => {
      const mask = Number(mStr);
      const total = v.sev1 + v.sev2 + v.sev3;
      return { mask, label: COMBO_LABEL[mask] || ("Mask " + mask), sev1: v.sev1, sev2: v.sev2, sev3: v.sev3, total };
    });

    rows.sort((a, b) => b.total - a.total);

    const totals = rows.reduce((acc, r) => ({
      sev1: acc.sev1 + r.sev1,
      sev2: acc.sev2 + r.sev2,
      sev3: acc.sev3 + r.sev3,
      total: acc.total + r.total
    }), { sev1: 0, sev2: 0, sev3: 0, total: 0 });

    return { rows: rows.filter(r => r.total > 0), totals };
  }

  // --------------------
  // accidentDetailTable: Einzelunfall-Liste für markierte Bereiche
  // Accepts a pre-filtered list of points (already in-bounds, already passing non-involvement filters).
  // --------------------
  const SEV_LABEL_MAP = { "1": "Getötet", "2": "Schwerverletzt", "3": "Leichtverletzt" };

  // Weekday raw codes (1=So, 2=Mo, …, 7=Sa) → { day, group }.
  // The Werktag/Wochenende grouping is derived from UA.WEEKEND_SET (single
  // source of truth in ua.utils.js) so it never drifts from how the rest of
  // the app classifies day-types (filters, dayType selector, etc.).
  const WEEKDAY_LABEL_MAP = (() => {
    const days = { "1": "So", "2": "Mo", "3": "Di", "4": "Mi", "5": "Do", "6": "Fr", "7": "Sa" };
    const weekendSet = (UA.WEEKEND_SET instanceof Set) ? UA.WEEKEND_SET : new Set(["1", "7"]);
    const m = {};
    for (const k of Object.keys(days)) {
      m[k] = { day: days[k], group: weekendSet.has(k) ? "Wochenende" : "Werktag" };
    }
    return m;
  })();
  const ROAD_COND_LABEL_MAP = { "0": "trocken", "1": "nass/feucht", "2": "winterglatt" };

  // Shared helper: format lat/lon pair for display; uses "—" when coordinates are missing
  function formatCoords(lat, lon) {
    if (lat != null && lon != null) return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    return "—";
  }

  function accidentDetailTable(filteredPts, maxRows, viewId, viewOpts) {
    const items = [];

    for (const p of filteredPts) {
      const pr = p.props || {};
      const mask = maskFromProps(pr);
      if (mask === 0) continue;

      const severity = String(pr.ukategorie ?? "");
      const year = parseInt(pr.year, 10);
      const hour = parseInt(pr.ustunde, 10);
      const weekdayRaw = String(pr.uwochentag ?? "");
      const roadCondRaw = String(pr.strzustand ?? "");

      items.push({
        lat: p.lat,
        lon: p.lon,
        year: Number.isFinite(year) ? year : null,
        severity,
        sevLabel: SEV_LABEL_MAP[severity] || severity,
        involved: COMBO_LABEL[mask] || ("Mask " + mask),
        hour: Number.isFinite(hour) ? hour : null,
        weekday: WEEKDAY_LABEL_MAP[weekdayRaw]?.day ?? weekdayRaw,
        weekdayGroup: WEEKDAY_LABEL_MAP[weekdayRaw]?.group ?? null,
        roadCondition: ROAD_COND_LABEL_MAP[roadCondRaw] || roadCondRaw,
        mask
      });
    }

    // Delegate grouping/cap/header rendering to the strategy registry.
    // `maxRows` overrides the strategy's default rowCap (back-compat with the
    // old per-group cap argument; tests and callers may still pass a number).
    // The override is passed explicitly to applyAccidentView so the shared
    // strategy object is never mutated (re-entrant / concurrent safe).
    // `viewOpts` may carry strategy-specific data (e.g. byTimePattern uses
    // `clusters` to support per-city time-cluster overrides).
    const resolvedViewId = viewId || (UA.ACCIDENT_VIEW_DEFAULT || "bySeverity");
    const view = (UA.resolveAccidentView ? UA.resolveAccidentView(resolvedViewId) : null);
    const explicitCap = (maxRows !== undefined && Number.isFinite(Number(maxRows)))
      ? Number(maxRows)
      : null;
    const cap = explicitCap !== null
      ? explicitCap
      : (view && Number.isFinite(view.rowCap) ? view.rowCap : 20);

    const opts = Object.assign({ rowCap: cap }, viewOpts || {});

    let viewResult;
    if (UA.applyAccidentView) {
      viewResult = UA.applyAccidentView(items, resolvedViewId, opts);
    } else {
      // Should not happen in production (ua.accident_views.js loads before ua.export_v2.js).
      viewResult = { viewId: resolvedViewId, columns: [], groups: [], total: items.length, truncated: false };
    }

    // Back-compat shape expected by existing tests / consumers:
    //   - groups[].sevKey, sevLabel (singular: "Getötet"), count, rows, overflow, histogram
    //   - rows: flattened cap-applied rows
    //   - total, truncated
    // For non-bySeverity views these legacy fields are best-effort.
    const legacyGroups = viewResult.groups.map(g => {
      const sevKey = g.key;
      const isSeverityKey = sevKey === "1" || sevKey === "2" || sevKey === "3";
      // Singular label (PR #219 contract). Plural form lives in meta.sevLabel.
      const sevLabelSingular = isSeverityKey
        ? SEV_LABEL_MAP[sevKey]
        : ((g.meta && g.meta.label) || g.key);
      return {
        // Back-compat keys (PR #219 tests and ua.report_v2 fallback)
        sevKey: isSeverityKey ? sevKey : g.key,
        sevLabel: sevLabelSingular,
        count: g.count,
        rows: g.rows,
        overflow: g.overflow,
        histogram: (g.meta && g.meta.histogram) || "",
        // Strategy-aware keys (used by ua.report_v2 / new HTML/text rendering)
        key: g.key,
        meta: g.meta,
        headers: g.headers,
        overflowLabel: g.overflowLabel
      };
    });

    const allRows = legacyGroups.flatMap(g => g.rows);

    return {
      viewId: viewResult.viewId,
      columns: viewResult.columns,
      groups: legacyGroups,
      rows: allRows,
      total: viewResult.total,
      truncated: viewResult.truncated
    };
  }

  // Export for testing and external use
  UA.accidentDetailTable = accidentDetailTable;
  UA.topDeviations = topDeviations;

  // --------------------
  // Public API: UA.computeExportReport(ctx)
  // --------------------
  UA.computeExportReport = async function computeExportReport(ctx) {
    const bounds = boundsForExport(ctx);
    
    const center = bounds.getCenter ? bounds.getCenter() : null;
    let loc = null;
    if (center) {
      loc = await UA.reverseGeocode(center.lat, center.lng);
    }
    
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const bStr = `${sw.lat.toFixed(5)},${sw.lng.toFixed(5)} – ${ne.lat.toFixed(5)},${ne.lng.toFixed(5)}`;

    const dev = topDeviations(ctx, bounds);
    const yr = yearTable(ctx, bounds);
    const sev = severityStats(ctx, bounds);
    const range = yearsRange(ctx.allPts || []);

    // Pre-filter points once: applies non-involvement filters + in-bounds check.
    // Both new summary tables share this filtered list to avoid repeated full scans over ctx.allPts.
    const filteredPts = getPointsInBounds(ctx);  // see getPointsInBounds() below
    const crossTable = crossTableSeverityByMask(filteredPts);
    const accidentViewId = ctx.accidentView || (UA.ACCIDENT_VIEW_DEFAULT || "bySeverity");

    const CITY_RAW = ctx.CITY_RAW || "—";
    const citySlug = UA.normKey ? UA.normKey(CITY_RAW) : CITY_RAW.toLowerCase().replace(/[^a-z0-9]+/g, "_");

    // Resolve optional-section toggles up front so we can gate expensive
    // fetch/parse work (cost factors, measures catalog, time clusters) on the
    // common path where the user disabled the corresponding modal options.
    const includeCosts = !ctx.exportOptions || ctx.exportOptions.includeCosts !== false;
    const includeMeasures = !ctx.exportOptions || ctx.exportOptions.includeMeasures !== false;

    // Load time clusters only when the byTimePattern view is actually active —
    // the other strategies (bySeverity / byInvolvement / flat) ignore the
    // cluster set, so on the default path no fetch/parse happens.
    let timeClusters = null;
    if (accidentViewId === "byTimePattern" && UA.timeClusters && UA.timeClusters.loadTimeClusters) {
      try {
        const cfg = await UA.timeClusters.loadTimeClusters(citySlug);
        timeClusters = (cfg && Array.isArray(cfg.clusters)) ? cfg.clusters : null;
      } catch (e) {
        console.warn("Time-cluster loading failed:", e);
      }
    }
    const accidentDetails = accidentDetailTable(filteredPts, undefined, accidentViewId, { clusters: timeClusters });

    // Load POI data
    let poiAnalysis = null;
    try {
      const poiData = await loadPOIData(citySlug);
      if (poiData) {
        poiAnalysis = analyzePOIs(poiData, bounds);
      }
    } catch (e) {
      console.warn("POI analysis failed:", e);
    }

    // Load reference documents
    let refDocs = null;
    try {
      refDocs = await loadReferenceDocuments(citySlug);
    } catch (e) {
      console.warn("Reference documents loading failed:", e);
    }

    // Match pattern templates based on detected deviations
    let matchedPatterns = [];
    try {
      matchedPatterns = await matchPatterns(dev, citySlug);
    } catch (e) {
      console.warn("Pattern matching failed:", e);
    }

    // Load Gremien data and match committee
    let gremiumMatch = { gremium: null, typ: null, kontakt: null, confidence: "unbekannt", hinweis: "" };
    try {
      const gremienConfig = await loadGremienData(citySlug);
      if (gremienConfig && loc && loc.admin) {
        gremiumMatch = matchGremium(loc.admin, gremienConfig);
      } else if (gremienConfig) {
        gremiumMatch = matchGremium({}, gremienConfig);
      }
    } catch (e) {
      console.warn("Gremien matching failed:", e);
    }

    const areaName = (loc && (loc.details || loc.label)) ? (loc.details || loc.label) : bStr;

    // ---- Economic impact (PR-C / B2): annual external cost via BASt-like factors ----
    // Only computed when the modal toggle "Volkswirtschaftliche Kosten" is on
    // (default ON). Skipping avoids a fetch + parse on the common opted-out path.
    let economicImpact = null;
    if (includeCosts && UA.costs && UA.costs.loadCostFactors) {
      try {
        const factors = await UA.costs.loadCostFactors();
        const yearsCount = (range && range.minY != null && range.maxY != null)
          ? Math.max(1, range.maxY - range.minY + 1)
          : 1;
        const calc = UA.costs.computeAnnualCost(sev.bySev, yearsCount, factors);
        economicImpact = {
          annual: calc.annual,
          total: calc.total,
          years: calc.years,
          breakdown: calc.breakdown,
          counts: calc.counts,
          source: factors.source,
          disclaimer: factors.disclaimer
        };
      } catch (e) {
        console.warn("Economic impact computation failed:", e);
      }
    }

    // ---- Recommended measures (PR-D / B1+B3) ----
    // Only computed when the modal toggle "Maßnahmenvorschläge" is on
    // (default ON). Avoids loading the catalog on the common opted-out path.
    let recommendedMeasures = null;
    if (includeMeasures && UA.measures && UA.measures.loadCatalog && UA.measures.recommendMeasures) {
      try {
        const detectedPatterns = (dev.focus || []).map(r => Number(r.mask)).filter(Number.isFinite);
        if (detectedPatterns.length > 0) {
          const catalog = await UA.measures.loadCatalog(citySlug);
          recommendedMeasures = UA.measures.recommendMeasures(detectedPatterns, catalog, {
            limit: 5,
            economicImpact: economicImpact
          });
        }
      } catch (e) {
        console.warn("Measure recommendation failed:", e);
      }
    }

    const vars = {
      city: CITY_RAW,
      CITY: CITY_RAW,
      bounds: bStr,
      BOUNDS: bStr,
      local_total: dev.local.total.toLocaleString(),
      baseline_total: dev.baseline.total.toLocaleString(),
      severity_summary: ((sev.bySev["1"] || 0) > 0
        ? `Im Ausschnitt wurden ${sev.bySev["1"]} Getötete, ${sev.bySev["2"] || 0} Schwerverletzte und ${sev.bySev["3"] || 0} Leichtverletzte registriert.`
        : `Im Ausschnitt wurden ${sev.bySev["2"] || 0} Schwerverletzte und ${sev.bySev["3"] || 0} Leichtverletzte registriert.`),
      date: new Date().toLocaleDateString("de-DE"),
      DATE: new Date().toLocaleDateString("de-DE"),
      link: window.location.href,
      LINK: window.location.href,
      area_name: areaName,
      AREA_NAME: areaName,
      THRESH_FACTOR: "1,35",
      location_label: loc ? loc.label : "",
      location_details: loc ? loc.details : "",
      location_osm: loc ? loc.osmUrl : "",
      GREMIUM_NAME: gremiumMatch.gremium || "—",
      GREMIUM_TYP: gremiumMatch.typ || "—",
      GREMIUM_HINWEIS: gremiumMatch.hinweis || "Zuständigkeit vor Einreichung bitte prüfen.",
      GREMIUM_KONTAKT: gremiumMatch.kontakt || ""
    };

    // Load Gen-2 templates with Gen-1 fallback:
    // If Gen-2 file loads successfully (non-empty), use it; otherwise fall back to Gen-1.
    // Always returns { content: string, isGen2: boolean } regardless of which generation was used.
    async function loadGen2WithFallback(gen2Name, gen1Name) {
      const gen2 = await loadTemplate(gen2Name, citySlug);
      if (gen2) return { content: gen2, isGen2: true };
      return { content: await loadTemplate(gen1Name, citySlug), isGen2: false };
    }

    const [introResult, tSach, beschResult, hinwResult, lizResult, tMethod] = await Promise.all([
      loadGen2WithFallback("base_intro", "intro"),
      loadTemplate("sachverhalt", citySlug),
      loadGen2WithFallback("base_resolution", "beschluss"),
      loadGen2WithFallback("outro_internal_note", "hinweis"),
      loadGen2WithFallback("outro_source_note", "lizenz"),
      loadTemplate("base_method", citySlug)
    ]);
    const tIntro = introResult.content;
    const isGen2Intro = introResult.isGen2;
    const tBesch = beschResult.content;
    const tHinw = hinwResult.content;
    const tLiz = lizResult.content;

    // ---- Text (Clipboard/Word) ----
    const lines = [];
    lines.push(tpl(tIntro, vars).trim());
    lines.push("");

    // When Gen-2 intro is used (base_intro.txt), it already contains "Stadt:" and
    // "Erstellt am:" in the cover block – skip those duplicate lines to avoid
    // doubled metadata in the output.  Datenzeitraum and location are new info, keep them.
    if (!isGen2Intro) {
      lines.push(`Stadt: ${CITY_RAW}`);
    }
    if (range) lines.push(`Datenzeitraum: ${range.minY}–${range.maxY}`);
    lines.push(`Ausschnitt (Bounds): ${bStr}`);

    if (loc) {
      lines.push(`Lage/Adresse (Mittelpunkt): ${loc.details || loc.label}`);
      lines.push(`OSM: ${loc.osmUrl}`);
    }

    if (!isGen2Intro) {
      lines.push(`Datum: ${vars.date}`);
    }
    lines.push("");
    lines.push(tpl(tSach, vars).trim());
    lines.push("");

    if (dev.focus.length) {
      lines.push("Auffälligkeiten (Top-Abweichungen, Anteil im Ausschnitt vs. Stadt):");
      for (const r of dev.focus) {
        const ciStr = `95%-KI: ${fmtPct(r.ciLow)} – ${fmtPct(r.ciHigh)}`;
        const sigStr = r.isSignificant ? "signifikant" : "nicht signifikant – kleine Datenmenge";
        lines.push(`- ${r.label}: lokal ${fmtPct(r.locR)} vs Stadt ${fmtPct(r.baseR)} (Faktor ${r.factor.toFixed(2)}, ${ciStr}; ${sigStr}); lokal ${r.locCnt} / stadtweit ${r.baseCnt}`);
      }
      const allNonSignificant = dev.focus.every(r => !r.isSignificant);
      if (allNonSignificant) {
        lines.push("Hinweis: Alle aufgeführten Abweichungen sind statistisch nicht signifikant (kleine Fallzahlen). Die Faktor-Werte sollten mit Vorsicht interpretiert werden.");
      }
      lines.push("");
      // Include pattern-specific assessments (Gen-2) if available, else fall back to heuristic
      if (matchedPatterns.length > 0) {
        for (const p of matchedPatterns) {
          lines.push(p.content.trim());
          lines.push("");
        }
      } else {
        lines.push("Bewertung / Interpretation (heuristisch):");
        for (const r of dev.focus.slice(0, 3)) {
          lines.push(`- ${r.label}: ${interpretMask(r.mask)}`);
        }
        lines.push("");
      }
    } else {
      lines.push("Auffälligkeiten: In diesem Ausschnitt zeigen sich unter den gewählten Filtern keine klar überrepräsentierten Beteiligungskombinationen (Schwelle: min. 3 Fälle, Faktor ≥ 1,35).");
      lines.push("");
    }

    // Add methodology section (Gen-2)
    if (tMethod) {
      lines.push(tpl(tMethod, vars).trim());
      lines.push("");
    }

    // Add economic impact (PR-C / B2): respect ctx.exportOptions.includeCosts (default ON).
    // Note: `economicImpact` is null when the toggle was off (load gated above).
    if (includeCosts && economicImpact && economicImpact.total > 0) {
      const fmt = (UA.costs && UA.costs.formatEUR) ? UA.costs.formatEUR : (n) => `${n} €`;
      lines.push("Volkswirtschaftliche Bedeutung (Schätzung):");
      lines.push(`  Geschätzte externe Kosten im Bereich: ${fmt(economicImpact.total)} (Datenzeitraum ${economicImpact.years} Jahr${economicImpact.years === 1 ? "" : "e"}).`);
      lines.push(`  Pro Jahr: ca. ${fmt(economicImpact.annual)}.`);
      lines.push(`  Aufschlüsselung – Getötete: ${fmt(economicImpact.breakdown.fatal)} · Schwerverletzte: ${fmt(economicImpact.breakdown.severe)} · Leichtverletzte: ${fmt(economicImpact.breakdown.light)}.`);
      if (economicImpact.source && (economicImpact.source.publisher || economicImpact.source.year)) {
        const srcParts = [economicImpact.source.publisher, economicImpact.source.year].filter(Boolean).join(", ");
        lines.push(`  Quelle: ${srcParts}.`);
      }
      if (economicImpact.disclaimer) {
        lines.push(`  Hinweis: ${economicImpact.disclaimer}`);
      }
      lines.push("");
    }

    // Add recommended measures (PR-D / B1+B3): respect ctx.exportOptions.includeMeasures (default ON).
    // Note: `recommendedMeasures` is null when the toggle was off (load gated above).
    if (includeMeasures && recommendedMeasures && recommendedMeasures.measures.length > 0) {
      const fmtCost = (UA.measures && UA.measures.formatCostRange) ? UA.measures.formatCostRange : (() => "—");
      const fmtRed = (UA.measures && UA.measures.formatReductionRange) ? UA.measures.formatReductionRange : (() => "—");
      lines.push("Empfohlene Maßnahmen (automatischer Vorschlag, basierend auf detektierten Mustern):");
      let i = 1;
      for (const item of recommendedMeasures.measures) {
        const m = item.measure;
        const cost = fmtCost(m.costRange);
        const red = fmtRed(m.effect && m.effect.expectedReductionPct);
        const ev = (m.effect && m.effect.evidenceLevel) ? ` Evidenz ${m.effect.evidenceLevel}` : "";
        lines.push(`  ${i}. ${m.label}`);
        if (m.description) lines.push(`     ${m.description}`);
        lines.push(`     Kosten: ${cost} pro ${m.perUnit || "Einheit"} · erwartete Reduktion: ${red} ·${ev} · Vorlauf: ${m.leadTime || "—"}`);
        if (item.amortisation && item.amortisation.years) {
          const [best, worst] = item.amortisation.years;
          lines.push(`     Geschätzte Amortisation: ca. ${best.toFixed(1)} – ${worst.toFixed(1)} Jahre (Best- bis Worst-Case).`);
        }
        if (Array.isArray(m.considerations) && m.considerations.length > 0) {
          for (const c of m.considerations) lines.push(`     – ${c}`);
        }
        i++;
      }
      if (recommendedMeasures.disclaimer) {
        lines.push(`  Hinweis: ${recommendedMeasures.disclaimer}`);
      }
      lines.push("");
    }

    // Add POI information to text report
    if (poiAnalysis && (poiAnalysis.totalWithin > 0 || poiAnalysis.totalNear > 0)) {
      lines.push("POI-Analyse (Schulen, Kindergärten, Kitas):");
      
      if (poiAnalysis.totalWithin > 0) {
        lines.push(`Im Ausschnitt: ${poiAnalysis.totalWithin} POI(s)`);
        for (const [type, count] of Object.entries(poiAnalysis.withinByType)) {
          const typeLabel = type === "school" ? "Schulen" : type === "kindergarten" ? "Kindergärten" : type === "childcare" ? "Kitas" : type;
          lines.push(`  - ${typeLabel}: ${count}`);
        }
      }
      
      if (poiAnalysis.totalNear > 0) {
        lines.push(`In der Nähe (< 200m): ${poiAnalysis.totalNear} POI(s)`);
        for (const [type, count] of Object.entries(poiAnalysis.nearByType)) {
          const typeLabel = type === "school" ? "Schulen" : type === "kindergarten" ? "Kindergärten" : type === "childcare" ? "Kitas" : type;
          lines.push(`  - ${typeLabel}: ${count}`);
        }
      }
      
      if (poiAnalysis.totalWithin > 0 || poiAnalysis.totalNear > 0) {
        lines.push("Hinweis: Das Vorhandensein von Schulen, Kindergärten oder Kitas im oder nahe dem Unfallbereich erfordert besondere Aufmerksamkeit hinsichtlich der Verkehrssicherheit für Kinder und Jugendliche.");
      }
      
      lines.push("");
    }

    // Add reference documents to text report
    if (refDocs && refDocs.documents && refDocs.documents.length > 0) {
      lines.push("Bezugsdokumente:");
      for (const doc of refDocs.documents) {
        lines.push(`- ${doc.title || "Ohne Titel"}`);
        if (doc.author) lines.push(`  Autor: ${doc.author}`);
        if (doc.date) lines.push(`  Datum: ${doc.date}`);
        if (doc.url) lines.push(`  URL: ${doc.url}`);
        if (doc.description) lines.push(`  ${doc.description}`);
      }
      lines.push("");
    }

    // Add political references to text report
    if (ctx.politicalReferences && ctx.politicalReferences.length > 0) {
      lines.push("Bisherige politische Befassung:");
      for (const ref of ctx.politicalReferences) {
        lines.push(`- ${ref.title || "Ohne Titel"}`);
        if (ref.type) lines.push(`  Typ: ${ref.type}`);
        if (ref.date) lines.push(`  Datum: ${ref.date}`);
        if (ref.gremium) lines.push(`  Gremium: ${ref.gremium}`);
        if (ref.number) lines.push(`  Nummer: ${ref.number}`);
        if (ref.url) lines.push(`  URL: ${ref.url}`);
      }
      lines.push("");
    }

    // Add cross-table (Beteiligungskombination × Schweregrad)
    if (crossTable.rows.length > 0) {
      lines.push("Beteiligungskombination × Schweregrad:");
      lines.push("  Kombination | Getötete | Schwerverletzt | Leichtverletzt | Summe");
      for (const r of crossTable.rows) {
        lines.push(`  ${r.label} | ${r.sev1} | ${r.sev2} | ${r.sev3} | ${r.total}`);
      }
      lines.push(`  Gesamt | ${crossTable.totals.sev1} | ${crossTable.totals.sev2} | ${crossTable.totals.sev3} | ${crossTable.totals.total}`);
      lines.push("");
    }

    // Add accident details using the active view strategy
    if (accidentDetails.groups.length > 0) {
      const view = UA.resolveAccidentView ? UA.resolveAccidentView(accidentDetails.viewId) : null;
      const colHeader = (accidentDetails.columns && accidentDetails.columns.length)
        ? accidentDetails.columns.join(" | ")
        : "# | Jahr | Beteiligte | Uhrzeit | Wochentag | Fahrbahnzustand | Koordinaten";
      lines.push("Einzelunfälle im Bereich:");
      for (const g of accidentDetails.groups) {
        const headerText = g.headers && g.headers.text ? g.headers.text : "";
        if (headerText) lines.push("  " + headerText);
        lines.push("  " + colHeader);
        g.rows.forEach((r, i) => {
          if (view && view.renderRow && view.renderRow.text) {
            lines.push(view.renderRow.text(r, i));
          } else {
            const hour = r.hour != null ? String(r.hour).padStart(2, "0") + ":00" : "—";
            lines.push(`  ${i + 1} | ${r.year ?? "—"} | ${r.involved} | ${hour} | ${(UA.fmtWeekday ? UA.fmtWeekday(r) : (r.weekday || "—"))} | ${r.roadCondition} | ${formatCoords(r.lat, r.lon)}`);
          }
        });
        if (g.overflow > 0) {
          const label = g.overflowLabel || `weitere ${g.sevLabel}`;
          lines.push(`  … und ${g.overflow} ${label}`);
        }
      }
      lines.push("");
    }

    // Dunkelziffer-Pflichthinweis (#C3) – immer, kein Toggle.
    lines.push(DARK_FIGURE_NOTE.title + ":");
    lines.push("  " + DARK_FIGURE_NOTE.body);
    lines.push("  " + DARK_FIGURE_NOTE.sourceLabel);
    lines.push("");

    lines.push(tpl(tBesch, vars).trim());
    lines.push("");
    lines.push(tpl(tHinw, vars).trim());
    lines.push("");
    lines.push(tpl(tLiz, vars).trim());

    const textOut = lines.join("\n").replace(/\n{3,}/g, "\n\n");

    // ---- Compute active filter mask for cross-table highlighting ----
    // Build a bitmask from the currently checked involvement checkboxes
    const activeFilterMask = (function () {
      if (!ctx.ui) return 0;
      let m = 0;
      if (ctx.ui.incBikeEl && ctx.ui.incBikeEl.checked) m |= 1;
      if (ctx.ui.incPedEl  && ctx.ui.incPedEl.checked)  m |= 2;
      if (ctx.ui.incCarEl  && ctx.ui.incCarEl.checked)  m |= 4;
      if (ctx.ui.incMotoEl && ctx.ui.incMotoEl.checked) m |= 8;
      if (ctx.ui.incGkfzEl && ctx.ui.incGkfzEl.checked) m |= 16;
      if (ctx.ui.incSonEl  && ctx.ui.incSonEl.checked)  m |= 32;
      return m;
    })();

    /**
     * Check if a cross-table row mask matches the active filter.
     * - "solo" mode: highlight rows whose mask is a single bit that is part of activeFilterMask
     * - "and" mode: highlight rows whose mask contains all bits from activeFilterMask
     * - "or" mode: highlight rows whose mask overlaps with activeFilterMask
     */
    function isActiveFilterRow(rowMask) {
      if (activeFilterMask === 0) return false;
      const mode = ctx.involvementMode || "or";
      if (mode === "solo") {
        // Solo: exactly one bit set, and that bit is in the active mask
        const isSingleBit = rowMask > 0 && (rowMask & (rowMask - 1)) === 0;
        return isSingleBit && (rowMask & activeFilterMask) !== 0;
      }
      if (mode === "and") {
        // AND: the row must contain ALL active filter bits
        return (rowMask & activeFilterMask) === activeFilterMask;
      }
      // OR: any overlap
      return (rowMask & activeFilterMask) !== 0;
    }

    // ---- HTML (Modal) ----
    const focusRows = dev.focus.length ? dev.focus : dev.rows.slice(0, 5);

    const fmtCI = (r) => `[${fmtPct(r.ciLow)} – ${fmtPct(r.ciHigh)}]`;
    const mkDevRow = (r) => {
      const sigStyle = r.isSignificant ? "" : " color:#999;";
      const sigTooltip = r.isSignificant ? "" : ` title="Nicht signifikant – kleine Datenmenge (95%-KI schließt Stadtwert ein)"`;
      const nsBadge = r.isSignificant ? "" : ` <span style="font-size:10px; color:#bbb;">n.s.</span>`;
      const factorCell = `${r.factor.toFixed(2)}× <span style="font-weight:normal; font-size:11px; color:#777;">${fmtCI(r)}</span>${nsBadge}`;
      return `
      <tr>
        <td><span class="pill">${UA.escHtml(r.label)}</span></td>
        <td style="text-align:right;">${r.locCnt.toLocaleString()}</td>
        <td style="text-align:right;">${fmtPct(r.locR)}</td>
        <td style="text-align:right;">${fmtPct(r.baseR)}</td>
        <td style="text-align:right; font-weight:900;${sigStyle}"${sigTooltip}>${factorCell}</td>
      </tr>`;
    };

    const mkYearRow = (row) => `
      <tr>
        <td style="width:80px;"><strong>${row.year}</strong></td>
        <td style="text-align:right; width:110px;">${row.total.toLocaleString()}</td>
        <td>${row.classes.length ? UA.escHtml(row.classes.join(", ")) : "<span style=\"color:#777;\">—</span>"}</td>
      </tr>`;

    // Build POI section for HTML report
    let poiHtmlSection = "";
    if (poiAnalysis && (poiAnalysis.totalWithin > 0 || poiAnalysis.totalNear > 0)) {
      poiHtmlSection = `
        <div style="margin-top:12px; font-weight:900;">POI-Analyse (Schulen, Kindergärten, Kitas)</div>
        <div style="margin-top:6px; color:#444;">`;
      
      if (poiAnalysis.totalWithin > 0) {
        poiHtmlSection += `<div><strong>Im Ausschnitt:</strong> ${poiAnalysis.totalWithin} POI(s)`;
        const typeLabels = [];
        for (const [type, count] of Object.entries(poiAnalysis.withinByType)) {
          const label = type === "school" ? "Schulen" : type === "kindergarten" ? "Kindergärten" : type === "childcare" ? "Kitas" : type;
          typeLabels.push(`${label}: ${count}`);
        }
        if (typeLabels.length > 0) {
          poiHtmlSection += ` (${UA.escHtml(typeLabels.join(", "))})`;
        }
        poiHtmlSection += `</div>`;
      }
      
      if (poiAnalysis.totalNear > 0) {
        poiHtmlSection += `<div><strong>In der Nähe (&lt; 200m):</strong> ${poiAnalysis.totalNear} POI(s)`;
        const typeLabels = [];
        for (const [type, count] of Object.entries(poiAnalysis.nearByType)) {
          const label = type === "school" ? "Schulen" : type === "kindergarten" ? "Kindergärten" : type === "childcare" ? "Kitas" : type;
          typeLabels.push(`${label}: ${count}`);
        }
        if (typeLabels.length > 0) {
          poiHtmlSection += ` (${UA.escHtml(typeLabels.join(", "))})`;
        }
        poiHtmlSection += `</div>`;
      }
      
      poiHtmlSection += `<div style="margin-top:6px; font-style:italic; color:#666; font-size:13px;">
        Hinweis: Das Vorhandensein von Schulen, Kindergärten oder Kitas im oder nahe dem Unfallbereich erfordert besondere Aufmerksamkeit hinsichtlich der Verkehrssicherheit für Kinder und Jugendliche.
      </div>`;
      poiHtmlSection += `</div>`;
    }

    // Build reference documents section for HTML report
    let refDocsHtmlSection = "";
    if (refDocs && refDocs.documents && refDocs.documents.length > 0) {
      refDocsHtmlSection = `
        <div style="margin-top:12px; font-weight:900;">Bezugsdokumente</div>
        <ul style="margin-top:6px;">`;
      for (const doc of refDocs.documents) {
        refDocsHtmlSection += `<li>`;
        if (doc.url) {
          refDocsHtmlSection += `<a href="${UA.escHtml(doc.url)}" target="_blank" rel="noopener">${UA.escHtml(doc.title || "Ohne Titel")}</a>`;
        } else {
          refDocsHtmlSection += `<strong>${UA.escHtml(doc.title || "Ohne Titel")}</strong>`;
        }
        if (doc.author || doc.date) {
          const meta = [];
          if (doc.author) meta.push(UA.escHtml(doc.author));
          if (doc.date) meta.push(UA.escHtml(doc.date));
          refDocsHtmlSection += ` <span style="color:#666; font-size:12px;">(${meta.join(", ")})</span>`;
        }
        if (doc.description) {
          refDocsHtmlSection += `<br><span style="color:#555; font-size:13px;">${UA.escHtml(doc.description)}</span>`;
        }
        refDocsHtmlSection += `</li>`;
      }
      refDocsHtmlSection += `</ul>`;
    }

    // Build economic-impact HTML section (PR-C / B2)
    let economicImpactHtmlSection = "";
    if (includeCosts && economicImpact && economicImpact.total > 0) {
      const fmt = (UA.costs && UA.costs.formatEUR) ? UA.costs.formatEUR : (n) => `${n} €`;
      const srcParts = (economicImpact.source && (economicImpact.source.publisher || economicImpact.source.year))
        ? [economicImpact.source.publisher, economicImpact.source.year].filter(Boolean).join(", ")
        : "";
      const srcUrl = (economicImpact.source && economicImpact.source.url) ? economicImpact.source.url : "";
      economicImpactHtmlSection = `
        <div style="margin-top:12px; font-weight:900;">Volkswirtschaftliche Bedeutung (Schätzung)</div>
        <table class="report" style="margin-top:6px;">
          <thead>
            <tr><th>Kategorie</th><th style="text-align:right;">Anzahl</th><th style="text-align:right;">Geschätzte Kosten</th></tr>
          </thead>
          <tbody>
            <tr><td>Getötete</td><td style="text-align:right;">${economicImpact.counts.fatal}</td><td style="text-align:right;">${UA.escHtml(fmt(economicImpact.breakdown.fatal))}</td></tr>
            <tr><td>Schwerverletzte</td><td style="text-align:right;">${economicImpact.counts.severe}</td><td style="text-align:right;">${UA.escHtml(fmt(economicImpact.breakdown.severe))}</td></tr>
            <tr><td>Leichtverletzte</td><td style="text-align:right;">${economicImpact.counts.light}</td><td style="text-align:right;">${UA.escHtml(fmt(economicImpact.breakdown.light))}</td></tr>
            <tr style="font-weight:700; border-top:2px solid #aaa;"><td>Gesamt im Datenzeitraum (${economicImpact.years} Jahr${economicImpact.years === 1 ? "" : "e"})</td><td style="text-align:right;">${economicImpact.counts.fatal + economicImpact.counts.severe + economicImpact.counts.light}</td><td style="text-align:right;">${UA.escHtml(fmt(economicImpact.total))}</td></tr>
            <tr style="font-weight:700;"><td>Pro Jahr</td><td></td><td style="text-align:right;">${UA.escHtml(fmt(economicImpact.annual))}</td></tr>
          </tbody>
        </table>
        <div style="margin-top:6px; color:#555; font-size:12px;">
          ${srcParts ? `<div><strong>Quelle:</strong> ${UA.escHtml(srcParts)}${srcUrl ? ` (<a href="${UA.escHtml(srcUrl)}" target="_blank" rel="noopener">Link</a>)` : ""}</div>` : ""}
          ${economicImpact.disclaimer ? `<div style="font-style:italic; margin-top:4px;">${UA.escHtml(economicImpact.disclaimer)}</div>` : ""}
        </div>`;
    }

    // Build recommended-measures HTML section (PR-D / B1+B3)
    let measuresHtmlSection = "";
    if (includeMeasures && recommendedMeasures && recommendedMeasures.measures.length > 0) {
      const fmtCost = (UA.measures && UA.measures.formatCostRange) ? UA.measures.formatCostRange : (() => "—");
      const fmtRed = (UA.measures && UA.measures.formatReductionRange) ? UA.measures.formatReductionRange : (() => "—");
      const itemsHtml = recommendedMeasures.measures.map((item) => {
        const m = item.measure;
        const cost = fmtCost(m.costRange);
        const red = fmtRed(m.effect && m.effect.expectedReductionPct);
        const ev = (m.effect && m.effect.evidenceLevel) ? `Evidenz ${m.effect.evidenceLevel}` : "";
        const amort = (item.amortisation && item.amortisation.years)
          ? `<div style="color:#0a5; font-size:12px; margin-top:2px;"><strong>Amortisation:</strong> ca. ${item.amortisation.years[0].toFixed(1)} – ${item.amortisation.years[1].toFixed(1)} Jahre</div>`
          : "";
        const considerationsHtml = (Array.isArray(m.considerations) && m.considerations.length > 0)
          ? `<ul style="margin:4px 0 0 18px; padding:0; color:#555; font-size:12px;">${m.considerations.map(c => `<li>${UA.escHtml(c)}</li>`).join("")}</ul>`
          : "";
        return `
          <li style="margin-bottom:10px;">
            <div style="font-weight:700;">${UA.escHtml(m.label)}</div>
            ${m.description ? `<div style="color:#444; font-size:13px; margin-top:2px;">${UA.escHtml(m.description)}</div>` : ""}
            <div style="color:#666; font-size:12px; margin-top:2px;">
              <strong>Kosten:</strong> ${UA.escHtml(cost)} pro ${UA.escHtml(m.perUnit || "Einheit")} ·
              <strong>Reduktion:</strong> ${UA.escHtml(red)} ·
              ${ev ? UA.escHtml(ev) + " · " : ""}<strong>Vorlauf:</strong> ${UA.escHtml(m.leadTime || "—")}
            </div>
            ${amort}
            ${considerationsHtml}
          </li>`;
      }).join("");
      const sourcesHtml = (recommendedMeasures.sources && recommendedMeasures.sources.length > 0)
        ? `<div style="color:#666; font-size:12px; margin-top:6px;"><strong>Quellen:</strong> ${recommendedMeasures.sources.map(s => UA.escHtml(s.title || "")).filter(Boolean).join(" · ")}</div>`
        : "";
      measuresHtmlSection = `
        <div style="margin-top:12px; font-weight:900;">Empfohlene Maßnahmen (automatischer Vorschlag)</div>
        <ol style="margin-top:6px;">${itemsHtml}</ol>
        ${sourcesHtml}
        ${recommendedMeasures.disclaimer ? `<div style="color:#555; font-size:12px; font-style:italic; margin-top:4px;">${UA.escHtml(recommendedMeasures.disclaimer)}</div>` : ""}`;
    }

    // Build accident-detail HTML section using the active view strategy.
    // Each group has pre-rendered headers (text/html/docx) and we wrap each row
    // with the strategy's renderRow.html callback.
    let accidentHtmlSection = "";
    if (accidentDetails.groups.length > 0) {
      const view = UA.resolveAccidentView ? UA.resolveAccidentView(accidentDetails.viewId) : null;
      const cols = (accidentDetails.columns && accidentDetails.columns.length)
        ? accidentDetails.columns
        : ["#", "Jahr", "Beteiligte", "Uhrzeit", "Wochentag", "Fahrbahnzustand", "Koordinaten"];
      const colsHtml = cols.map((c) => {
        const ta = (c === "Jahr" || c === "Uhrzeit") ? ' style="text-align:right;"' : "";
        return `<th${ta}>${UA.escHtml(c)}</th>`;
      }).join("");
      const groupsHtml = accidentDetails.groups.map(g => {
        const headerHtml = (g.headers && g.headers.html) ? g.headers.html : "";
        const rowsHtml = g.rows.map((r, i) => {
          if (view && view.renderRow && view.renderRow.html) return view.renderRow.html(r, i);
          // Defensive fallback
          const hour = r.hour != null ? String(r.hour).padStart(2, "0") + ":00" : "—";
          return `<tr><td>${i + 1}</td><td style="text-align:right;">${r.year ?? "—"}</td><td>${UA.escHtml(r.involved)}</td><td style="text-align:right;">${hour}</td><td>${UA.escHtml(UA.fmtWeekday ? UA.fmtWeekday(r) : (r.weekday || "—"))}</td><td>${UA.escHtml(r.roadCondition)}</td><td style="font-size:11px; color:#555;">${UA.escHtml(formatCoords(r.lat, r.lon))}</td></tr>`;
        }).join("");
        const overflowLabel = g.overflowLabel || `weitere ${g.sevLabel || ""}`;
        const overflowHtml = g.overflow > 0
          ? `<div style="color:#777; font-size:12px; margin-top:4px;">… und ${g.overflow} ${UA.escHtml(overflowLabel)}</div>`
          : "";
        return `${headerHtml}
        <table class="report" style="margin-top:4px;">
          <thead>
            <tr>${colsHtml}</tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        ${overflowHtml}`;
      }).join("");
      accidentHtmlSection = `
        <div style="margin-top:12px; font-weight:900;">Einzelunfälle im Bereich</div>
        ${groupsHtml}`;
    }

    const htmlOut = `
      <div style="font:14px/1.35 system-ui;">
        <div style="font-weight:950; font-size:16px;">Report – Auffälligkeiten im markierten Bereich</div>
        <div style="color:#444; margin-top:4px;">
          <div><strong>Stadt:</strong> ${UA.escHtml(CITY_RAW)} | <strong>Bounds:</strong> <code>${UA.escHtml(bStr)}</code></div>
          <div><strong>Auswertung:</strong> lokal ${dev.local.total.toLocaleString()} Unfälle | Baseline ${dev.baseline.total.toLocaleString()} Unfälle</div>
          <div><strong>Datenzeitraum:</strong> ${range ? (range.minY + "–" + range.maxY) : "—"}</div>
          
          ${loc ? `
  <div><strong>Lage (Mittelpunkt):</strong> ${UA.escHtml(loc.details || loc.label)}
    &nbsp; <a href="${UA.escHtml(loc.osmUrl)}" target="_blank" rel="noopener">OSM</a>
  </div>
` : ``}
          
        </div>

        <div style="margin-top:12px; font-weight:900;">Top-Abweichungen</div>
        <table class="report">
          <thead>
            <tr><th>Muster</th><th style="text-align:right;">lokal</th><th style="text-align:right;">lokal %</th><th style="text-align:right;">Stadt %</th><th style="text-align:right;">Faktor [95%-KI]</th></tr>
          </thead>
          <tbody>
            ${(() => {
              const visibleRows = focusRows.filter(r => r.locCnt > 0);
              const rowsHtml = visibleRows.map(mkDevRow).join("");
              const allNonSig = visibleRows.length > 0 && visibleRows.every(r => !r.isSignificant);
              const nonSigBanner = allNonSig
                ? `<tr><td colspan="5" style="color:#888; font-size:12px; font-style:italic;">Hinweis: Alle aufgeführten Abweichungen sind statistisch nicht signifikant (95%-KI schließt Stadtwert ein). Faktor-Werte bei kleinen Fallzahlen mit Vorsicht interpretieren.</td></tr>`
                : "";
              return rowsHtml ? (rowsHtml + nonSigBanner) : "<tr><td colspan=\"5\" style=\"color:#777;\">—</td></tr>";
            })()}
          </tbody>
        </table>

        <div style="margin-top:12px; font-weight:900;">Unfälle pro Jahr (im Ausschnitt)</div>
        <table class="report">
          <thead>
            <tr><th>Jahr</th><th style="text-align:right;">Summe</th><th>Kombinationen (sortiert)</th></tr>
          </thead>
          <tbody>
            ${yr.map(mkYearRow).join("")}
          </tbody>
        </table>

        <div style="margin-top:12px; font-weight:900;">Verletzungsschwere im Ausschnitt</div>
        <table class="report" style="margin-top:6px;">
          <thead>
            <tr><th>Kategorie</th><th style="text-align:right;">Anzahl</th><th style="text-align:right;">Anteil</th></tr>
          </thead>
          <tbody>
            <tr><td>1 – Getötete</td><td style="text-align:right;">${sev.bySev["1"] || 0}</td><td style="text-align:right;">${sev.total ? fmtPct((sev.bySev["1"] || 0) / sev.total) : "0,0 %"}</td></tr>
            <tr><td>2 – Schwerverletzte</td><td style="text-align:right;">${sev.bySev["2"] || 0}</td><td style="text-align:right;">${sev.total ? fmtPct((sev.bySev["2"] || 0) / sev.total) : "0,0 %"}</td></tr>
            <tr><td>3 – Leichtverletzte</td><td style="text-align:right;">${sev.bySev["3"] || 0}</td><td style="text-align:right;">${sev.total ? fmtPct((sev.bySev["3"] || 0) / sev.total) : "0,0 %"}</td></tr>
          </tbody>
        </table>

        ${crossTable.rows.length > 0 ? `
        <div style="margin-top:12px; font-weight:900;">Beteiligungskombination × Schweregrad</div>
        <table class="report" style="margin-top:6px;">
          <thead>
            <tr><th>Kombination</th><th style="text-align:right;">Getötete</th><th style="text-align:right;">Schwerverletzt</th><th style="text-align:right;">Leichtverletzt</th><th style="text-align:right;">Summe</th></tr>
          </thead>
          <tbody>
            ${crossTable.rows.map(r => `<tr${isActiveFilterRow(r.mask) ? ' style="background-color:#FFFFCC; font-weight:600;"' : ''}><td>${UA.escHtml(r.label)}</td><td style="text-align:right;">${r.sev1}</td><td style="text-align:right;">${r.sev2}</td><td style="text-align:right;">${r.sev3}</td><td style="text-align:right; font-weight:700;">${r.total}</td></tr>`).join("")}
            <tr style="font-weight:700; border-top:2px solid #aaa;"><td>Gesamt</td><td style="text-align:right;">${crossTable.totals.sev1}</td><td style="text-align:right;">${crossTable.totals.sev2}</td><td style="text-align:right;">${crossTable.totals.sev3}</td><td style="text-align:right;">${crossTable.totals.total}</td></tr>
          </tbody>
        </table>
        ` : ""}

        ${economicImpactHtmlSection}

        ${measuresHtmlSection}

        ${accidentHtmlSection}

        ${poiHtmlSection}
        
        ${refDocsHtmlSection}

        ${(() => {
          const polRefs = ctx.politicalReferences;
          if (!polRefs || !polRefs.length) return '';
          let html = `<div style="margin-top:12px; font-weight:900;">Bisherige politische Befassung</div><ul style="margin-top:6px;">`;
          for (const ref of polRefs) {
            const meta = [];
            if (ref.type) meta.push(UA.escHtml(ref.type));
            if (ref.date) meta.push(UA.escHtml(ref.date));
            if (ref.gremium) meta.push(UA.escHtml(ref.gremium));
            if (ref.number) meta.push(UA.escHtml(ref.number));
            html += `<li>`;
            if (ref.url) {
              html += `<a href="${UA.escHtml(ref.url)}" target="_blank" rel="noopener">${UA.escHtml(ref.title || 'Ohne Titel')}</a>`;
            } else {
              html += `<strong>${UA.escHtml(ref.title || 'Ohne Titel')}</strong>`;
            }
            if (meta.length) html += ` <span style="color:#666;font-size:12px;">(${meta.join(' · ')})</span>`;
            html += `</li>`;
          }
          html += `</ul>`;
          return html;
        })()}

        <div style="margin-top:10px; color:#555; font-size:12px;">
          <div><strong>Methodik:</strong> Verglichen wird die Verteilung exakter Beteiligungskombinationen im Ausschnitt vs. stadtweit – jeweils unter denselben Nicht-Beteiligungsfiltern (Schwere/Zeit/Zustand/Wochentag).</div>
          <div><strong>Hinweis:</strong> Heuristisch – ersetzt keine Unfallkommission/Ortsbegehung.</div>
        </div>
      </div>
    `;

    // Build active filters description for structured meta
    const filters = {};
    if (ctx.ui) {
      if (ctx.ui.severityEl) filters.severity = ctx.ui.severityEl.value;
      if (ctx.ui.roadConditionEl) filters.roadCondition = ctx.ui.roadConditionEl.value;
      if (ctx.ui.incBikeEl) filters.includeCyclist    = ctx.ui.incBikeEl.checked;
      if (ctx.ui.incPedEl)  filters.includePedestrian = ctx.ui.incPedEl.checked;
      if (ctx.ui.incCarEl)  filters.includeCar        = ctx.ui.incCarEl.checked;
      if (ctx.ui.incMotoEl) filters.includeMotorcycle  = ctx.ui.incMotoEl.checked;
      if (ctx.ui.incGkfzEl) filters.includeGkfz       = ctx.ui.incGkfzEl.checked;
      if (ctx.ui.incSonEl)  filters.includeSonstig    = ctx.ui.incSonEl.checked;
      if (ctx.ui.hFromEl)   filters.hourFrom          = Number(ctx.ui.hFromEl.value);
      if (ctx.ui.hToEl)     filters.hourTo            = Number(ctx.ui.hToEl.value);
      if (ctx.ui.dayTypeEl) filters.dayType           = ctx.ui.dayTypeEl.value;
    }
    if (ctx.involvementMode) filters.involvementMode = ctx.involvementMode;

    const structured = {
      meta: {
        city: CITY_RAW,
        date: vars.date,
        bounds: bStr,
        areaName,
        link: vars.link,
        filters,
        gremium: gremiumMatch,
        activeFilterMask,
        involvementMode: ctx.involvementMode || "or"
      },
      severity: sev,
      deviations: dev,
      yearTable: yr,
      poi: poiAnalysis,
      references: refDocs,
      politicalReferences: ctx.politicalReferences || [],
      patterns: matchedPatterns,
      crossTable,
      accidentDetails,
      economicImpact,
      recommendedMeasures,
      timeClusters: timeClusters
    };

    return { text: textOut, html: htmlOut, structured };
  };


  // --------------------
  // Private: get points in export bounds (applies non-involvement filters to match the current UI view)
  // --------------------
  function getPointsInBounds(ctx) {
    const bounds = boundsForExport(ctx);
    const points = [];
    for (const p of ctx.allPts || []) {
      if (!p?.props) continue;
      if (typeof UA.matchesNonInvolvementFilters === "function") {
        if (!UA.matchesNonInvolvementFilters(ctx, p.props)) continue;
      }
      if (!inBounds(p, bounds)) continue;
      points.push(p);
    }
    return points;
  }

  // --------------------
  // Private: normalize city name for use in filenames
  // --------------------
  function safeCity(cityRaw) {
    if (typeof UA.normKey === "function") return UA.normKey(cityRaw) || "export";
    // Fallback: strip everything that is not alphanumeric or underscore
    return String(cityRaw || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "export";
  }

  // --------------------
  // Private: trigger file download
  // --------------------
  function triggerDownload(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    if (typeof window.saveAs === "function") {
      window.saveAs(blob, filename);
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    }
  }

  // --------------------
  // Public API: UA.exportToCSV(ctx)
  // --------------------
  UA.exportToCSV = function exportToCSV(ctx) {
    const points = getPointsInBounds(ctx);
    const CITY = ctx.CITY_RAW || "";
    const date = new Date().toISOString().slice(0, 10);

    const headers = ["lat", "lon", "year", "ukategorie", "IstRad", "IstFuss", "IstPKW", "IstKrad", "IstGkfz", "IstSonstig", "ustunde", "uwochentag", "strzustand"];
    const rows = [headers.join(",")];

    for (const p of points) {
      const pr = p.props || {};
      const row = [
        p.lat,
        p.lon,
        pr.year ?? "",
        pr.ukategorie ?? "",
        pr.IstRad ?? pr.istrad ?? "",
        pr.IstFuss ?? pr.istfuss ?? "",
        pr.IstPKW ?? pr.istpkw ?? "",
        pr.IstKrad ?? pr.istkrad ?? "",
        pr.IstGkfz ?? pr.istgkfz ?? "",
        pr.IstSonstig ?? pr.istsonstig ?? "",
        pr.ustunde ?? "",
        pr.uwochentag ?? "",
        pr.strzustand ?? ""
      ].map(v => {
        const s = String(v ?? "");
        return s.includes(",") || s.includes('"') || s.includes("\n")
          ? `"${s.replace(/"/g, '""')}"` : s;
      });
      rows.push(row.join(","));
    }

    const filename = `Unfallatlas_${safeCity(CITY)}_${date}.csv`;
    triggerDownload(rows.join("\n"), filename, "text/csv;charset=utf-8");
  };

  // --------------------
  // Public API: UA.exportToGeoJSON(ctx)
  // --------------------
  UA.exportToGeoJSON = function exportToGeoJSON(ctx) {
    const points = getPointsInBounds(ctx);
    const CITY = ctx.CITY_RAW || "";
    const date = new Date().toISOString().slice(0, 10);

    const features = points.map(p => {
      const pr = p.props || {};
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lon, p.lat] },
        properties: {
          year: pr.year ?? null,
          ukategorie: pr.ukategorie ?? null,
          IstRad: pr.IstRad ?? pr.istrad ?? null,
          IstFuss: pr.IstFuss ?? pr.istfuss ?? null,
          IstPKW: pr.IstPKW ?? pr.istpkw ?? null,
          IstKrad: pr.IstKrad ?? pr.istkrad ?? null,
          IstGkfz: pr.IstGkfz ?? pr.istgkfz ?? null,
          IstSonstig: pr.IstSonstig ?? pr.istsonstig ?? null,
          ustunde: pr.ustunde ?? null,
          uwochentag: pr.uwochentag ?? null,
          strzustand: pr.strzustand ?? null
        }
      };
    });

    const geojson = { type: "FeatureCollection", features };
    const filename = `Unfallatlas_${safeCity(CITY)}_${date}.geojson`;
    triggerDownload(JSON.stringify(geojson, null, 2), filename, "application/geo+json;charset=utf-8");
  };

  // --------------------
  // Public API: UA.exportToKML(ctx)
  // --------------------
  UA.exportToKML = function exportToKML(ctx) {
    const points = getPointsInBounds(ctx);
    const CITY = ctx.CITY_RAW || "";
    const date = new Date().toISOString().slice(0, 10);

    function escXml(v) {
      return String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
    }

    const SEV_LABEL = { "1": "Getötet", "2": "Schwerverletzt", "3": "Leichtverletzt" };

    const placemarks = points.map(p => {
      const pr = p.props || {};
      const year = pr.year ?? "";
      const ukategorie = pr.ukategorie ?? "";
      const sevLabel = SEV_LABEL[String(ukategorie)] || String(ukategorie);

      const involved = [];
      if (String(pr.IstRad ?? pr.istrad) === "1") involved.push("Rad");
      if (String(pr.IstFuss ?? pr.istfuss) === "1") involved.push("Fuß");
      if (String(pr.IstPKW ?? pr.istpkw) === "1") involved.push("PKW");
      if (String(pr.IstKrad ?? pr.istkrad) === "1") involved.push("Krad");
      if (String(pr.IstGkfz ?? pr.istgkfz) === "1") involved.push("Gkfz");
      if (String(pr.IstSonstig ?? pr.istsonstig) === "1") involved.push("Sonst.");

      const name = `${year} ${sevLabel}${involved.length ? " (" + involved.join("+") + ")" : ""}`;

      return `    <Placemark>
      <name>${escXml(name)}</name>
      <ExtendedData>
        <Data name="year"><value>${escXml(year)}</value></Data>
        <Data name="ukategorie"><value>${escXml(ukategorie)}</value></Data>
        <Data name="ustunde"><value>${escXml(pr.ustunde ?? "")}</value></Data>
        <Data name="uwochentag"><value>${escXml(pr.uwochentag ?? "")}</value></Data>
        <Data name="strzustand"><value>${escXml(pr.strzustand ?? "")}</value></Data>
      </ExtendedData>
      <Point><coordinates>${p.lon},${p.lat},0</coordinates></Point>
    </Placemark>`;
    }).join("\n");

    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escXml("Unfallatlas " + CITY + " " + date)}</name>
    <description>Exportierte Unfalldaten</description>
${placemarks}
  </Document>
</kml>`;

    const filename = `Unfallatlas_${safeCity(CITY)}_${date}.kml`;
    triggerDownload(kml, filename, "application/vnd.google-earth.kml+xml;charset=utf-8");
  };


  // sehr kleine Cache-Strategie, damit beim Klicken nicht dauernd neue Requests kommen
  const _rgCache = new Map();

  UA.reverseGeocode = async function reverseGeocode(lat, lon){
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (_rgCache.has(key)) return _rgCache.get(key);

    // Fallback-Text (wenn alles schief geht)
    const fallback = {
      label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
      details: "",
      osmUrl: `https://www.openstreetmap.org/?mlat=${encodeURIComponent(lat)}&mlon=${encodeURIComponent(lon)}#map=18/${encodeURIComponent(lat)}/${encodeURIComponent(lon)}`
    };

    try {
      // Nominatim (OSM) Reverse; kann je nach Browser/CORS/Policy manchmal blocken.
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1`;
      const r = await fetch(url, {
        method: "GET",
        cache: "no-store",
        headers: { "Accept": "application/json" }
      });
      if (!r.ok) throw new Error(`reverse status ${r.status}`);
      const j = await r.json();

      // display_name ist meist am brauchbarsten
      const label = j.display_name || fallback.label;

      // optional: hübschere Kurzform aus address-Objekt
      const a = j.address || {};
      const parts = [
        a.road,
        a.house_number ? String(a.house_number) : "",
        a.postcode,
        a.city || a.town || a.village || a.municipality,
        a.suburb || a.neighbourhood
      ].filter(Boolean);

      const details = parts.length ? parts.join(", ") : "";

      const out = {
        label,
        details,
        osmUrl: fallback.osmUrl,
        // Pass through administrative fields useful for Gremien matching
        admin: {
          suburb: a.suburb || a.neighbourhood || null,
          city_district: a.city_district || null,
          borough: a.borough || null,
          quarter: a.quarter || null,
          city: a.city || a.town || a.village || a.municipality || null,
          state: a.state || null,
          postcode: a.postcode || null
        }
      };

      _rgCache.set(key, out);
      return out;
    } catch (e) {
      _rgCache.set(key, fallback);
      return fallback;
    }
  };
  
  
})();
