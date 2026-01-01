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

  async function loadTemplate(name) {
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
  // Unfallklassen / Masken (robust, unabhängig von anderen Modulen)
  // --------------------
  const COMBO_LABEL = {
    1:  "🚲",
    2:  "🚶",
    4:  "🚗",
    8:  "🏍️",
    3:  "🚲+🚶",
    5:  "🚲+🚗",
    6:  "🚗+🚶",
    7:  "🚲+🚗+🚶",
    9:  "🚲+🏍️",
    10: "🚶+🏍️",
    12: "🚗+🏍️",
    11: "🚲+🚶+🏍️",
    13: "🚲+🚗+🏍️",
    14: "🚶+🚗+🏍️",
    15: "🚲+🚶+🚗+🏍️"
  };

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

    return (isBike ? 1 : 0) | (isPed ? 2 : 0) | (isCar ? 4 : 0) | (isMoto ? 8 : 0);
  }

  function interpretMask(mask) {
    if (mask === 1) return "Überrepräsentation von 🚲-Alleinunfällen kann auf Infrastruktur-Risiken (z. B. Schienenquerungen, Kanten/Spurrinnen, Belagswechsel, Engstellen) hindeuten.";
    if (mask === 2) return "Überrepräsentation von 🚶-Alleinunfällen kann auf Querungsdefizite, Sichtbehinderungen oder Stolperstellen hinweisen.";
    if (mask === 5) return "Überrepräsentation von 🚲+🚗 deutet häufig auf Konflikte an Knotenpunkten/Abbiegesituationen, Sichtbeziehungen und Führung des Radverkehrs hin.";
    if (mask === 6) return "Überrepräsentation von 🚗+🚶 weist oft auf Querungsdefizite, Sichtbeziehungen oder hohes Geschwindigkeitsniveau hin.";
    if (mask === 3) return "Überrepräsentation von 🚲+🚶 kann auf enge Führungen, gemeinsame Flächen oder fehlende Trennung hinweisen.";
    if (mask === 7) return "Überrepräsentation von 🚲+🚗+🚶 spricht für komplexe Konfliktlagen an Knotenpunkten bzw. stark frequentierten Querungen.";
    return "Auffälligkeit kann auf lokale Führungs-/Sicht-/Querungsprobleme hinweisen; eine Ortsbegehung und Unfallkommissionsprüfung ist angezeigt.";
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
      rows.push({ mask: m, label: COMBO_LABEL[m] || ("Mask " + m), locCnt, baseCnt, locR, baseR, factor });
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

    const CITY_RAW = ctx.CITY_RAW || "—";
    const citySlug = UA.normKey ? UA.normKey(CITY_RAW) : CITY_RAW.toLowerCase().replace(/[^a-z0-9]+/g, "_");

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

    const vars = {
      city: CITY_RAW,
      bounds: bStr,
      local_total: dev.local.total.toLocaleString(),
      baseline_total: dev.baseline.total.toLocaleString(),
      severity_summary: ((sev.bySev["1"] || 0) > 0
        ? `Im Ausschnitt wurden ${sev.bySev["1"]} Getötete, ${sev.bySev["2"] || 0} Schwerverletzte und ${sev.bySev["3"] || 0} Leichtverletzte registriert.`
        : `Im Ausschnitt wurden ${sev.bySev["2"] || 0} Schwerverletzte und ${sev.bySev["3"] || 0} Leichtverletzte registriert.`),
      date: new Date().toLocaleDateString("de-DE"),
      link: window.location.href,
      location_label: loc ? loc.label : "",
      location_details: loc ? loc.details : "",
      location_osm: loc ? loc.osmUrl : ""
    };

    const [tIntro, tSach, tBesch, tHinw, tLiz] = await Promise.all([
      loadTemplate("intro"),
      loadTemplate("sachverhalt"),
      loadTemplate("beschluss"),
      loadTemplate("hinweis"),
      loadTemplate("lizenz")
    ]);

    // ---- Text (Clipboard/Word) ----
    const lines = [];
    lines.push(tpl(tIntro, vars).trim());
    lines.push("");
    lines.push(`Stadt: ${CITY_RAW}`);
    if (range) lines.push(`Datenzeitraum: ${range.minY}–${range.maxY}`);
    lines.push(`Ausschnitt (Bounds): ${bStr}`);
    
    if (loc) {
      lines.push(`Lage/Adresse (Mittelpunkt): ${loc.details || loc.label}`);
      lines.push(`OSM: ${loc.osmUrl}`);
    }
    
    lines.push(`Datum: ${vars.date}`);
    lines.push("");
    lines.push(tpl(tSach, vars).trim());
    lines.push("");

    if (dev.focus.length) {
      lines.push("Auffälligkeiten (Top-Abweichungen, Anteil im Ausschnitt vs. Stadt):");
      for (const r of dev.focus) {
        lines.push(`- ${r.label}: lokal ${fmtPct(r.locR)} vs Stadt ${fmtPct(r.baseR)} (Faktor ${r.factor.toFixed(2)}); lokal ${r.locCnt} / stadtweit ${r.baseCnt}`);
      }
      lines.push("");
      lines.push("Bewertung / Interpretation (heuristisch):");
      for (const r of dev.focus.slice(0, 3)) {
        lines.push(`- ${r.label}: ${interpretMask(r.mask)}`);
      }
      lines.push("");
    } else {
      lines.push("Auffälligkeiten: In diesem Ausschnitt zeigen sich unter den gewählten Filtern keine klar überrepräsentierten Beteiligungskombinationen (Schwelle: min. 3 Fälle, Faktor ≥ 1,35).");
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

    lines.push(tpl(tBesch, vars).trim());
    lines.push("");
    lines.push(tpl(tHinw, vars).trim());
    lines.push("");
    lines.push(tpl(tLiz, vars).trim());

    const textOut = lines.join("\n").replace(/\n{3,}/g, "\n\n");

    // ---- HTML (Modal) ----
    const focusRows = dev.focus.length ? dev.focus : dev.rows.slice(0, 5);

    const mkDevRow = (r) => `
      <tr>
        <td><span class="pill">${UA.escHtml(r.label)}</span></td>
        <td style="text-align:right;">${r.locCnt.toLocaleString()}</td>
        <td style="text-align:right;">${fmtPct(r.locR)}</td>
        <td style="text-align:right;">${fmtPct(r.baseR)}</td>
        <td style="text-align:right; font-weight:900;">${r.factor.toFixed(2)}×</td>
      </tr>`;

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
            <tr><th>Muster</th><th style="text-align:right;">lokal</th><th style="text-align:right;">lokal %</th><th style="text-align:right;">Stadt %</th><th style="text-align:right;">Faktor</th></tr>
          </thead>
          <tbody>
            ${focusRows.filter(r => r.locCnt > 0).map(mkDevRow).join("") || "<tr><td colspan=\"5\" style=\"color:#777;\">—</td></tr>"}
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

        ${poiHtmlSection}
        
        ${refDocsHtmlSection}

        <div style="margin-top:10px; color:#555; font-size:12px;">
          <div><strong>Methodik:</strong> Verglichen wird die Verteilung exakter Beteiligungskombinationen im Ausschnitt vs. stadtweit – jeweils unter denselben Nicht-Beteiligungsfiltern (Schwere/Zeit/Zustand/Wochentag).</div>
          <div><strong>Hinweis:</strong> Heuristisch – ersetzt keine Unfallkommission/Ortsbegehung.</div>
        </div>
      </div>
    `;

    return { text: textOut, html: htmlOut };
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
        osmUrl: fallback.osmUrl
      };

      _rgCache.set(key, out);
      return out;
    } catch (e) {
      _rgCache.set(key, fallback);
      return fallback;
    }
  };
  
  
})();
