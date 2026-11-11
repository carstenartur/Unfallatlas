(() => {
  const UA = (window.UA = window.UA || {});

  // Initialize export libraries loaded flag and in-flight load guard
  UA._exportLibrariesLoaded = false;
  UA._exportLibrariesLoading = null;

  function reportSubject(reportData) {
    const structured = reportData?.structured?.motion?.subject || reportData?.structured?.subject;
    if (typeof structured === "string" && structured.trim()) return structured.trim();
    const subjectFrom = value => {
      const lines = String(value || "").split(/\r?\n/);
      const index = lines.findIndex(line => /^\s*Betreff\s*:/i.test(line));
      if (index < 0) return null;
      const inline = lines[index].replace(/^\s*Betreff\s*:\s*/i, "").trim();
      if (inline) return inline;
      const next = lines.slice(index + 1).find(line => line.trim());
      const nextIsHeader = next && /^\s*(?:Stadt|Datum|Erstellt am|Bereich|An|Gremium|Gremientyp|Vermutlich zuständiges Gremium|Hinweis|Datengrundlage(?: und Einordnung)?|Sachverhalt|Beschlussvorschlag|Begründung|Statistik|Methodik(?:\s*\([^)]*\))?|Anlagen)\s*:/i.test(next);
      return next && !/:\s*$/.test(next) && !nextIsHeader ? next.trim() : null;
    };
    // Older standalone render callers do not load generated template defaults.
    // Their fallback matches templates/intro.txt; the normal runtime uses it directly.
    return subjectFrom(reportData?.text) || subjectFrom(UA.exportTemplateDefaults?.intro) ||
      "Prüfung und Verbesserung der Verkehrssicherheit im markierten Bereich auf Grundlage amtlich dokumentierter Unfälle";
  }

  // ---------------------------------------------------------------------
  // Hinweis zur Zählweise (PR 2 / Spec-Item 4 — „Hinweis-zur-Zählweise"-Box)
  //
  // Wird sowohl in DOCX als auch in PDF unmittelbar nach dem „Aktive
  // Filter"-Block eingefügt. Die Box stellt für Verwaltungspublikum klar,
  // welche Population die in den Tabellen genannten Fallzahlen abdecken,
  // damit Ausschnittszahlen nicht versehentlich als stadtweite Statistik
  // gelesen werden.
  const HINWEIS_ZAEHLWEISE_LINES = [
    "Hinweis zur Zählweise:",
    "Alle in diesem Dokument genannten Fallzahlen beziehen sich – sofern nicht anders ausgewiesen – ausschließlich auf den oben markierten Auswertungsbereich (Kartenausschnitt + aktive Filter). Stadtweite Vergleichswerte (z. B. in den Top-Abweichungen) werden als \"Vergleich mit dem Stadtgebiet\" gekennzeichnet."
  ];

  // ---------------------------------------------------------------------
  // Figure-Caption-Counter (PR 2 / Spec-Item 4 — „Abbildung N: …")
  //
  // Beide Renderer (DOCX + PDF) erzeugen genau drei Bildklassen:
  // Übersichtskarte, Detailkarte, Cluster-Karten (1..n). Die Caption-Box
  // hängt unter jedem Bild eine durchnummerierte Bildunterschrift an,
  // damit das resultierende Dokument zitierfähig wird (z. B. „siehe
  // Abbildung 2"). Für jeden Export-Aufruf wird ein frischer Counter
  // erzeugt; die DOCX- und PDF-Pfade verwenden je einen eigenen.
  function makeFigureCounter() {
    let n = 0;
    return {
      next(subject) {
        n += 1;
        return { index: n, caption: `Abbildung ${n}: ${subject}` };
      }
    };
  }


  // ---------------------------------------------------------------------
  // Block headers used to terminate the SACHVERHALT extraction in DOCX
  // and PDF export. The TEXT renderer in js/ua.export_v2.js emits these
  // headers after "Sachverhalt:". Used by extractSection() and by the
  // PDF/DOCX SACHVERHALT extraction call sites to terminate the
  // SACHVERHALT block before the next major section. Without this,
  // blocks like "Mehrjahres-Trend (Gesamtzahl pro Jahr):\n  Jahr |
  // Getötete | …" leak into the SACHVERHALT paragraph as raw pipe-text
  // and then render again later as proper structured tables — exactly
  // the QA blocker tracked by the regression assertion in
  // tests/unit/ua.report_v2.pdfQA.test.js.
  //
  // The list also includes "Sachverhalt:" itself so that an unexpected
  // re-entry of the entry marker terminates extraction defensively (the
  // first "Sachverhalt:" line activates collection and is consumed by
  // the inSection flag in extractSection; only a second occurrence would
  // be matched against this list). The DOCX call site explicitly filters
  // out the entry marker since it's already used as the sectionHeader
  // argument.
  //
  // Headers are matched via String.prototype.startsWith on the trimmed
  // line, so substrings of headers (e.g. "Auffälligkeiten (" matches both
  // "Auffälligkeiten:" and "Auffälligkeiten (Top-Abweichungen…)") are
  // sufficient.
  const POST_SACHVERHALT_STOP_HEADERS = [
    "Sachverhalt:",
    "Auffälligkeiten:",
    "Auffälligkeiten (",
    "URSACHEN UND MASSNAHMEN",
    "Bewertung / Interpretation",
    "Methodik",
    "Mehrjahres-Trend",
    "Stunden-Heatmap",
    "Verkehrsräumlicher Kontext",
    "Volkswirtschaftliche Bedeutung",
    "Modellrechnung für Personenschäden",
    "Empfohlene Maßnahmen",
    "POI-Analyse",
    "Bezugsdokumente:",
    "Bisherige politische Befassung:",
    "Beteiligungskombination × Schweregrad:",
    "Einzelunfälle im Bereich:",
    "Beschlussvorschlag:",
    "Begründung:",
    "Hinweis zur Datenquelle / Lizenz:",
    "VOLLSTÄNDIGE NUMMERIERTE UNFALLBEWEISANLAGE",
    "Hinweis (intern)",
    "Datenquelle",
    "Datenerfassung",
    "Welche Unfälle sind erfasst?",
    "Kontextdaten"
  ];

  const EVIDENCE_HEADERS = ["ID", "Jahr", "Schwere", "Beteiligte", "Tag / Zeit", "Fahrbahn", "Lage", "Suchfilter", "Karte"];
  const MOTION_NUMBERING = "motion-requests";
  const FACTOR_READING = "Der Faktor gibt das Verhältnis des lokalen Anteils eines Beteiligungsmusters zum Anteil im Stadtgebiet an. Werte über 1 zeigen einen höheren lokalen Anteil. Die 95 %-Konfidenzintervalle beschreiben die Unsicherheit des lokalen Anteils. „n. s.“ kennzeichnet Werte ohne statistisch nachweisbare Abweichung.";
  const EVIDENCE_PDF_LAYOUT = {
    hLineWidth: (row, node) => row === 1 ? 0.8 : row === node.table.body.length ? 0 : 0.35,
    hLineColor: row => row === 1 ? "#7891A0" : "#C7D0D7",
    vLineWidth: () => 0,
    paddingLeft: () => 4,
    paddingRight: () => 4,
    paddingTop: () => 1,
    paddingBottom: () => 1
  };

  function readMotionSection(lines, heading) {
    const index = lines.findIndex(line => line.trim().startsWith(heading));
    if (index < 0) return [];
    const inline = lines[index].trim().slice(heading.length).trim();
    const result = inline ? [inline] : [];
    for (const line of lines.slice(index + 1)) {
      const content = line.trim();
      if (POST_SACHVERHALT_STOP_HEADERS.some(header => content.startsWith(header))) break;
      if (content) result.push(content);
    }
    return result;
  }

  function motionSections(sd, lines, hasMap) {
    const { intro, requests, rationale, source } = sd?.motion || {};
    const structuredRequests = Array.isArray(requests) ? requests.filter(text => typeof text === "string" && text.trim()) : [];
    const withoutMapReference = text => hasMap ? text : text.replace(/den in Anlage 1 dargestellten Bereich/g, "den ausgewählten Bereich");
    const reason = typeof rationale === "string" && rationale.trim()
      ? [rationale]
      : readMotionSection(lines, "Begründung:");
    if (structuredRequests.length) {
      return {
        paragraphs: [intro || "Die Verwaltung wird um folgende Schritte gebeten."],
        requests: structuredRequests.map(withoutMapReference),
        reason,
        source
      };
    }
    const paragraphs = readMotionSection(lines, "Beschlussvorschlag:").map(withoutMapReference);
    if (!paragraphs.length) {
      paragraphs.push("Die Verwaltung wird gebeten, innerhalb von drei Monaten die Verkehrssicherheit im ausgewählten Bereich fachlich zu prüfen, kurzfristige Sicherungsmaßnahmen vorzulegen und über die geplante Wirkungskontrolle zu berichten.");
    }
    const listStart = paragraphs.findIndex(line => /^1[.)]\s/.test(line));
    const numbered = listStart >= 0 ? paragraphs.slice(listStart) : [];
    const isOrderedList = numbered.length > 0 && numbered.every((line, i) => new RegExp(`^${i + 1}[.)]\\s`).test(line));
    return {
      paragraphs: isOrderedList ? paragraphs.slice(0, listStart) : paragraphs,
      requests: isOrderedList ? numbered.map(line => line.replace(/^\d+[.)]\s+/, "")) : [],
      reason,
      source
    };
  }

  function councilSourceRuns(sd) {
    return (sd?.motion?.priorWork || []).flatMap(record => [
      { text: record.number ? `DS ${record.number} (${sourceDate(record.date)})` : `Amtlicher Beleg vom ${sourceDate(record.date)}`, href: reportLink(record.url) },
      ...(record.attachment ? [{ text: record.attachment.label, href: reportLink(record.attachment.url) }] : []),
    ]).filter(source => source.href);
  }

  // Match only complete document numbers with an unambiguous, supplied original URL.
  // A main motion and its reply (e.g. 15-2377/2023 F1) are separate publications.
  function councilCitationMatcher(records) {
    const urls = new Map();
    for (const record of records) {
      const number = String(record?.number || "").trim().replace(/\s+/g, " ");
      const href = reportLink(record?.url);
      if (!number || !href) continue;
      urls.set(number, urls.has(number) && urls.get(number) !== href ? null : href);
    }
    if (!urls.size) return null;
    const alternatives = [...urls.keys()].sort((a, b) => b.length - a.length)
      .map(number => number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"));
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}/-])(?:DS\\s+)?(${alternatives.join("|")})(?![\\p{L}\\p{N}/-]|\\s+[A-Z]+\\d+\\b)`, "gu");
    return { pattern, urls };
  }

  // The HTML preview, Word and native PDF cite the same verified originals at
  // the point of use. Preserve literal URL links and unresolved document numbers.
  UA.createMotionLinkFormatter = function (priorWork, selectedRecords) {
    const citations = councilCitationMatcher([...(priorWork || []), ...(selectedRecords || [])]);
    return text => {
      const content = textWithLinks(text);
      if (!citations) return content;
      const parts = Array.isArray(content) ? content : [{ text: content }];
      const runs = parts.flatMap(part => {
        if (part.link) return [part];
        const matches = [];
        let offset = 0;
        for (const match of part.text.matchAll(citations.pattern)) {
          const link = citations.urls.get(match[1].replace(/\s+/g, " "));
          if (!link) continue;
          if (match.index > offset) matches.push({ text: part.text.slice(offset, match.index) });
          matches.push({ text: match[0], link, color: "#174F71", decoration: "underline" });
          offset = match.index + match[0].length;
        }
        if (!matches.length) return [part];
        if (offset < part.text.length) matches.push({ text: part.text.slice(offset) });
        return matches;
      });
      return runs.length === 1 && !runs[0].link ? runs[0].text : runs;
    };
  };

  function reportLink(href) {
    if (typeof href !== "string" || !href.trim()) return null;
    try {
      const url = new URL(href, window.location?.href);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch (_) {
      return null;
    }
  }

  function numberedEvidence(sd) {
    const appendix = sd?.accidentEvidenceAppendix;
    const cohorts = sd?.evidenceCohorts;
    const rows = appendix?.rows ?? cohorts?.completeEvidenceCohort?.rows;
    if (!Array.isArray(rows)) return null;
    const discoveryCount = rows.filter(row => row.discoveryMatch === true).length;
    const reportingPeriod = cohorts?.reportingPeriod;
    const period = reportingPeriod?.from && reportingPeriod?.to
      ? (reportingPeriod.from === reportingPeriod.to ? String(reportingPeriod.from) : `${reportingPeriod.from}–${reportingPeriod.to}`)
      : "";
    return {
      rows,
      discoveryCount,
      cohortLabel: cohorts?.discoveryCohort?.label,
      period,
      complete: appendix?.complete !== false && appendix?.truncated !== true && cohorts?.status !== "not-assessable"
        && (appendix?.total == null || appendix.total === rows.length),
      link: reportLink(appendix?.numberedMapUrl || cohorts?.numberedMapUrl),
      sourceNote: appendix?.sourceNote,
      limitations: Array.isArray(appendix?.limitations) ? appendix.limitations : []
    };
  }

  function verifiedDiscoveryCount(sd) {
    const evidence = sd?.motion?.discoveryEvidence;
    const focus = sd?.discoveryFocus;
    if (!focus?.key || focus.key !== evidence?.key || evidence.count !== focus.points?.length ||
        !Number.isSafeInteger(evidence.count) || evidence.count < 1) return null;
    return evidence.count;
  }

  function severityPopulationText(sd) {
    const title = "Unfälle im ausgewerteten Ausschnitt nach schwerster Folge";
    const total = sd?.severity?.total;
    if (!Number.isSafeInteger(total) || total < 0) return title;
    const heading = `${title} (n = ${total.toLocaleString("de-DE")})`;
    const count = verifiedDiscoveryCount(sd);
    if (count === null || count > total) return heading;
    return `${heading}. Das ausgewählte Muster umfasst davon ${count.toLocaleString("de-DE")} ${count === 1 ? "Fall" : "Fälle"}.`;
  }

  function involvementComparisonReading(sd, isPolitical) {
    const total = sd.deviations.local?.total;
    const population = Number.isSafeInteger(total) && total >= 0
      ? ` unter ${total.toLocaleString("de-DE")} ${total === 1 ? "Unfall" : "Unfällen"}` : "";
    const sentences = [`Die Spalte „Lokal“ zählt die Fälle je Beteiligungsgruppe${population} im ausgewerteten Ausschnitt.`];
    const count = verifiedDiscoveryCount(sd);
    if (count !== null && sd.discoveryFocus.label) {
      sentences.push(`Für das ausgewählte Muster „${sd.discoveryFocus.label}“ weist die Stellensuche ${count.toLocaleString("de-DE")} ${count === 1 ? "Fall" : "Fälle"} aus.`);
    }
    if (!isPolitical) sentences.push(FACTOR_READING);
    return sentences.join(" ");
  }

  function evidenceCountText(evidence) {
    const count = evidence.rows.length.toLocaleString("de-DE");
    const filteredCount = evidence.discoveryCount.toLocaleString("de-DE");
    const period = evidence.period ? ` (${evidence.period})` : "";
    if (!evidence.complete) {
      return `Die Liste enthält ${count} veröffentlichte Unfälle mit Personenschaden${period}. Ihre Vollständigkeit konnte nicht bestätigt werden.`;
    }
    const events = evidence.rows.length === 1 ? "ist 1 Unfall" : `sind ${count} Unfälle`;
    const selection = evidence.cohortLabel
      ? `Die Netzzuordnung umfasst unter den aktiven Such- und Kartenfiltern ${filteredCount} ${evidence.discoveryCount === 1 ? "Fall" : "Fälle"}.`
      : `Die Suchfilter heben davon ${filteredCount} hervor.`;
    return `Im ausgewählten Gebiet${period} ${events} mit Personenschaden veröffentlicht. ${selection}`;
  }

  function evidenceTable(evidence, mapRefs, anchorPrefix) {
    const includeMapRefs = mapRefs.size > 0;
    const headers = (includeMapRefs ? EVIDENCE_HEADERS : EVIDENCE_HEADERS.slice(0, -1))
      .map(label => label === "Suchfilter" && evidence.cohortLabel ? "Netzfall" : label);
    const rows = evidence.rows.map(row => {
      const hour = row.hour == null ? "—" : `${String(row.hour).padStart(2, "0")}:00`;
      const coordinates = Number.isFinite(row.lat) && Number.isFinite(row.lon)
        ? `${row.lat.toFixed(5)}\n${row.lon.toFixed(5)}`
        : "—";
      return [
        { text: row.displayId, href: reportLink(row.mapDeepLink) },
        String(row.year ?? "—"),
        row.severityLabel || "—",
        row.involvementLabel || "—",
        `${row.weekdayLabel || "—"}\n${hour}`,
        (row.roadConditionLabel || "—").replaceAll("/", " / "),
        coordinates,
        row.discoveryMatch === true ? "Ja" : "Nein",
        ...(includeMapRefs ? [mapRefs.has(row.mapRef) ? { text: row.mapRef, anchor: `${anchorPrefix}${row.mapRef}` } : "—"] : [])
      ];
    });
    return { headers, rows };
  }

  function evidenceAnnexIntro(evidence, hasMap) {
    const mapHint = hasMap ? " Die Spalte Karte verweist auf die jeweiligen Kartenblätter in Anlage 1." : "";
    const legend = evidence.cohortLabel
      ? "In der Spalte Netzfall steht „Ja“ bei den zugeordneten Fällen, die die aktiven Such- und Kartenfilter erfüllen."
      : "In der Spalte Suchfilter steht „Ja“ bei den durch die Filter hervorgehobenen Fällen.";
    return [
      evidenceCountText(evidence),
      `A### bezeichnet eine Dokumentkennung. ${legend} Die Koordinaten geben die veröffentlichte Lage als Breiten- und Längengrad an.${mapHint}`
    ];
  }

  function motionAnnexes(evidence, hasMap, analysisAnnexNumber) {
    return [
      ...(hasMap ? ["1 Karten"] : []),
      ...(evidence ? [`${1 + Number(hasMap)} Unfallliste`] : []),
      `${analysisAnnexNumber} Auswertung und Methodik`
    ].join(" · ");
  }

  function motionPoliticalNote(sd, options, analysisAnnexNumber) {
    if (!options.includeReferences || !Array.isArray(sd?.politicalReferences) || !sd.politicalReferences.length) return [];
    const citations = sd.politicalReferences.filter(ref => ref.scope === "export-area" && ref.number && reportLink(ref.url)).slice(0, 2);
    const label = citations.length ? "Politische Vorbefassung: " : "Politische Vorbefassung siehe ";
    return [{ text: label }, ...citations.flatMap((ref, i) => [
      ...(i ? [{ text: " · " }] : []),
      { text: `DS ${ref.number}`, href: reportLink(ref.url) }
    ]), { text: citations.length ? ` (Anlage ${analysisAnnexNumber}).` : `Anlage ${analysisAnnexNumber}.` }];
  }

  function methodLineForMotion(line) {
    return String(line)
      .replace(/nummerierte completeEvidenceCohort/g, "nummerierte Unfallliste")
      .replace(/Die einzelnen Wilson-95-%-Intervalle und isSignificant sind unbereinigt, eine Mehrfachtestkorrektur wird nicht behauptet\./g,
        "Die Wilson-95-%-Intervalle und die Signifikanzkennzeichnung sind ohne Korrektur für Mehrfachtests berechnet.")
      .replace(/stadtweite Baseline/g, "stadtweite Referenz")
      .replace(/Sichtbar- und Markierungszahlen werden aus derselben ungekappte Filterpopulation und den exakten geometrischen Grenzen berechnet; Renderlimit und technischer Ladepuffer verändern diese Fallzahlen nicht\./g,
        "Die Fallzahlen berücksichtigen alle gefilterten Unfälle innerhalb der Auswahlgrenzen, auch wenn die Karte nur einen Teil davon anzeigt.");
  }

  // =====================================================================
  // Lazy Loading Utilities for Export Libraries
  // =====================================================================

  /**
   * Load a script dynamically
   * @param {string} src - Script URL
   * @param {string} globalCheck - Global variable to check if already loaded
   * @returns {Promise<void>}
   */
  function loadScript(src, globalCheck) {
    return new Promise((resolve, reject) => {
      // Check if already loaded
      if (globalCheck && window[globalCheck]) {
        resolve();
        return;
      }

      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
      document.head.appendChild(script);
    });
  }

  /**
   * Ensure export libraries are loaded.
   * Concurrent calls share the same in-flight Promise so scripts are only
   * injected once even if Word and PDF buttons are clicked simultaneously.
   * @param {Function} [onProgress] - Optional callback(message) called as each library loads
   * @returns {Promise<void>}
   */
  UA.ensureExportLibraries = async function ensureExportLibraries(onProgress) {
    if (UA._exportLibrariesLoaded) return;
    
    // In test environment, libraries might already be loaded or mocked
    if (window.docx && window.pdfMake && window.saveAs) {
      UA._exportLibrariesLoaded = true;
      return;
    }
    
    // If no document object (not in browser), skip loading
    if (typeof document === 'undefined') {
      UA._exportLibrariesLoaded = true;
      return;
    }

    // If a load is already in progress, share it to avoid duplicate script injections.
    // Subsequent callers silently join — progress messages go to the first caller's UI.
    if (UA._exportLibrariesLoading) {
      return UA._exportLibrariesLoading;
    }

    function progress(msg) {
      if (typeof onProgress === 'function') onProgress(msg);
    }

    UA._exportLibrariesLoading = (async function doLoad() {
      try {
        // These files are materialised from the exact package-lock versions by
        // `npm run build:site`. Runtime CDN fallbacks are deliberately absent:
        // production, E2E and screenshot QA must execute identical bytes.
        progress('Lade Bibliothek 1/3: docx…');
        await loadScript('vendor/export/docx.js', 'docx');

        progress('Lade Bibliothek 2/3: pdfMake…');
        await loadScript('vendor/export/pdfmake.js', 'pdfMake');

        progress('Lade Bibliothek 3/3: FileSaver…');
        await loadScript('vendor/export/file-saver.js', 'saveAs');
        
        // Load vfs_fonts after pdfMake so it can register fonts via side-effect
        if (window.pdfMake) {
          progress('Lade Schriftarten…');
          await loadScript('vendor/export/pdfmake-fonts.js', null);
        }
        
        UA._exportLibrariesLoaded = true;
      } catch (e) {
        console.error('Failed to load export libraries:', e);
        throw new Error('Export-Bibliotheken konnten nicht geladen werden. Bitte Seite neu laden.');
      } finally {
        UA._exportLibrariesLoading = null;
      }
    })();

    return UA._exportLibrariesLoading;
  };

  // =====================================================================
  // Map Image Export (programmatic, using leaflet-image)
  // =====================================================================

  // Delay (in milliseconds) to wait for map tiles to load before capture
  const MAP_CAPTURE_DELAY_MS = 100;

  // ---------------------------------------------------------------------
  // Layout-PR „Bildverzerrung beheben" — Aspektrate-erhaltende Skalierung.
  //
  // Bisheriges Verhalten:
  //   * DOCX setzte ImageRun-`transformation` hart auf `{width:600, height:400}`,
  //     unabhängig von der Originalgröße der von leaflet-image gelieferten
  //     PNGs. Bei einem realen Map-Canvas (z. B. 1024×512 oder 800×900) wurde
  //     das Bild gestreckt/gestaucht — Kreise erschienen als Ellipsen, Straßen
  //     wirkten verzerrt. QA-Befund Item 1: harte Anforderung.
  //   * PDF nutzt zwar pdfMake-`fit:[w,h]` (ratio-erhaltend), aber mit
  //     unterschiedlichen Boxen pro Map-Typ (Übersicht 475×650, Detail/Cluster
  //     475×350). QA-Befund Item 2: einheitliche Skalierungslogik.
  //
  // Lösung: ein gemeinsamer Helper, der die Originalgröße aus dem PNG-Header
  // liest (IHDR-Chunk, Bytes 16–23 nach dem 8-Byte-Magic) und einen
  // einheitlichen Skalierungsfaktor `min(maxW/origW, maxH/origH)` anwendet.
  //
  // Zentrale Konstanten — gleicher Bildrahmen für ALLE Karten (Übersicht,
  // Detail, Cluster), damit Karten visuell konsistent skaliert wirken
  // (Spec-Item 2 + 6).
  // ---------------------------------------------------------------------
  const DOCX_MAP_MAX = Object.freeze({ width: 600, height: 400 }); // EMU-Punkte (docx)
  const PDF_MAP_MAX  = Object.freeze({ width: 475, height: 340 }); // pdfMake-Punkte
  // Akzeptanzkriterium 7: |after.ratio − before.ratio| < ASPECT_TOLERANCE
  const ASPECT_TOLERANCE = 0.01;

  /**
   * Read PNG width/height from the IHDR chunk of a base64-encoded PNG.
   * PNG file format:
   *   bytes  0–7   : magic   (89 50 4E 47 0D 0A 1A 0A)
   *   bytes  8–15  : IHDR length (4) + chunk type "IHDR" (4)
   *   bytes 16–19  : width  (uint32 BE)
   *   bytes 20–23  : height (uint32 BE)
   *
   * Akzeptiert sowohl reine Base64-Strings als auch Data-URLs
   * (`data:image/png;base64,…`). Wirft `Error` bei nicht-PNG-Daten oder zu
   * kurzen Eingaben — das ist gewollt, weil unbekannte Originalgrößen die
   * QA-Anforderung „Aspektrate erhalten" nicht erfüllen können.
   *
   * @param {string} dataUrlOrBase64
   * @returns {{width:number, height:number}}
   */
  function readPngDimensions(dataUrlOrBase64) {
    if (typeof dataUrlOrBase64 !== "string" || !dataUrlOrBase64) {
      throw new Error("readPngDimensions: empty input");
    }
    const base64 = dataUrlOrBase64.replace(/^data:image\/png;base64,/, "");
    // We only need the first 24 bytes (magic + IHDR len/type + w/h).
    // atob is available in browser + jsdom test environment.
    const head = (typeof atob === "function")
      ? atob(base64.slice(0, 64))
      : Buffer.from(base64.slice(0, 64), "base64").toString("binary");
    if (head.length < 24) throw new Error("readPngDimensions: input too short to be a PNG");
    // Full 8-byte PNG magic: 0x89 'P' 'N' 'G' 0x0D 0x0A 0x1A 0x0A
    const PNG_MAGIC = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    for (let i = 0; i < PNG_MAGIC.length; i++) {
      if (head.charCodeAt(i) !== PNG_MAGIC[i]) {
        throw new Error("readPngDimensions: not a PNG (magic mismatch)");
      }
    }
    // The first chunk in a PNG must be IHDR. Bytes 8..11 = chunk length,
    // bytes 12..15 = chunk type. Validate "IHDR" so that arbitrary data
    // with a valid PNG prefix cannot pass.
    if (
      head.charCodeAt(12) !== 0x49 || // 'I'
      head.charCodeAt(13) !== 0x48 || // 'H'
      head.charCodeAt(14) !== 0x44 || // 'D'
      head.charCodeAt(15) !== 0x52    // 'R'
    ) {
      throw new Error("readPngDimensions: missing IHDR chunk");
    }
    const u32 = (off) =>
      ((head.charCodeAt(off)     & 0xff) << 24 >>> 0) +
      ((head.charCodeAt(off + 1) & 0xff) << 16) +
      ((head.charCodeAt(off + 2) & 0xff) << 8)  +
       (head.charCodeAt(off + 3) & 0xff);
    const width  = u32(16);
    const height = u32(20);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error("readPngDimensions: invalid IHDR dimensions");
    }
    return { width, height };
  }
  UA.readPngDimensions = readPngDimensions;

  /**
   * Compute scaled `{width, height}` that fits inside `max` while
   * preserving the original aspect ratio. Uses one common scale factor
   * for both axes — the QA-Spec verbietet ausdrücklich, width und height
   * unabhängig zu setzen.
   *
   *   scale  = min(maxW / origW, maxH / origH)
   *   width  = origW * scale
   *   height = origH * scale
   *
   * Beide Achsen werden auf maximal eine Nachkommastelle gerundet, damit
   * die `transformation`-Werte stabil und im Test deterministisch sind.
   *
   * @param {{width:number,height:number}} orig
   * @param {{width:number,height:number}} max
   * @returns {{width:number, height:number}}
   */
  function fitWithAspectRatio(orig, max) {
    const oW = Number(orig && orig.width);
    const oH = Number(orig && orig.height);
    const mW = Number(max && max.width);
    const mH = Number(max && max.height);
    if (!(oW > 0) || !(oH > 0) || !(mW > 0) || !(mH > 0)) {
      throw new Error("fitWithAspectRatio: non-positive dimensions");
    }
    const scale = Math.min(mW / oW, mH / oH);
    const round1 = (n) => Math.round(n * 10) / 10;
    return { width: round1(oW * scale), height: round1(oH * scale) };
  }
  UA.fitWithAspectRatio = fitWithAspectRatio;

  /**
   * Convenience: read PNG size + fit to `max` in one call.
   *
   * Fallback-Hierarchie, wenn der PNG-Header nicht gelesen werden kann:
   *  1. `opts.strict === true`  → wirft den ursprünglichen Fehler weiter.
   *  2. `opts.fallbackRatio` (Zahl, width/height) gesetzt → benutzt diese
   *     bekannte Ratio via `fitWithAspectRatio`. Empfohlen, wenn der
   *     Aufrufer das Canvas- oder Viewport-Seitenverhältnis kennt.
   *  3. Kein fallbackRatio → konservativer Default: Ratio der `max`-Box
   *     selbst (`max.width / max.height`). Das bewahrt die Proportionen
   *     der Zielbox, NICHT die des Originalbildes (das unbekannt ist).
   *     Dieser Fallback verhindert das unabhängige Setzen von width/height
   *     aus der alten Implementierung, liefert aber weiterhin nur dann die
   *     korrekte Originalratio, wenn Originalbild und max-Box zufällig
   *     dieselbe Ratio haben. Für präzises Seitenverhältnis → opts.fallbackRatio.
   *
   * Returned object hat die kanonische `{width, height}`-Form, die
   * `docx`-`ImageRun.transformation` und pdfMake `image` erwarten.
   *
   * @param {string} dataUrlOrBase64
   * @param {{width:number,height:number}} max
   * @param {{fallbackRatio?: number, strict?: boolean}} [opts]
   */
  function fitImageToMax(dataUrlOrBase64, max, opts) {
    try {
      const orig = readPngDimensions(dataUrlOrBase64);
      return fitWithAspectRatio(orig, max);
    } catch (err) {
      if (opts && opts.strict) {
        throw err;
      }
      // Bestimme eine sichere Fallback-Ratio:
      //  - explizit übergeben → nutze sie (bewahrt bekannte Originalratio)
      //  - sonst: Ratio der max-Box (bewahrt Box-Proportionen, nicht
      //    Originalratio — Originalratio ist ohne Header nicht bekannt)
      const ratio = (opts && typeof opts.fallbackRatio === 'number' && opts.fallbackRatio > 0)
        ? opts.fallbackRatio
        : max.width / max.height;
      return fitWithAspectRatio({ width: ratio * 1000, height: 1000 }, max);
    }
  }
  UA.fitImageToMax = fitImageToMax;
  UA.DOCX_MAP_MAX = DOCX_MAP_MAX;
  UA.PDF_MAP_MAX = PDF_MAP_MAX;
  UA.ASPECT_TOLERANCE = ASPECT_TOLERANCE;

  /**
   * Bake opacity into the heatmap canvas pixel data so that leaflet-image
   * (which ignores CSS style.opacity) exports the correct transparency.
   * Returns a restore function that reverts the canvas to its original state.
   * @param {Object} heatLayer - Leaflet.heat layer instance
   * @param {number} opacity - Opacity to apply (0–1)
   * @returns {Function} Restore function (call after capture to undo)
   */
  function bakeHeatOpacityIntoCanvas(heatLayer, opacity) {
    // Match same canvas resolution as applyHeatOpacity in ua.map_v2.js
    const canvas = heatLayer && (heatLayer._canvas || (heatLayer._renderer && heatLayer._renderer._container));
    if (!canvas) return function () {};
    try {
      const ctx2d = canvas.getContext("2d");
      const imageData = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
      const original = new Uint8ClampedArray(imageData.data);
      // Also save/restore CSS opacity to avoid double-applying on screen during export
      const originalCssOpacity = canvas.style.opacity;
      for (let i = 3; i < imageData.data.length; i += 4) {
        imageData.data[i] = Math.round(imageData.data[i] * opacity);
      }
      canvas.style.opacity = "1";
      ctx2d.putImageData(imageData, 0, 0);
      return function restoreHeatCanvas() {
        try {
          const restore = ctx2d.createImageData(canvas.width, canvas.height);
          restore.data.set(original);
          ctx2d.putImageData(restore, 0, 0);
          canvas.style.opacity = originalCssOpacity;
        } catch (err) {
          canvas.style.opacity = originalCssOpacity;
          console.warn("Failed to restore heatmap canvas:", err);
        }
      };
    } catch (err) {
      console.warn("Failed to bake heatmap opacity:", err);
      return function () {};
    }
  }

  /**
   * Detach markers that leaflet-image@0.4.0 cannot render from the given map.
   *
   * Background: leaflet-image's handleMarkerLayer assumes every marker icon
   * exposes an HTMLImageElement at marker._icon with a .src URL. For markers
   * created with L.divIcon (used by our POI layer for school/kindergarten
   * pictograms) marker._icon is a <div>, so reading marker._icon.src yields
   * undefined. leaflet-image then throws inside an asynchronous image.onload,
   * its callback is never invoked, and any awaited capture hangs forever —
   * which breaks the entire Word/PDF export pipeline.
   *
   * To work around this we temporarily detach those non-imageable markers
   * from the map before invoking leaflet-image and re-attach them afterwards.
   *
   * @param {Object} map - Leaflet map instance
   * @returns {Function} Restore function that re-attaches detached markers.
   */
  function detachUncapturableMarkers(map) {
    const detached = [];
    if (!map || typeof map.eachLayer !== "function" || typeof window.L === "undefined") {
      return function () {};
    }
    try {
      map.eachLayer(function (layer) {
        if (!(layer instanceof window.L.Marker)) return;
        const icon = layer.options && layer.options.icon;
        if (!icon) return;
        const isDivIcon = window.L.DivIcon && icon instanceof window.L.DivIcon;
        const iconUrl = icon.options && icon.options.iconUrl;
        // leaflet-image only knows how to draw markers backed by a real image
        // URL. Anything else (DivIcon, custom icons without iconUrl) crashes
        // the capture, so detach it for the duration of the snapshot.
        if (isDivIcon || typeof iconUrl !== "string" || !iconUrl) {
          detached.push(layer);
          map.removeLayer(layer);
        }
      });
    } catch (err) {
      console.warn("Failed to scan markers for export capture:", err);
    }
    return function restoreDetachedMarkers() {
      for (const marker of detached) {
        try {
          marker.addTo(map);
        } catch (err) {
          console.warn("Failed to re-attach marker after export capture:", err);
        }
      }
    };
  }

  // Safety timeout (ms) for leaflet-image. Some marker/layer combinations can
  // cause leaflet-image's internal queue to never invoke its callback (see
  // detachUncapturableMarkers above). Without an upper bound the export
  // promise would hang indefinitely and the export buttons stay disabled.
  const MAP_CAPTURE_TIMEOUT_MS = 30000;
  UA.MAP_CAPTURE_TIMEOUT_MS = MAP_CAPTURE_TIMEOUT_MS;

  // Readiness failures are correctness failures, not cosmetic capture errors:
  // exporting a map before all layers have rendered can produce a plausible
  // but incomplete accident map. Keep the original rejection object while
  // carrying that distinction through the intentionally graceful map fallbacks.
  const mapRenderReadinessFailures = new WeakSet();
  function markMapRenderReadinessFailure(reason) {
    const failure = reason && (typeof reason === "object" || typeof reason === "function")
      ? reason
      : new Error(String(reason || "Die Karte wurde nicht vollständig gerendert."));
    mapRenderReadinessFailures.add(failure);
    return failure;
  }
  function isMapRenderReadinessFailure(reason) {
    return !!reason && (typeof reason === "object" || typeof reason === "function")
      && mapRenderReadinessFailures.has(reason);
  }

  /**
   * Capture current map view as base64 image
   * @param {Object} ctx - Application context with map instance
   * @param {Object} options - Export options
   * @param {number} [options.heatmapExportOpacity] - Override heatmap opacity for export (0–1)
   * @returns {Promise<string>} Base64 image data URL
   */
  UA.captureMapImage = async function captureMapImage(ctx, options = {}) {
    return new Promise((resolve, reject) => {
      if (!window.leafletImage) {
        reject(new Error("leaflet-image library not loaded"));
        return;
      }

      try {
        const waitForRender = (typeof UA.waitForMapFullyRendered === 'function')
          ? UA.waitForMapFullyRendered(ctx.map, { ctx, timeoutMs: MAP_CAPTURE_TIMEOUT_MS })
          : new Promise((r) => setTimeout(r, MAP_CAPTURE_DELAY_MS));
        Promise.resolve(waitForRender).then((fullyRendered) => {
          if (fullyRendered === false) {
            throw markMapRenderReadinessFailure(new Error(
              "Kartenaufnahme abgebrochen: Die Karte wurde nicht vollständig gerendert."
            ));
          }

          // Bake heatmap opacity into canvas pixels so leaflet-image picks it up
          // (leaflet-image ignores CSS style.opacity on the canvas element)
          let restoreHeat = function () {};
          if (ctx.heatLayer) {
            const zoom = ctx.map && ctx.map.getZoom ? ctx.map.getZoom() : 12;
            const rawOpacity =
              options.heatmapExportOpacity != null
                ? options.heatmapExportOpacity
                : (UA.heatOpacityForZoom ? UA.heatOpacityForZoom(zoom) : 0.6);
            const exportOpacity = Number.isFinite(Number(rawOpacity))
              ? Math.max(0, Math.min(1, Number(rawOpacity)))
              : 0.6;
            restoreHeat = bakeHeatOpacityIntoCanvas(ctx.heatLayer, exportOpacity);
          }

          // Detach markers leaflet-image can't render (DivIcon / no iconUrl)
          // BEFORE invoking leafletImage — otherwise the capture throws inside
          // an async image.onload, never invokes its callback, and the export
          // promise hangs forever (breaking Word + PDF export).
          const restoreMarkers = detachUncapturableMarkers(ctx.map);

          // Idempotent cleanup that restores both side-effects (detached
          // markers + baked heatmap canvas) exactly once, even if a late
          // leaflet-image callback fires after the safety timeout already
          // settled the promise. Any restore error is logged and surfaced
          // through `finish()` only when the primary path didn't already
          // produce one.
          let restoredCaptureState = false;
          const restoreCaptureState = function () {
            if (restoredCaptureState) return null;
            restoredCaptureState = true;

            let restoreError = null;
            try {
              restoreMarkers();
            } catch (e) {
              restoreError = e;
            }
            try {
              restoreHeat();
            } catch (e) {
              if (!restoreError) restoreError = e;
            }
            return restoreError;
          };

          let settled = false;
          const finish = function (err, dataUrl) {
            if (settled) {
              // Late callback after timeout: still ensure cleanup happens
              // exactly once, but don't change the already-settled result.
              restoreCaptureState();
              return;
            }
            settled = true;
            clearTimeout(safetyTimer);

            const restoreError = restoreCaptureState();
            if (restoreError) {
              console.error("Map capture cleanup error:", restoreError);
              if (!err) err = restoreError;
            }

            if (err) reject(err);
            else resolve(dataUrl);
          };

          // Safety net: if leaflet-image's callback is never invoked (e.g. an
          // unhandled async error inside one of its layer handlers), reject
          // with a clear error so the export UI can recover instead of hanging.
          const safetyTimer = setTimeout(() => {
            const e = new Error(
              "Kartenaufnahme abgebrochen: leaflet-image hat nicht innerhalb von " +
              (MAP_CAPTURE_TIMEOUT_MS / 1000) + "s geantwortet."
            );
            console.error(e.message);
            finish(e);
          }, MAP_CAPTURE_TIMEOUT_MS);

          try {
            // Use leaflet-image to capture the map with all layers and styling
            window.leafletImage(ctx.map, (err, canvas) => {
              if (err) {
                console.error("leaflet-image capture error:", err);
                finish(err);
                return;
              }

              try {
                // Convert canvas to base64 data URL (PNG format preserves transparency)
                const dataUrl = canvas.toDataURL("image/png");

                // Verify the data URL is valid
                if (!dataUrl || !dataUrl.startsWith("data:image/png;base64,")) {
                  finish(new Error("Invalid map image data URL generated"));
                  return;
                }

                finish(null, dataUrl);
              } catch (e) {
                console.error("Canvas to data URL conversion error:", e);
                finish(e);
              }
            });
          } catch (e) {
            console.error("leafletImage call error:", e);
            finish(e);
          }
        }, (renderError) => {
          throw markMapRenderReadinessFailure(renderError);
        }).catch((e) => {
          console.error("captureMapImage render readiness error:", e);
          reject(e);
        });
      } catch (e) {
        console.error("captureMapImage error:", e);
        reject(markMapRenderReadinessFailure(e));
      }
    });
  };

  // Expose for tests
  UA._detachUncapturableMarkers = detachUncapturableMarkers;

  /**
   * Capture the current map view styled for export: high-contrast accident
   * points overlay (severity-coloured, white border) on top of a dimmed
   * heatmap. This is what the Tasks call for: locations dominate, density
   * stays as supporting context (Tasks 1, 5, 7).
   *
   * The wrapper is symmetric – `endExportMapMode` always runs, even on
   * capture errors – so the live map state is restored unconditionally.
   *
   * @param {Object} ctx
   * @param {Object} [options]
   * @returns {Promise<string>} Base64 PNG data URL
   */
  UA.captureExportMapImage = async function captureExportMapImage(ctx, options = {}) {
    let token = null;
    try {
      if (typeof UA.beginExportMapMode === "function") {
        // Allow callers (e.g. cluster maps) to restrict the severity overlay
        // to a specific subset of points so the visible markers exactly match
        // the table count below the map (Tasks 4, 5, 6).
        const beginOpts = Array.isArray(options.exportPoints)
          ? {
              points: options.exportPoints,
              rebuildHeat: ctx.documentRasterAvailable !== undefined && options.heatmapExportOpacity !== 0
            }
          : undefined;
        token = UA.beginExportMapMode(ctx, beginOpts);
      }
      // A short wait gives Leaflet a tick to lay out the overlay layer
      // before leaflet-image walks the layer list.
      await new Promise(r => setTimeout(r, 50));
      // leaflet-image ignores the canvas CSS opacity that beginExportMapMode
      // sets, so we additionally clamp the baked heatmap opacity used by
      // captureMapImage to the same ≤0.35 ceiling. Cloned to avoid mutating
      // the caller's options object.
      const exportOptions = { ...options };
      const HEAT_EXPORT_CEILING = 0.35;
      if (typeof exportOptions.heatmapExportOpacity === "number"
          && Number.isFinite(exportOptions.heatmapExportOpacity)) {
        exportOptions.heatmapExportOpacity = Math.min(
          exportOptions.heatmapExportOpacity, HEAT_EXPORT_CEILING);
      } else {
        exportOptions.heatmapExportOpacity = HEAT_EXPORT_CEILING;
      }
      return await UA.captureMapImage(ctx, exportOptions);
    } finally {
      if (typeof UA.endExportMapMode === "function") {
        try { UA.endExportMapMode(ctx, token); } catch { /* swallow */ }
      }
    }
  };

  // A document has its own map so live markers, heat, and viewport updates
  // cannot change the population or the position of an exported figure.
  UA.createDocumentMapContext = function createDocumentMapContext(ctx) {
    const L = window.L;
    const live = ctx.map;
    const doc = window.document;
    if (ctx.documentRasterAvailable !== undefined || !L?.Map || !(live instanceof L.Map) || !doc?.body) {
      return { ctx, close() {} };
    }
    const container = doc.createElement("div");
    container.setAttribute("aria-hidden", "true");
    container.style.cssText = "position:fixed;left:-2000px;top:0;width:1050px;height:650px;pointer-events:none";
    doc.body.appendChild(container);
    let map;
    try {
      const state = ctx.baseMapState;
      const layers = state ? [state.standardLayer, state.orthophotoLayer, state.labelLayer] : [];
      if (!state) live.eachLayer(layer => layers.push(layer));
      const raster = layers.filter(layer => layer instanceof L.TileLayer && live.hasLayer(layer) && layer.options.opacity !== 0);
      // leaflet-image expects the tile and map zooms to match. Leaflet's live
      // view can scale the last native tiles at higher zooms.
      const maxZoom = Math.min(live.getMaxZoom(), ...raster.map(layer => layer.options.maxNativeZoom ?? layer.options.maxZoom ?? 19), 22);
      const renderer = L.canvas();
      const redraw = renderer._redraw;
      renderer._redraw = function () {
        // A zoom change can leave a queued draw after Leaflet removes the canvas.
        if (this._ctx) redraw.call(this);
      };
      map = L.map(container, {
        renderer, maxZoom, zoomControl: false, attributionControl: false,
        zoomAnimation: false, fadeAnimation: false, crs: live.options.crs
      }).setView(live.getCenter(), Math.min(live.getZoom(), maxZoom));
      for (const layer of raster) {
        const options = { ...layer.options };
        const clone = layer instanceof L.TileLayer.WMS
          ? L.tileLayer.wms(layer._url, { ...options, ...layer.wmsParams })
          : L.tileLayer(layer._url, options);
        clone.addTo(map);
      }
      return {
        ctx: { ...ctx, map, heatLayer: null, contextOverlays: null, documentRasterAvailable: raster.length > 0 },
        close() {
          try { map.remove(); } finally { container.remove(); }
        }
      };
    } catch (error) {
      try { map?.remove(); } finally { container.remove(); }
      throw error;
    }
  };

  function drawSchematicMap(ctx, points, bounds) {
    const map = ctx.map;
    const size = map.getSize();
    const canvas = window.document.createElement("canvas");
    canvas.width = size.x;
    canvas.height = size.y;
    const drawing = canvas.getContext("2d");
    drawing.fillStyle = "#f8fafc";
    drawing.fillRect(0, 0, size.x, size.y);
    drawing.strokeStyle = "#e2e8f0";
    drawing.beginPath();
    for (let x = 0; x < size.x; x += 50) { drawing.moveTo(x, 0); drawing.lineTo(x, size.y); }
    for (let y = 0; y < size.y; y += 50) { drawing.moveTo(0, y); drawing.lineTo(size.x, y); }
    drawing.stroke();
    if (bounds) {
      const nw = map.latLngToContainerPoint([bounds.north, bounds.west]);
      const se = map.latLngToContainerPoint([bounds.south, bounds.east]);
      drawing.strokeStyle = "#2563eb";
      drawing.lineWidth = 2;
      drawing.strokeRect(nw.x, nw.y, se.x - nw.x, se.y - nw.y);
    }
    for (const p of points) {
      const { x, y } = map.latLngToContainerPoint([p.lat, p.lon]);
      drawing.beginPath();
      drawing.arc(x, y, 6, 0, Math.PI * 2);
      drawing.fillStyle = UA.SEVERITY_COLORS?.[p.props?.ukategorie] || "#64748b";
      drawing.strokeStyle = "#fff";
      drawing.lineWidth = 2;
      drawing.fill();
      drawing.stroke();
    }
    drawing.fillStyle = "#0f172a";
    drawing.font = "bold 17px sans-serif";
    drawing.fillText("Schematische Unfallkarte ohne Basiskarte", 14, 24);
    if (bounds) {
      drawing.font = "15px sans-serif";
      drawing.fillText(
        `WGS 84   SW ${bounds.south.toFixed(6)}, ${bounds.west.toFixed(6)}   NO ${bounds.north.toFixed(6)}, ${bounds.east.toFixed(6)}`,
        14, size.y - 14
      );
    }
    drawing.font = "bold 17px sans-serif";
    drawing.textAlign = "right";
    drawing.fillText("N ↑", size.x - 14, 24);
    return canvas.toDataURL("image/png");
  }

  UA.captureDocumentMap = async function captureDocumentMap(ctx, options = {}) {
    const { map } = ctx;
    const bounds = options.exportBounds;
    const isolated = ctx.documentRasterAvailable !== undefined;
    const frame = isolated && bounds ? window.L.rectangle(
      [[bounds.south, bounds.west], [bounds.north, bounds.east]],
      { color: "#2563eb", weight: 2, fill: false, interactive: false }
    ).addTo(map) : null;
    let image;
    let schematic = false;
    try {
      if (ctx.documentRasterAvailable !== false) {
        try {
          image = await UA.captureExportMapImage(ctx, options);
        } catch (error) {
          if (!isolated) throw error;
          console.warn("Rasterkartenaufnahme fehlgeschlagen; schematische Karte wird erzeugt:", error);
          // The remaining figures use the same unavailable raster provider.
          ctx.documentRasterAvailable = false;
        }
      }
      if (!image) {
        image = drawSchematicMap(ctx, options.exportPoints || [], bounds);
        schematic = true;
      }
      if (options.evidenceRows?.length) {
        image = await UA.EvidenceCohort.annotateMapImage(window, ctx, image, options.evidenceRows);
      }
      const center = map.getCenter?.();
      return { image, schematic, center: center && { lat: center.lat, lon: center.lng }, zoom: map.getZoom?.() };
    } finally {
      frame?.remove();
    }
  };

  function fitDocumentMap(ctx, bounds, { padding = 30, maxZoom } = {}) {
    if (!bounds || typeof ctx.map.fitBounds !== "function") return;
    ctx.map.fitBounds([[bounds.south, bounds.west], [bounds.north, bounds.east]], {
      animate: false, padding: [padding, padding], maxZoom
    });
  }

  // =====================================================================
  // Word Document Export (using docx.js)
  // =====================================================================

  // Shared helper: map OSM POI type key to German label
  const POI_TYPE_LABELS = { school: "Schulen", kindergarten: "Kindergärten", childcare: "Kitas" };
  function poiTypeLabel(type) {
    return POI_TYPE_LABELS[type] || type;
  }

  /**
   * Capture a detail map fitted to its own bounds.
   * Temporarily calls fitBounds (with animation disabled), waits for re-render,
   * captures, then restores the original view.
   * Throws if the map or usable bounds are missing; capture errors propagate
   * to the caller, which is responsible for graceful fallback.
   * @param {Object} ctx - Application context
   * @param {Object} options - Export options
   * @returns {Promise<Object>} Image data and map position
   */
  async function captureDetailMap(ctx, options) {
    const bounds = options?.exportBounds || boundsToBbox(ctx.selectionBounds);
    if (!ctx.map || !bounds) {
      throw new Error("No map or bounds available for detail capture");
    }

    // Save current map state
    const origCenter = ctx.map.getCenter();
    const origZoom = ctx.map.getZoom();

    try {
      fitDocumentMap(ctx, bounds);
      return await UA.captureDocumentMap(ctx, { ...options, exportBounds: bounds });
    } finally {
      // Always restore original map state
      try {
        ctx.map.setView(origCenter, origZoom, { animate: false });
      } catch (restoreErr) {
        console.warn("Failed to restore map view after detail capture:", restoreErr);
      }
    }
  }

  /**
   * Capture additional zoom-in maps for the dominant accident clusters
   * (Tasks 2, 3, 4). Centers each capture on the actual coordinate centroid
   * of the cluster (not on selectionBounds), at a zoom level chosen by
   * point density. Returns at most `opts.maxTargets` captures (default 2).
   *
   * Each returned entry: { label, image, total, lat, lon, zoom }.
   * Failures for individual targets are logged and skipped – we never let a
   * single cluster capture break the export pipeline.
   *
   * @param {Object} ctx
   * @param {Object} options
   * @param {Object} [opts]
   * @returns {Promise<Array<{label:string,image:string,total:number,lat:number,lon:number,zoom:number}>>}
   */
  async function captureClusterMaps(ctx, options, opts) {
    if (!ctx || !ctx.map) return [];
    if (typeof UA.computeClusterMapTargets !== "function") return [];
    let points = Array.isArray(options?.exportPoints) ? options.exportPoints
      : ((ctx.viewportPts && ctx.viewportPts.length) ? ctx.viewportPts : (ctx.allPts || []));

    // When the user has drawn a selection rectangle, restrict the cluster
    // analysis to points inside that rectangle. Without this filter,
    // computeClusterMapTargets could pick hotspots from a different part of
    // the viewport that are completely unrelated to the marked area.
    if (!Array.isArray(options?.exportPoints) && ctx.selectionBounds && typeof ctx.selectionBounds.contains === "function") {
      points = points.filter(p =>
        Number.isFinite(p?.lat) && Number.isFinite(p?.lon) &&
        ctx.selectionBounds.contains([p.lat, p.lon])
      );
    }

    const targets = UA.computeClusterMapTargets(points, opts);
    if (!targets.length) return [];

    const origCenter = ctx.map.getCenter();
    const origZoom = ctx.map.getZoom();
    const out = [];
    try {
      for (const t of targets) {
        try {
          if (t.bounds && typeof ctx.map.fitBounds === "function") {
            fitDocumentMap(ctx, t.bounds, { maxZoom: t.zoom });
          } else {
            ctx.map.setView([t.lat, t.lon], t.zoom, { animate: false });
          }
          const members = Array.isArray(t.points) ? t.points : [];
          const capture = await UA.captureDocumentMap(ctx, { ...options, exportPoints: members, exportBounds: t.bounds });
          out.push({
            ...capture,
            label: t.label,
            total: t.total,
            lat: t.lat,
            lon: t.lon,
            bounds: t.bounds || null,
            points: members
          });
        } catch (err) {
          if (isMapRenderReadinessFailure(err)) throw err;
          console.warn("Cluster map capture failed for target (graceful fallback):", t, err);
        }
      }
    } finally {
      try {
        ctx.map.setView(origCenter, origZoom, { animate: false });
      } catch (restoreErr) {
        console.warn("Failed to restore map view after cluster capture:", restoreErr);
      }
    }
    return out;
  }
  // Exported for tests; the public name stays inside the IIFE.
  UA._captureClusterMaps = captureClusterMaps;
  UA._captureDetailMap = captureDetailMap;

  /**
   * Build the German verification sentence required below every exported map
   * (Task 6). The exact wording is mandated by the Werkbank export spec.
   * @param {number} n
   * @returns {string}
   */
  function mapVerificationSentence(n) {
    const safe = Number.isFinite(Number(n)) ? Math.max(0, Math.trunc(Number(n))) : 0;
    return `Die dargestellten Punkte entsprechen exakt den in der Tabelle aufgeführten Unfällen (n = ${safe}).`;
  }
  UA.mapVerificationSentence = mapVerificationSentence;

  function reportMapCount(n, cohorts) {
    return cohorts?.completeEvidenceCohort?.rows?.length
      ? `Dargestellte Unfälle unter aktiven Filtern (n = ${n}).`
      : mapVerificationSentence(n);
  }

  function buildMapSourceNoteLines(ctx, capture) {
    if (capture?.schematic) {
      return ["Schematische Unfallkarte ohne Basiskarte. Der Kartenhintergrund war für diese Aufnahme nicht verfügbar."];
    }
    const info = (typeof UA.getActiveMapLayerInfo === 'function')
      ? UA.getActiveMapLayerInfo(ctx)
      : null;
    if (!info) return [];
    const activeModeLabel = info.modeLabel || 'Standardkarte';
    const requestedModeLabel = info.requestedModeLabel || activeModeLabel;
    const requestedDiffers = !!(info.requestedMode && info.mode && info.requestedMode !== info.mode);
    const lines = [requestedDiffers
      ? `Kartenmodus: ${activeModeLabel} (angefordert: ${requestedModeLabel}).`
      : `Kartenmodus: ${activeModeLabel}.`];
    const mapSourceMode = (typeof document !== 'undefined' && document.documentElement)
      ? document.documentElement.dataset.mapSourceMode
      : null;
    if (mapSourceMode === 'fixture') {
      lines.push('Kartenhintergrund: synthetische QA-Kartenfixture – keine reale Basiskarte oder Luftbildaufnahme.');
      if (info.warning) lines.push(info.warning);
      return lines;
    }
    if (info.orthophoto) {
      lines.push(`Orthofoto: ${info.orthophoto.displayName} (${info.orthophoto.provider}).`);
      if (info.orthophotoFallbackFrom) {
        lines.push(`Fallback verwendet: ${info.orthophoto.displayName} statt ${info.orthophotoFallbackFrom.displayName}.`);
      }
      const sourceBits = [info.orthophoto.attribution, info.orthophoto.license].filter(Boolean);
      if (sourceBits.length) {
        lines.push(`Quelle/Lizenz: ${sourceBits.join(' | ')}.`);
      }
      lines.push('Sichtbarer Hinweis: Orthofoto/Luftbild zeigt lediglich visuellen Kontext; möglicherweise relevant, aber nicht als amtliche Unfallursache belegt.');
      lines.push('Empfehlung: Detailprüfung empfohlen (prüfbedürftig, Vor-Ort-Begehung durch Fachstelle).');
      if (info.orthophoto.officialForExport === false) {
        lines.push('Hinweis: Nicht-amtliche Hintergrundkarte – nur zur Vorschau, nicht für amtliche Berichte geeignet.');
      }
    } else {
      lines.push('Basiskarte: OpenStreetMap.');
      if (requestedDiffers) {
        lines.push('Fallback verwendet: Standardkarte (OpenStreetMap).');
      }
    }
    if (info.warning) lines.push(info.warning);
    return lines;
  }
  UA._buildMapSourceNoteLines = buildMapSourceNoteLines;

  function pushDocxMapSourceNote(children, ctx, spacingAfter = 200, capture) {
    const text = buildMapSourceNoteLines(ctx, capture).join(' ');
    if (!text) return;
    const ParagraphCtor = (typeof window !== 'undefined' && window.docx && window.docx.Paragraph)
      ? window.docx.Paragraph
      : null;
    if (typeof ParagraphCtor !== 'function') return;
    children.push(new ParagraphCtor({
      text,
      italics: true,
      spacing: { after: spacingAfter }
    }));
  }

  function pushPdfMapSourceNote(docDefinition, ctx, marginBottom = 8, capture) {
    const text = buildMapSourceNoteLines(ctx, capture).join(' ');
    if (!text) return;
    docDefinition.content.push({
      text,
      style: 'small',
      italics: true,
      margin: [0, 0, 0, marginBottom]
    });
  }

  /**
   * Total number of involvement participant categories (Rad, Fuss, PKW,
   * Krad, Lkw, Sonst). Used to detect "alle Kombinationen" vs. echte
   * Auswahl-Restriktion.
   */
  const INVOLVEMENT_CATEGORY_COUNT = 6;

  /**
   * Inspects the active filters object (sd.meta.filters) and derives the
   * currently selected involvement participant codes plus a Prosa-Label
   * ("Rad + PKW") and a `hasRestriction` flag.
   *
   * - `hasRestriction` is true exactly when the user has narrowed the
   *   involvement filter to a non-empty proper subset of the 6 known
   *   categories (i.e. 1..5 of them are selected). When all six (or none)
   *   are selected we treat the involvement axis as unrestricted, so no
   *   separate Auswahl-Karte is rendered.
   * - `prose` falls back to a simple `Code1 + Code2` join if the central
   *   formatter is unavailable (e.g. unit tests that only load the
   *   report module).
   *
   * @param {object} filters Plain `meta.filters` object as built by
   *   computeExportReport.
   * @returns {{codes:string[], hasRestriction:boolean, prose:string}}
   */
  function activeInvolvementSelection(filters) {
    const codes = [];
    if (filters && filters.includeCyclist)    codes.push("Rad");
    if (filters && filters.includePedestrian) codes.push("Fuss");
    if (filters && filters.includeCar)        codes.push("PKW");
    if (filters && filters.includeMotorcycle) codes.push("Krad");
    if (filters && filters.includeGkfz)       codes.push("Lkw");
    if (filters && filters.includeSonstig)    codes.push("Sonst");
    const hasRestriction = codes.length > 0 && (
      codes.length < INVOLVEMENT_CATEGORY_COUNT || ["and", "solo"].includes(filters?.involvementMode)
    );
    const mode = filters?.involvementMode;
    const labels = codes.map(code => typeof UA.formatParticipantCombinationForExport === "function"
      ? UA.formatParticipantCombinationForExport([code]) : code);
    const prose = labels.join(mode === "or" ? " oder " : " + ");
    return { codes, hasRestriction, prose };
  }
  UA._activeInvolvementSelection = activeInvolvementSelection;

  /**
   * Sentence that explicitly names the active involvement selection on
   * an Auswahl-Karte ("Nur Unfälle mit Beteiligung ‹Rad + PKW›
   * dargestellt."). Returned verbatim so the same wording can be reused
   * across DOCX/PDF and asserted from tests.
   *
   * @param {string} prose Prosa-Label, e.g. "Radverkehr + PKW".
   * @returns {string}
   */
  function selectionHintSentence(prose) {
    const safe = (typeof prose === "string" && prose.trim()) ? prose.trim() : "";
    return `Nur Unfälle mit Beteiligung \u2039${safe}\u203A dargestellt.`;
  }
  UA._selectionHintSentence = selectionHintSentence;

  /**
   * Builds the overview-map point set for the new "Übersichtskarte – alle
   * Beteiligungs-Kombinationen". Mirrors `getPointsInBounds` from
   * js/ua.export_v2.js: applies non-involvement filters and the export
   * bbox, but **bypasses** the involvement filter so every accident in
   * the bounded area is shown — independent of the user's
   * Beteiligungs-Auswahl.
   *
   * Returns an empty array if `ctx.allPts` is missing or no usable
   * bounds can be derived (defensive: callers gracefully skip the extra
   * map in that case).
   *
   * @param {object} ctx
   * @returns {Array}
   */
  function getAllCombinationPointsInBounds(ctx, bbox = exportBoundsFromCtx(ctx)) {
    const source = UA.EvidenceCohort?.rootContext?.(ctx) || ctx?.__analysisScopeOriginalCtx || ctx;
    if (!Array.isArray(source?.allPts)) return [];
    // Defensive: an unbounded "alle Kombinationen"-Karte würde quer über
    // die Stadt streuen und dem Lesegremium falsche Maßstäbe vermitteln;
    // ohne nutzbare Export-Bounds liefern wir lieber gar nichts und der
    // Aufrufer überspringt die Karte (try/catch um den Capture-Block).
    if (!bbox) return [];
    const out = [];
    for (const p of source.allPts) {
      if (!p || !p.props) continue;
      if (typeof UA.matchesNonInvolvementFilters === "function"
          && !UA.matchesNonInvolvementFilters(ctx, p.props)) continue;
      if (typeof UA.maskFromProps === "function"
          && UA.maskFromProps(p.props) === 0) continue;
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
      if (p.lat < bbox.south || p.lat > bbox.north
          || p.lon < bbox.west || p.lon > bbox.east) continue;
      out.push(p);
    }
    return out;
  }
  UA._getAllCombinationPointsInBounds = getAllCombinationPointsInBounds;

  function reportMapPlan(ctx, filters) {
    const bounds = boundsToBbox(ctx.exportSourceManifest?.scenario?.bounds) || exportBoundsFromCtx(ctx);
    const selection = activeInvolvementSelection({ involvementMode: ctx.involvementMode, ...filters });
    let selected = ctx.selectionBounds && Array.isArray(ctx.selectionPts) ? ctx.selectionPts
      : (ctx.visibleViewportPts || ctx.filteredAll || ctx.viewportPts || []);
    if (ctx.exportSourceManifest && Array.isArray(ctx.allPts)) {
      selected = ctx.allPts.filter(p => typeof UA.matchesInvolvementFilter !== "function"
        || UA.matchesInvolvementFilter(ctx, UA.maskFromProps(p.props)));
    }
    const points = selected.filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon)
      && (!bounds || (p.lat >= bounds.south && p.lat <= bounds.north && p.lon >= bounds.west && p.lon <= bounds.east)));
    return {
      bounds,
      selection,
      points,
      allPoints: selection.hasRestriction ? getAllCombinationPointsInBounds(ctx, bounds) : null
    };
  }

  function reportDiscoveryFocus(plan, structured) {
    const discovery = UA.SiteDiscovery;
    const candidate = structured && Object.prototype.hasOwnProperty.call(structured, "discoveryFocus")
      ? structured.discoveryFocus
      : discovery?.patternForPoints?.(plan.points);
    if (!candidate?.label || !Array.isArray(candidate.points)) return null;

    // Document provenance can project the point objects after the report data
    // was computed. Match published cases, then use the frozen map points.
    const fingerprint = UA.EvidenceCohort?.fingerprintForPoint;
    const identity = point => fingerprint ? fingerprint(UA, point) : point;
    const members = new Set(candidate.points.map(identity));
    const latest = new Set((candidate.recentPoints || []).map(identity));
    const points = plan.points.filter(point => members.has(identity(point)));
    if (!points.length) return null;

    const recentCount = points.filter(point => latest.has(identity(point))).length;
    const recentText = recentCount && Number.isInteger(candidate.recentYear)
      ? `Im jüngsten Musterjahr ${candidate.recentYear} ${recentCount === 1 ? "wurde 1 Unfall" : `wurden ${recentCount} Unfälle`} dieses Musters erfasst.`
      : "";
    // A context margin preserves the connecting streets around the pattern.
    // A focus with the same cases as the overview needs no separate image.
    const bounds = points.length < plan.points.length
      ? discovery?.boundsForPoints?.(points, { paddingMeters: 28 })
      : null;
    const assignedOnly = candidate.site && !candidate.key;
    return {
      key: candidate.key, query: candidate.query, site: candidate.site, label: candidate.label, points, recentText, bounds,
      title: assignedOnly ? "Zugeordnete Unfälle im Detail" : "Unfallmuster im Detail",
      mapLabel: assignedOnly ? "Netzobjektkarte" : "Musterkarte",
      legend: assignedOnly ? "Die Punkte sind dem Netzobjekt räumlich zugeordnet. Die Fahrbeziehungen bleiben offen." : FOCUS_MAP_LEGEND,
      summary: (assignedOnly ? candidate.label : "Unfallmuster im Auswertungsgebiet – " + candidate.label) + " (n = " + points.length + ").",
    };
  }

  function focusCaption(figure, focus, overviewN, overviewIndex) {
    const n = focus.points.length;
    const subset = n === 1 ? `Der dargestellte Unfall gehört zu den ${overviewN} Unfällen`
      : `Die ${n} dargestellten Unfälle sind eine Teilmenge der ${overviewN} Unfälle`;
    return `${figure.caption} ${subset} aus Abbildung ${overviewIndex}.`;
  }

  function focusCriteria(query) {
    if (!query) return "";
    const { fromYear, toYear, severity, type, involvement } = query;
    const criteria = [];
    if (fromYear && toYear) criteria.push(fromYear === toYear ? String(fromYear) : `${fromYear}–${toYear}`);
    else if (fromYear) criteria.push(`ab ${fromYear}`);
    else if (toYear) criteria.push(`bis ${toYear}`);
    const severityLabels = { serious: "getötet oder schwer verletzt", 1: "getötet", 2: "schwer verletzt", 3: "leicht verletzt" };
    if (severityLabels[severity]) criteria.push(severityLabels[severity]);
    if (type && type !== "all") criteria.push(type === "turning" ? "Unfalltypen 2/3" : `Unfalltyp ${type}`);
    const modeLabels = { "bike-foot": "Rad- oder Fußbeteiligung", bike: "Radbeteiligung", foot: "Fußbeteiligung", car: "Pkw-Beteiligung", heavy: "Güter-Kfz-Beteiligung" };
    if (modeLabels[involvement]) criteria.push(modeLabels[involvement]);
    return criteria.length ? `Suchkriterien der Musterkarte – ${criteria.join(", ")}.` : "";
  }

  function sourceDate(date) {
    return String(date || "").replace(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/, (_date, year, month, day) =>
      day ? `${day}.${month}.${year}` : `${month}/${year}`);
  }

  function reportSiteChanges(structured) {
    return (structured?.siteChanges || []).filter(change => change?.label && change.date).map(change => {
      const date = sourceDate(change.date);
      const when = change.precision === "documented-by" ? `spätestens am ${date} dokumentiert`
        : change.precision === "month" ? `Beginn im ${date}` : `Quellenstand ${date}`;
      return { text: `${change.label} – ${when}.`, href: reportLink(change.url) };
    });
  }

  const SITE_CHANGE_LIMIT = "Für einen belastbaren Vorher-Nachher-Vergleich fehlen hinreichend gesicherte und vergleichbare Zeitangaben.";
  const FOCUS_MAP_LEGEND = "Der Rahmen markiert den Bereich der Musterkarte. Die Punkte zeigen veröffentlichte Unfallorte. Die Fahrtrichtungen bleiben offen.";

  function reportNetworkSite(ctx, structured) {
    const finding = structured?.siteNetwork;
    if (!finding || !UA.ReviewNetwork?.findingLines) return null;
    const sources = [finding.source, finding.boundarySource].filter(Boolean).map(source => ({
      text: [source.label, sourceDate(source.date)].filter(Boolean).join(" · "),
      href: reportLink(source.url),
    }));
    const link = finding.status === "available" ? buildWerkbankUrl(ctx, {
      bounds: finding.bounds,
      discoveryFocus: { site: finding.site, key: structured.discoveryFocus?.key, query: finding.query },
    }) : null;
    return { lines: UA.ReviewNetwork.findingLines(finding), sources, link };
  }

  function reportFacilities(poi) {
    return (poi?.facilities || []).filter(facility => facility?.name && facility.relation).slice(0, 5).map(facility => {
      const sources = [facility.source, facility.locationSource, ...(facility.planSources || [])].filter(source => source?.label);
      const unique = new Map(sources.map(source => [source.url || source.label, source]));
      return {
        text: `${facility.name} – ${facility.relation}`,
        detail: facility.reason,
        sources: [...unique.values()].map(source => ({
          text: source.date ? `${source.label} (Stand ${sourceDate(source.date)})` : source.label,
          href: reportLink(source.url)
        }))
      };
    });
  }

  /**
   * Count points whose coordinates fall inside a {south,west,north,east}
   * bounding box. Used for Task 5 (cross-check map ↔ table count) and to
   * compute n for the verification sentence (Task 6).
   * @param {Array<{lat:number,lon:number}>} points
   * @param {{south:number,west:number,north:number,east:number}|null|undefined} bounds
   * @returns {number}
   */
  function countPointsInBounds(points, bounds) {
    if (!Array.isArray(points) || !bounds) return 0;
    const { south, west, north, east } = bounds;
    if (![south, west, north, east].every(Number.isFinite)) return 0;
    let n = 0;
    for (const p of points) {
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
      if (p.lat >= south && p.lat <= north && p.lon >= west && p.lon <= east) n++;
    }
    return n;
  }
  UA._countPointsInBounds = countPointsInBounds;

  /**
   * Derive a {south,west,north,east} bbox from the export-relevant area on
   * `ctx`. Mirrors `boundsForExport` in js/ua.export_v2.js (selectionBounds
   * wins, otherwise the current map viewport). Returns null if no usable
   * bounds are available — in that case the consistency check below short-
   * circuits as success.
   */
  function exportBoundsFromCtx(ctx) {
    if (!ctx) return null;
    return boundsToBbox(ctx.selectionBounds || ctx.map?.getBounds?.());
  }
  UA._exportBoundsFromCtx = exportBoundsFromCtx;

  /**
   * Pre-Flight-Konsistenz-Gate für PDF/DOCX-Export (Phase 2.2 des Sanierungs-
   * plans). Stellt die Invariante sicher:
   *
   *   accidentDetails.total ≤ structured.totalAccidents
   *   countPointsInBounds(ctx.viewportPts, exportBbox) === structured.totalAccidents
   *
   * Hintergrund: Der Render-Gate für Cluster-Karten (Task 5) prüft nur
   * einzelne Bounding-Boxen. Eine globale Inkonsistenz – etwa wenn das
   * Tabellen-Modell mehr Punkte führt, als auf den Karten tatsächlich
   * gerendert werden – würde dort durchrutschen und Vertrauen brechen
   * („Bericht behauptet 262, Karte zeigt 250").
   *
   * Bei Mismatch liefert die Funktion `{ ok: false, ... }` mit einer
   * deutschen Fehlermeldung im exakt vom Plan vorgeschriebenen Wortlaut
   * („Export abgebrochen: Tabelle (n=X) und Karte (n=Y) inkonsistent.").
   * Aufrufer (Export-Handler) brechen den Export daraufhin ab und zeigen
   * die Meldung im Modal-Banner (#exportProgress).
   *
   * Defensiv: fehlende/unvollständige Eingaben → ok:true (kein false-positive
   * Abbruch in Tests oder bei sehr kleinen Datensätzen ohne Bounds).
   *
   * @param {Object} ctx        Application context (uses ctx.viewportPts und
   *                            ctx.selectionBounds / ctx.map).
   * @param {Object} structured Output von UA.computeExportReport(...).structured
   * @returns {{ok:boolean, message?:string, nTable?:number, nMap?:number, kind?:string}}
   */
  function validateExportConsistency(ctx, structured) {
    if (!structured || typeof structured !== "object") return { ok: true };

    // Kanonische Fallzahl: bevorzugt structured.totalAccidents (Phase-2.2-
    // Erweiterung), Fallback severity.total für Alt-Reports/Tests.
    let totalAccidents = null;
    if (Number.isFinite(structured.totalAccidents)) {
      totalAccidents = structured.totalAccidents;
    } else if (structured.severity && Number.isFinite(structured.severity.total)) {
      totalAccidents = structured.severity.total;
    }
    if (totalAccidents === null) return { ok: true };

    // Invariante 1: Detail-Tabelle darf nie mehr Zeilen führen als die
    // Gesamt-Fallzahl behauptet (mask-0-Punkte werden in accidentDetails
    // ausgefiltert, sind aber in severity.total mitgezählt → ≤, nicht ===).
    const ad = structured.accidentDetails;
    const adTotal = (ad && Number.isFinite(ad.total)) ? ad.total : null;
    if (adTotal !== null && adTotal > totalAccidents) {
      return {
        ok: false,
        kind: "table_exceeds_total",
        nTable: adTotal,
        nMap: totalAccidents,
        message: `Export abgebrochen: Tabelle (n=${adTotal}) und Karte (n=${totalAccidents}) inkonsistent.`
      };
    }

    // Invariante 2: Die Punkte, die der Export auf der Übersichtskarte
    // rendert (= ctx.viewportPts innerhalb der Export-Bounds), müssen mit
    // den Zeilen der Einzelunfall-Tabelle (= structured.accidentDetails)
    // übereinstimmen. Beide Datenquellen sind beteiligungsgefiltert
    // (mask>0 + Involvement-Filter), während structured.totalAccidents
    // alle non-involvement-gefilterten Punkte (inkl. mask=0) zählt — ein
    // direkter Vergleich gegen totalAccidents erzeugte bei realen Daten
    // immer einen False-Positive (siehe Sanierungsplan Phase 2.2).
    // Fallback auf totalAccidents nur, wenn accidentDetails fehlt
    // (Alt-Reports/Tests ohne Detail-Tabelle).
    const ad2 = structured.accidentDetails;
    const ad2Total = (ad2 && Number.isFinite(ad2.total)) ? ad2.total : null;
    const tableN = (ad2Total !== null) ? ad2Total : totalAccidents;
    const bbox = exportBoundsFromCtx(ctx);
    const pts = (ctx && Array.isArray(ctx.viewportPts)) ? ctx.viewportPts : null;
    if (bbox && pts) {
      const nMap = countPointsInBounds(pts, bbox);
      if (nMap !== tableN) {
        return {
          ok: false,
          kind: "table_map_mismatch",
          nTable: tableN,
          nMap,
          message: `Export abgebrochen: Tabelle (n=${tableN}) und Karte (n=${nMap}) inkonsistent.`
        };
      }
    }

    // Invariante 3 (PR 2 / Spec-Item 5 — cluster-subset): Jede Cluster-/
    // Gruppen-Zählung in accidentDetails.groups ist eine Teilmenge der
    // Gesamtfallzahl im Ausschnitt. Eine Gruppe darf NIE größer sein als
    // die Gesamtmenge der sie enthaltenden Tabelle. Außerdem darf die
    // Summe mehrerer Cluster (z. B. mainCluster + secondaryCluster) NICHT
    // automatisch mit der Gesamtsumme gleichgesetzt werden — Cluster
    // können sich nicht überlappen, müssen aber auch nicht erschöpfend
    // sein. Dieser Check fängt verfälschte Cluster-Counts ab, bevor sie
    // im PDF/DOCX als „n=X" gerendert und in den Verifikationssatz
    // übernommen werden.
    if (ad2 && Array.isArray(ad2.groups) && Number.isFinite(tableN)) {
      for (const g of ad2.groups) {
        if (!g || !Number.isFinite(g.count)) continue;
        if (g.count > tableN) {
          const label = g.sevLabel || g.key || "(unbenannt)";
          return {
            ok: false,
            kind: "cluster_exceeds_total",
            nCluster: g.count,
            nTable: tableN,
            clusterLabel: label,
            message: `Export abgebrochen: Cluster „${label}" (n=${g.count}) ist größer als die Tabellen-Gesamtsumme (n=${tableN}).`
          };
        }
      }
    }

    return { ok: true };
  }
  UA.validateExportConsistency = validateExportConsistency;

  // ---------------------------------------------------------------------
  // QA-PR „Export-Semantik vor Layout" — Export-QA-Gate
  //
  // Prüft den `pdfMake`-`docDefinition.content`-Baum (oder den DOCX-
  // Children-Baum) auf verbotene Tokens, bevor die Datei erzeugt wird:
  //   - Beteiligten-Emojis  (🚲/🚗/🚶/🚌/🏍/🚛)
  //   - FontAwesome / Private-Use-Codepoints  (U+E000…U+F8FF)
  //   - „Fetch is aborted" / „Beteiligungsmaske" / isoliertes „Scope"
  //   - „undefined" / „null" als sichtbarer Zellinhalt
  //   - „+ :" oder „+:"-Kombinationen ohne Textlabel (das frühere
  //     QA-Symptom „Symbol-Wüste" in den Kreuztabellen).
  //
  // Liefert `{ ok:true }` oder `{ ok:false, violations: [...] }`. Caller
  // (in `exportToPDF`) wirft auf Verletzung mit lesbarer Meldung, damit
  // der Export NICHT als „PR-reifes" PDF nach außen dringt.
  // ---------------------------------------------------------------------
  function _walkVisibleStrings(node, sink) {
    if (node == null) return;
    if (Array.isArray(node)) { for (const n of node) _walkVisibleStrings(n, sink); return; }
    if (typeof node === "string") { sink(node); return; }
    if (typeof node !== "object") return;
    if (typeof node.text === "string") sink(node.text);
    else if (Array.isArray(node.text)) _walkVisibleStrings(node.text, sink);
    if (Array.isArray(node.stack))   _walkVisibleStrings(node.stack, sink);
    if (Array.isArray(node.columns)) _walkVisibleStrings(node.columns, sink);
    if (Array.isArray(node.ul))      _walkVisibleStrings(node.ul, sink);
    if (Array.isArray(node.ol))      _walkVisibleStrings(node.ol, sink);
    if (node.table && Array.isArray(node.table.body)) {
      for (const row of node.table.body) for (const cell of row) _walkVisibleStrings(cell, sink);
    }
  }

  // Forbidden glyphs: involvement emojis + FontAwesome/private-use range.
  const _QA_FORBIDDEN_GLYPH_RE =
    /(\u{1F6B2}|\u{1F6B6}|\u{1F697}|\u{1F3CD}\u{FE0F}?|\u{1F69B}|\u{1F68C}|[\uE000-\uF8FF])/u;
  // Forbidden technical words / phrases.
  const _QA_FORBIDDEN_PHRASES = [
    { re: /Fetch is aborted/i,                                  reason: 'Technische Fehlermeldung "Fetch is aborted" im Antrag.' },
    { re: /Beteiligungsmaske/,                                  reason: 'Technischer Begriff "Beteiligungsmaske" im sichtbaren Text.' },
    { re: /(?:^|[^A-Za-zÄÖÜäöüß])Scope(?:[^A-Za-zÄÖÜäöüß]|$)/,  reason: 'Entwicklerjargon "Scope" im sichtbaren Text.' },
    { re: /Vergleichs-Baseline/,                                reason: 'Entwicklerjargon "Vergleichs-Baseline" im sichtbaren Text.' },
    { re: /Aktiver Filter-Scope/,                               reason: 'Entwicklerjargon "Aktiver Filter-Scope" im sichtbaren Text.' },
    { re: /Muster-Analyse/,                                     reason: 'Entwicklerjargon "Muster-Analyse" im sichtbaren Text.' }
  ];
  // „+ :" / „+:" mit nur Symbolen drumherum (typisches QA-Symptom).
  const _QA_PLUS_COLON_RE = /\+\s*:/;

  /**
   * Run the export-content QA gate over the visible strings of a pdfMake
   * docDefinition.content tree (or any tree with the `text`/`stack`/
   * `columns`/`table.body` shape we use).
   *
   * @param {Array|object} contentRoot
   * @returns {{ok: true} | {ok: false, violations: Array<{kind:string,sample:string,reason:string}>}}
   */
  function runExportQAGate(contentRoot) {
    const violations = [];
    const seenSamples = new Set();
    const push = (kind, sample, reason) => {
      const key = kind + "|" + sample;
      if (seenSamples.has(key)) return;
      seenSamples.add(key);
      violations.push({ kind, sample, reason });
    };
    _walkVisibleStrings(contentRoot, (s) => {
      const str = String(s);
      if (!str) return;
      if (_QA_FORBIDDEN_GLYPH_RE.test(str)) {
        push("glyph", str.slice(0, 80), "Beteiligten-Symbol oder Private-Use-Glyph im sichtbaren Export.");
      }
      for (const { re, reason } of _QA_FORBIDDEN_PHRASES) {
        if (re.test(str)) push("phrase", str.slice(0, 120), reason);
      }
      // Standalone "undefined"/"null" cell content (whitespace tolerated).
      if (/^\s*(?:undefined|null)\s*$/.test(str)) {
        push("placeholder", str, 'Roher Platzhalter ("undefined"/"null") als Zellinhalt.');
      }
      // "+ :" / "+:" pattern (cross-table symbol-wüste).
      if (_QA_PLUS_COLON_RE.test(str)) {
        push("symbolOnly", str.slice(0, 80), 'Beteiligungs-Kombination ohne Textlabel ("+ :"-Muster).');
      }
    });
    if (violations.length === 0) return { ok: true };
    return { ok: false, violations };
  }
  UA.runExportQAGate = runExportQAGate;

  /**
   * Derive a {south,west,north,east} bbox from a Leaflet LatLngBounds object.
   * Tolerant of plain {south,west,north,east} objects (already serialised).
   * Returns null if no usable input.
   */
  function boundsToBbox(b) {
    if (!b) return null;
    if (typeof b.getSouth === "function") {
      b = {
        south: b.getSouth(), west: b.getWest(),
        north: b.getNorth(), east: b.getEast()
      };
    } else if (typeof b.getSouthWest === "function" && typeof b.getNorthEast === "function") {
      const sw = b.getSouthWest();
      const ne = b.getNorthEast();
      b = { south: sw?.lat, west: sw?.lng, north: ne?.lat, east: ne?.lng };
    }
    if (Number.isFinite(b.south) && Number.isFinite(b.west)
        && Number.isFinite(b.north) && Number.isFinite(b.east)) {
      return { south: b.south, west: b.west, north: b.north, east: b.east };
    }
    return null;
  }
  UA._boundsToBbox = boundsToBbox;

  /**
   * Derive a {south,west,north,east} bbox enclosing all supplied points.
   * Returns null if no valid coordinates are present.
   */
  function bboxFromPoints(points) {
    if (!Array.isArray(points) || !points.length) return null;
    let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
    let any = false;
    for (const p of points) {
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
      any = true;
      if (p.lat < south) south = p.lat;
      if (p.lat > north) north = p.lat;
      if (p.lon < west) west = p.lon;
      if (p.lon > east) east = p.lon;
    }
    return any ? { south, west, north, east } : null;
  }
  UA._bboxFromPoints = bboxFromPoints;

  /**
   * Derive a document title from the Gremium type string.
   * @param {string|undefined} gremiumTyp - Value of sd.meta.gremium.typ
   * @returns {string} German document title
   */
  function deriveDocTitle(gremiumTyp) {
    if (!gremiumTyp) return "Antrag zur Verkehrssicherheit";
    const t = gremiumTyp.trim();
    const normalized = t.replace(/\s*\([^)]*\)\s*$/, "");
    if (t === "Bezirksverordnetenversammlung" || t === "BVV" ||
        normalized === "Bezirksverordnetenversammlung" || normalized === "BVV") return "BVV-Antrag";
    if (t === "Bezirksrat" || normalized === "Bezirksrat") return "Bezirksratsantrag";
    if (normalized === "Stadtbezirksrat") return "Stadtbezirksratsantrag";
    if (t === "Bezirksvertretung" || normalized === "Bezirksvertretung") return "Antrag an die Bezirksvertretung";
    return "Antrag zur Verkehrssicherheit";
  }
  // Expose for use in other modules (e.g. ua.app_v2.js for dynamic modal title)
  UA.deriveDocTitle = deriveDocTitle;

  // --------------------
  // Trend-Qualifier (PR-β) und OSM-Voraussetzungen-Hinweis (PR-γ).
  // Identische Wortwahl wie in `js/ua.export_v2.js` (TEXT/HTML), damit
  // DOCX und PDF dieselben Antragstexte ausgeben.
  // --------------------
  function trendQualifierTextDocx(classification) {
    switch (classification) {
      case "steigend":     return "im Mittel der letzten Jahre steigend";
      case "stagnierend":  return "im Mehrjahresvergleich ohne deutlichen Rückgang";
      case "rückläufig":   return "rückläufig im Mehrjahresvergleich";
      case "unbestimmt":   return "Trend statistisch unbestimmt (zu wenig Datenjahre)";
      default:             return null;
    }
  }
  function osmCoverageNoteDocx(coverage, formalMotion) {
    if (!coverage) return null;
    if (!coverage.present) {
      if (formalMotion) return "Die räumlichen Voraussetzungen der Prüfoptionen konnten anhand der verfügbaren OpenStreetMap-Daten nicht überprüft werden.";
      const why = coverage.error ? ` (${coverage.error})` : "";
      return `OSM-Kontext nicht abgerufen${why}: Maßnahmen-Voraussetzungen wurden mangels Daten NICHT geprüft – die unten gelisteten Vorschläge können daher räumliche Voraussetzungen verletzen.`;
    }
    if (coverage.hasGap) {
      return `OSM-Voraussetzungen mangels Daten nicht geprüft: ${coverage.missingAxes.join(", ")}. Die Vorschläge wurden NICHT anhand dieser Achse(n) gefiltert.`;
    }
    return null;
  }
  // Exportieren, damit Tests die Helfer direkt prüfen können.
  UA.trendQualifierTextDocx = trendQualifierTextDocx;
  UA.osmCoverageNoteDocx = osmCoverageNoteDocx;

  // Gleicher Wortlaut wie für Text und HTML in ua.export_v2.js.
  function snapshotCitationLines(snapshot) {
    if (!snapshot) return [];
    const { generatedAt, complete, stale, warnings } = snapshot;
    const lines = ["Recherchequelle: veröffentlichter Ratsdaten-Snapshot"];
    if (typeof snapshot.sha256 === "string" && /^[a-f0-9]{64}$/.test(snapshot.sha256)) {
      lines.push(`Snapshot-SHA-256: ${snapshot.sha256}`);
      if (typeof snapshot.mapSha256 === "string" && /^[a-f0-9]{64}$/.test(snapshot.mapSha256) && snapshot.mapSha256 !== snapshot.sha256) {
        lines.push(`Karten-SHA-256: ${snapshot.mapSha256}`);
      }
    }
    if (typeof generatedAt === "string" && generatedAt) lines.push(`Katalogstand: ${generatedAt.slice(0, 10)}`);
    if (complete === false) lines.push("Katalogabdeckung: eingeschränkt");
    if (stale === true) lines.push("Der Katalogstand ist veraltet.");
    for (const warning of Array.isArray(warnings) ? warnings : []) {
      if (typeof warning === "string" && warning.trim()) lines.push(`Kataloghinweis: ${warning.trim()}`);
    }
    return lines;
  }

  /**
   * Generate and download Word document
   * @param {Object} ctx - Application context
   * @param {Object} reportData - Report data from UA.computeExportReport
   * @param {Object} options - Export options
   */
  UA.exportToWord = async function exportToWord(ctx, reportData, options = {}) {
    // Ensure export libraries are loaded
    await UA.ensureExportLibraries();
    
    if (!window.docx) {
      throw new Error("docx.js library not loaded");
    }

    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ImageRun,
            Table, TableRow, TableCell, WidthType, BorderStyle, TableLayoutType, ExternalHyperlink,
            InternalHyperlink, Bookmark, Footer, PageNumber, LevelFormat } = window.docx;

    function linkedWordRun({ text, href, anchor }, runOptions = {}) {
      const value = replaceEmojisForDocx(String(text ?? ""));
      if (href && ExternalHyperlink) {
        return new ExternalHyperlink({ link: href, children: [new TextRun({ text: value, ...runOptions, style: "Hyperlink" })] });
      }
      if (anchor && InternalHyperlink) {
        return new InternalHyperlink({ anchor, children: [new TextRun({ text: value, ...runOptions, style: "Hyperlink" })] });
      }
      return new TextRun({ text: value, ...runOptions });
    }

    function motionParagraph(text, options = {}) {
      const content = formatMotionText(String(text));
      const parts = Array.isArray(content) ? content : [{ text: content }];
      const runs = parts.map(part => linkedWordRun({ text: part.text, href: part.link }));
      return new Paragraph({ children: runs, spacing: { after: 100 }, keepLines: true, ...options });
    }

    // ---------------------------------------------------------------
    // PR-QA „DOCX-Härtung": eindeutige docPr-IDs + altText pro Bild.
    // docx@9.x speichert Bilder ohne `type` als `word/media/*.undefined`,
    // was Word/LibreOffice/PDF-Konverter destabilisiert. Außerdem vergibt
    // die Library ohne `altText.id` für jedes Bild dieselbe `docPr id="1"`,
    // was OOXML-technisch unsauber ist und Screenreader stört. Die Helper
    // `nextImageId()` und `pngImageRun()` zentralisieren Type, Alt-Text
    // und ID-Vergabe für alle drei Karten-Bildquellen (Übersicht, Detail,
    // Cluster) und werden vom QA-Test geprüft.
    // ---------------------------------------------------------------
    // Bild-IDs starten bewusst bei 1000 (statt 1), damit sie sich von
    // historischen `docPr id="1"` Werten klar abheben — erleichtert das
    // Debugging in alten vs. neuen DOCX und macht den QA-Test gegen
    // doppelte ID="1" robuster.
    let _docxImageIdSeq = 1000;
    function nextImageId() { return String(_docxImageIdSeq++); }

    /**
     * Build a docx ImageRun for a PNG with mandatory accessibility
     * metadata. Decodes either a base64-encoded data URL or raw base64
     * (leaflet-image always produces PNG).
     * @param {string} dataUrlOrBase64 - data URL or raw base64 string
     * @param {{width:number,height:number}} transformation
     * @param {{title:string, description:string}} alt
     */
    function pngImageRun(dataUrlOrBase64, transformation, alt) {
      const base64 = String(dataUrlOrBase64 || "").replace(/^data:image\/png;base64,/, "");
      const binaryString = atob(base64);
      const data = Uint8Array.from(binaryString, c => c.charCodeAt(0));
      const id = nextImageId();
      const altText = {
        // `name` is also used as the image's filename inside the DOCX
        // package — must be unique to avoid collisions in word/media.
        name: `Bild_${id}`,
        title: (alt && alt.title) || "Karte",
        description: (alt && alt.description) || "Kartenausschnitt des untersuchten Unfallbereichs",
        id
      };
      return new ImageRun({
        type: "png",            // ← fixes word/media/*.undefined bug
        data,
        transformation,
        altText
      });
    }

    // Helper: shared cell border style
    const cellBorder = {
      top:    { style: BorderStyle.SINGLE, size: 1, color: "AAAAAA" },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: "AAAAAA" },
      left:   { style: BorderStyle.SINGLE, size: 1, color: "AAAAAA" },
      right:  { style: BorderStyle.SINGLE, size: 1, color: "AAAAAA" }
    };

    // Helper: build a table cell containing plain text. Emoji-bearing strings
    // (e.g. "🚲+🚗") get sanitized first so DOCX viewers without an emoji-
    // capable body font still show the involvement labels (PR-QA Task 1).
    function textCell(text, bold) {
      return new TableCell({
        borders: cellBorder,
        children: [new Paragraph({ children: [new TextRun({ text: replaceEmojisForDocx(text), bold })] })]
      });
    }

    // Helper to build a simple bordered table from headers + rows (plain text cells)
    // Optional: rowHighlights is an array of booleans – true = highlight that data row
    // Cells go through `replaceEmojisForDocx` so involvement icons fall back to
    // text labels (`[Rad]+[PKW]`) when the Word installation lacks an emoji
    // body font (PR-QA Task 1).
    //
    // PR-QA „Tabellenlayout":
    //  - explizite Spaltenbreiten (DXA-Twips) statt der generischen Default-
    //    Verteilung von docx@9, damit lange Tabellen nicht über den rechten
    //    Seitenrand hinauslaufen (A4 nutzbare Breite ≈ 9000 Twips).
    //  - Kopfzeile als wiederholter Header (`tableHeader: true`), damit lange
    //    Tabellen auch auf Folgeseiten ihre Spaltenbeschriftung behalten.
    //  - gleichmäßige bzw. gewichtete Spaltenverteilung fördert Zellumbruch
    //    in schmalen Spalten, ohne hier zusätzliche Row-Optionen zu setzen.
    function _twipsForCols(numCols, weights, total = 9000) {
      if (Array.isArray(weights) && weights.length === numCols) {
        const sum = weights.reduce((a, b) => a + b, 0) || numCols;
        return weights.map(w => Math.max(400, Math.round(total * w / sum)));
      }
      // even split, but never narrower than 400 twips per column
      const each = Math.max(400, Math.floor(total / Math.max(1, numCols)));
      return Array(numCols).fill(each);
    }

    function makeDocxTable(headers, dataRows, rowHighlights, opts) {
      const numCols = headers.length;
      const compact = opts?.compact;
      const colWidths = _twipsForCols(numCols, opts?.colWeights, compact ? 9800 : 9000);
      const makeRow = (cells, bold, highlight, isHeader) =>
        new TableRow({
          tableHeader: !!isHeader,
          cantSplit: true,
          children: cells.map((value, ci) => {
            const cell = value && typeof value === "object" ? value : { text: value };
            const runOptions = { bold, ...(compact ? { size: 18 } : {}) };
            const lines = String(cell.text ?? "").split("\n");
            return new TableCell({
              borders: cellBorder,
              width: { size: colWidths[ci] || colWidths[0], type: WidthType.DXA },
              children: lines.map(text => new Paragraph({
                children: [linkedWordRun({ ...cell, text }, runOptions)],
                ...(compact ? { spacing: { after: 0 } } : {})
              })),
              ...(highlight ? { shading: { fill: "FFFFCC" } } : (compact && isHeader ? { shading: { fill: "E9EEF2" } } : {}))
            });
          })
        });
      return new Table({
        width: compact ? { size: 9800, type: WidthType.DXA } : { size: 100, type: WidthType.PERCENTAGE },
        ...(compact ? { layout: TableLayoutType.FIXED, margins: { top: 32, bottom: 32, left: 48, right: 48 } } : {}),
        columnWidths: colWidths,
        rows: [
          makeRow(headers, true, false, true),
          ...dataRows.map((row, i) => makeRow(row, false, rowHighlights ? rowHighlights[i] : false, false))
        ]
      });
    }

    // Helper to build a 2-column key/value table where the value cell may be a hyperlink.
    // Row schema:
    //   [key, value, false]                       → plain value cell
    //   [key, displayText, true, hrefOverride?]   → hyperlink cell; if
    //         hrefOverride is set, the URL stored in the link is taken
    //         from there and `displayText` is shown as a short caption.
    //
    // PR-QA „Tabellenlayout": schmale Label-Spalte (~2200 twips ≈ 38 mm),
    // breite Wert-Spalte (~6800 twips). Dadurch passen lange Werte
    // (Bereich, Hinweis-Text) sauber, ohne dass die Label-Spalte unnötig
    // viel Platz frisst.
    function makeKVTable(rows) {
      const colWidths = [2200, 6800];
      const headerRow = new TableRow({
        tableHeader: true,
        cantSplit: true,
        children: [
          new TableCell({
            borders: cellBorder,
            width: { size: colWidths[0], type: WidthType.DXA },
            shading: { fill: "EEEEEE" },
            children: [new Paragraph({ children: [new TextRun({ text: "Merkmal", bold: true })] })]
          }),
          new TableCell({
            borders: cellBorder,
            width: { size: colWidths[1], type: WidthType.DXA },
            shading: { fill: "EEEEEE" },
            children: [new Paragraph({ children: [new TextRun({ text: "Angabe", bold: true })] })]
          })
        ]
      });
      return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        columnWidths: colWidths,
        rows: [headerRow, ...rows.map(([key, value, isLink, hrefOverride]) => {
          const keyCell = new TableCell({
            borders: cellBorder,
            width: { size: colWidths[0], type: WidthType.DXA },
            children: [new Paragraph({ children: [new TextRun({ text: replaceEmojisForDocx(key), bold: true })] })]
          });
          let valueCell;
          if (isLink) {
            const href = hrefOverride || value;
            const link = ExternalHyperlink
              ? new ExternalHyperlink({
                  link: href,
                  children: [new TextRun({ text: value, style: "Hyperlink" })]
                })
              : new TextRun({ text: value });
            valueCell = new TableCell({
              borders: cellBorder,
              width: { size: colWidths[1], type: WidthType.DXA },
              children: [new Paragraph({ children: [link] })]
            });
          } else {
            valueCell = new TableCell({
              borders: cellBorder,
              width: { size: colWidths[1], type: WidthType.DXA },
              children: [new Paragraph({ children: [new TextRun({ text: replaceEmojisForDocx(value), bold: false })] })]
            });
          }
          return new TableRow({ cantSplit: true, children: [keyCell, valueCell] });
        })]
      });
    }

    const children = [];
    // PR-QA Task 1: Body-Text durch dieselbe Emoji→Label-Substitution wie der
    // PDF-Renderer schicken – DOCX hat dasselbe Font-Risiko (Beteiligungs-
    // Symbole bleiben auf vielen Word-Installationen leer).
    const docxText = replaceEmojisForDocx(reportData.text || "");
    const textLines = docxText ? docxText.split("\n") : [];

    // Use structured data if available (preferred path), else fall back to text parsing
    const sd = reportData.structured || null;
    const includeReferences = options.includeReferences !== false;
    const selectedCouncilRecords = includeReferences && Array.isArray(sd?.politicalReferences) ? sd.politicalReferences : [];
    const formatMotionText = UA.createMotionLinkFormatter(sd?.motion?.priorWork, selectedCouncilRecords);
    let evidence = numberedEvidence(sd);
    const formalMotion = Boolean(evidence || sd?.motion);
    const hasMap = Boolean(options.includeMap && ctx.map);
    const analysisAnnexNumber = 1 + Number(hasMap) + Number(Boolean(evidence));
    const renderedEvidenceMapRefs = new Set();
    const setup = formalMotion ? [] : children;

    // Task 5: Dedup-Guard. Renderpfad pro Sektion höchstens einmal ausgeben.
    // Aktuell rendert dieser Code jede Sektion exakt einmal aus structured;
    // diese Guard-Set verhindert zukünftige Regressions, bei denen Text-
    // Fallback (`textLines`) und structured-Pfad denselben Block doppeln.
    const renderedSections = new Set();
    /** @returns {boolean} true wenn schon gerendert (Caller überspringt dann). */
    function _alreadyRendered(name) {
      if (renderedSections.has(name)) return true;
      renderedSections.add(name);
      return false;
    }
    // Expose for nested helpers within this function.
    const sectionGuard = _alreadyRendered;

    // Helper: determine if a cross-table row mask matches the active filter
    const afm = (sd && sd.meta && sd.meta.activeFilterMask) || 0;
    const afMode = (sd && sd.meta && sd.meta.involvementMode) || "or";
    function isActiveFilterRow(rowMask) {
      if (afm === 0) return false;
      if (afMode === "solo") {
        const isSingleBit = rowMask > 0 && (rowMask & (rowMask - 1)) === 0;
        return isSingleBit && (rowMask & afm) !== 0;
      }
      if (afMode === "and") {
        return (rowMask & afm) === afm;
      }
      return (rowMask & afm) !== 0;
    }

    const CITY_RAW = ctx.CITY_RAW || "—";
    const today = new Date().toLocaleDateString("de-DE");

    // ---- 1. Derive document title from meta ----
    const gremiumMeta = sd && sd.meta && sd.meta.gremium ? sd.meta.gremium : {};
    const docTitle = deriveDocTitle(gremiumMeta.typ);

    // ---- 2. Dokumentkopf ----
    const metaCity    = (sd && sd.meta && sd.meta.city)     || CITY_RAW;
    const metaArea    = (sd && sd.meta && sd.meta.areaName) || "(Kartenausschnitt)";
    const metaDate    = (sd && sd.meta && sd.meta.date)     || today;
    const metaToWhom  = gremiumMeta.gremium || "Zuständiges Gremium vor Einreichung prüfen";
    const subject = replaceEmojisForDocx(reportSubject(reportData));
    const hannoverDistrictMotion = formalMotion
      && /^(?:Landeshauptstadt\s+)?Hannover$/i.test(metaCity.trim())
      && /^(?:Stadt)?Bezirksrat(?:\s*\([^)]*\))?$/i.test((gremiumMeta.typ || "").trim());
    if (hannoverDistrictMotion) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: `Entwurf · Stand ${metaDate}`, size: 19 })],
          alignment: AlignmentType.RIGHT, spacing: { after: 140 }
        }),
        new Paragraph({ text: "Antragsteller: [Name des Mitglieds, der Fraktion oder der Gruppe]", spacing: { after: 100 } }),
        new Paragraph({ text: `An den ${gremiumMeta.gremium || "Stadtbezirksrat [Stadtbezirk]"}`, spacing: { after: 40 } }),
        new Paragraph({ text: "über die Bezirksratsbetreuung der Landeshauptstadt Hannover", spacing: { after: 40 } }),
        new Paragraph({ text: "Sitzung am [Datum, falls bekannt]", spacing: { after: 160 } }),
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun({ text: `Betreff: ${subject}`, color: "191919", size: 28, bold: true })],
          keepNext: true, keepLines: true, spacing: { before: 0, after: 100 }
        })
      );
      if (sd?.meta?.areaName && !subject.includes(metaArea)) {
        children.push(new Paragraph({ text: `Bereich: ${metaArea}`, spacing: { after: 80 } }));
      }
    } else if (formalMotion) {
      children.push(new Paragraph({
        children: [new TextRun({ text: docTitle.toUpperCase(), bold: true, color: "254B61", size: 20 })],
        keepNext: true, spacing: { after: 100 }
      }));
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: subject, color: "163B50", size: 36, bold: true })],
        keepNext: true, keepLines: true, spacing: { before: 0, after: 100 }
      }));
      children.push(new Paragraph({
        text: [metaToWhom, metaCity, metaDate, ...(sd?.meta?.areaName && !subject.includes(metaArea) ? [metaArea] : [])].join(" · "),
        spacing: { after: 220 }
      }));
    } else {
      children.push(new Paragraph({ text: docTitle.toUpperCase(), heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER }));
      const headerLines = [["An:", metaToWhom], ["Stadt:", metaCity], ["Bereich:", metaArea], ["Datum:", metaDate], ["Betreff:", subject]];
      for (const [label, value] of headerLines) {
        children.push(new Paragraph({
          children: [new TextRun({ text: `${label} `, bold: true }), new TextRun({ text: value })],
          spacing: { before: 80, after: 80 }
        }));
      }
      children.push(new Paragraph({ text: "---------------------------------", alignment: AlignmentType.CENTER, spacing: { before: 100, after: 200 } }));
    }

    // ---- 3. Rahmendaten (metadata box) ----
    const metaLink    = (sd && sd.meta && sd.meta.link) || "";
    const IS_LINK = true;
    const kvRahmen = [
      !formalMotion         ? ["Dokumenttyp",          docTitle,              false]   : null,
      !formalMotion && gremiumMeta.gremium ? ["Gremium", gremiumMeta.gremium, false] : null,
      !formalMotion && gremiumMeta.typ ? ["Gremiumstyp", gremiumMeta.typ, false] : null,
      gremiumMeta.kontakt   ? ["Kontakt",               gremiumMeta.kontakt,   false]   : null,
      !formalMotion && metaArea ? ["Bereich", metaArea, false] : null,
      !formalMotion && metaCity ? ["Stadt", metaCity, false] : null,
      !formalMotion && metaDate ? ["Exportdatum", metaDate, false] : null,
      metaLink              ? ["Werkbank-Link",         "Werkbank-Link öffnen", IS_LINK, metaLink] : null,
      gremiumMeta.hinweis   ? ["Zuständigkeitshinweis", gremiumMeta.hinweis,   false]   : null
    ].filter(Boolean);

    if (kvRahmen.length > 0) {
      setup.push(new Paragraph({
        text: "Rahmendaten",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 200, after: 100 }
      }));
      setup.push(makeKVTable(kvRahmen));
    }

    // ---- 4. Aktive Filter ----
    // PR-QA „Textqualität": rohe technische Filterwerte (z. B. "all",
    // "wet", numerische Codes) in lesbare deutsche Begriffe übersetzen.
    // Sonst landen Zeilen wie „Schweregrad: all" oder „Wochentag: all" im
    // einreichungsreifen Antrag und wirken wie ein Rohdatenexport.
    const filters = (sd && sd.meta && sd.meta.filters) || {};
    const filterRows = [];
    const fmtFilterValue = (UA && typeof UA.formatFilterValue === "function")
      ? UA.formatFilterValue
      : (key, val) => String(val);

    if (filters.severity   != null) filterRows.push(["Schweregrad",       fmtFilterValue("severity", filters.severity),               false]);
    if (filters.roadCondition != null) filterRows.push(["Fahrbahnzustand", fmtFilterValue("roadCondition", filters.roadCondition),    false]);
    if (filters.involvementMode != null) filterRows.push(["Beteiligungsmodus", fmtFilterValue("involvementMode", filters.involvementMode), false]);

    // Build participation flags label — Prosa-Form (QA-PR „Export-Semantik
    // vor Layout"): keine Emojis im DOCX-Sichtbereich.
    const partCodes = [];
    if (filters.includeCyclist)    partCodes.push("Rad");
    if (filters.includePedestrian) partCodes.push("Fuss");
    if (filters.includeCar)        partCodes.push("PKW");
    if (filters.includeMotorcycle) partCodes.push("Krad");
    if (filters.includeGkfz)       partCodes.push("Lkw");
    if (filters.includeSonstig)    partCodes.push("Sonst");
    if (partCodes.length > 0) {
      const partProse = (typeof UA.formatParticipantCombinationForExport === "function")
        ? UA.formatParticipantCombinationForExport(partCodes)
        : partCodes.join(" + ");
      filterRows.push(["Beteiligte", partProse, false]);
    }

    if (filters.hourFrom != null && filters.hourTo != null) {
      filterRows.push(["Zeitraum", `${filters.hourFrom}:00–${filters.hourTo}:00 Uhr`, false]);
    }
    if (filters.dayType != null) filterRows.push(["Wochentag", fmtFilterValue("dayType", filters.dayType), false]);

    if (filterRows.length > 0) {
      setup.push(new Paragraph({
        text: "Aktive Filter",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 200, after: 100 }
      }));
      setup.push(makeKVTable(filterRows));
    }

    // ---- 4b. Hinweis zur Zählweise (PR 2 / Spec-Item 4) ----
    // Direkt nach dem „Aktive Filter"-Block, damit Lesende beim Übergang
    // zu den eigentlichen Inhalten wissen, worauf sich alle folgenden
    // Fallzahlen beziehen. Optisch als kursive Info-Box gestaltet.
    if (!evidence) {
      setup.push(new Paragraph({
        children: [new TextRun({ text: HINWEIS_ZAEHLWEISE_LINES[0], bold: true, italics: true })],
        spacing: { before: 100, after: 60 }
      }), new Paragraph({
        children: [new TextRun({ text: HINWEIS_ZAEHLWEISE_LINES[1], italics: true })],
        spacing: { after: 200 }
      }));
    }

    // ---- 4c. Methodik – Scope der Auswertung (PR 2 / Spec-Item 6) ----
    // Spiegelt structured.methodikScope (drei Sätze) als kompakter
    // Methodik-Block in das DOCX. Der Block fasst die in
    // structured.meta.activeFilterScope / patternAnalysisScope /
    // baselineScope hinterlegten Definitionen für Lesende zusammen.
    if (sd && sd.methodikScope && Array.isArray(sd.methodikScope.lines) && sd.methodikScope.lines.length > 0) {
      setup.push(new Paragraph({
        text: sd.methodikScope.title || "Methodik – Auswertungsbereich",
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 100, after: 80 }
      }));
      for (const ln of sd.methodikScope.lines) {
        setup.push(new Paragraph({
          children: [new TextRun({ text: formalMotion ? methodLineForMotion(ln) : String(ln) })],
          spacing: { after: 60 }
        }));
      }
    }

    // ---- 4d. Figure-Caption-Counter (PR 2 / Spec-Item 4) ----
    // Pro DOCX-Aufruf wird ein eigener Counter erzeugt; jede der drei
    // Bildklassen (Übersichts-, Detail-, Cluster-Karte) ruft figCounter
    // .next(...) auf und fügt die Bildunterschrift unmittelbar unter
    // dem ImageRun ein.
    const figCounter = makeFigureCounter();

    const motion = motionSections(sd, textLines, hasMap);
    function motionHeading(text) {
      return new Paragraph({
        ...(hannoverDistrictMotion ? { children: [new TextRun({ text, bold: true, size: 24, color: "191919" })] } : { text }),
        heading: HeadingLevel.HEADING_2,
        keepNext: true,
        spacing: { before: 160, after: 100 }
      });
    }
    children.push(motionHeading(hannoverDistrictMotion ? "Antrag" : formalMotion ? "Beschlussvorschlag" : "ANTRAG / BESCHLUSSVORSCHLAG"));
    if (hannoverDistrictMotion) {
      const opening = motion.paragraphs[0] || motion.requests[0] || "";
      const resolutionFormula = /\b(?:stadt)?bezirksrat\b[^.!?:\n]*?\b(?:beschlie(?:ß|ss)(?:en|t)|beschluss fassen|bittet|beauftragt)\b/i;
      if (!resolutionFormula.test(opening)) children.push(motionParagraph("Der Bezirksrat möge beschließen:", { keepNext: true }));
    }
    for (const line of motion.paragraphs) children.push(motionParagraph(line));
    for (const request of motion.requests) {
      children.push(motionParagraph(request, { numbering: { reference: MOTION_NUMBERING, level: 0 } }));
    }

    children.push(motionHeading(formalMotion ? "Begründung" : "BEGRÜNDUNG"));
    if (evidence) children.push(motionParagraph(evidenceCountText(evidence)));
    for (const line of motion.reason) children.push(motionParagraph(line));
    if (hannoverDistrictMotion) children.push(new Paragraph({
      children: [new TextRun({ text: "[Name und Funktion der zeichnenden Person]", italics: true, size: 20 })],
      spacing: { before: 80, after: 160 }
    }));
    for (const source of [motion.source, sd?.meta?.gremium?.source]) {
      if (!source?.label) continue;
      children.push(new Paragraph({
        children: [linkedWordRun({ text: source.label, href: reportLink(source.url) }, { size: 18 })],
        spacing: { after: 80 }
      }));
    }
    const councilSources = councilSourceRuns(sd);
    const shownCouncilUrls = new Set(councilSources.map(source => source.href));
    const additionalSources = selectedCouncilRecords.map(ref => ({
      text: ref.number ? `DS ${ref.number}` : ref.title,
      href: reportLink(ref.url),
    })).filter(source => source.text && source.href && !shownCouncilUrls.has(source.href));
    const frontSources = [...councilSources, ...additionalSources.slice(0, 2)];
    if (frontSources.length) {
      children.push(new Paragraph({
        children: [
          new TextRun({ text: "Ratsvorgänge im Original  ", bold: true, size: 18 }),
          ...frontSources.flatMap((part, i) => [...(i ? [new TextRun(" · ")] : []), linkedWordRun(part, { size: 18 })]),
          ...(additionalSources.length > 2 && formalMotion ? [new TextRun({ text: ` · Weitere Vorgänge in Anlage ${analysisAnnexNumber}.`, size: 18 })] : []),
        ],
        spacing: { after: 80 }
      }));
    }
    if (formalMotion) {
      children.push(new Paragraph({ children: [
        new TextRun({ text: "Anlagen  ", bold: true, size: 18, color: "435766" }),
        new TextRun({ text: motionAnnexes(evidence, hasMap, analysisAnnexNumber), size: 18, color: "435766" })
      ], spacing: { before: 80, after: 80 } }));
    }
    const firstAnnexIndex = children.length;
    if (formalMotion) {
      children.push(new Paragraph({
        text: `Anlage ${analysisAnnexNumber} – Auswertung und Methodik`,
        heading: HeadingLevel.HEADING_1, pageBreakBefore: true, keepNext: true, spacing: { after: 140 }
      }), ...setup);
    }

    // ---- 4b. KURZBEWERTUNG (Task 2) ----
    if (!formalMotion && sd && sd.executiveSummary) {
      const es = sd.executiveSummary;
      children.push(new Paragraph({
        text: "KURZBEWERTUNG",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 200 }
      }));
      children.push(new Paragraph({
        children: [new TextRun({ text: es.classification, bold: true })],
        spacing: { after: 120 }
      }));
      for (const b of (es.bullets || [])) {
        children.push(new Paragraph({ text: "• " + b, spacing: { after: 60 } }));
      }
      if (es.urgency) {
        children.push(new Paragraph({
          children: [new TextRun({ text: es.urgency, italics: true })],
          spacing: { before: 100, after: 200 }
        }));
      }
      // Task 7 – Map reference sentences immediately after KURZBEWERTUNG.
      if (Array.isArray(sd.mapReferences) && sd.mapReferences.length > 0) {
        for (const s of sd.mapReferences) {
          children.push(new Paragraph({ text: s, spacing: { after: 80 } }));
        }
      }
    }

    // ---- 5. SACHVERHALT section ----
    children.push(
      new Paragraph({
        text: "SACHVERHALT",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 200 }
      })
    );

    // Parse the text report to extract the SACHVERHALT section using helper.
    // Stop list mirrors POST_SACHVERHALT_STOP_HEADERS (minus "Sachverhalt:"
    // itself, which is the entry marker) so post-Sachverhalt blocks like
    // Mehrjahres-Trend never leak into the SACHVERHALT paragraph.
    const sachverhaltSection = extractSection(
      textLines,
      "Sachverhalt:",
      POST_SACHVERHALT_STOP_HEADERS.filter(h => h !== "Sachverhalt:")
    );

    const sachverhaltContent = Array.isArray(sachverhaltSection)
      ? sachverhaltSection.join(" ").trim()
      : (sachverhaltSection || "").trim();

    if (sachverhaltContent.length > 0) {
      children.push(
        new Paragraph({
          text: sachverhaltContent,
          spacing: { after: 200 }
        })
      );
    }

    // ---- 6. STATISTIK section with real tables (from structured data) ----
    if (sd && !sectionGuard("STATISTIK")) {
      children.push(
        new Paragraph({
          text: "STATISTIK",
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 }
        })
      );

      // Severity table
      children.push(new Paragraph({
        text: severityPopulationText(sd),
        keepNext: true, spacing: { after: 100 }
      }));
      const sev = sd.severity;
      const sevTotal = sev ? sev.total : 0;
      const fmtPct = (n, total) => total ? ((n / total) * 100).toFixed(1).replace(".", ",") + " %" : "0,0 %";
      children.push(makeDocxTable(
        ["Kategorie", "Anzahl", "Anteil"],
        [
          ["Unfälle mit Getöteten", String((sev && sev.bySev["1"]) || 0), fmtPct((sev && sev.bySev["1"]) || 0, sevTotal)],
          ["Unfälle mit Schwerverletzten", String((sev && sev.bySev["2"]) || 0), fmtPct((sev && sev.bySev["2"]) || 0, sevTotal)],
          ["Unfälle mit Leichtverletzten", String((sev && sev.bySev["3"]) || 0), fmtPct((sev && sev.bySev["3"]) || 0, sevTotal)]
        ]
      ));
      children.push(new Paragraph({ text: "", spacing: { after: 200 } }));

      // Deviations table
      if (sd.deviations && sd.deviations.focus && sd.deviations.focus.length > 0) {
        const isPolitical = sd.meta && sd.meta.mode === "political";
        children.push(new Paragraph({ text: "Top-Abweichungen (Ausschnitt vs. Stadt):", keepNext: true, spacing: { after: 100 } }));
        const fmtCombo = (UA.formatInvolvementCombo || ((s) => s));
        const fmtFactor = UA.formatFactorPolitical || ((f) => `Faktor ${f.toFixed(2).replace(".", ",")}`);
        const devRows = sd.deviations.focus.map(r => {
          const locPct = sd.deviations.local.total ? ((r.locR) * 100).toFixed(1).replace(".", ",") + " %" : "0,0 %";
          const basePct = ((r.baseR) * 100).toFixed(1).replace(".", ",") + " %";
          const muster = r.textLabel || fmtCombo(r.mask, { format: "text" });
          if (isPolitical) {
            // Task 9/10: politisches Wording; 95%-KI weggelassen.
            return [muster, String(r.locCnt), locPct, basePct, fmtFactor(r.factor, { mode: "political" })];
          }
          const ciLowPct = r.ciLow != null ? (r.ciLow * 100).toFixed(1).replace(".", ",") + " %" : "—";
          const ciHighPct = r.ciHigh != null ? (r.ciHigh * 100).toFixed(1).replace(".", ",") + " %" : "—";
          const factorStr = formatFactorDe(r.factor) + "×" + (r.isSignificant === false ? " (n. s.)" : "");
          return [muster, String(r.locCnt), locPct, basePct, factorStr, `[${ciLowPct} – ${ciHighPct}]`];
        });
        const headers = isPolitical
          ? ["Muster", "Lokal", "Lokal %", "Stadt %", "Einordnung"]
          : ["Muster", "Lokal", "Lokal %", "Stadt %", "Faktor", "95%-KI (lokaler Anteil)"];
        children.push(makeDocxTable(headers, devRows, undefined, {
          // Spaltengewichte (relative Anteile, werden in `_twipsForCols`
          // normiert). Reihenfolge entspricht den Headern oben:
          //   technisch:  Muster | Lokal | Lokal % | Stadt % | Faktor | 95%-KI
          //   politisch:  Muster | Lokal | Lokal % | Stadt % | Einordnung
          // Das „Muster"- und das „95%-KI"/„Einordnung"-Feld sind die
          // textreichen Spalten und bekommen den meisten Platz; die drei
          // Zahl-Spalten in der Mitte werden bewusst schmaler gehalten.
          colWeights: isPolitical
            ? [2.0, 0.8, 1.0, 1.0, 1.6]
            : [1.8, 0.7, 0.9, 0.9, 0.9, 1.6]
        }));
        children.push(new Paragraph({
          children: [
            new TextRun({ text: "Lesart: ", bold: true }),
            new TextRun({ text: involvementComparisonReading(sd, isPolitical) })
          ],
          spacing: { after: 100 }
        }));
        if (!isPolitical) {
          const allNonSig = sd.deviations.focus.every(r => r.isSignificant === false);
          if (allNonSig) {
            children.push(new Paragraph({
              text: "Hinweis: Alle aufgeführten Abweichungen sind statistisch nicht signifikant (95%-KI schließt Stadtwert ein). Faktor-Werte bei kleinen Fallzahlen mit Vorsicht interpretieren.",
              spacing: { after: 100 }
            }));
          }
        }
        children.push(new Paragraph({ text: "", spacing: { after: 200 } }));

        // Task 4 – URSACHEN UND MASSNAHMEN direkt nach den Abweichungen.
        if (Array.isArray(sd.causesMeasures) && sd.causesMeasures.length > 0) {
          children.push(new Paragraph({
            text: "URSACHEN UND MASSNAHMEN",
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 200, after: 100 }
          }));
          // Cross-Reference per Maßnahmen-Nummer, falls verfügbar — sonst
          // klassische Label-Liste (Backward-compat).
          const cmRows = sd.causesMeasures.map(c => [
            c.cause,
            (c.measureRefs && c.measureRefs.length > 0)
              ? c.measureRefs.map(e => `#${e.idx} (${e.label})`).join("; ")
              : c.measures.join("; ")
          ]);
          children.push(makeDocxTable(
            ["Auffälliges Muster", "Empfohlene Maßnahmen (siehe Liste unten)"],
            cmRows
          ));
          children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
        }
      }

      // Year table
      if (sd.yearTable && sd.yearTable.length > 0) {
        children.push(new Paragraph({ text: "Unfälle pro Jahr im Ausschnitt:", spacing: { after: 100 } }));
        const yrRows = sd.yearTable.map(row => {
          // Phase 1.2: DOCX bevorzugt das deterministische Bracket-Label
          // (`textClasses`), damit auch ohne Emoji-fähigen Body-Font in Word
          // keine kaputten Trennzeichen ("+", "=") sichtbar werden.
          const cls = (row.textClasses && row.textClasses.length)
            ? row.textClasses
            : (row.classes || []);
          return [
            String(row.year),
            String(row.total),
            cls.length ? cls.join(", ") : "—"
          ];
        });
        children.push(makeDocxTable(
          ["Jahr", "Summe", "Kombinationen"],
          yrRows
        ));
        children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
      }

      // Cross-table: Beteiligungskombination × Schweregrad
      if (sd.crossTable && sd.crossTable.rows && sd.crossTable.rows.length > 0) {
        children.push(new Paragraph({ text: "Beteiligungskombination × Schweregrad:", spacing: { after: 100 } }));
        // PR-QA Task 1: deterministische Text-Labels in der DOCX-Tabelle.
        const fmtCombo = (UA.formatInvolvementCombo || ((s) => s));
        const ctRows = sd.crossTable.rows.map(r => [
          r.textLabel || fmtCombo(r.mask, { format: "text" }),
          String(r.sev1), String(r.sev2), String(r.sev3), String(r.total)
        ]);
        // Highlight rows whose mask matches the active filter
        const ctHighlights = sd.crossTable.rows.map(r => isActiveFilterRow(r.mask));
        ctRows.push([
          "Gesamt",
          String(sd.crossTable.totals.sev1),
          String(sd.crossTable.totals.sev2),
          String(sd.crossTable.totals.sev3),
          String(sd.crossTable.totals.total)
        ]);
        ctHighlights.push(false); // Gesamt row is not highlighted
        children.push(makeDocxTable(
          ["Kombination", "mit Getöteten", "mit Schwerverletzten", "mit Leichtverletzten", "Unfälle gesamt"],
          ctRows,
          ctHighlights,
          { colWeights: [45, 12, 17, 16, 10] }
        ));
        children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
      }

      // Patterns section
      if (sd.patterns && sd.patterns.length > 0) {
        children.push(new Paragraph({
          text: "FACHLICHE EINORDNUNG / MUSTER",
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 }
        }));
        for (const pat of sd.patterns) {
          if (pat.title) {
            children.push(new Paragraph({
              children: [new TextRun({ text: pat.title, bold: true })],
              spacing: { after: 60 }
            }));
          }
          if (pat.content) {
            children.push(new Paragraph({ text: pat.content, spacing: { after: 100 } }));
          }
        }
        children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
      }

      // Economic impact (PR-C / B2): Volkswirtschaftliche Bedeutung
      const costTable = options.includeCosts !== false && UA.costs?.reportTable(sd.economicImpact);
      if (costTable) {
        children.push(new Paragraph({ text: costTable.title, heading: HeadingLevel.HEADING_2, spacing: { before: 400, after: 200 } }));
        children.push(new Paragraph({ text: costTable.note, spacing: { after: 120 } }));
        children.push(makeDocxTable(costTable.headers, costTable.rows));
        const tq = trendQualifierTextDocx(sd.economicImpact.trendQualifier);
        if (tq) children.push(new Paragraph({ text: `Mehrjahres-Trend der Unfallzahlen: ${tq}.` }));
        children.push(new Paragraph({ children: [new TextRun("Quelle: "),
          linkedWordRun({ text: costTable.sourceLabel, href: reportLink(costTable.sourceUrl) })], spacing: { after: 120 } }));
      }

      if (options.includeMeasures !== false && sd.measureAssessmentNote) {
        children.push(motionParagraph(sd.measureAssessmentNote));
      }

      // Orts- und musterbezogene Empfehlungen (UA.contextMeasures, Spec
      // Items 4–8). Direkt VOR „EMPFOHLENE MASSNAHMEN" — Antrag soll mit
      // den passenden Prüfaufträgen beginnen, nicht mit Standardmaßnahmen.
      if (options.includeMeasures !== false && sd.contextualMeasures
          && Array.isArray(sd.contextualMeasures.matchedRules)
          && sd.contextualMeasures.matchedRules.length > 0
          && !sectionGuard("ORTS- UND MUSTERBEZOGENE EMPFEHLUNGEN")) {
        children.push(new Paragraph({
          text: "ORTS- UND MUSTERBEZOGENE EMPFEHLUNGEN",
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 }
        }));
        if (sd.contextualMeasures.rationale) {
          children.push(new Paragraph({
            children: [new TextRun({ text: sd.contextualMeasures.rationale, italics: true })],
            spacing: { after: 200 }
          }));
        }
        const renderBucketDocxCtx = (heading, items) => {
          if (!Array.isArray(items) || items.length === 0) return;
          children.push(new Paragraph({
            children: [new TextRun({ text: heading, bold: true })],
            spacing: { before: 120, after: 40 }
          }));
          for (const it of items) {
            children.push(new Paragraph({ text: "• " + it, spacing: { after: 20 } }));
          }
        };
        renderBucketDocxCtx("Erforderliche Vor-Ort-Prüfung",     sd.contextualMeasures.pruefauftraege);
        renderBucketDocxCtx("Kurzfristig prüfbar",               sd.contextualMeasures.kurzfristig);
        renderBucketDocxCtx("Baulich/organisatorisch zu prüfen", sd.contextualMeasures.mittelfristig);
      }

      // Recommended measures (PR-D / B1+B3)
      if (options.includeMeasures !== false && UA.hasRecommendationsOrFiltered
          && UA.hasRecommendationsOrFiltered(sd.recommendedMeasures)
          && !sectionGuard("EMPFOHLENE MASSNAHMEN")) {
        const fmtCost = (UA.measures && UA.measures.formatCostRange) ? UA.measures.formatCostRange : (() => "—");
        const fmtRed = (UA.measures && UA.measures.formatReductionRange) ? UA.measures.formatReductionRange : (() => "—");
        children.push(new Paragraph({
          text: "EMPFOHLENE MASSNAHMEN",
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 }
        }));
        // OSM-Datenstand-Hinweis vor der Liste, kursiv hervorgehoben.
        const cov = osmCoverageNoteDocx(sd.recommendedMeasures.osmCoverage, formalMotion);
        if (cov) {
          children.push(new Paragraph({
            children: [new TextRun({ text: `OSM-Datenstand: ${cov}`, italics: true })],
            spacing: { after: 120 }
          }));
        }
        let i = 1;
        for (const item of (sd.recommendedMeasures.measures || [])) {
          const m = item.measure;
          children.push(new Paragraph({
            children: [new TextRun({ text: `${i}. ${m.label}`, bold: true })],
            spacing: { after: 40 }
          }));
          if (m.description) {
            children.push(new Paragraph({ text: m.description, spacing: { after: 40 } }));
          }
          const ev = (m.effect && m.effect.evidenceLevel) ? `Evidenz ${m.effect.evidenceLevel}` : "";
          const meta = `Kosten: ${fmtCost(m.costRange)} pro ${m.perUnit || "Einheit"} · Reduktion: ${fmtRed(m.effect && m.effect.expectedReductionPct)}${ev ? " · " + ev : ""} · Vorlauf: ${m.leadTime || "—"}`;
          children.push(new Paragraph({ text: meta, spacing: { after: 40 } }));
          // Goldstandard Items 5–6: explizite Cross-Reference auf den
          // URSACHEN-Block, damit der Leser sofort sieht, *warum* diese
          // Maßnahme empfohlen wird.
          if (Array.isArray(item.derivedFrom) && item.derivedFrom.length > 0) {
            children.push(new Paragraph({
              children: [
                new TextRun({ text: "Abgeleitet aus auffälligem Muster: ", italics: true }),
                new TextRun({ text: item.derivedFrom.map(d => d.label).join(" · "), italics: true })
              ],
              spacing: { after: 40 }
            }));
          }
          if (item.amortisation && item.amortisation.years) {
            const [best, worst] = item.amortisation.years;
            children.push(new Paragraph({
              text: `Geschätzte Amortisation: ca. ${best.toFixed(1)} – ${worst.toFixed(1)} Jahre.`,
              spacing: { after: 40 }
            }));
          }
          if (Array.isArray(m.considerations)) {
            for (const c of m.considerations) {
              children.push(new Paragraph({ text: "• " + c, spacing: { after: 20 } }));
            }
          }
          i++;
        }
        // Wegen OSM-Voraussetzungen ausgeschlossene Vorschläge transparent listen.
        if (Array.isArray(sd.recommendedMeasures.filteredOut) && sd.recommendedMeasures.filteredOut.length > 0) {
          children.push(new Paragraph({
            children: [new TextRun({ text: "Wegen OSM-Voraussetzungen NICHT empfohlen:", bold: true })],
            spacing: { before: 120, after: 40 }
          }));
          for (const f of sd.recommendedMeasures.filteredOut) {
            children.push(new Paragraph({
              text: `• ${f.label}: ${f.reason || "Voraussetzungen nicht erfüllt"}`,
              spacing: { after: 20 }
            }));
          }
        }
        if (sd.recommendedMeasures.disclaimer) {
          children.push(new Paragraph({
            children: [new TextRun({ text: sd.recommendedMeasures.disclaimer, italics: true })],
            spacing: { before: 100, after: 200 }
          }));
        }
        // Issue 2 (a): Quellen vollständig — Titel, Publisher, Jahr, URL
        // als anklickbarer Hyperlink (wenn vorhanden), analog zur
        // Anlage „Quellen & Methodische Hinweise" weiter unten.
        if (Array.isArray(sd.recommendedMeasures.sources) && sd.recommendedMeasures.sources.length > 0) {
          children.push(new Paragraph({
            children: [new TextRun({ text: "Quellen:", bold: true })],
            spacing: { before: 80, after: 40 }
          }));
          for (const s of sd.recommendedMeasures.sources) {
            if (!s || !s.title) continue;
            const meta = [s.publisher, s.year].filter(Boolean).join(", ");
            const head = meta ? `${s.title} (${meta})` : s.title;
            children.push(new Paragraph({
              children: [new TextRun({ text: `– ${head}` })],
              spacing: { after: 20 }
            }));
            if (s.url) {
              const urlLink = ExternalHyperlink
                ? new ExternalHyperlink({
                    link: s.url,
                    children: [new TextRun({ text: "Quelle öffnen", style: "Hyperlink" })]
                  })
                : new TextRun({ text: "Quelle verfügbar", italics: true });
              children.push(new Paragraph({ children: [urlLink], spacing: { after: 40 } }));
            }
          }
        }
      }

      // Goldstandard-Sektion 8: Priorisierung (DOCX). Drei-Bucket-Listen
      // mit den vom User vorgegebenen Überschriften. Leere Buckets werden
      // explizit ausgewiesen, damit die Wahrnehmung nicht zu „nur lang-
      // fristig möglich" verschoben wird.
      if (sd.prioritization && sd.prioritization.meta && sd.prioritization.meta.totals.all > 0) {
        children.push(new Paragraph({
          children: [new TextRun({ text: "Priorisierung (Umsetzungshorizont)", bold: true, size: 24 })],
          spacing: { before: 240, after: 120 }
        }));
        const renderBucketDocx = (heading, bucket) => {
          children.push(new Paragraph({
            children: [new TextRun({ text: heading, bold: true })],
            spacing: { before: 120, after: 40 }
          }));
          if (bucket.length === 0) {
            children.push(new Paragraph({
              children: [new TextRun({ text: "— keine Maßnahmen in diesem Horizont —", italics: true })],
              spacing: { after: 40 }
            }));
            return;
          }
          for (const it of bucket) {
            children.push(new Paragraph({
              text: `• ${it.label} (Vorlauf: ${it.leadTime})`,
              spacing: { after: 20 }
            }));
          }
        };
        renderBucketDocx("Kurzfristig (0–3 Monate)", sd.prioritization.kurzfristig);
        renderBucketDocx("Mittelfristig (3–12 Monate)", sd.prioritization.mittelfristig);
        renderBucketDocx("Langfristig (>12 Monate)", sd.prioritization.langfristig);
      }

      // Accident details table – grouped by strategy (consumes structured.accidentDetails.groups)
      if (!evidence && sd.accidentDetails && sd.accidentDetails.groups && sd.accidentDetails.groups.length > 0) {
        const view = (typeof UA !== "undefined" && UA.resolveAccidentView)
          ? UA.resolveAccidentView(sd.accidentDetails.viewId)
          : null;
        const cols = (sd.accidentDetails.columns && sd.accidentDetails.columns.length)
          ? sd.accidentDetails.columns
          : ["#", "Jahr", "Beteiligte", "Uhrzeit", "Wochentag", "Fahrbahnzustand", "Koordinaten"];
        children.push(new Paragraph({
          text: "EINZELUNFÄLLE IM BEREICH",
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 }
        }));
        for (const g of sd.accidentDetails.groups) {
          // Render header from the strategy (skip empty headers, e.g. flat view)
          const docxHeader = (g.headers && Array.isArray(g.headers.docx)) ? g.headers.docx : null;
          if (docxHeader && docxHeader.length > 0) {
            for (const h of docxHeader) {
              children.push(new Paragraph({
                text: replaceEmojisForDocx(h.text || ""),
                bold: !!h.bold,
                spacing: { before: 200, after: 100 }
              }));
            }
          } else if (g.sevLabel) {
            // Back-compat: synthesize a header for plain { sevLabel, histogram } groups
            const headerText = `${g.sevLabel} (n=${g.count})${g.histogram ? "  —  " + g.histogram : ""}`;
            children.push(new Paragraph({
              text: replaceEmojisForDocx(headerText),
              bold: true,
              spacing: { before: 200, after: 100 }
            }));
          }
          const detailRows = g.rows.map((r, i) => {
            if (view && view.renderRow && view.renderRow.docx) return view.renderRow.docx(r, i);
            // Defensive fallback (matches the previous bySeverity layout)
            const hour = r.hour != null ? String(r.hour).padStart(2, "0") + ":00" : "—";
            const coords = (r.lat != null && r.lon != null) ? `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}` : "—";
            return [String(i + 1), String(r.year ?? "—"), r.involved, hour, (typeof UA !== "undefined" && UA.fmtWeekday ? UA.fmtWeekday(r) : (r.weekday || "—")), r.roadCondition || "—", coords];
          });
          children.push(makeDocxTable(cols, detailRows, undefined, {
            // Einzelunfälle-Tabelle: Spaltenanzahl hängt von der gewählten
            // accidentDetails-View ab.
            //   7-Spalten-Layout (View ohne Schwere-Spalte):
            //     #  | Jahr | Beteiligte | Uhrzeit | Wochentag | Fahrbahnzustand | Koordinaten
            //   8-Spalten-Layout (View mit Schwere-Spalte):
            //     #  | Jahr | Schwere | Beteiligte | Uhrzeit | Wochentag | Fahrbahnzustand | Koordinaten
            // Gewichte: laufende Nummer und Jahr sind sehr schmal, „Beteiligte"
            // und „Koordinaten" brauchen viel Platz, die Mittel-Spalten halten
            // sich an typische Inhalte (Uhrzeit „08:30", Wochentag „Mittwoch",
            // Fahrbahnzustand „nass/feucht/schlüpfrig").
            colWeights: cols.length === 7
              ? [0.5, 0.7, 1.5, 0.9, 1.0, 1.2, 1.6]
              : cols.length === 8
                ? [0.5, 0.7, 1.0, 1.5, 0.9, 1.0, 1.2, 1.4]
                : undefined
          }));
          if (g.overflow > 0) {
            const label = g.overflowLabel || `weitere ${g.sevLabel || ""}`;
            children.push(new Paragraph({
              text: `… und ${g.overflow} ${label}`,
              italics: true,
              spacing: { after: 100 }
            }));
          }
        }
        children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
      } else if (!evidence && sd.accidentDetails && sd.accidentDetails.rows && sd.accidentDetails.rows.length > 0) {
        // Fallback for legacy data without groups
        children.push(new Paragraph({
          text: "EINZELUNFÄLLE IM BEREICH",
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 }
        }));
        const detailRows = sd.accidentDetails.rows.map((r, i) => {
          const hour = r.hour != null ? String(r.hour).padStart(2, "0") + ":00" : "—";
          const coords = (r.lat != null && r.lon != null) ? `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}` : "—";
          return [String(i + 1), String(r.year ?? "—"), r.sevLabel, r.involved, hour, (typeof UA !== "undefined" && UA.fmtWeekday ? UA.fmtWeekday(r) : (r.weekday || "—")), r.roadCondition || "—", coords];
        });
        children.push(makeDocxTable(
          ["#", "Jahr", "Schwere", "Beteiligte", "Uhrzeit", "Wochentag", "Fahrbahnzustand", "Koordinaten"],
          detailRows,
          undefined,
          { colWeights: [0.5, 0.7, 1.0, 1.5, 0.9, 1.0, 1.2, 1.4] }
        ));
        if (sd.accidentDetails.truncated) {
          children.push(new Paragraph({
            text: `… und ${sd.accidentDetails.total - sd.accidentDetails.rows.length} weitere Unfälle`,
            italics: true,
            spacing: { after: 100 }
          }));
        }
        children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
      }
    }

    // ---- 7. Map section (if enabled) ----
    const mapsStart = children.length;
    const plan = hasMap ? reportMapPlan(ctx, filters) : null;
    // Older reports may contain map points without a numbered evidence appendix.
    // P identifiers then belong only to the printed map; A identifiers always
    // come from the existing, snapshot-bound evidence table.
    const mapRows = hasMap && UA.EvidenceCohort?.documentPointSheets
      ? evidence?.rows ?? plan.points.map((point, index) => ({
          lat: point.lat, lon: point.lon, displayId: 'P' + String(index + 1).padStart(3, '0'),
          sourceFingerprint: UA.EvidenceCohort.fingerprintForPoint(UA, point)
        }))
      : [];
    if (hasMap && mapRows.some(row => Number.isFinite(row.lat) && Number.isFinite(row.lon))) {
      const focus = reportDiscoveryFocus(plan, sd);
      const fingerprints = new Set((focus?.points || []).map(p => UA.EvidenceCohort.fingerprintForPoint(UA, p)));
      const focusIds = new Set(mapRows.filter(row =>
        focus ? fingerprints.has(row.sourceFingerprint) : row.discoveryMatch === true
      ).map(row => row.displayId));
      const sheets = UA.EvidenceCohort.documentPointSheets(mapRows, focusIds);
      const refById = new Map();
      const figure = (image, caption, description, ref) => {
        const numbered = figCounter.next(caption);
        const run = new TextRun({ text: numbered.caption, bold: true });
        const frame = ref ? { width: 640, height: 400 } : { width: 610, height: 345 };
        children.push(new Paragraph({
          children: [pngImageRun(image, fitImageToMax(image, frame), {
            title: caption, description
          })], alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 120, after: 70 }
        }));
        children.push(new Paragraph({
          children: ref ? [new Bookmark({ id: 'evidence_map_' + ref, children: [run] })] : [run],
          spacing: { after: 70 }
        }));
      };
      children.push(new Paragraph({
        text: formalMotion ? 'Anlage 1 – Karten' : 'Kartenausschnitt', heading: HeadingLevel.HEADING_2, pageBreakBefore: formalMotion, keepNext: true,
        spacing: { after: 160 }
      }));
      const photo = await UA.fetchDocumentOrthophoto?.(ctx, plan.bounds);
      let aerial = null;
      if (photo) {
        const label = 'Amtliches Luftbild des Untersuchungsbereichs';
        const place = sd?.siteNetwork?.label || sd?.meta?.areaName;
        figure(photo.image, place ? label + ' – ' + place : label, place || label);
        const credit = photo.provider.attribution;
        const licence = photo.provider.license;
        const sourceUrl = reportLink(photo.provider.metadataUrl);
        const licenseUrl = reportLink(photo.provider.licenseUrl);
        const linked = (value, url) => url
          ? new ExternalHyperlink({ link: url, children: [new TextRun({ text: value, style: 'Hyperlink' })] })
          : new TextRun({ text: value });
        children.push(new Paragraph({
          children: [new TextRun('Bildquelle: '), linked(credit, sourceUrl), new TextRun(' · '),
            linked(licence, licenseUrl), new TextRun('. Nord ist oben. Das Aufnahmedatum ist im Kartenbild nicht ausgewiesen.')], spacing: { after: 140 }
        }));
        // Reuse this exact image for the detail crops, with the same GetMap bounds.
        if (window.Image) {
          const bitmap = new window.Image();
          bitmap.src = photo.image;
          try {
            await bitmap.decode();
            aerial = { bounds: photo.bounds, bitmap };
          } catch (error) {
            console.warn('Luftbild konnte für die Punktkarte nicht dekodiert werden:', error);
          }
        }
      } else {
        children.push(motionParagraph('Für diesen Ausschnitt war beim Export kein amtliches Luftbild verfügbar.'));
      }
      children.push(motionParagraph('Die Punkte liegen auf den veröffentlichten Koordinaten. '
          + (evidence ? 'Die Linien verbinden sie mit den Kennungen in der Unfallliste.' : 'Die Linien führen zu den Punktkennungen dieses Kartenausschnitts.')
          + (aerial ? ' Bildhintergrund: ' + photo.provider.attribution + ' · ' + photo.provider.license + '.' : ' Darstellung ohne Bildhintergrund.')));
      for (const sheet of sheets) {
        const ids = sheet.locations.flatMap(location => location.ids);
        const subject = sheet.kind === 'focus' ? 'ausgewählte Unfälle'
          : sheet.kind === 'other' ? 'weitere Unfälle im Gebiet' : 'Unfälle im Gebiet';
        const title = `Punktkarte ${sheet.ref} – ${subject}`;
        const description = ids.length + (ids.length === 1 ? ' Unfall an ' : ' Unfälle an ')
          + (sheet.locations.length === 1 ? 'einem veröffentlichten Unfallort.' : sheet.locations.length + ' veröffentlichten Unfallorten.');
        children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_3, keepNext: true,
          spacing: { before: 180, after: 60 } }));
        let intro = description;
        if (sheet.kind === 'focus' && focus?.label) intro += ' ' + focus.label + '.';
        const shared = sheet.locations.filter(location => location.ids.length > 1);
        if (shared.length) intro += ' Gleiche Koordinaten: '
          + shared.map(p => p.ids[0] + ' ×' + p.ids.length + ' (' + p.ids.join(', ') + ')').join(' · ') + '.';
        children.push(new Paragraph({ text: intro, keepNext: true, spacing: { after: 60 } }));
        const image = UA.EvidenceCohort.drawDocumentPointMap(window, sheet, aerial);
        figure(image, 'Veröffentlichte Unfallorte auf ' + sheet.ref, 'Unfall-IDs ' + ids.join(', '), sheet.ref);
        for (const id of ids) refById.set(id, sheet.ref);
        renderedEvidenceMapRefs.add(sheet.ref);
      }
      if (focus?.recentText) children.push(motionParagraph(focus.recentText));
      if (focus?.query) {
        const criteria = focusCriteria(focus.query);
        if (criteria) children.push(motionParagraph(criteria));
      }
      if (evidence?.link) children.push(new Paragraph({
        children: [new ExternalHyperlink({ link: evidence.link,
          children: [new TextRun({ text: 'Nummerierte Unfallkarte in der Werkbank öffnen', style: 'Hyperlink' })] })],
        spacing: { after: 100 }
      }));
      // Map references in this Word table address its own sheets. The source
      // cohort (also used by the CSV, PDF and evidence export) remains immutable.
      if (evidence) evidence = { ...evidence, rows: evidence.rows.map(row => ({ ...row, mapRef: refById.get(row.displayId) })) };
    } else if (hasMap) {
      const focus = reportDiscoveryFocus(plan, sd);
      const mapOptions = { ...options, exportPoints: plan.points, exportBounds: plan.bounds };
      const documentMap = UA.createDocumentMapContext(ctx);
      const mapCtx = documentMap.ctx;
      const cohorts = sd?.evidenceCohorts;
      try {
        fitDocumentMap(mapCtx, plan.bounds, { maxZoom: mapCtx.map.getZoom() });
        children.push(
          new Paragraph({
            text: formalMotion ? "Anlage 1 – Karten" : "KARTENAUSSCHNITT",
            heading: HeadingLevel.HEADING_2,
            ...(formalMotion ? { pageBreakBefore: true, keepNext: true } : {}),
            spacing: { before: 400, after: 200 }
          })
        );

        children.push(new Paragraph({
          children: [new TextRun({
            text: "Die Übersicht zeigt die ausgewerteten Unfallorte unter den aktiven Filtern."
          })],
          spacing: { after: 160 }
        }));

        const docxSelection = plan.selection;
        const addMapLink = (capture, overrides = {}) => children.push(new Paragraph({
          children: [new ExternalHyperlink({
            link: buildWerkbankUrl(ctx, { center: capture.center, zoom: capture.zoom, bounds: plan.bounds, ...overrides }),
            children: [new TextRun({ text: "In Werkbank öffnen", style: "Hyperlink" })]
          })],
          spacing: { after: 80 }
        }));
        let docxSelectionFigIndex = 1;
        if (docxSelection.hasRestriction) {
          try {
            const allCombPts = plan.allPoints;
            const allCombCapture = await UA.captureDocumentMap(mapCtx, {
              ...mapOptions, exportPoints: allCombPts
            });
            const allCombImage = allCombCapture.image;
            let allCombRun;
            try {
              allCombRun = pngImageRun(
                allCombImage,
                fitImageToMax(allCombImage, DOCX_MAP_MAX),
                {
                  title: "Übersichtskarte – alle Beteiligungs-Kombinationen",
                  description: "Übersichtskarte des untersuchten Bereichs ohne Beteiligungs-Filter (alle Kombinationen)"
                }
              );
            } catch (decodeError) {
              console.error("Failed to decode all-combinations overview map:", decodeError);
              throw new Error("Übersichtskartenbild (alle Kombinationen) konnte nicht dekodiert werden");
            }
            children.push(new Paragraph({
              children: [allCombRun],
              keepNext: true,
              alignment: AlignmentType.CENTER,
              spacing: { after: 200 }
            }));
            const allCombFig = figCounter.next("Übersichtskarte – alle Beteiligungs-Kombinationen im aktuellen Kartenausschnitt");
            children.push(new Paragraph({
              children: [new TextRun({
                text: allCombFig.caption,
                italics: true,
                bold: true
              })],
              alignment: AlignmentType.CENTER,
              spacing: { after: 80 }
            }));
            pushDocxMapSourceNote(children, ctx, 80, allCombCapture);
            addMapLink(allCombCapture, { allCombinations: true });
            children.push(new Paragraph({
              text: `Unfälle im selben Gebiet vor Beteiligungsfilter (n = ${allCombPts.length}).`,
              italics: true,
              spacing: { after: 200 }
            }));
            // Die folgende Auswahl-Karte ist Abbildung 2.
            docxSelectionFigIndex = allCombFig.index + 1;
          } catch (allCombErr) {
            if (isMapRenderReadinessFailure(allCombErr)) throw allCombErr;
            console.warn("All-combinations overview capture failed (graceful fallback):", allCombErr);
          }
        }

        const mainCapture = await UA.captureDocumentMap(mapCtx, mapOptions);
        const mapImageData = mainCapture.image;

        let mainMapRun;
        try {
          mainMapRun = pngImageRun(
            mapImageData,
            // Layout-PR „Bildverzerrung beheben": Aspektrate des PNG-
            // Originals erhalten — kein hartes 600×400 mehr.
            fitImageToMax(mapImageData, DOCX_MAP_MAX),
            {
              title: "Übersichtskarte",
              description: "Übersichtskarte des untersuchten Unfallbereichs mit allen gefilterten Unfällen"
            }
          );
        } catch (decodeError) {
          console.error("Failed to decode base64 map image data:", decodeError);
          throw new Error("Kartenbild konnte nicht dekodiert werden: ungültige Base64-Bilddaten");
        }

        children.push(
          new Paragraph({
            children: [mainMapRun],
            // Layout-PR Spec-Item 3: Bild und Caption als Einheit halten —
            // `keepNext` verhindert einen Seitenumbruch zwischen Bild-
            // Paragraph und folgendem Caption-Paragraph.
            keepNext: true,
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 }
          })
        );

        // PR 2 / Spec-Item 4: numbered figure caption directly under the image.
        // Doppelte Karten: Wenn eine Beteiligungs-Restriktion aktiv ist,
        // beschriften wir diese Karte explizit als „Auswahl-Karte" und
        // benennen die aktive Auswahl im Caption.
        const docxMainMapCaptionSubject = docxSelection.hasRestriction
          ? `Auswahl-Karte – Unfälle mit Beteiligung \u2039${docxSelection.prose}\u203A im aktuellen Kartenausschnitt`
          : "Übersichtskarte – gefilterte Unfälle im aktuellen Kartenausschnitt";
        children.push(new Paragraph({
          children: [new TextRun({
            text: figCounter.next(docxMainMapCaptionSubject).caption,
            italics: true,
            bold: true
          })],
          alignment: AlignmentType.CENTER,
          spacing: { after: 80 }
        }));

        const legendText =
          ctx && typeof ctx.t === "function"
            ? ctx.t("report.map.legend")
            : "Legende: Darstellung entsprechend der aktuellen Kartendarstellung. Die Punktfarbe zeigt die schwerste Unfallfolge: rot bei Unfällen mit Getöteten, orange bei Schwerverletzten und gelb bei Leichtverletzten.";

        children.push(
          new Paragraph({
            text: legendText,
            italics: true,
            spacing: { after: 200 }
          })
        );
        pushDocxMapSourceNote(children, ctx, 120, mainCapture);
        addMapLink(mainCapture);

        const overviewN = plan.points.length;
        const docxParentNForSubset = overviewN;
        children.push(new Paragraph({
          text: reportMapCount(overviewN, cohorts),
          italics: true,
          spacing: { after: docxSelection.hasRestriction ? 80 : 200 }
        }));
        // Doppelte Karten / Caption-Transparenz: nennt die aktive
        // Beteiligungs-Auswahl explizit unter der Auswahl-Karte
        // („Nur Unfälle mit Beteiligung ‹Rad + PKW› dargestellt.").
        if (docxSelection.hasRestriction) {
          children.push(new Paragraph({
            text: selectionHintSentence(docxSelection.prose),
            italics: true,
            spacing: { after: 200 }
          }));
        }
        let focusMapShown = false;
        if (focus?.bounds) {
          try {
            const capture = await (UA._captureDetailMap || captureDetailMap)(mapCtx, {
              ...mapOptions, exportPoints: focus.points, exportBounds: focus.bounds, heatmapExportOpacity: 0
            });
            const detailRun = pngImageRun(capture.image, fitImageToMax(capture.image, DOCX_MAP_MAX), {
              title: focus.title, description: focus.label
            });
            const figure = figCounter.next(`${focus.mapLabel} – ${focus.label}`);
            children.push(new Paragraph({
              text: focus.title, heading: HeadingLevel.HEADING_3, keepNext: true,
              spacing: { before: 200, after: 100 }
            }));
            children.push(new Paragraph({
              children: [detailRun], keepNext: true, alignment: AlignmentType.CENTER, spacing: { after: 100 }
            }));
            children.push(new Paragraph({
              text: focusCaption(figure, focus, overviewN, docxSelectionFigIndex),
              italics: true, spacing: { after: 80 }
            }));
            children.push(motionParagraph(focus.legend));
            pushDocxMapSourceNote(children, ctx, 80, capture);
            addMapLink(capture, { discoveryFocus: focus });
            focusMapShown = true;
          } catch (error) {
            if (isMapRenderReadinessFailure(error)) throw error;
            console.warn("Musterkarte konnte nicht erfasst werden:", error);
          }
        }
        if (focus) {
          if (!focusMapShown) {
            children.push(new Paragraph({ text: focus.summary }));
          }
          if (focus.recentText) children.push(new Paragraph({ text: focus.recentText, spacing: { after: 100 } }));
          const criteria = focusCriteria(focus.query);
          if (criteria) children.push(new Paragraph({ text: criteria, spacing: { after: 100 } }));
        }

        // Cluster maps: one zoom-in per dominant accident hotspot (Tasks 1–7).
        // Each cluster gets:
        //   – its own bbox-driven map view (fitBounds → no unrelated areas)
        //   – a unique heading "<label> – n Unfälle (Zoom z)" matching the table
        //   – the verification sentence below the image
        try {
          const clusterMaps = focusMapShown ? [] : await (UA._captureClusterMaps || captureClusterMaps)(mapCtx, mapOptions);
          for (const cm of clusterMaps) {
            // Task 5: do not render a cluster map if the visible point count
            // would not match the stated total.
            const visibleN = Array.isArray(cm.points)
              ? cm.points.length
              : countPointsInBounds(ctx.viewportPts || [], cm.bounds);
            if (visibleN !== cm.total) {
              console.warn(
                "Cluster map skipped: point/total mismatch",
                { label: cm.label, total: cm.total, visibleN }
              );
              continue;
            }

            const cBase64 = cm.image.replace(/^data:image\/png;base64,/, "");
            let cRun;
            try {
              cRun = pngImageRun(
                cBase64,
                // Layout-PR „Bildverzerrung beheben": Aspektrate erhalten.
                fitImageToMax(cBase64, DOCX_MAP_MAX),
                {
                  title: `Cluster-Karte: ${cm.label || "Hotspot"}`,
                  description: `Zoomansicht eines Unfall-Hotspots (${cm.total} Unfälle, Zoom ${cm.zoom})`
                }
              );
            } catch {
              console.warn("Cluster map image could not be decoded – skipping");
              continue;
            }
            children.push(new Paragraph({
              text: `${cm.label} – ${cm.total} Unfälle (Zoom ${cm.zoom})`,
              heading: HeadingLevel.HEADING_3,
              keepNext: true,
              spacing: { before: 200, after: 100 }
            }));
            children.push(new Paragraph({
              children: [cRun],
              keepNext: true,
              alignment: AlignmentType.CENTER,
              spacing: { after: 100 }
            }));
            // PR 2 / Spec-Item 4: numbered figure caption per cluster map.
            // Layout-Pass: Subset-Cross-Reference auf die Auswahl-Karte.
            const clusterFig = figCounter.next(`Cluster-Karte – ${cm.label} (n=${cm.total})`);
            const clusterCaptionText = (docxParentNForSubset != null)
              ? `${clusterFig.caption} Die ${cm.total} dargestellten Unfälle sind eine Teilmenge der ${docxParentNForSubset} Unfälle aus Abbildung ${docxSelectionFigIndex}.`
              : clusterFig.caption;
            children.push(new Paragraph({
              children: [new TextRun({
                text: clusterCaptionText,
                italics: true
              })],
              spacing: { after: 80 }
            }));
            pushDocxMapSourceNote(children, ctx, 80, cm);
            addMapLink(cm, { bounds: cm.bounds, center: cm.center || { lat: cm.lat, lon: cm.lon } });
            children.push(new Paragraph({
              text: reportMapCount(cm.total, cohorts),
              italics: true,
              spacing: { after: docxSelection.hasRestriction ? 80 : 200 }
            }));
            if (docxSelection.hasRestriction) {
              children.push(new Paragraph({
                text: selectionHintSentence(docxSelection.prose),
                italics: true,
                spacing: { after: 200 }
              }));
            }
          }
        } catch (clusterErr) {
          if (isMapRenderReadinessFailure(clusterErr)) throw clusterErr;
          console.warn("Cluster maps capture failed (graceful fallback):", clusterErr);
        }
        if (cohorts?.detailMapPartitions?.length) {
          const maps = await UA.EvidenceCohort.captureEvidenceMaps(UA, mapCtx, cohorts, { includeOverview: false });
          for (const evidenceMap of maps) {
            const { mapRef, image, title, accidentIds } = evidenceMap;
            const fig = figCounter.next(`${title} (n = ${accidentIds.length})`);
            children.push(new Paragraph({
              children: [pngImageRun(image, fitImageToMax(image, DOCX_MAP_MAX), {
                title, description: `Unfall-IDs ${accidentIds.join(", ")}`
              })],
              alignment: AlignmentType.CENTER,
              keepNext: true
            }));
            children.push(new Paragraph({
              children: [new Bookmark({ id: `evidence_map_${mapRef}`, children: [new TextRun(fig.caption)] })],
              alignment: AlignmentType.CENTER,
              keepNext: true
            }));
            children.push(new Paragraph({ text: `Unfall-IDs ${accidentIds.join(", ")}.`, spacing: { after: 60 } }));
            pushDocxMapSourceNote(children, ctx, 100, evidenceMap);
            renderedEvidenceMapRefs.add(mapRef);
          }
        }
      } catch (e) {
        if (isMapRenderReadinessFailure(e) || cohorts?.detailMapPartitions?.length) throw e;
        console.error("Map capture failed:", e);
        children.push(
          new Paragraph({
            text: "[Kartenerstellung fehlgeschlagen]",
            italics: true,
            spacing: { after: 200 }
          })
        );
      } finally {
        documentMap.close();
      }
    }
    const mapSection = formalMotion ? children.splice(mapsStart) : [];

    const networkSite = reportNetworkSite(ctx, sd);
    if (networkSite) {
      children.push(new Paragraph({ text: "Befund aus dem Netzregister", heading: HeadingLevel.HEADING_2, keepNext: true }));
      networkSite.lines.forEach((line, index) => {
        children.push(motionParagraph(line, { keepNext: index === 0 && networkSite.lines.length > 1 }));
      });
      for (const source of networkSite.sources) {
        children.push(new Paragraph({ children: [linkedWordRun(source)], spacing: { after: 80 }, keepLines: true }));
      }
      if (networkSite.link) children.push(new Paragraph({ children: [linkedWordRun({ text: "Auswertung in der Werkbank öffnen", href: networkSite.link })] }));
    }

    const siteChanges = reportSiteChanges(sd);
    if (siteChanges.length) {
      children.push(new Paragraph({
        text: "Dokumentierte Veränderungen", heading: HeadingLevel.HEADING_2, keepNext: true
      }));
      for (const change of siteChanges) {
        children.push(new Paragraph({
          children: [new TextRun(change.text), ...(change.href ? [new TextRun(" "), linkedWordRun({ text: "Quelle", href: change.href })] : [])],
          spacing: { after: 80 }, keepLines: true
        }));
      }
      children.push(motionParagraph(SITE_CHANGE_LIMIT));
    }

    // ---- 8. POI section (if enabled and data available) ----
    if (options.includePOIs) {
      // Prefer structured POI data for a real table
      const poi = sd && sd.poi;
      const hasPoi = poi && (poi.totalWithin > 0 || poi.totalNear > 0);
      const facilities = reportFacilities(poi);
      const poiTextSection = extractSection(textLines, "POI-Analyse");
      if (hasPoi || facilities.length || poiTextSection.length > 0) {
        children.push(
          new Paragraph({
            text: "SENSIBLE EINRICHTUNGEN",
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 400, after: 200 }
          })
        );

        if (hasPoi) {
          const poiRows = [];
          const allTypes = [...new Set([
            ...Object.keys(poi.withinByType || {}),
            ...Object.keys(poi.nearByType || {})
          ])].sort((a, b) => poiTypeLabel(a).localeCompare(poiTypeLabel(b), "de"));
          for (const type of allTypes) {
            const label = poiTypeLabel(type);
            poiRows.push([
              label,
              String(poi.withinByType[type] || 0),
              String(poi.nearByType[type] || 0)
            ]);
          }
          children.push(makeDocxTable(
            ["Typ", "Im Bereich", "In der Nähe (< 200m)"],
            poiRows
          ));
          children.push(new Paragraph({ text: "", spacing: { after: 100 } }));
          children.push(new Paragraph({
            text: "Hinweis: Das Vorhandensein von Schulen, Kindergärten oder Kitas im oder nahe dem Unfallbereich erfordert besondere Aufmerksamkeit hinsichtlich der Verkehrssicherheit für Kinder und Jugendliche.",
            spacing: { after: 200 }
          }));
        } else if (!facilities.length) {
          for (const line of poiTextSection) {
            children.push(new Paragraph({ text: line, spacing: { after: 100 } }));
          }
        }
        for (const facility of facilities) {
          children.push(new Paragraph({ children: [new TextRun({ text: facility.text, bold: true })], keepNext: true }));
          if (facility.detail) children.push(motionParagraph(facility.detail));
          for (const source of facility.sources) {
            children.push(new Paragraph({ children: [linkedWordRun(source)], spacing: { after: 80 } }));
          }
        }
      }
    }

    // ---- 8b. DUNKELZIFFER-PFLICHTHINWEIS (#C3) ----
    {
      const note = (sd && sd.darkFigureNote) || (typeof UA !== "undefined" && UA.DARK_FIGURE_NOTE) || null;
      if (note) {
        children.push(new Paragraph({
          text: note.title,
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 }
        }));
        children.push(new Paragraph({ text: note.body, spacing: { after: 100 } }));
        children.push(new Paragraph({
          children: [new TextRun({ text: note.sourceLabel, italics: true })],
          spacing: { after: note.sources && note.sources.length > 0 ? 50 : 200 }
        }));
        if (note.sources && note.sources.length > 0) {
          for (const src of note.sources) {
            const sourceChildren = [new TextRun({ text: "– " + src.label, italics: true, size: 18 })];
            if (src.url) {
              sourceChildren.push(new TextRun({ text: " – ", italics: true, size: 18 }));
              sourceChildren.push(ExternalHyperlink
                ? new ExternalHyperlink({
                    link: src.url,
                    children: [new TextRun({ text: "Quelle öffnen", style: "Hyperlink", size: 18 })]
                  })
                : new TextRun({ text: "Quelle verfügbar", italics: true, size: 18 }));
            }
            children.push(new Paragraph({ children: sourceChildren, spacing: { after: 50 } }));
          }
          children.push(new Paragraph({ text: "", spacing: { after: 150 } }));
        }
      }
    }

    // ---- 8b2. PR-E – KONTEXTDATEN-QUELLENHINWEIS ----
    // Dokumentiert die Datenquellen für Topographie-/OSM-/Verkehrslast-
    // Felder. Wird nur dann gerendert, wenn der Datensatz sie tatsächlich
    // trägt (`sd.enrichmentSourcesNote` ist sonst null).
    {
      const enrichNote = sd && sd.enrichmentSourcesNote;
      if (enrichNote) {
        children.push(new Paragraph({
          text: enrichNote.title,
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 200, after: 200 }
        }));
        children.push(new Paragraph({ text: enrichNote.body, spacing: { after: 100 } }));
        for (const src of enrichNote.sources) {
          const sourceChildren = [new TextRun({ text: "– " + src.label, italics: true, size: 18 })];
          if (src.url) {
            sourceChildren.push(new TextRun({ text: " – ", italics: true, size: 18 }));
            sourceChildren.push(ExternalHyperlink
              ? new ExternalHyperlink({
                  link: src.url,
                  children: [new TextRun({ text: "Quelle öffnen", style: "Hyperlink", size: 18 })]
                })
              : new TextRun({ text: "Quelle verfügbar", italics: true, size: 18 }));
          }
          children.push(new Paragraph({ children: sourceChildren, spacing: { after: 50 } }));
        }
        children.push(new Paragraph({ text: "", spacing: { after: 150 } }));
      }
    }

    // ---- 8c. MEHRJAHRES-TREND (#C2) ----
    if (sd && sd.yearlyTrend && Array.isArray(sd.yearlyTrend.years) && sd.yearlyTrend.years.length > 0
        && !sectionGuard("MEHRJAHRES-TREND")) {
      const t = sd.yearlyTrend;
      children.push(new Paragraph({
        text: "MEHRJAHRES-TREND",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 200 }
      }));
      const trendHeader = ["Jahr", "mit Getöteten", "mit Schwerverletzten", "mit Leichtverletzten", "Unfälle gesamt"];
      const trendRows = t.years.map((y, i) => [
        String(y),
        String(t.counts.fatal[i]),
        String(t.counts.severe[i]),
        String(t.counts.light[i]),
        String(t.counts.total[i])
      ]);
      children.push(makeDocxTable(trendHeader, trendRows));
      const slopeStr = Number.isFinite(t.slope) ? t.slope.toFixed(2) : "—";
      const r2Str = Number.isFinite(t.r2) ? t.r2.toFixed(2) : "—";
      children.push(new Paragraph({
        children: [
          new TextRun({ text: "Klassifikation: ", bold: true }),
          new TextRun({ text: `${t.classification} ` }),
          new TextRun({ text: `(Slope ${slopeStr}/Jahr, R² ${r2Str}, n=${t.nYears})`, italics: true })
        ],
        spacing: { after: 200 }
      }));
    }

    // ---- 8d. STUNDEN-HEATMAP (#A2) ----
    if (sd && sd.heatmap && sd.heatmap.total > 0 && UA.heatmap) {
      const hm = sd.heatmap;
      children.push(new Paragraph({
        text: "STUNDEN-HEATMAP (WERKTAG VS. WOCHENENDE)",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 200 }
      }));
      // Build a 25-row table: 1 header + 24 hour rows. Per-cell shading
      // mirrors the SVG in HTML so DOCX/PDF readers see the same hot/cold
      // pattern even when they can't render inline SVG.
      const headerRow = new TableRow({
        tableHeader: true,
        cantSplit: true,
        children: ["Stunde", "Mo–Fr", "Sa/So"].map(t => new TableCell({
          borders: cellBorder,
          shading: { fill: "EEEEEE" },
          children: [new Paragraph({ children: [new TextRun({ text: t, bold: true })] })]
        }))
      });
      const rows = [headerRow];
      for (let h = 0; h < 24; h++) {
        const cells = [
          new TableCell({
            borders: cellBorder,
            children: [new Paragraph({ children: [new TextRun({ text: `${String(h).padStart(2, "0")}:00`, bold: true })] })]
          })
        ];
        for (let c = 0; c < 2; c++) {
          const v = hm.matrix[h][c];
          const fill = UA.heatmap.cellColor(v, hm.max);
          // docx shading.fill expects 6-hex without leading "#"
          const hex = fill.replace(/^#/, "");
          const txtColor = UA.heatmap.readableTextColor(fill).replace(/^#/, "");
          cells.push(new TableCell({
            borders: cellBorder,
            shading: { fill: hex },
            children: [new Paragraph({
              alignment: undefined,
              children: [new TextRun({ text: v > 0 ? String(v) : "", color: txtColor })]
            })]
          }));
        }
        rows.push(new TableRow({ cantSplit: true, children: cells }));
      }
      children.push(new Table({
        width: { size: 60, type: WidthType.PERCENTAGE },
        rows
      }));
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `Gesamt: ${hm.total} Unfälle (Mo–Fr: ${hm.colTotals[0]}, Sa/So: ${hm.colTotals[1]}). `, italics: true }),
          new TextRun({ text: `Max. ${hm.max} Unfälle pro Stunde × Tagestyp.`, italics: true })
        ],
        spacing: { before: 100, after: 200 }
      }));
    }

    // ---- 8e. OSM-KONTEXT (#C4) ----
    // Only render the table when we actually have aggregated data.
    // For pure error stubs we add a one-line note so readers know why the
    // section is missing in this run.
    if (sd && sd.osmContext && sd.osmContext.summary) {
      const oc = sd.osmContext;
      const s = oc.summary;
      children.push(new Paragraph({
        text: "VERKEHRSRÄUMLICHER KONTEXT (OSM)",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 200 }
      }));
      const ocRows = [];
      if (s.dominantMaxspeed != null) {
        ocRows.push(["Vorherrschendes Tempolimit", `${s.dominantMaxspeed} km/h (n=${s.speedSampleSize} Wegabschnitte)`]);
      }
      ocRows.push(["Radverkehrsanlagen",
        s.cycleInfraWays > 0
          ? `${s.cycleInfraWays} Wegabschnitte mit Radinfrastruktur` + (s.cycleInfraShare != null ? ` (${Math.round(s.cycleInfraShare * 100)} % der Hauptachsen)` : "")
          : "keine separaten Radverkehrsanlagen erkannt"
      ]);
      ocRows.push(["Knoten / Querungen", `${s.trafficSignals} signalisierte Knoten · ${s.crossings} markierte Querungen`]);
      if (s.avgLanes != null) ocRows.push(["Ø Fahrstreifen", `${s.avgLanes.toFixed(1)} (n=${s.lanesSampleSize})`]);
      if (s.avgWidthMeters != null) ocRows.push(["Ø Fahrbahnbreite", `${s.avgWidthMeters.toFixed(1)} m (n=${s.widthSampleSize})`]);
      children.push(makeKVTable(ocRows));
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `Quelle: ${oc.source.publisher} (${oc.source.license}), via ${oc.source.retrievedVia}.`, italics: true })
        ],
        spacing: { before: 100, after: 100 }
      }));
      // Task 8 – analytische Schlussfolgerungen aus den OSM-Werten.
      if (Array.isArray(sd.osmInsights) && sd.osmInsights.length > 0) {
        children.push(new Paragraph({
          children: [new TextRun({ text: "OSM-Schlussfolgerungen:", bold: true })],
          spacing: { before: 100, after: 60 }
        }));
        for (const s of sd.osmInsights) {
          children.push(new Paragraph({ text: "• " + s, spacing: { after: 60 } }));
        }
        children.push(new Paragraph({ text: "", spacing: { after: 100 } }));
      }
    } else if (sd && sd.osmContext && sd.osmContext.quality && sd.osmContext.quality.error) {
      children.push(new Paragraph({
        text: "VERKEHRSRÄUMLICHER KONTEXT (OSM)",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 200 }
      }));
      for (const line of sd.osmContext.matchedRoads?.lines || ["OSM-Kontextdaten konnten beim Export nicht geladen werden."]) {
        children.push(new Paragraph({ children: [new TextRun({ text: line, italics: true })], spacing: { after: 200 } }));
      }
    }

    // ---- 10. FACHLICHE BEZÜGE section (if enabled) ----
    if (includeReferences) {
      const refs = sd && sd.references;
      const refsTextSection = extractSection(textLines, "Bezugsdokumente:");
      if ((refs && refs.documents && refs.documents.length > 0) || refsTextSection.length > 0) {
        children.push(
          new Paragraph({
            text: "FACHLICHE BEZÜGE",
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 400, after: 200 }
          })
        );

        if (refs && refs.documents && refs.documents.length > 0) {
          for (const doc of refs.documents) {
            const title = doc.title || "Ohne Titel";
            const meta = [doc.author, doc.date].filter(Boolean).join(", ");
            children.push(new Paragraph({
              children: [
                new TextRun({ text: `- ${title}`, bold: false }),
                ...(meta ? [new TextRun({ text: ` (${meta})`, italics: true })] : [])
              ],
              spacing: { after: 80 }
            }));
            if (doc.url) {
              // Render reference URLs as clickable hyperlinks
              const urlLink = ExternalHyperlink
                ? new ExternalHyperlink({
                    link: doc.url,
                    children: [new TextRun({ text: "Quelle öffnen", style: "Hyperlink" })]
                  })
                : new TextRun({ text: "Quelle verfügbar", italics: true });
              children.push(new Paragraph({ children: [urlLink], spacing: { after: 40 } }));
            }
          }
        } else {
          for (const line of refsTextSection) {
            children.push(new Paragraph({ text: line, spacing: { after: 100 } }));
          }
        }
      }

      // Issue 2 (e): Bisherige politische Befassung — Vorgänge aus
      // ctx.politicalReferences (politisches Recherche-Panel) als eigene
      // Unterüberschrift mit allen verfügbaren Feldern. Vorher nur in
      // TEXT/HTML sichtbar, fehlte komplett im DOCX-Export.
      const polRefs = sd && sd.politicalReferences;
      if (Array.isArray(polRefs) && polRefs.length > 0) {
        children.push(new Paragraph({
          text: "Bisherige politische Befassung",
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 200, after: 120 }
        }));
        for (const ref of polRefs) {
          const title = ref.title || "Ohne Titel";
          const href = reportLink(ref.url);
          const meta = [ref.type, ref.date, ref.gremium].filter(Boolean).join(" · ");
          children.push(new Paragraph({
            children: [
              linkedWordRun({ text: title, href }, { bold: true }),
              ...(meta ? [new TextRun({ text: ` · ${meta}`, italics: true })] : []),
              ...(ref.number ? [new TextRun(" · "), linkedWordRun({ text: `DS ${ref.number}`, href })] : []),
            ],
            spacing: { after: 40 }
          }));
          if (ref.referenceType && ref.referenceType !== ref.type) {
            children.push(new Paragraph({
              children: [new TextRun({ text: `  Klassifikation: ${ref.referenceType}`, italics: true })],
              spacing: { after: 20 }
            }));
          }
          if (ref.snippet) {
            children.push(new Paragraph({
              children: [new TextRun({ text: `  Auszug: ${String(ref.snippet).slice(0, 240)}` })],
              spacing: { after: 20 }
            }));
          }
          if (ref.reason) {
            children.push(new Paragraph({
              children: [new TextRun({ text: `  Relevanz: ${ref.reason}`, italics: true })],
              spacing: { after: 20 }
            }));
          }
          if (ref.source) {
            children.push(new Paragraph({
              children: [new TextRun({ text: `  Portal: ${ref.source}`, italics: true })],
              spacing: { after: 80 }
            }));
          }
          for (const line of snapshotCitationLines(ref.snapshot)) {
            children.push(new Paragraph({
              children: [new TextRun({ text: `  ${line}`, italics: true })],
              spacing: { after: 40 }
            }));
          }
        }
      }
    }

    // ---- 11. DATENQUELLE section ----
    children.push(
      new Paragraph({
        text: "DATENQUELLE",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 200 }
      })
    );

    children.push(
      new Paragraph({
        text: "Unfallatlas / Open-Data-Downloads. Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0).",
        spacing: { after: 200 }
      })
    );

    // ---- 12. Werkbank-Link ("→ In Werkbank öffnen") ----
    if (!formalMotion && metaLink && ExternalHyperlink) {
      children.push(new Paragraph({
        children: [
          new ExternalHyperlink({
            link: metaLink,
            children: [new TextRun({ text: "→ In Werkbank öffnen", style: "Hyperlink" })]
          })
        ],
        spacing: { before: 200, after: 100 }
      }));
    } else if (!formalMotion && metaLink) {
      children.push(new Paragraph({
        text: `→ In Werkbank öffnen: ${metaLink}`,
        spacing: { before: 200, after: 100 }
      }));
    }

    const evidenceSection = [];
    if (evidence) {
      const annexName = evidence.complete ? "Vollständige Unfallliste" : "Nummerierte Unfallliste";
      evidenceSection.push(new Paragraph({
        text: `Anlage ${1 + Number(hasMap)} – ${annexName}`,
        heading: HeadingLevel.HEADING_1, pageBreakBefore: true, keepNext: true,
        spacing: { after: 140 }
      }));
      for (const line of evidenceAnnexIntro(evidence, renderedEvidenceMapRefs.size > 0)) evidenceSection.push(motionParagraph(line));
      if (evidence.link) {
        evidenceSection.push(new Paragraph({
          children: [linkedWordRun({ text: "Nummerierte Karte in der Werkbank öffnen", href: evidence.link })],
          spacing: { after: 130 }
        }));
      }
      if (evidence.rows.length) {
        const { headers, rows } = evidenceTable(evidence, renderedEvidenceMapRefs, "evidence_map_");
        evidenceSection.push(makeDocxTable(headers, rows, undefined, {
          compact: true, colWeights: [33, 26, 64, 95, 52, 63, 54, 44, 30].slice(0, headers.length)
        }));
      }
      for (const line of [evidence.sourceNote, ...evidence.limitations].filter(Boolean)) {
        evidenceSection.push(motionParagraph(line, { spacing: { before: 70, after: 30 } }));
      }
    }
    if (formalMotion) children.splice(firstAnnexIndex, 0, ...mapSection, ...evidenceSection);

    // Create document
    const doc = new Document({
      ...(formalMotion ? {
        title: subject,
        description: docTitle,
        styles: { default: { document: { run: { size: 22, language: { value: "de-DE" } } } } }
      } : {}),
      ...(motion.requests.length ? {
        numbering: { config: [{ reference: MOTION_NUMBERING, levels: [{
          level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 380, hanging: 380 } } }
        }] }] }
      } : {}),
      sections: [{
        properties: formalMotion ? {
          page: { size: { width: 11906, height: 16838 }, margin: { top: 940, right: 1000, bottom: 990, left: 1000 } }
        } : {},
        ...(formalMotion ? { footers: { default: new Footer({ children: [new Paragraph({
          children: [new TextRun({ children: ["Unfallwerkbank · Seite ", PageNumber.CURRENT, " von ", PageNumber.TOTAL_PAGES], size: 17, color: "435766" })],
          alignment: AlignmentType.RIGHT
        })] }) } } : {}),
        children
      }]
    });

    // Generate and download
    const blob = await Packer.toBlob(doc);
    const citySlug = CITY_RAW
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    // Use dynamic title prefix for filename (normalize same way as citySlug)
    const titleSlug = docTitle
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const filename = `${titleSlug}_${citySlug}_${today.replace(/\./g, "-")}.docx`;
    
    if (window.saveAs) {
      window.saveAs(blob, filename);
    } else {
      // Fallback download
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  // =====================================================================
  // PDF Export (using pdfmake)
  // =====================================================================

  /**
   * Build Werkbank URL from current application context
   * @param {Object} ctx - Application context
   * @returns {string} URL to Werkbank page with current parameters
   */
  function buildWerkbankUrl(ctx, override) {
    const params = new URLSearchParams();
    const ovr = override || {};
    
    // City
    if (ctx.CITY_RAW) {
      params.set("city", ctx.CITY_RAW);
    }
    
    // UI filters (if available)
    const allCombOverride = ovr.allCombinations === true;
    if (ctx.ui) {
      if (ctx.ui.severityEl) params.set("severity", ctx.ui.severityEl.value);
      if (ctx.ui.roadConditionEl) params.set("roadCondition", ctx.ui.roadConditionEl.value);
      if (ctx.ui.dayTypeEl) params.set("dayType", ctx.ui.dayTypeEl.value);
      if (ctx.ui.hFromEl) params.set("hourFrom", ctx.ui.hFromEl.value);
      if (ctx.ui.hToEl) params.set("hourTo", ctx.ui.hToEl.value);
      if (ctx.ui.maxPointsEl) params.set("maxPoints", ctx.renderPointLimit ?? ctx.ui.maxPointsEl.value);
      if (ctx.ui.viewportPaddingEl) params.set("viewportPaddingPct", ctx.ui.viewportPaddingEl.value);
      if (ctx.ui.heatRadiusEl) params.set("heatRadius", ctx.ui.heatRadiusEl.value);
    }
    const involvementFields = {
      includeCyclist: "incBikeEl", includePedestrian: "incPedEl", includeCar: "incCarEl",
      includeMotorcycle: "incMotoEl", includeGkfz: "incGkfzEl", includeSonstig: "incSonEl"
    };
    for (const [key, field] of Object.entries(involvementFields)) {
      const input = ctx.ui?.[field];
      if (allCombOverride || input) params.set(key, allCombOverride || input.checked ? 1 : 0);
    }
    if (allCombOverride || ctx.involvementMode) {
      params.set("involvementMode", allCombOverride ? "or" : ctx.involvementMode);
    }
    const { slopeClasses, trafficClasses, onlyMatchedWays } = ctx.contextFilters || {};
    if (slopeClasses?.size) params.set("ctxSlope", [...slopeClasses].sort().join(","));
    if (trafficClasses?.size) params.set("ctxTraffic", [...trafficClasses].sort().join(","));
    if (onlyMatchedWays) params.set("ctxOnlyMatched", "1");
    
    // Display modes
    if (ctx.showCluster !== undefined) params.set("showCluster", ctx.showCluster ? 1 : 0);
    if (ctx.showHeatmap !== undefined) params.set("showHeatmap", ctx.showHeatmap ? 1 : 0);
    if (ctx.showOnlyAboveAverage !== undefined) params.set("showOnlyAboveAverage", "0");
    if (ctx.mapMode) params.set("mapMode", ctx.mapMode);
    if (Number.isFinite(Number(ctx.orthophotoOpacity))) {
      params.set("orthophotoOpacity", Math.round(Number(ctx.orthophotoOpacity) * 100));
    }
    if (ovr.discoveryFocus?.key || ovr.discoveryFocus?.site) {
      params.set("siteFocus", ovr.discoveryFocus.key || "all");
      const { fromYear, toYear, severity, type, involvement } = ovr.discoveryFocus.query || {};
      for (const [name, value] of Object.entries({ siteFrom: fromYear, siteTo: toYear, siteSeverity: severity, siteType: type, siteInvolvement: involvement })) {
        if (value != null && value !== "") params.set(name, value);
      }
      params.set("siteMapFilters", "1");
      if (ovr.discoveryFocus.site) {
        params.set("siteNetworkId", ovr.discoveryFocus.site.id);
        params.set("siteNetworkRev", ovr.discoveryFocus.site.revision);
      }
    }

    // Map position – override.center / override.zoom take precedence so each
    // exported map (overview, detail, cluster A, cluster B) gets its own
    // unique URL pointing exactly at its cluster (Task 3).
    if (ovr.center && Number.isFinite(ovr.center.lat) && Number.isFinite(ovr.center.lon)) {
      params.set("centerLat", Number(ovr.center.lat).toFixed(6));
      params.set("centerLon", Number(ovr.center.lon).toFixed(6));
    } else if (ctx.map) {
      const center = ctx.map.getCenter();
      params.set("centerLat", center.lat.toFixed(6));
      params.set("centerLon", center.lng.toFixed(6));
    }
    if (Number.isFinite(Number(ovr.zoom))) {
      params.set("zoom", Number(ovr.zoom));
    } else if (ctx.map) {
      params.set("zoom", ctx.map.getZoom());
    }

    const b = boundsToBbox(ovr.bounds || ctx.selectionBounds);
    if (b) {
      // Do not round a point-defined boundary inward. Use the smallest
      // representable neighbourhood for collapsed axes so the UI accepts it.
      const dLat = b.south === b.north ? Number.EPSILON * Math.max(1, Math.abs(b.south)) : 0;
      const dLon = b.west === b.east ? Number.EPSILON * Math.max(1, Math.abs(b.west)) : 0;
      params.set("selSouth", String(Math.max(-90, b.south - dLat)));
      params.set("selWest",  String(Math.max(-180, b.west - dLon)));
      params.set("selNorth", String(Math.min(90, b.north + dLat)));
      params.set("selEast",  String(Math.min(180, b.east + dLon)));
    }
    
    // Build full URL
    // Determine werkbank path:
    // 1) per-call override via ctx.werkbankPath
    // 2) global configuration via window.UA_WERKBANK_PATH
    // 3) fallback: same directory as current page (preserve existing behavior)
    const fallbackWerkbankPath = window.location.pathname.replace(/[^/]*$/, "werkbank_v2.html");
    const werkbankPath =
      (ctx && ctx.werkbankPath) ||
      (typeof window !== "undefined" && window.UA_WERKBANK_PATH) ||
      fallbackWerkbankPath;

    // Build full URL using URL API for robust resolution
    const baseUrl = new URL(werkbankPath, window.location.origin).toString();
    
    // Only append query string if there are parameters
    const query = params.toString();
    return query ? `${baseUrl}?${query}` : baseUrl;
  }
  // Expose for testing purposes
  UA.buildWerkbankUrl = buildWerkbankUrl;

  /**
   * Convert text to pdfMake content with auto-detected clickable links
   * @param {string} text - Text that may contain URLs
   * @returns {Array|string} pdfMake content array with links or plain text
   */
  function textWithLinks(text) {
    if (text == null) {
      return "";
    }
    // URL regex pattern - matches URLs and excludes common trailing punctuation
    // that is likely to be sentence punctuation rather than part of the URL
    const urlPattern = /(https?:\/\/[^\s)]+?)([.,!?;:)]*)(?=\s|$)/g;
    const matches = [...text.matchAll(urlPattern)];
    
    if (matches.length === 0) {
      return text;
    }
    
    // Split text and create content array with links
    const content = [];
    let lastIndex = 0;
    
    for (const match of matches) {
      const url = match[1]; // URL without trailing punctuation
      const trailingPunct = match[2]; // Captured trailing punctuation
      const offset = match.index;
      
      // Add text before URL
      if (offset > lastIndex) {
        content.push({ text: text.substring(lastIndex, offset) });
      }
      
      // Add URL as link
      content.push({
        text: url,
        link: url,
        color: "blue",
        decoration: "underline"
      });
      
      // Add trailing punctuation as regular text (if any)
      if (trailingPunct) {
        content.push({ text: trailingPunct });
      }
      
      lastIndex = offset + match[0].length;
    }
    
    // Add remaining text
    if (lastIndex < text.length) {
      content.push({ text: text.substring(lastIndex) });
    }
    
    return content;
  }

  /**
   * Replace involvement icons / bracket tokens with verwaltungstaugliche
   * prose labels for PDF export (QA-PR „Export-Semantik vor Layout").
   *
   * Im sichtbaren PDF dürfen weder Emojis (`🚲`/`🚗`/…) noch die
   * Übergangs-Bracket-Tokens (`[Rad]`/`[PKW]`/…) erscheinen — sie sind
   * für ein Verwaltungspublikum nicht akzeptabel und auf vielen
   * Behörden-Arbeitsplätzen ohne Emoji-Font unleserlich. Stattdessen
   * nutzen wir die zentralen Prosa-Labels aus
   * `UA.proseLabelForExport` (definiert in js/ua.export_v2.js).
   *
   * Fallback: wenn das Modul `UA.proseLabelForExport` nicht geladen ist
   * (bei Standalone-Tests von ua.report_v2.js ohne ua.export_v2.js),
   * substituieren wir mit derselben Prosa-Tabelle als Inline-Fallback.
   *
   * @param {string} text - Text containing emoji icons and/or [Rad]-tokens
   * @returns {string} Text with all involvement glyphs replaced by prose
   */
  function replaceEmojisForPDF(text) {
    if (text == null) return "";
    if (typeof UA.proseLabelForExport === "function") {
      return UA.proseLabelForExport(text);
    }
    // Inline fallback (mirror of UA.proseLabelForExport).
    let s = String(text);
    const PROSE = {
      Rad: "Radverkehr", Fuss: "Fußverkehr", PKW: "PKW",
      Krad: "Motorrad", Lkw: "LKW/Güterverkehr", Sonst: "Sonstige Beteiligte"
    };
    s = s.replace(/\[(Rad|Fuss|PKW|Krad|Lkw|Sonst)\]/g, (_, k) => PROSE[k] || _);
    s = s
      .replace(/\u{1F6B2}/gu, PROSE.Rad)
      .replace(/\u{1F6B6}/gu, PROSE.Fuss)
      .replace(/\u{1F697}/gu, PROSE.PKW)
      .replace(/\u{1F3CD}[\u{FE0F}]?/gu, PROSE.Krad)
      .replace(/\u{1F69B}/gu, PROSE.Lkw)
      .replace(/\u{1F68C}/gu, PROSE.Sonst);
    s = s.replace(/(\p{L})\s*\+\s*(\p{L})/gu, "$1 + $2");
    return s;
  }

  /**
   * DOCX-Variante derselben Prosa-Substitution. Wir routen die DOCX-
   * Anzeigetexte durch dieselbe Funktion wie das PDF, damit beide
   * Exportformate identische Beteiligten-Beschriftungen führen
   * (QA-PR „Export-Semantik vor Layout").
   * Exportiert als `UA.replaceEmojisForDocx`, damit Tests sie einzeln
   * prüfen können.
   */
  function replaceEmojisForDocx(text) {
    return replaceEmojisForPDF(String(text == null ? "" : text));
  }
  UA.replaceEmojisForDocx = replaceEmojisForDocx;

  /**
   * PR-QA „Textqualität": Übersetzt rohe technische Filterwerte in
   * lesbare deutsche Begriffe. Rohwerte wie "all", "wet", "dry" entstehen
   * direkt aus den UI-Selectors und gehören nicht in einen
   * einreichungsreifen Bezirksratsantrag.
   *
   * Bekannte Werte werden umgesetzt; alles andere wird unverändert
   * zurückgegeben (numerische Codes, Eigennamen). "all" bzw. "*" werden
   * grundsätzlich zu „Alle" bzw. „Alle (keine Einschränkung)".
   *
   * @param {string} key   - Filtername (z. B. "severity", "dayType")
   * @param {string|number} val
   * @returns {string}
   */
  function formatFilterValue(key, val) {
    if (val == null) return "—";
    const s = String(val).trim();
    const lower = s.toLowerCase();
    if (lower === "all" || lower === "*" || lower === "any") return "Alle (keine Einschränkung)";
    const dicts = {
      severity: {
        "1": "Getötete", "2": "Schwerverletzte", "3": "Leichtverletzte",
        "tot": "Getötete", "schwer": "Schwerverletzte", "leicht": "Leichtverletzte"
      },
      roadCondition: {
        "0": "trocken", "1": "nass/feucht/schlüpfrig", "2": "winterglatt",
        "dry": "trocken", "wet": "nass/feucht/schlüpfrig", "winter": "winterglatt"
      },
      dayType: {
        "weekday": "Werktag (Mo–Fr)", "weekend": "Wochenende (Sa/So)",
        "mo-fr": "Werktag (Mo–Fr)", "sa-so": "Wochenende (Sa/So)"
      },
      involvementMode: {
        "or": "ODER (eine der gewählten Beteiligungen)",
        "and": "UND (alle gewählten Beteiligungen gemeinsam)",
        "solo": "Nur Solo (genau eine Beteiligung)"
      }
    };
    const dict = dicts[key];
    if (dict && Object.prototype.hasOwnProperty.call(dict, lower)) return dict[lower];
    return s;
  }
  UA.formatFilterValue = formatFilterValue;

  /**
   * PR-QA „Textqualität": Deutsches Zahlformat für Faktor-Werte. Aus
   * „Faktor 2.18" wird „Faktor 2,18". Wird sowohl im DOCX/PDF als auch
   * in den TEXT/HTML-Renderern verwendet. Liefert „k. A." bei NaN/∞.
   * @param {number} factor
   * @param {number} [decimals=2]
   */
  function formatFactorDe(factor, decimals) {
    if (!Number.isFinite(factor)) return "k. A.";
    const d = (typeof decimals === "number") ? decimals : 2;
    return factor.toFixed(d).replace(".", ",");
  }
  UA.formatFactorDe = formatFactorDe;


  // ---------------------------------------------------------------------
  // PDF involvement icons (issue: "Symbole … sichtbar machen in der PDF")
  //
  // Inline-SVG pictograms for the 6 involvement classes. They are embedded
  // directly into pdfMake table cells via { svg, width, height } content
  // nodes, which renders independently of the (Roboto) text font and so
  // works without bundling an emoji-capable TTF.
  //
  // The SVGs are kept tiny and monochrome (single dark-grey fill) so they
  // print cleanly in B/W and stay legible at the table font sizes we use
  // (~9 pt). All viewBoxes are 24×24 → easy to scale uniformly.
  // ---------------------------------------------------------------------
  const PDF_ICON_FILL = "#222";
  // Source: Material-design / Tabler-style minimalist pictograms, hand-trimmed
  // to single <path> elements per icon to keep the inline SVG small. Each is
  // a stand-alone, self-contained SVG document (no external refs).
  const PDF_INVOLVEMENT_ICONS = {
    bike:  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="' + PDF_ICON_FILL + '" d="M5 18a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm0-1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm14 1.5a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm0-1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM15 6h3v2h-2l-2.3 4.6 2 3.4H13l-1.5-2.6L9 17H7l3.5-6.3L9 8H7V6h3l1.5 3h2L15 6Z"/></svg>',
    ped:   '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="' + PDF_ICON_FILL + '" d="M13.5 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM10 8h2.5l2 4 2.5 1-.5 1.5-3-1-1.5-2v3l2 5h-1.7l-2-5-2 5H6l2-6V9.5L7 11l-2 1V10l2.5-1L10 8Z"/></svg>',
    car:   '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="' + PDF_ICON_FILL + '" d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11h.5a1.5 1.5 0 0 1 1.5 1.5V17a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H6v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4.5A1.5 1.5 0 0 1 4.5 11H5Zm1.7 0h10.6l-1-3a.5.5 0 0 0-.5-.4H8.2a.5.5 0 0 0-.5.4l-1 3ZM7 14.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm10 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"/></svg>',
    moto:  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="' + PDF_ICON_FILL + '" d="M5 17a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm0-1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm14 1.5a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm0-1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM14 7h3l2 4-2 1-2-3h-1.5l-1.5 2 2.5 2-1 1.5-3-2.5-2 1V12l1.5-1L8 8H6V6h2.5L11 8h3V7Z"/></svg>',
    truck: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="' + PDF_ICON_FILL + '" d="M3 7a1 1 0 0 1 1-1h9v8H3V7Zm11 1h3.5l2.5 3v3h-1a2 2 0 1 1-4 0h-1V8Zm3 5h2v-1.5L17.7 9.5H17V13ZM7 17a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm10 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4ZM7 15.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1Zm10 0a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1Z"/></svg>',
    bus:   '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="' + PDF_ICON_FILL + '" d="M6 4h12a2 2 0 0 1 2 2v10a2 2 0 0 1-1 1.7V19a1 1 0 0 1-2 0v-1H7v1a1 1 0 0 1-2 0v-1.3A2 2 0 0 1 4 16V6a2 2 0 0 1 2-2Zm0 2v5h12V6H6Zm0 7v3h12v-3H6Zm2 2.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm8 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"/></svg>'
  };
  // Map original emoji codepoints → icon key. Mirrors COMBO_BITS in
  // js/ua.export_v2.js so the two stay in sync.
  const PDF_EMOJI_TO_KEY = {
    "\u{1F6B2}": "bike",   // 🚲
    "\u{1F6B6}": "ped",    // 🚶
    "\u{1F697}": "car",    // 🚗
    "\u{1F3CD}": "moto",   // 🏍 (variation-selector handled by stripping below)
    "\u{1F69B}": "truck",  // 🚛
    "\u{1F68C}": "bus"     // 🚌
  };
  // Regex matches any of the involvement emojis (with optional VS-16 selector).
  const PDF_EMOJI_RE = /(\u{1F6B2}|\u{1F6B6}|\u{1F697}|\u{1F3CD}\u{FE0F}?|\u{1F69B}|\u{1F68C})/u;

  /**
   * Build a pdfMake table-cell content node for an involvement label.
   * If `label` contains no involvement emoji, returns the original string
   * unchanged so callers stay back-compatible. Otherwise returns a `columns`
   * node where every emoji is rendered as an inline SVG icon and any non-
   * emoji text (e.g. " + ", counts, prefixes like "Mask " for unknown masks)
   * is preserved as plain text — emojis themselves are replaced with their
   * pictogram so no glyph is left for the unsupported font to render.
   *
   * @param {string} label   e.g. "🚲+🚗" or "🚲: 4"
   * @param {object} [opts]  { fontSize?: number, iconSize?: number, bold?: boolean }
   * @returns {string|object} pdfMake content node
   */
  function pdfInvolvementCell(label, opts) {
    const s = String(label == null ? "" : label);
    if (!PDF_EMOJI_RE.test(s)) return s;
    const fontSize = (opts && opts.fontSize) || 9;
    const iconSize = (opts && opts.iconSize) || (fontSize + 2);
    const bold = !!(opts && opts.bold);
    // Tokenise: split on the emoji regex, alternating text / emoji.
    const parts = s.split(PDF_EMOJI_RE);
    const cols = [];
    for (const part of parts) {
      if (!part) continue;
      // Strip optional VS-16 (\uFE0F) so the lookup hits 🏍.
      const stripped = part.replace(/\uFE0F/g, "");
      const key = PDF_EMOJI_TO_KEY[stripped];
      if (key && PDF_INVOLVEMENT_ICONS[key]) {
        cols.push({ svg: PDF_INVOLVEMENT_ICONS[key], width: iconSize, height: iconSize, margin: [0, 0, 1, 0] });
      } else {
        cols.push({ text: part, fontSize, bold, margin: [0, 1, 1, 0] });
      }
    }
    return { columns: cols, columnGap: 1 };
  }
  // Expose for unit tests; harmless if a future refactor moves it elsewhere.
  UA.pdfInvolvementCell = pdfInvolvementCell;

  /**
   * Generate and download PDF document
   * @param {Object} ctx - Application context
   * @param {Object} reportData - Report data from UA.computeExportReport
   * @param {Object} options - Export options
   */
  UA.exportToPDF = async function exportToPDF(ctx, reportData, options = {}) {
    // Ensure export libraries are loaded
    await UA.ensureExportLibraries();
    
    if (!window.pdfMake) {
      throw new Error("pdfMake library not loaded");
    }

    const CITY_RAW = ctx.CITY_RAW || "—";
    const today = new Date().toLocaleDateString("de-DE");
    // Replace emojis with text labels for PDF compatibility
    const pdfText = replaceEmojisForPDF(reportData.text || "");
    const textLines = pdfText.split("\n");

    // Use structured data if available
    const sd = reportData.structured || null;
    const evidence = numberedEvidence(sd);
    const formalMotion = Boolean(evidence || sd?.motion);
    const hasMap = Boolean(options.includeMap && ctx.map);
    const analysisAnnexNumber = 1 + Number(hasMap) + Number(Boolean(evidence));
    const renderedEvidenceMapRefs = new Set();

    function linkedPdfRun({ text, href, anchor }, fontSize) {
      return {
        text: replaceEmojisForPDF(String(text ?? "")),
        ...(fontSize ? { fontSize } : {}),
        ...(href ? { link: href, color: "#174F71", decoration: "underline" } : {}),
        ...(anchor ? { linkToDestination: anchor, color: "#174F71", decoration: "underline" } : {})
      };
    }

    // Task 5: Dedup-Guard für PDF (siehe DOCX-Variante).
    const renderedSections = new Set();
    function sectionGuard(name) {
      if (renderedSections.has(name)) return true;
      renderedSections.add(name);
      return false;
    }

    // Helper: format percentage for PDF
    function fmtPctPdf(n, total) {
      return total ? ((n / total) * 100).toFixed(1).replace(".", ",") + " %" : "0,0 %";
    }

    // Helper: build pdfmake table with header row
    // Optional: rowHighlights is an array of booleans – true = highlight that data row
    // Optional: opts.widths overrides column widths (default: equal "*" split).
    //           opts.fontSize overrides per-cell font size (default 9).
    // Cells may be plain strings (rendered as { text }) OR pre-built pdfMake
    // content objects (e.g. { columns: [...] } for cells produced by
    // pdfInvolvementCell). The latter pass through unchanged so callers can
    // embed inline SVG icons or other rich layouts without extra plumbing.
    function makePdfTable(headers, dataRows, rowHighlights, opts) {
      const fontSize = (opts && opts.fontSize) || 9;
      const widths = (opts && opts.widths) || headers.map(() => "*");
      const wrapCell = (cell, highlight) => {
        if (cell != null && typeof cell === "object") {
          // Pass-through for rich content (svg/columns/stack). Apply highlight
          // by wrapping in a 1-row table-like fillColor cell only if needed —
          // pdfMake honors `fillColor` on the cell descriptor itself, which
          // for compound nodes we set on the wrapping object.
          return highlight ? Object.assign({}, cell, { fillColor: "#FFFFCC" }) : cell;
        }
        // QA-PR „Export-Semantik vor Layout": jede sichtbare String-Zelle
        // wird durch die zentrale Prosa-Substitution gefiltert. Damit
        // erscheinen weder Beteiligten-Emojis (🚲/🚗/…) noch die internen
        // Bracket-Tokens („[Rad]+[PKW]") in den PDF-Tabellen — nur die
        // verwaltungstauglichen Prosa-Labels („Radverkehr + PKW").
        const safe = replaceEmojisForPDF(String(cell ?? ""));
        return {
          text: safe,
          fontSize,
          ...(highlight ? { fillColor: "#FFFFCC", bold: true } : {})
        };
      };
      return {
        table: {
          headerRows: 1,
          ...(opts?.keepRowsTogether ? { dontBreakRows: true, keepWithHeaderRows: 1 } : {}),
          widths,
          body: [
            headers.map(h => ({ text: h, bold: true, fillColor: "#EEEEEE", fontSize })),
            ...dataRows.map((row, i) => row.map(cell => wrapCell(cell, !!(rowHighlights && rowHighlights[i]))))
          ]
        },
        layout: opts?.layout || "lightHorizontalLines",
        margin: [0, 4, 0, 10]
      };
    }

    // Helper: noteBox — light-gray, padded, single-cell info box.
    // Wird im Layout-PR für die "Hinweis zur Zählweise"-Box (und potentiell
    // weitere kursiv-graue Hinweisblöcke) verwendet, damit pdfMake echtes
    // Padding + Hintergrund rendert (Text-Knoten allein erlauben das nicht).
    // `lines` ist ein Array von pdfMake-text-Knoten ODER plain-Strings.
    function makePdfNoteBox(lines) {
      const linesArr = (Array.isArray(lines) ? lines : [lines])
        .filter((x) => x != null);
      const stack = linesArr.map((ln) => {
        if (ln && typeof ln === "object") return ln;
        return { text: String(ln), style: "noteBox" };
      });
      return {
        table: {
          widths: ["*"],
          body: [[
            {
              stack,
              fillColor: "#F2F2F2",
              margin: [8, 6, 8, 6],
              border: [false, false, false, false]
            }
          ]]
        },
        layout: "noBorders",
        margin: [0, 6, 0, 8]
      };
    }


    const pdfAfm = (sd && sd.meta && sd.meta.activeFilterMask) || 0;
    const pdfAfMode = (sd && sd.meta && sd.meta.involvementMode) || "or";
    function isPdfActiveFilterRow(rowMask) {
      if (pdfAfm === 0) return false;
      if (pdfAfMode === "solo") {
        const isSingleBit = rowMask > 0 && (rowMask & (rowMask - 1)) === 0;
        return isSingleBit && (rowMask & pdfAfm) !== 0;
      }
      if (pdfAfMode === "and") {
        return (rowMask & pdfAfm) === pdfAfm;
      }
      return (rowMask & pdfAfm) !== 0;
    }

    const docDefinition = {
      pageSize: "A4",
      pageBreakBefore(currentNode, nodeContainer) {
        if (currentNode.id === "analysis-annex-heading") {
          return nodeContainer.getPreviousNodesOnPage().some(node => node.text || node.image || node.svg);
        }
        if (currentNode.id === "hour-heatmap-heading") {
          return !nodeContainer.getFollowingNodesOnPage().some(node => node.id === "hour-heatmap-first-data");
        }
        return currentNode.headlineLevel === 2 && !nodeContainer.getFollowingNodesOnPage().length;
      },
      // Reduced left/right margins (was 60/60) so wide tables — especially the
      // Einzelunfall-Detailtabelle with 7+ columns — fit within the printable
      // area instead of overflowing the page edge.
      pageMargins: formalMotion ? [40, 46, 40, 48] : [40, 60, 40, 60],
      content: [],
      styles: {
        // ---- Layout-Pass: kanonische Style-Namen ----
        // Die neuen Stilnamen (title/sectionHeader/subsectionHeader/body/
        // lead/caption/noteBox) bilden die im Layout-PR vorgegebene zentrale
        // Typografie ab. Die Legacy-Namen (header/subheader/subheader2/
        // normal/small) bleiben als Aliase erhalten, damit bestehende Call-
        // sites unverändert weiter funktionieren — neue Inhalte SOLLEN aber
        // konsequent die kanonischen Namen verwenden.
        title: {
          fontSize: 20,
          bold: true,
          alignment: "center",
          margin: [0, 0, 0, 12]
        },
        sectionHeader: {
          fontSize: 15,
          bold: true,
          margin: [0, 12, 0, 6]
        },
        subsectionHeader: {
          fontSize: 12,
          bold: true,
          margin: [0, 8, 0, 4]
        },
        body: {
          fontSize: 11,
          margin: [0, 0, 0, 4],
          lineHeight: 1.3
        },
        lead: {
          fontSize: 12,
          bold: true,
          margin: [0, 0, 0, 6]
        },
        caption: {
          fontSize: 9,
          italics: true,
          color: "#444444",
          margin: [0, 2, 0, 8]
        },
        // noteBox als Style-Definition — wird von einer leichten Tabelle mit
        // einer einzigen Zelle (fillColor=lightGray) genutzt, damit pdfMake
        // tatsächlich Padding+Background rendert (pdfMake unterstützt
        // Padding nicht direkt auf Text-Knoten). Bewusst KEIN `margin` hier:
        // der Style wird per Zeile (`stack[i].style = "noteBox"`) gesetzt
        // und würde sich sonst pro Zeile aufaddieren — Außenabstände
        // kommen vom Cell-`margin` (Padding) und der Wrapper-Tabelle in
        // `makePdfNoteBox()`.
        noteBox: {
          fontSize: 10,
          color: "#222222"
        },
        motionType: { fontSize: 10, bold: true, color: "#254B61", margin: [0, 0, 0, 5] },
        motionTitle: { fontSize: 21, bold: true, color: "#163B50", margin: [0, 0, 0, 6] },
        motionMeta: { fontSize: 10, color: "#435766", margin: [0, 0, 0, 12] },
        motionBody: { fontSize: 11, lineHeight: 1.18, margin: [0, 0, 0, 5] },
        motionNote: { fontSize: 9, lineHeight: 1.12, margin: [0, 1, 0, 5] },

        // ---- Legacy-Aliase (siehe Kommentar oben) ----
        header: {
          fontSize: 18,
          bold: true,
          alignment: "center",
          margin: [0, 0, 0, 10]
        },
        subheader: {
          fontSize: 14,
          bold: true,
          margin: [0, 10, 0, 5]
        },
        // Phase 1.4: dritte Hierarchiestufe für Sub-Sub-Sektionen
        // (z. B. "Detailansicht – markierter Bereich" und einzelne
        // Cluster-Karten innerhalb von KARTENAUSSCHNITT). Kleinere Schrift
        // und engere Margins trennen sie optisch von Hauptkapiteln.
        subheader2: {
          fontSize: 12,
          bold: true,
          margin: [0, 6, 0, 3]
        },
        normal: {
          fontSize: 11,
          margin: [0, 0, 0, 5]
        },
        small: {
          fontSize: 9,
          italics: true,
          color: "#666666"
        }
      },
      defaultStyle: {
        font: "Roboto"
      }
    };
    const setup = formalMotion ? [] : docDefinition.content;

    // ---- Title / Cover ----
    // Derive document title from structured data (same logic as Word export)
    const gremiumMeta = sd && sd.meta && sd.meta.gremium ? sd.meta.gremium : {};
    const docTitle = deriveDocTitle(gremiumMeta.typ);

    const metaCity   = (sd && sd.meta && sd.meta.city)     || CITY_RAW;
    const metaArea   = (sd && sd.meta && sd.meta.areaName) || "(Kartenausschnitt)";
    const metaDate   = (sd && sd.meta && sd.meta.date)     || today;
    const metaToWhom = gremiumMeta.gremium || "Zuständiges Gremium vor Einreichung prüfen";
    const subject = replaceEmojisForPDF(reportSubject(reportData));
    if (formalMotion) {
      docDefinition.language = "de-DE";
      docDefinition.displayTitle = true;
      docDefinition.info = { title: subject, subject: docTitle };
      docDefinition.footer = (page, total) => ({
        text: `Unfallwerkbank · Seite ${page} von ${total}`, alignment: "right", fontSize: 8,
        color: "#435766", margin: [40, 13, 40, 0]
      });
      docDefinition.content.push(
        { text: docTitle.toUpperCase(), style: "motionType" },
        { text: subject, style: "motionTitle", fontSize: 19, headlineLevel: 1 },
        { text: [metaToWhom, metaCity, metaDate, ...(sd?.meta?.areaName && !subject.includes(metaArea) ? [metaArea] : [])].join(" · "), style: "motionMeta" }
      );
    } else {
      docDefinition.content.push({ text: docTitle.toUpperCase(), style: "header" });
      const headerLines = [["An:", metaToWhom], ["Stadt:", metaCity], ["Bereich:", metaArea], ["Datum:", metaDate], ["Betreff:", subject]];
      for (const [label, value] of headerLines) {
        docDefinition.content.push({
          text: [{ text: `${label} `, bold: true }, { text: value }],
          style: "normal", margin: [0, 2, 0, 2]
        });
      }
      docDefinition.content.push({
        canvas: [{ type: 'line', x1: 0, y1: 0, x2: 450, y2: 0, lineWidth: 0.5, lineColor: '#888888' }],
        margin: [0, 5, 0, 15]
      });
    }

    // ---- Rahmendaten table ----
    const metaLink = (sd && sd.meta && sd.meta.link) || "";
    const kvRahmen = [
      !formalMotion        ? ["Dokumenttyp",          docTitle]            : null,
      !formalMotion && gremiumMeta.gremium ? ["Gremium", gremiumMeta.gremium] : null,
      !formalMotion && gremiumMeta.typ ? ["Gremiumstyp", gremiumMeta.typ] : null,
      gremiumMeta.kontakt  ? ["Kontakt",               gremiumMeta.kontakt]  : null,
      !formalMotion && metaArea ? ["Bereich", metaArea] : null,
      !formalMotion && metaCity ? ["Stadt", metaCity] : null,
      !formalMotion && metaDate ? ["Exportdatum", metaDate] : null,
      // PR-QA „Werkbank-Link in Tabelle": kurzer Linktext statt
      // vollständigem URL — pdfmake-Hyperlink über `link:` + Zellinhalt.
      metaLink             ? ["Werkbank-Link",
                              { text: "Werkbank-Link öffnen", link: metaLink, color: "blue", decoration: "underline" }
                             ] : null,
      gremiumMeta.hinweis  ? ["Zuständigkeitshinweis", gremiumMeta.hinweis]  : null
    ].filter(Boolean);

    if (kvRahmen.length > 0) {
      setup.push({ text: "Rahmendaten", style: "subheader" });
      // Narrow label column + flexible value column so long values like the
      // Werkbank-Link don't push the whole table off-page.
      setup.push(makePdfTable(
        ["Feld", "Wert"],
        kvRahmen,
        undefined,
        { widths: ["auto", "*"] }
      ));
    }

    // ---- Aktive Filter table ----
    // PR-QA „Textqualität": rohe Werte wie "all" in lesbare Begriffe
    // übersetzen (siehe UA.formatFilterValue für die Wörterbücher).
    const filters = (sd && sd.meta && sd.meta.filters) || {};
    const filterRows = [];
    if (filters.severity      != null) filterRows.push(["Schweregrad",       UA.formatFilterValue("severity", filters.severity)]);
    if (filters.roadCondition != null) filterRows.push(["Fahrbahnzustand",   UA.formatFilterValue("roadCondition", filters.roadCondition)]);
    if (filters.involvementMode != null) filterRows.push(["Beteiligungsmodus", UA.formatFilterValue("involvementMode", filters.involvementMode)]);

    // Render the active "Beteiligte" line as Prosa-Textlabel (QA-PR
    // „Export-Semantik vor Layout"): keine Emojis/Icons im PDF.
    const partCodesPdf = [];
    if (filters.includeCyclist)    partCodesPdf.push("Rad");
    if (filters.includePedestrian) partCodesPdf.push("Fuss");
    if (filters.includeCar)        partCodesPdf.push("PKW");
    if (filters.includeMotorcycle) partCodesPdf.push("Krad");
    if (filters.includeGkfz)       partCodesPdf.push("Lkw");
    if (filters.includeSonstig)    partCodesPdf.push("Sonst");
    if (partCodesPdf.length > 0) {
      const partProsePdf = (typeof UA.formatParticipantCombinationForExport === "function")
        ? UA.formatParticipantCombinationForExport(partCodesPdf)
        : partCodesPdf.join(" + ");
      filterRows.push(["Beteiligte", partProsePdf]);
    }

    if (filters.hourFrom != null && filters.hourTo != null) {
      filterRows.push(["Zeitraum", `${filters.hourFrom}:00-${filters.hourTo}:00 Uhr`]);
    }
    if (filters.dayType != null) filterRows.push(["Wochentag", UA.formatFilterValue("dayType", filters.dayType)]);

    if (filterRows.length > 0) {
      setup.push({ text: "Aktive Filter", style: "subheader" });
      setup.push(makePdfTable(
        ["Filter", "Wert"],
        filterRows,
        undefined,
        { widths: ["auto", "*"] }
      ));
    }

    // ---- Hinweis zur Zählweise (PR 2 / Spec-Item 4) ----
    // Layout-Pass: als echte noteBox (light-gray, padded) statt als loser
    // kursiver Text — damit der Hinweis visuell als Block erkennbar ist
    // und vom Antragstext klar abgesetzt wird.
    if (!evidence) {
      setup.push(makePdfNoteBox([
        { text: HINWEIS_ZAEHLWEISE_LINES[0], style: "noteBox", bold: true, margin: [0, 0, 0, 3] },
        { text: HINWEIS_ZAEHLWEISE_LINES[1], style: "noteBox" }
      ]));
    }

    // ---- Methodik – Scope der Auswertung (PR 2 / Spec-Item 6) ----
    if (sd && sd.methodikScope && Array.isArray(sd.methodikScope.lines) && sd.methodikScope.lines.length > 0) {
      // Keep this short semantic block together. Without an unbreakable
      // container pdfMake may carry only the final word of the last sentence
      // (for example "Wochentag).") onto the next page immediately before
      // the Antrag heading, which is visually misleading and hard to scan.
      setup.push({
        unbreakable: true,
        stack: [
          {
            text: sd.methodikScope.title || "Methodik – Auswertungsbereich",
            style: "subsectionHeader"
          },
          ...sd.methodikScope.lines.map(ln => ({
            text: formalMotion ? methodLineForMotion(ln) : String(ln),
            style: "body"
          }))
        ],
        margin: [0, 0, 0, 6]
      });
    }

    // PR 2 / Spec-Item 4: per-export figure-caption counter (PDF side).
    const pdfFigCounter = makeFigureCounter();

    const motion = motionSections(sd, textLines, hasMap);
    const selectedCouncilRecords = options.includeReferences !== false && Array.isArray(sd?.politicalReferences) ? sd.politicalReferences : [];
    const formatMotionText = UA.createMotionLinkFormatter(sd?.motion?.priorWork, selectedCouncilRecords);
    const motionParagraph = text => ({ text: formatMotionText(replaceEmojisForPDF(text)), style: formalMotion ? "motionBody" : "normal" });
    docDefinition.content.push({
      text: formalMotion ? "Beschlussvorschlag" : "ANTRAG / BESCHLUSSVORSCHLAG",
      style: formalMotion ? "sectionHeader" : "subheader",
      headlineLevel: 2
    });
    docDefinition.content.push(...motion.paragraphs.map(motionParagraph));
    if (motion.requests.length) {
      docDefinition.content.push({ ol: motion.requests.map(motionParagraph), margin: [2, 0, 0, 3] });
    }

    // ---- BEGRÜNDUNG / KURZBEWERTUNG (Task 2) ----
    // The executive summary is short enough to fit on a page and functions
    // as one semantic reading unit. Keep its heading, classification,
    // bullets, urgency and map references together. Otherwise pdfMake can
    // leave only the final map-reference sentence (for example
    // "Schwerpunkt der Häufung: …") at the top of the following page.
    // That continuation has no local heading and is as misleading as the
    // formerly orphaned final Methodik line.
    if (formalMotion) {
      docDefinition.content.push({ text: "Begründung", style: "sectionHeader", headlineLevel: 2 });
      if (evidence) docDefinition.content.push(motionParagraph(evidenceCountText(evidence)));
      docDefinition.content.push(...motion.reason.map(motionParagraph));
      for (const source of [motion.source, sd?.meta?.gremium?.source]) {
        if (!source?.label) continue;
        docDefinition.content.push({ ...linkedPdfRun({ text: source.label, href: reportLink(source.url) }), style: "motionNote" });
      }
      const councilSources = councilSourceRuns(sd);
      if (councilSources.length) {
        docDefinition.content.push({ text: councilSources.flatMap((part, i) => [...(i ? [" · "] : []), linkedPdfRun(part)]), style: "motionNote" });
      }
      const priorWork = motionPoliticalNote(sd, options, analysisAnnexNumber);
      if (priorWork.length) docDefinition.content.push({ text: priorWork.map(part => linkedPdfRun(part)), style: "motionNote" });
      docDefinition.content.push({
        text: [{ text: "Anlagen  ", bold: true }, { text: motionAnnexes(evidence, hasMap, analysisAnnexNumber) }],
        style: "motionNote", color: "#435766", margin: [0, 6, 0, 0]
      });
    } else if (sd && sd.executiveSummary) {
      const es = sd.executiveSummary;
      const executiveSummaryStack = [
        { text: "BEGRÜNDUNG", style: "subheader" },
        { text: "KURZBEWERTUNG", style: "subheader" },
        { text: es.classification, bold: true, margin: [0, 0, 0, 6] }
      ];
      for (const b of (es.bullets || [])) {
        executiveSummaryStack.push({ text: "• " + b, margin: [0, 0, 0, 3] });
      }
      if (es.urgency) {
        executiveSummaryStack.push({ text: es.urgency, italics: true, margin: [0, 4, 0, 8] });
      }
      if (Array.isArray(sd.mapReferences) && sd.mapReferences.length > 0) {
        for (const s of sd.mapReferences) {
          executiveSummaryStack.push({ text: s, margin: [0, 0, 0, 4] });
        }
      }
      docDefinition.content.push({
        unbreakable: true,
        stack: executiveSummaryStack
      });
    } else {
      docDefinition.content.push({
        text: "BEGRÜNDUNG",
        style: "subheader"
      });
    }
    if (!formalMotion) docDefinition.content.push(...motion.reason.map(motionParagraph));
    const firstAnnexIndex = docDefinition.content.length;
    if (formalMotion) {
      docDefinition.content.push({ text: `Anlage ${analysisAnnexNumber} – Auswertung und Methodik`, id: "analysis-annex-heading", style: "motionTitle", headlineLevel: 1 }, ...setup);
    }

    // ---- SACHVERHALT section ----
    docDefinition.content.push({
      text: "SACHVERHALT",
      style: "subheader",
      pageBreak: undefined
    });

    const sachverhaltSection = extractSection(textLines, "Sachverhalt:");
    if (sachverhaltSection.length > 0) {
      // Defense in depth: the default stop-list in extractSection already
      // terminates at every post-Sachverhalt block header, but keep this
      // inline guard in sync with POST_SACHVERHALT_STOP_HEADERS so future
      // refactors of extractSection cannot regress the QA blocker.
      for (const line of sachverhaltSection) {
        const trimmed = line.trim();
        const hitsBlockHeader = POST_SACHVERHALT_STOP_HEADERS.some(
          h => h !== "Sachverhalt:" && trimmed.startsWith(h)
        );
        if (hitsBlockHeader) {
          break;
        }
        const content = textWithLinks(line);
        docDefinition.content.push({
          text: content,
          style: "normal"
        });
      }
    }

    // ---- STATISTIK section with real tables (from structured data) ----
    if (sd && !sectionGuard("STATISTIK")) {
      // Keep the section heading, its explanatory line and the first table
      // together. Otherwise pdfMake can leave “STATISTIK” alone at the
      // bottom of a page while moving the complete severity table to the
      // next page, which is an orphan heading in the final rendered PDF.
      const sev = sd.severity;
      const sevTotal = sev ? sev.total : 0;
      const severityRows = [
        ["Unfälle mit Getöteten", String((sev && sev.bySev["1"]) || 0), fmtPctPdf((sev && sev.bySev["1"]) || 0, sevTotal)],
        ["Unfälle mit Schwerverletzten", String((sev && sev.bySev["2"]) || 0), fmtPctPdf((sev && sev.bySev["2"]) || 0, sevTotal)],
        ["Unfälle mit Leichtverletzten", String((sev && sev.bySev["3"]) || 0), fmtPctPdf((sev && sev.bySev["3"]) || 0, sevTotal)]
      ];
      docDefinition.content.push({
        unbreakable: true,
        stack: [
          { text: "STATISTIK", style: "subheader" },
          { text: severityPopulationText(sd), style: "normal" },
          makePdfTable(["Kategorie", "Anzahl", "Anteil"], severityRows, undefined, evidence ? { widths: ["*", 78, 78] } : undefined)
        ]
      });

      // Deviations table — parity with DOCX/HTML: 95%-KI + n.s.-Hinweis (or political simplification).
      if (sd.deviations && sd.deviations.focus && sd.deviations.focus.length > 0) {
        const isPolitical = sd.meta && sd.meta.mode === "political";
        const fmtFactor = UA.formatFactorPolitical || ((f) => `Faktor ${f.toFixed(2).replace(".", ",")}`);
        docDefinition.content.push({ text: "Top-Abweichungen (Ausschnitt vs. Stadt):", style: "normal", headlineLevel: 2 });
        const devRows = sd.deviations.focus.map(r => {
          const locPct = ((r.locR) * 100).toFixed(1).replace(".", ",") + " %";
          const basePct = ((r.baseR) * 100).toFixed(1).replace(".", ",") + " %";
          // QA-PR „Export-Semantik": Prosa-Label statt SVG-Icons.
          const muster = r.textLabel || (typeof UA.formatParticipantCombinationForExport === "function"
            ? UA.formatParticipantCombinationForExport(r.mask)
            : r.label);
          if (isPolitical) {
            // Task 9/10: politisches Wording, kein 95%-KI.
            return [muster, String(r.locCnt), locPct, basePct, fmtFactor(r.factor, { mode: "political" })];
          }
          const ciLowPct  = r.ciLow  != null ? (r.ciLow  * 100).toFixed(1).replace(".", ",") + " %" : "—";
          const ciHighPct = r.ciHigh != null ? (r.ciHigh * 100).toFixed(1).replace(".", ",") + " %" : "—";
          const factorStr = formatFactorDe(r.factor) + "×" + (r.isSignificant === false ? " (n. s.)" : "");
          return [muster, String(r.locCnt), locPct, basePct, factorStr, `[${ciLowPct} – ${ciHighPct}]`];
        });
        if (isPolitical) {
          docDefinition.content.push(makePdfTable(
            ["Muster", "Lokal", "Lokal %", "Stadt %", "Einordnung"],
            devRows,
            undefined,
            { widths: ["*", "auto", "auto", "auto", "*"] }
          ));
        } else {
          // Explicit widths: pattern column gets the slack (*), narrow numeric
          // columns are sized to their content so the table stops overflowing
          // on narrower viewports/pageSizes.
          docDefinition.content.push(makePdfTable(
            ["Muster", "Lokal", "Lokal %", "Stadt %", "Faktor", "95%-KI (lokaler Anteil)"],
            devRows,
            undefined,
            { widths: ["*", "auto", "auto", "auto", "auto", "auto"] }
          ));
        }
        docDefinition.content.push({
          text: [
            { text: "Lesart: ", bold: true },
            { text: involvementComparisonReading(sd, isPolitical) }
          ],
          style: "small",
          margin: [0, 2, 0, 6]
        });
        // Task 10: 95%-KI/n.s.-Hinweis nur im technischen Modus.
        if (!isPolitical) {
          const allNonSig = sd.deviations.focus.every(r => r.isSignificant === false);
          if (allNonSig) {
            docDefinition.content.push({
              text: "Hinweis: Alle aufgeführten Abweichungen sind statistisch nicht signifikant (95%-KI schließt Stadtwert ein). Faktor-Werte bei kleinen Fallzahlen mit Vorsicht interpretieren.",
              style: "normal",
              italics: true,
              margin: [0, 4, 0, 8]
            });
          }
        }
        // Task 4 – URSACHEN UND MASSNAHMEN direkt nach den Abweichungen.
        if (Array.isArray(sd.causesMeasures) && sd.causesMeasures.length > 0) {
          docDefinition.content.push({ text: "URSACHEN UND MASSNAHMEN", style: "subheader" });
          const cmRows = sd.causesMeasures.map(c => [
            c.cause,
            (c.measureRefs && c.measureRefs.length > 0)
              ? c.measureRefs.map(e => `#${e.idx} (${e.label})`).join("; ")
              : c.measures.join("; ")
          ]);
          docDefinition.content.push(makePdfTable(
            ["Auffälliges Muster", "Empfohlene Maßnahmen (siehe Liste unten)"],
            cmRows,
            undefined,
            { widths: ["auto", "*"] }
          ));
        }
      }

      // Year table
      if (sd.yearTable && sd.yearTable.length > 0) {
        docDefinition.content.push({ text: "Unfälle pro Jahr im Ausschnitt:", style: "normal" });
        // QA-PR „Export-Semantik": „Kombinationen"-Spalte als Prosa,
        // niemals als Icon-/Bracket-Text. textClasses (Bracket-Form) wird
        // durch proseLabelForExport in „Radverkehr + PKW: 4" überführt.
        const proseFor = (typeof UA.proseLabelForExport === "function")
          ? UA.proseLabelForExport
          : (s) => String(s == null ? "" : s);
        const yrRows = sd.yearTable.map(row => {
          const cls = (row.textClasses && row.textClasses.length)
            ? row.textClasses.map(proseFor)
            : (row.classes || []).map(proseFor);
          return [
            String(row.year),
            String(row.total),
            cls.length ? cls.join(", ") : "—"
          ];
        });
        docDefinition.content.push(makePdfTable(
          ["Jahr", "Summe", "Kombinationen"],
          yrRows,
          undefined,
          { widths: ["auto", "auto", "*"] }
        ));
      }

      // Cross-table: Beteiligungskombination × Schweregrad
      if (sd.crossTable && sd.crossTable.rows && sd.crossTable.rows.length > 0) {
        docDefinition.content.push({ text: "Beteiligungskombination × Schweregrad:", style: "normal" });
        const ctRows = sd.crossTable.rows.map(r => {
          // QA-PR „Export-Semantik": Prosa-Label statt SVG-Icons.
          const label = (typeof UA.formatParticipantCombinationForExport === "function")
            ? UA.formatParticipantCombinationForExport(r.mask)
            : (r.textLabel || r.label);
          return [label, String(r.sev1), String(r.sev2), String(r.sev3), String(r.total)];
        });
        // Highlight rows whose mask matches the active filter
        const ctHighlights = sd.crossTable.rows.map(r => isPdfActiveFilterRow(r.mask));
        ctRows.push([
          "Gesamt",
          String(sd.crossTable.totals.sev1),
          String(sd.crossTable.totals.sev2),
          String(sd.crossTable.totals.sev3),
          String(sd.crossTable.totals.total)
        ]);
        ctHighlights.push(false); // Gesamt row is not highlighted
        docDefinition.content.push(makePdfTable(
          ["Kombination", "mit Getöteten", "mit Schwerverletzten", "mit Leichtverletzten", "Unfälle gesamt"],
          ctRows,
          ctHighlights,
          { widths: ["*", "auto", "auto", "auto", "auto"] }
        ));
      }

      // Accident details table – grouped by strategy (consumes structured.accidentDetails.groups)
      // Economic impact (PR-C / B2): Volkswirtschaftliche Bedeutung
      const costTable = options.includeCosts !== false && UA.costs?.reportTable(sd.economicImpact);
      if (costTable) {
        docDefinition.content.push({ text: costTable.title, style: "subheader", headlineLevel: 2 });
        docDefinition.content.push({ text: costTable.note, style: "normal" });
        docDefinition.content.push(makePdfTable(costTable.headers, costTable.rows));
        const tq = trendQualifierTextDocx(sd.economicImpact.trendQualifier);
        if (tq) docDefinition.content.push({ text: `Mehrjahres-Trend der Unfallzahlen: ${tq}.`, style: "normal" });
        docDefinition.content.push({ text: ["Quelle: ", { text: costTable.sourceLabel, link: reportLink(costTable.sourceUrl),
          color: "#174b79", decoration: "underline" }], style: "normal" });
      }

      if (options.includeMeasures !== false && sd.measureAssessmentNote) {
        docDefinition.content.push(motionParagraph(sd.measureAssessmentNote));
      }

      // Orts- und musterbezogene Empfehlungen (UA.contextMeasures, Spec
      // Items 4–8). Direkt VOR „EMPFOHLENE MASSNAHMEN" — analog zur DOCX-
      // Sektion oben. Nutzt pdfMake-Styles ("subheader" für Heading-2,
      // bold/italics inline, eingerückte Bullets via margin: [10, …]).
      if (options.includeMeasures !== false && sd.contextualMeasures
          && Array.isArray(sd.contextualMeasures.matchedRules)
          && sd.contextualMeasures.matchedRules.length > 0
          && !sectionGuard("ORTS- UND MUSTERBEZOGENE EMPFEHLUNGEN")) {
        docDefinition.content.push({ text: "ORTS- UND MUSTERBEZOGENE EMPFEHLUNGEN", style: "subheader" });
        if (sd.contextualMeasures.rationale) {
          docDefinition.content.push({
            text: sd.contextualMeasures.rationale,
            italics: true, fontSize: 10, margin: [0, 2, 0, 8]
          });
        }
        const renderBucketPdfCtx = (heading, items) => {
          if (!Array.isArray(items) || items.length === 0) return;
          docDefinition.content.push({ text: heading, bold: true, margin: [0, 6, 0, 2] });
          for (const it of items) {
            docDefinition.content.push({
              text: "• " + it,
              style: "normal",
              margin: [10, 0, 0, 2]
            });
          }
        };
        renderBucketPdfCtx("Erforderliche Vor-Ort-Prüfung",     sd.contextualMeasures.pruefauftraege);
        renderBucketPdfCtx("Kurzfristig prüfbar",               sd.contextualMeasures.kurzfristig);
        renderBucketPdfCtx("Baulich/organisatorisch zu prüfen", sd.contextualMeasures.mittelfristig);
      }

      // Recommended measures (PR-D / B1+B3)
      if (options.includeMeasures !== false && UA.hasRecommendationsOrFiltered
          && UA.hasRecommendationsOrFiltered(sd.recommendedMeasures)
          && !sectionGuard("EMPFOHLENE MASSNAHMEN")) {
        const fmtCost = (UA.measures && UA.measures.formatCostRange) ? UA.measures.formatCostRange : (() => "—");
        const fmtRed = (UA.measures && UA.measures.formatReductionRange) ? UA.measures.formatReductionRange : (() => "—");
        docDefinition.content.push({ text: "EMPFOHLENE MASSNAHMEN", style: "subheader" });
        const cov = osmCoverageNoteDocx(sd.recommendedMeasures.osmCoverage, formalMotion);
        if (cov) {
          docDefinition.content.push({
            text: `OSM-Datenstand: ${cov}`,
            italics: true, fontSize: 9, margin: [0, 2, 0, 6],
            color: "#a05000"
          });
        }
        let i = 1;
        for (const item of (sd.recommendedMeasures.measures || [])) {
          const m = item.measure;
          docDefinition.content.push({ text: `${i}. ${m.label}`, bold: true, margin: [0, 6, 0, 2] });
          if (m.description) docDefinition.content.push({ text: m.description, style: "normal" });
          const ev = (m.effect && m.effect.evidenceLevel) ? `Evidenz ${m.effect.evidenceLevel}` : "";
          const meta = `Kosten: ${fmtCost(m.costRange)} pro ${m.perUnit || "Einheit"} · Reduktion: ${fmtRed(m.effect && m.effect.expectedReductionPct)}${ev ? " · " + ev : ""} · Vorlauf: ${m.leadTime || "—"}`;
          docDefinition.content.push({ text: meta, style: "normal" });
          // Goldstandard Items 5–6: explizite Cross-Reference auf den
          // URSACHEN-Block (analog DOCX/HTML/TEXT).
          if (Array.isArray(item.derivedFrom) && item.derivedFrom.length > 0) {
            docDefinition.content.push({
              text: `Abgeleitet aus auffälligem Muster: ${item.derivedFrom.map(d => d.label).join(" · ")}`,
              italics: true, fontSize: 10, color: "#555555",
              margin: [0, 0, 0, 2]
            });
          }
          if (item.amortisation && item.amortisation.years) {
            const [best, worst] = item.amortisation.years;
            docDefinition.content.push({ text: `Geschätzte Amortisation: ca. ${best.toFixed(1)} – ${worst.toFixed(1)} Jahre.`, style: "normal" });
          }
          if (Array.isArray(m.considerations)) {
            for (const c of m.considerations) {
              docDefinition.content.push({ text: "• " + c, style: "normal", margin: [10, 0, 0, 0] });
            }
          }
          i++;
        }
        if (Array.isArray(sd.recommendedMeasures.filteredOut) && sd.recommendedMeasures.filteredOut.length > 0) {
          docDefinition.content.push({ text: "Wegen OSM-Voraussetzungen NICHT empfohlen:", bold: true, margin: [0, 8, 0, 2] });
          for (const f of sd.recommendedMeasures.filteredOut) {
            docDefinition.content.push({ text: `• ${f.label}: ${f.reason || "Voraussetzungen nicht erfüllt"}`, style: "normal", margin: [10, 0, 0, 0] });
          }
        }
        if (sd.recommendedMeasures.disclaimer) {
          docDefinition.content.push({ text: sd.recommendedMeasures.disclaimer, italics: true, fontSize: 9, margin: [0, 4, 0, 8] });
        }
        // Issue 2 (a): Quellen vollständig — Titel, Publisher, Jahr, URL
        // als anklickbarer Link (pdfMake `link:` + Decoration).
        if (Array.isArray(sd.recommendedMeasures.sources) && sd.recommendedMeasures.sources.length > 0) {
          docDefinition.content.push({ text: "Quellen:", bold: true, margin: [0, 4, 0, 2] });
          for (const s of sd.recommendedMeasures.sources) {
            if (!s || !s.title) continue;
            const meta = [s.publisher, s.year].filter(Boolean).join(", ");
            const head = meta ? `${s.title} (${meta})` : s.title;
            if (s.url) {
              docDefinition.content.push({
                text: [
                  { text: `– ${head} ` },
                  { text: "Quelle öffnen", link: s.url, color: "blue", decoration: "underline" }
                ],
                style: "normal",
                margin: [10, 0, 0, 2]
              });
            } else {
              docDefinition.content.push({
                text: `– ${head}`,
                style: "normal",
                margin: [10, 0, 0, 2]
              });
            }
          }
        }
      }

      // Goldstandard-Sektion 8: Priorisierung (PDF). Drei-Bucket-Listen
      // analog zur DOCX-Sektion oben. Leere Buckets werden explizit
      // ausgewiesen, damit das Bild „der Bereich erfordert nur lange
      // Maßnahmen" nicht entsteht.
      if (sd.prioritization && sd.prioritization.meta && sd.prioritization.meta.totals.all > 0) {
        docDefinition.content.push({ text: "Priorisierung (Umsetzungshorizont)", style: "h2", margin: [0, 12, 0, 6] });
        const renderBucketPdf = (heading, bucket) => {
          docDefinition.content.push({ text: heading, bold: true, margin: [0, 6, 0, 2] });
          if (bucket.length === 0) {
            docDefinition.content.push({ text: "— keine Maßnahmen in diesem Horizont —", italics: true, color: "#666666", margin: [10, 0, 0, 0] });
            return;
          }
          for (const it of bucket) {
            docDefinition.content.push({
              text: `• ${it.label} (Vorlauf: ${it.leadTime})`,
              style: "normal",
              margin: [10, 0, 0, 0]
            });
          }
        };
        renderBucketPdf("Kurzfristig (0–3 Monate)", sd.prioritization.kurzfristig);
        renderBucketPdf("Mittelfristig (3–12 Monate)", sd.prioritization.mittelfristig);
        renderBucketPdf("Langfristig (>12 Monate)", sd.prioritization.langfristig);
      }

      if (!evidence && sd.accidentDetails && sd.accidentDetails.groups && sd.accidentDetails.groups.length > 0) {
        // Resolve accident-view strategy + columns from the structured payload,
        // mirroring the DOCX branch above. Without these the per-row producer
        // and `makePdfTable(cols, …)` call below reference undefined names and
        // pdfMake.createPdf() then throws ReferenceError ("view is not defined")
        // before the download can ever fire.
        const view = (typeof UA !== "undefined" && UA.resolveAccidentView)
          ? UA.resolveAccidentView(sd.accidentDetails.viewId)
          : null;
        const cols = (sd.accidentDetails.columns && sd.accidentDetails.columns.length)
          ? sd.accidentDetails.columns
          : ["#", "Jahr", "Beteiligte", "Uhrzeit", "Wochentag", "Fahrbahnzustand", "Koordinaten"];
        for (const g of sd.accidentDetails.groups) {
          const docxHeader = (g.headers && Array.isArray(g.headers.docx)) ? g.headers.docx : null;
          if (docxHeader && docxHeader.length > 0) {
            for (const h of docxHeader) {
              docDefinition.content.push({ text: replaceEmojisForPDF(h.text || ""), bold: !!h.bold, margin: [0, 8, 0, 4] });
            }
          } else if (g.sevLabel) {
            const headerText = `${g.sevLabel} (n=${g.count})${g.histogram ? "  —  " + g.histogram : ""}`;
            docDefinition.content.push({ text: replaceEmojisForPDF(headerText), bold: true, margin: [0, 8, 0, 4] });
          }
          const detailRows = g.rows.map((r, i) => {
            // Use the strategy's docx row producer (same column shape as DOCX).
            // QA-PR „Export-Semantik": jede String-Zelle wird durch
            // proseLabelForExport gefiltert — danach enthält keine Detail-
            // tabellen-Zelle mehr ein Beteiligten-Emoji oder ein Bracket-
            // Token wie „[Rad]+[PKW]"; sichtbar bleibt nur Prosa
            // („Radverkehr + PKW"). Vorher wurden Strings stattdessen
            // durch pdfInvolvementCell als SVG-Icons gerendert — das hat
            // der QA-Bericht ausdrücklich als „kaputte Symbole" markiert.
            let cells;
            if (view && view.renderRow && view.renderRow.docx) {
              cells = view.renderRow.docx(r, i);
            } else {
              const hour = r.hour != null ? String(r.hour).padStart(2, "0") + ":00" : "—";
              const coords = (r.lat != null && r.lon != null) ? `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}` : "—";
              cells = [String(i + 1), String(r.year ?? "—"), r.involved, hour, (typeof UA !== "undefined" && UA.fmtWeekday ? UA.fmtWeekday(r) : (r.weekday || "—")), r.roadCondition || "—", coords];
            }
            const proseFor = (typeof UA.proseLabelForExport === "function")
              ? UA.proseLabelForExport
              : (s) => String(s == null ? "" : s);
            return cells.map(c => typeof c === "string" ? proseFor(c) : c);
          });
          // Tighter column widths so a 7-column accident-details table stays
          // within the printable area (was overflowing on A4 even with margin
          // tightened to 40 pt). Numeric/short-text columns sized to content;
          // the lone star column absorbs the slack.
          const detailWidths = (cols.length === 7)
            ? ["auto", "auto", "*", "auto", "auto", "auto", "auto"]
            : cols.map(() => "*");
          docDefinition.content.push(makePdfTable(cols, detailRows, undefined, { widths: detailWidths, fontSize: 8 }));
          if (g.overflow > 0) {
            const label = g.overflowLabel || `weitere ${g.sevLabel || ""}`;
            docDefinition.content.push({
              text: `… und ${g.overflow} ${label}`,
              style: "small"
            });
          }
        }
      } else if (!evidence && sd.accidentDetails && sd.accidentDetails.rows && sd.accidentDetails.rows.length > 0) {
        // Fallback for legacy data without groups.
        // Phase 1.1: Statt eines 8-Spalters splitten wir in zwei kompakte
        // Tabellen ("Zeit/Ort" + "Beteiligung/Zustand"), korreliert über
        // die laufende Nr. (#). Damit bleiben beide Tabellen ≤ 5 Spalten
        // und es gibt keinen rechten Überlauf mehr auf A4.
        docDefinition.content.push({ text: "EINZELUNFÄLLE IM BEREICH", style: "subheader" });

        const ts = sd.accidentDetails.rows.map((r, i) => {
          const hour = r.hour != null ? String(r.hour).padStart(2, "0") + ":00" : "—";
          const wd = (typeof UA !== "undefined" && UA.fmtWeekday)
            ? UA.fmtWeekday(r)
            : (r.weekday || "—");
          return [String(i + 1), String(r.year ?? "—"), r.sevLabel, hour, wd];
        });
        docDefinition.content.push({ text: "Zeit", style: "subheader2" });
        docDefinition.content.push(makePdfTable(
          ["#", "Jahr", "Schwere", "Uhrzeit", "Wochentag"],
          ts,
          undefined,
          { widths: ["auto", "auto", "auto", "auto", "*"], fontSize: 8 }
        ));

        const bs = sd.accidentDetails.rows.map((r, i) => {
          const coords = (r.lat != null && r.lon != null)
            ? `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}`
            : "—";
          // QA-PR „Export-Semantik": Prosa statt SVG-Icons.
          const involvedProse = (typeof UA.proseLabelForExport === "function")
            ? UA.proseLabelForExport(r.involved)
            : String(r.involved == null ? "" : r.involved);
          return [String(i + 1), involvedProse, r.roadCondition || "—", coords];
        });
        docDefinition.content.push({ text: "Beteiligung & Ort", style: "subheader2" });
        docDefinition.content.push(makePdfTable(
          ["#", "Beteiligte", "Fahrbahnzustand", "Koordinaten"],
          bs,
          undefined,
          { widths: ["auto", "*", "auto", "auto"], fontSize: 8 }
        ));
        if (sd.accidentDetails.truncated) {
          docDefinition.content.push({
            text: `… und ${sd.accidentDetails.total - sd.accidentDetails.rows.length} weitere Unfälle`,
            style: "small"
          });
        }
      }
    }

    // ---- Map section (if enabled) ----
    const mapsStart = docDefinition.content.length;
    if (hasMap) {
      const plan = reportMapPlan(ctx, filters);
      const focus = reportDiscoveryFocus(plan, sd);
      const mapOptions = { ...options, exportPoints: plan.points, exportBounds: plan.bounds };
      const documentMap = UA.createDocumentMapContext(ctx);
      const mapCtx = documentMap.ctx;
      const cohorts = sd?.evidenceCohorts;
      const mapUrl = (capture, overrides = {}) => buildWerkbankUrl(ctx, {
        center: capture.center, zoom: capture.zoom, bounds: plan.bounds, ...overrides
      });
      try {
        fitDocumentMap(mapCtx, plan.bounds, { maxZoom: mapCtx.map.getZoom() });
        docDefinition.content.push({
          text: formalMotion ? "Anlage 1 – Karten" : "KARTENAUSSCHNITT",
          style: formalMotion ? "motionTitle" : "sectionHeader",
          ...(formalMotion ? { pageBreak: "before", headlineLevel: 1 } : {})
        });

        docDefinition.content.push({
          text: "Die Übersicht zeigt die ausgewerteten Unfallorte unter den aktiven Filtern.",
          style: "body"
        });

        const pdfSelection = plan.selection;
        let pdfSelectionFigIndex = 1;
        if (pdfSelection.hasRestriction) {
          try {
            const allCombPts = plan.allPoints;
            const allCombCapture = await UA.captureDocumentMap(mapCtx, {
              ...mapOptions, exportPoints: allCombPts
            });
            const allCombUrl = mapUrl(allCombCapture, { allCombinations: true });
            const allCombFig = pdfFigCounter.next("Übersichtskarte – alle Beteiligungs-Kombinationen im aktuellen Kartenausschnitt");
            docDefinition.content.push({
              unbreakable: true,
              stack: [
                {
                  image: allCombCapture.image,
                  fit: [PDF_MAP_MAX.width, PDF_MAP_MAX.height],
                  alignment: "center",
                  margin: [0, 10, 0, 6],
                  link: allCombUrl
                },
                {
                  text: allCombFig.caption,
                  style: "caption",
                  alignment: "center",
                  margin: [0, 0, 0, 4]
                }
              ]
            });
            docDefinition.content.push({
              text: `Unfälle im selben Gebiet vor Beteiligungsfilter (n = ${allCombPts.length}).`,
              style: "small",
              italics: true,
              margin: [0, 4, 0, 8]
            });
            pushPdfMapSourceNote(docDefinition, ctx, 8, allCombCapture);
            pdfSelectionFigIndex = allCombFig.index + 1;
          } catch (allCombErr) {
            if (isMapRenderReadinessFailure(allCombErr)) throw allCombErr;
            console.warn("All-combinations overview capture failed for PDF (graceful fallback):", allCombErr);
          }
        }

        const mainCapture = await UA.captureDocumentMap(mapCtx, mapOptions);
        const mapImageData = mainCapture.image;
        const werkbankUrl = mapUrl(mainCapture);

        // Layout-PR „Bildverzerrung beheben" / Spec-Items 1+2:
        //  - pdfMake-`fit:[w,h]` erhält die Aspektrate des PNG-Originals
        //    automatisch (das Bild wird in die Box eingepasst).
        //  - ALLE Karten (Übersicht, Detail, Cluster) nutzen jetzt dieselbe
        //    `PDF_MAP_MAX`-Box — vorher hatte die Übersicht 475×650 (zu hoch,
        //    erzeugte fast leere Folgeseiten), Detail/Cluster 475×350.
        // Bild und Caption werden in einem `stack` mit `unbreakable: true`
        // gerendert (Spec-Item 3 + 5: Bild-Block als Einheit, kein
        // Seitenumbruch zwischen Bild und Caption).
        // Doppelte Karten: Caption nennt explizit die aktive
        // Beteiligungs-Auswahl, wenn restringiert.
        const pdfMainMapCaptionSubject = pdfSelection.hasRestriction
          ? `Auswahl-Karte – Unfälle mit Beteiligung \u2039${pdfSelection.prose}\u203A im aktuellen Kartenausschnitt`
          : "Übersichtskarte – gefilterte Unfälle im aktuellen Kartenausschnitt";
        const overviewCaption = pdfFigCounter.next(pdfMainMapCaptionSubject).caption;
        docDefinition.content.push({
          unbreakable: true,
          stack: [
            {
              image: mapImageData,
              fit: [PDF_MAP_MAX.width, PDF_MAP_MAX.height],
              alignment: "center",
              margin: [0, 10, 0, 6],
              link: werkbankUrl
            },
            {
              text: overviewCaption,
              style: "caption",
              alignment: "center",
              margin: [0, 0, 0, 4]
            }
          ]
        });
        pushPdfMapSourceNote(docDefinition, ctx, 6, mainCapture);

        // Add "In Werkbank öffnen" link
        docDefinition.content.push({
          text: "In Werkbank öffnen",
          link: werkbankUrl,
          color: "blue",
          decoration: "underline",
          style: "normal",
          margin: [0, 5, 0, 10]
        });

        docDefinition.content.push({
          text: [
            "Legende: Der blaue Rahmen kennzeichnet das Auswertungsgebiet.\n",
            "Punkte nach Unfallschwere: rot = mit Getöteten, orange = mit Schwerverletzten, gelb = mit Leichtverletzten.\n",
            "Kategorien: [Rad]=Fahrrad, [Fuss]=Fußgänger, [PKW]=PKW, [Krad]=Motorrad, [Lkw]=Lkw/Gkfz, [Sonst]=Sonstige."
          ].join(""),
          style: "small"
        });

        const overviewN = plan.points.length;
        const pdfParentNForSubset = overviewN;
        docDefinition.content.push({
          text: reportMapCount(overviewN, cohorts),
          style: "small",
          italics: true,
          margin: [0, 4, 0, pdfSelection.hasRestriction ? 2 : 8]
        });
        // Doppelte Karten / Caption-Transparenz: nennt die aktive
        // Beteiligungs-Auswahl explizit unter der Auswahl-Karte.
        if (pdfSelection.hasRestriction) {
          docDefinition.content.push({
            text: selectionHintSentence(pdfSelection.prose),
            style: "small",
            italics: true,
            margin: [0, 0, 0, 8]
          });
        }

        let focusMapShown = false;
        if (focus?.bounds) {
          try {
            const capture = await (UA._captureDetailMap || captureDetailMap)(mapCtx, {
              ...mapOptions, exportPoints: focus.points, exportBounds: focus.bounds, heatmapExportOpacity: 0
            });
            const focusUrl = mapUrl(capture, { discoveryFocus: focus });
            const figure = pdfFigCounter.next(`${focus.mapLabel} – ${focus.label}`);
            docDefinition.content.push({
              unbreakable: true,
              stack: [
                { text: focus.title, style: "subsectionHeader" },
                {
                  image: capture.image,
                  fit: [PDF_MAP_MAX.width, PDF_MAP_MAX.height],
                  alignment: "center",
                  margin: [0, 10, 0, 6],
                  link: focusUrl
                },
                { text: focusCaption(figure, focus, overviewN, pdfSelectionFigIndex), style: "caption", alignment: "center" },
                { text: focus.legend, style: "small", margin: [0, 4, 0, 4] }
              ]
            });
            pushPdfMapSourceNote(docDefinition, ctx, 4, capture);
            docDefinition.content.push({
              text: "In Werkbank öffnen", link: focusUrl, color: "blue", decoration: "underline",
              style: "normal", margin: [0, 5, 0, 4]
            });
            focusMapShown = true;
          } catch (error) {
            if (isMapRenderReadinessFailure(error)) throw error;
            console.warn("Musterkarte konnte nicht erfasst werden:", error);
          }
        }
        if (focus) {
          if (!focusMapShown) {
            docDefinition.content.push({
              text: focus.summary, style: "small"
            });
          }
          if (focus.recentText) docDefinition.content.push({ text: focus.recentText, style: "small", margin: [0, 4, 0, 8] });
          const criteria = focusCriteria(focus.query);
          if (criteria) docDefinition.content.push({ text: criteria, style: "small", margin: [0, 4, 0, 8] });
        }

        // Cluster maps: one zoomed-in PDF page section per dominant accident
        // hotspot (Tasks 1–7). Each map gets:
        //   – fitBounds onto its own bbox (no unrelated areas, Task 7)
        //   – a unique Werkbank URL with cluster-specific selSouth/…/selEast
        //     and centerLat/Lon/zoom (Tasks 1, 3)
        //   – heading "<label> – n Unfälle (Zoom z)" (matches the table)
        //   – verification sentence "Die dargestellten Punkte … (n = X)." (Task 6)
        try {
          const clusterMaps = focusMapShown ? [] : await (UA._captureClusterMaps || captureClusterMaps)(mapCtx, mapOptions);
          for (const cm of clusterMaps) {
            // Task 5: only render a cluster map when the visible point count
            // matches the stated total. This is the explicit consistency
            // gate required by the spec.
            const visibleN = Array.isArray(cm.points)
              ? cm.points.length
              : countPointsInBounds(ctx.viewportPts || [], cm.bounds);
            if (visibleN !== cm.total) {
              console.warn(
                "Cluster map skipped: point/total mismatch",
                { label: cm.label, total: cm.total, visibleN }
              );
              continue;
            }

            const clusterUrl = mapUrl(cm, {
              bounds: cm.bounds,
              center: cm.center || { lat: cm.lat, lon: cm.lon }
            });
            // Layout-PR „Bildverzerrung beheben": einheitliche Box +
            // unbreakable-Stack — Header, Bild und Caption bleiben zusammen.
            const clusterFig = pdfFigCounter.next(`Cluster-Karte – ${cm.label} (n=${cm.total})`);
            const clusterCaptionText = (pdfParentNForSubset != null)
              ? `${clusterFig.caption} Die ${cm.total} dargestellten Unfälle sind eine Teilmenge der ${pdfParentNForSubset} Unfälle aus Abbildung ${pdfSelectionFigIndex}.`
              : clusterFig.caption;
            docDefinition.content.push({
              unbreakable: true,
              stack: [
                {
                  text: `${cm.label} – ${cm.total} Unfälle (Zoom ${cm.zoom})`,
                  style: "subsectionHeader"
                },
                {
                  image: cm.image,
                  fit: [PDF_MAP_MAX.width, PDF_MAP_MAX.height],
                  alignment: "center",
                  margin: [0, 10, 0, 6],
                  link: clusterUrl
                },
                {
                  text: clusterCaptionText,
                  style: "caption",
                  alignment: "center"
                }
              ]
            });
            pushPdfMapSourceNote(docDefinition, ctx, 4, cm);
            docDefinition.content.push({
              text: "In Werkbank öffnen",
              link: clusterUrl,
              color: "blue",
              decoration: "underline",
              style: "normal",
              margin: [0, 5, 0, 4]
            });
            docDefinition.content.push({
              text: reportMapCount(cm.total, cohorts),
              style: "small",
              italics: true,
              margin: [0, 0, 0, pdfSelection.hasRestriction ? 2 : 8]
            });
            if (pdfSelection.hasRestriction) {
              docDefinition.content.push({
                text: selectionHintSentence(pdfSelection.prose),
                style: "small",
                italics: true,
                margin: [0, 0, 0, 8]
              });
            }
          }
        } catch (clusterErr) {
          if (isMapRenderReadinessFailure(clusterErr)) throw clusterErr;
          console.warn("Cluster maps capture failed for PDF (graceful fallback):", clusterErr);
        }
        if (cohorts?.detailMapPartitions?.length) {
          const maps = await UA.EvidenceCohort.captureEvidenceMaps(UA, mapCtx, cohorts, { includeOverview: false });
          for (const evidenceMap of maps) {
            const { mapRef, image, title, accidentIds } = evidenceMap;
            const fig = pdfFigCounter.next(`${title} (n = ${accidentIds.length})`);
            docDefinition.content.push({
              unbreakable: true,
              stack: [
                { image, fit: [PDF_MAP_MAX.width, PDF_MAP_MAX.height], alignment: "center", margin: [0, 10, 0, 6] },
                { id: `evidence-map-${mapRef}`, text: fig.caption, style: "caption", alignment: "center" },
                { text: `Unfall-IDs ${accidentIds.join(", ")}.`, style: "small", margin: [0, 4, 0, 4] },
                ...buildMapSourceNoteLines(ctx, evidenceMap).map(text => ({ text, style: "small", italics: true }))
              ]
            });
            renderedEvidenceMapRefs.add(mapRef);
          }
        }
      } catch (e) {
        if (isMapRenderReadinessFailure(e) || cohorts?.detailMapPartitions?.length) throw e;
        console.error("Map capture failed for PDF:", e);
        docDefinition.content.push({
          text: "[Kartenerstellung fehlgeschlagen]",
          style: "small"
        });
      } finally {
        documentMap.close();
      }
    }
    const mapSection = formalMotion ? docDefinition.content.splice(mapsStart) : [];

    const networkSite = reportNetworkSite(ctx, sd);
    if (networkSite) {
      docDefinition.content.push({ text: "Befund aus dem Netzregister", style: "subheader" });
      for (const line of networkSite.lines) docDefinition.content.push({ text: line, style: "normal", margin: [0, 0, 0, 4] });
      for (const source of networkSite.sources) docDefinition.content.push({ text: [linkedPdfRun(source)], style: "normal" });
      if (networkSite.link) {
        docDefinition.content.push({ text: [linkedPdfRun({ text: "Auswertung in der Werkbank öffnen", href: networkSite.link })], style: "normal" });
      }
    }

    const siteChanges = reportSiteChanges(sd);
    if (siteChanges.length) {
      docDefinition.content.push({ text: "Dokumentierte Veränderungen", style: "subheader" });
      for (const change of siteChanges) {
        docDefinition.content.push({
          text: [{ text: change.text }, ...(change.href ? [" ", linkedPdfRun({ text: "Quelle", href: change.href })] : [])],
          style: "normal"
        });
      }
      docDefinition.content.push({ text: SITE_CHANGE_LIMIT, style: "small", margin: [0, 4, 0, 8] });
    }

    // ---- POI section (if enabled) ----
    if (options.includePOIs) {
      const poi = sd && sd.poi;
      const hasPoi = poi && (poi.totalWithin > 0 || poi.totalNear > 0);
      const facilities = reportFacilities(poi);
      const poiSection = extractSection(textLines, "POI-Analyse");
      if (hasPoi || facilities.length || poiSection.length > 0) {
        docDefinition.content.push({
          text: "SENSIBLE EINRICHTUNGEN",
          style: "subheader"
        });

        if (hasPoi) {
          const poiRows = [];
          const allTypes = [...new Set([
            ...Object.keys(poi.withinByType || {}),
            ...Object.keys(poi.nearByType || {})
          ])].sort((a, b) => poiTypeLabel(a).localeCompare(poiTypeLabel(b), "de"));
          for (const type of allTypes) {
            const label = poiTypeLabel(type);
            poiRows.push([
              label,
              String(poi.withinByType[type] || 0),
              String(poi.nearByType[type] || 0)
            ]);
          }
          docDefinition.content.push(makePdfTable(
            ["Typ", "Im Bereich", "In der Nähe (< 200m)"],
            poiRows
          ));
          docDefinition.content.push({
            text: "Hinweis: Das Vorhandensein von Schulen, Kindergärten oder Kitas im oder nahe dem Unfallbereich erfordert besondere Aufmerksamkeit hinsichtlich der Verkehrssicherheit für Kinder und Jugendliche.",
            style: "small"
          });
        } else if (!facilities.length) {
          for (const line of poiSection) {
            const content = textWithLinks(line);
            docDefinition.content.push({
              text: content,
              style: "normal"
            });
          }
        }
        for (const facility of facilities) {
          docDefinition.content.push({
            text: facility.text, bold: true, style: "normal", margin: [0, 6, 0, 0]
          });
          if (facility.detail) docDefinition.content.push({ text: facility.detail, style: "small" });
          for (const source of facility.sources) {
            docDefinition.content.push({ ...linkedPdfRun(source), style: "small" });
          }
        }
      }
    }

    // ---- DUNKELZIFFER-PFLICHTHINWEIS (#C3) ----
    {
      const note = (sd && sd.darkFigureNote) || (typeof UA !== "undefined" && UA.DARK_FIGURE_NOTE) || null;
      if (note) {
        docDefinition.content.push({ text: note.title, style: "subheader" });
        docDefinition.content.push({ text: note.body, style: "normal" });
        docDefinition.content.push({ text: note.sourceLabel, italics: true, fontSize: 9, margin: [0, 4, 0, note.sources && note.sources.length > 0 ? 2 : 8] });
        if (note.sources && note.sources.length > 0) {
          for (const src of note.sources) {
            const line = [{ text: "– " + src.label }];
            if (src.url) line.push({ text: " – Quelle öffnen", link: src.url, color: "blue", decoration: "underline" });
            docDefinition.content.push({ text: line, italics: true, fontSize: 8, margin: [8, 0, 0, 2] });
          }
          docDefinition.content.push({ text: "", margin: [0, 0, 0, 6] });
        }
      }
    }

    // ---- PR-E – KONTEXTDATEN-QUELLENHINWEIS ----
    // Spiegel zum DOCX-Block; nur wenn der Datensatz Kontextfelder trägt.
    {
      const enrichNote = sd && sd.enrichmentSourcesNote;
      if (enrichNote) {
        docDefinition.content.push({ text: enrichNote.title, style: "subheader" });
        docDefinition.content.push({ text: enrichNote.body, style: "normal" });
        for (const src of enrichNote.sources) {
          const line = [{ text: "– " + src.label }];
          if (src.url) line.push({ text: " – Quelle öffnen", link: src.url, color: "blue", decoration: "underline" });
          docDefinition.content.push({ text: line, italics: true, fontSize: 8, margin: [8, 0, 0, 2] });
        }
        docDefinition.content.push({ text: "", margin: [0, 0, 0, 6] });
      }
    }

    // ---- MEHRJAHRES-TREND (#C2) ----
    if (sd && sd.yearlyTrend && Array.isArray(sd.yearlyTrend.years) && sd.yearlyTrend.years.length > 0
        && !sectionGuard("MEHRJAHRES-TREND")) {
      const t = sd.yearlyTrend;
      docDefinition.content.push({ text: "MEHRJAHRES-TREND", style: "subheader" });
      const trendRows = t.years.map((y, i) => [
        String(y),
        String(t.counts.fatal[i]),
        String(t.counts.severe[i]),
        String(t.counts.light[i]),
        String(t.counts.total[i])
      ]);
      docDefinition.content.push(makePdfTable(
        ["Jahr", "mit Getöteten", "mit Schwerverletzten", "mit Leichtverletzten", "Unfälle gesamt"],
        trendRows,
        undefined,
        { widths: ["auto", "auto", "auto", "auto", "*"] }
      ));
      const slopeStr = Number.isFinite(t.slope) ? t.slope.toFixed(2) : "—";
      const r2Str = Number.isFinite(t.r2) ? t.r2.toFixed(2) : "—";
      docDefinition.content.push({
        text: [
          { text: "Klassifikation: ", bold: true },
          { text: `${t.classification} ` },
          { text: `(Slope ${slopeStr}/Jahr, R² ${r2Str}, n=${t.nYears})`, italics: true }
        ],
        style: "normal",
        margin: [0, 0, 0, 8]
      });
    }

    // ---- STUNDEN-HEATMAP (#A2) ----
    if (sd && sd.heatmap && sd.heatmap.total > 0 && UA.heatmap) {
      const hm = sd.heatmap;
      docDefinition.content.push({ id: "hour-heatmap-heading", text: "STUNDEN-HEATMAP (WERKTAG VS. WOCHENENDE)", style: "subheader" });
      const body = [];
      // Header row
      body.push(["Stunde", "Mo–Fr", "Sa/So"].map(t => ({ text: t, bold: true, fillColor: "#EEEEEE", fontSize: 9, alignment: "center" })));
      for (let h = 0; h < 24; h++) {
        const row = [{ ...(h === 0 ? { id: "hour-heatmap-first-data" } : {}), text: `${String(h).padStart(2, "0")}:00`, fontSize: 9, bold: true }];
        for (let c = 0; c < 2; c++) {
          const v = hm.matrix[h][c];
          const fill = UA.heatmap.cellColor(v, hm.max);
          const txt = UA.heatmap.readableTextColor(fill);
          row.push({
            text: v > 0 ? String(v) : "",
            fontSize: 9,
            alignment: "center",
            color: txt,
            fillColor: fill
          });
        }
        body.push(row);
      }
      docDefinition.content.push({
        // Constrain width so the heatmap doesn't span the whole page; the
        // narrow 3-column layout reads better at typical magnifications.
        table: {
          headerRows: 1,
          keepWithHeaderRows: 1,
          // Slim hour col, two equal data cols; total ≈ 200 pt < page width.
          widths: [40, 60, 60],
          body
        },
        layout: "lightHorizontalLines",
        margin: [0, 4, 0, 6]
      });
      docDefinition.content.push({
        text: `Gesamt: ${hm.total} Unfälle (Mo–Fr: ${hm.colTotals[0]}, Sa/So: ${hm.colTotals[1]}). Max. ${hm.max} Unfälle pro Stunde × Tagestyp.`,
        italics: true,
        fontSize: 9,
        margin: [0, 0, 0, 8]
      });
    }

    // ---- VERKEHRSRÄUMLICHER KONTEXT (#C4) ----
    if (sd && sd.osmContext && sd.osmContext.summary) {
      const oc = sd.osmContext;
      const s = oc.summary;
      docDefinition.content.push({ text: "VERKEHRSRÄUMLICHER KONTEXT (OSM)", style: "subheader", headlineLevel: 2 });
      const ocBody = [];
      if (s.dominantMaxspeed != null) {
        ocBody.push([
          { text: "Vorherrschendes Tempolimit", bold: true, fontSize: 10 },
          { text: `${s.dominantMaxspeed} km/h (n=${s.speedSampleSize} Wegabschnitte)`, fontSize: 10 }
        ]);
      }
      ocBody.push([
        { text: "Radverkehrsanlagen", bold: true, fontSize: 10 },
        { text: s.cycleInfraWays > 0
            ? `${s.cycleInfraWays} Wegabschnitte mit Radinfrastruktur` + (s.cycleInfraShare != null ? ` (${Math.round(s.cycleInfraShare * 100)} % der Hauptachsen)` : "")
            : "keine separaten Radverkehrsanlagen erkannt", fontSize: 10 }
      ]);
      ocBody.push([
        { text: "Knoten / Querungen", bold: true, fontSize: 10 },
        { text: `${s.trafficSignals} signalisierte Knoten · ${s.crossings} markierte Querungen`, fontSize: 10 }
      ]);
      if (s.avgLanes != null) {
        ocBody.push([
          { text: "Ø Fahrstreifen", bold: true, fontSize: 10 },
          { text: `${s.avgLanes.toFixed(1)} (n=${s.lanesSampleSize})`, fontSize: 10 }
        ]);
      }
      if (s.avgWidthMeters != null) {
        ocBody.push([
          { text: "Ø Fahrbahnbreite", bold: true, fontSize: 10 },
          { text: `${s.avgWidthMeters.toFixed(1)} m (n=${s.widthSampleSize})`, fontSize: 10 }
        ]);
      }
      docDefinition.content.push({
        table: { widths: ["auto", "*"], body: ocBody },
        layout: "lightHorizontalLines",
        margin: [0, 4, 0, 4]
      });
      docDefinition.content.push({
        text: `Quelle: ${oc.source.publisher} (${oc.source.license}), via ${oc.source.retrievedVia}.`,
        italics: true,
        fontSize: 9,
        margin: [0, 0, 0, 4]
      });
      // Task 8 – analytische OSM-Schlussfolgerungen.
      if (Array.isArray(sd.osmInsights) && sd.osmInsights.length > 0) {
        docDefinition.content.push({ text: "OSM-Schlussfolgerungen:", bold: true, margin: [0, 4, 0, 2] });
        for (const s of sd.osmInsights) {
          docDefinition.content.push({ text: "• " + s, margin: [0, 0, 0, 2] });
        }
        docDefinition.content.push({ text: "", margin: [0, 0, 0, 6] });
      }
    } else if (sd && sd.osmContext && sd.osmContext.quality && sd.osmContext.quality.error) {
      docDefinition.content.push({ text: "VERKEHRSRÄUMLICHER KONTEXT (OSM)", style: "subheader", headlineLevel: 2 });
      for (const line of sd.osmContext.matchedRoads?.lines || ["OSM-Kontextdaten konnten beim Export nicht geladen werden."]) {
        docDefinition.content.push({ text: line, italics: true, fontSize: 9, margin: [0, 0, 0, 8] });
      }
    }

    // ---- FACHLICHE BEZÜGE section (if enabled) ----
    if (options.includeReferences) {
      const refs = sd && sd.references;
      const refsSection = extractSection(textLines, "Bezugsdokumente:");
      if ((refs && refs.documents && refs.documents.length > 0) || refsSection.length > 0) {
        docDefinition.content.push({
          text: "FACHLICHE BEZÜGE",
          style: "subheader", headlineLevel: 2
        });

        if (refs && refs.documents && refs.documents.length > 0) {
          for (const doc of refs.documents) {
            const title = doc.title || "Ohne Titel";
            const meta = [doc.author, doc.date].filter(Boolean).join(", ");
            docDefinition.content.push({
              text: meta ? `- ${title} (${meta})` : `- ${title}`,
              style: "normal"
            });
            if (doc.url) {
              docDefinition.content.push({
                text: "Quelle öffnen",
                link: doc.url,
                color: "blue",
                decoration: "underline",
                style: "normal"
              });
            }
          }
        } else {
          for (const line of refsSection) {
            const content = textWithLinks(line);
            docDefinition.content.push({
              text: content,
              style: "normal"
            });
          }
        }
      }

      // Issue 2 (e): Bisherige politische Befassung — analog zu DOCX,
      // damit PDF-Reports die ausgewählten Vorgänge mit allen Feldern
      // (Klassifikation, Auszug, Relevanz, URL, Portal) zeigen.
      const polRefs = sd && sd.politicalReferences;
      if (Array.isArray(polRefs) && polRefs.length > 0) {
        docDefinition.content.push({
          text: "Bisherige politische Befassung",
          style: "h2",
          margin: [0, 8, 0, 4]
        });
        for (const ref of polRefs) {
          const title = ref.title || "Ohne Titel";
          const meta = [ref.type, ref.date, ref.gremium, ref.number].filter(Boolean).join(" · ");
          docDefinition.content.push({
            text: meta ? `- ${title} (${meta})` : `- ${title}`,
            bold: true,
            style: "normal",
            margin: [0, 4, 0, 2]
          });
          if (ref.referenceType && ref.referenceType !== ref.type) {
            docDefinition.content.push({
              text: `  Klassifikation: ${ref.referenceType}`,
              italics: true, style: "normal", margin: [10, 0, 0, 2]
            });
          }
          if (ref.snippet) {
            docDefinition.content.push({
              text: `  Auszug: ${String(ref.snippet).slice(0, 240)}`,
              style: "normal", margin: [10, 0, 0, 2]
            });
          }
          if (ref.reason) {
            docDefinition.content.push({
              text: `  Relevanz: ${ref.reason}`,
              italics: true, style: "normal", margin: [10, 0, 0, 2]
            });
          }
          if (ref.url) {
            docDefinition.content.push({
              text: [
                { text: "Vorgang öffnen", link: ref.url, color: "blue", decoration: "underline" }
              ],
              style: "normal", margin: [10, 0, 0, 2]
            });
          }
          if (ref.source) {
            docDefinition.content.push({
              text: `  Portal: ${ref.source}`,
              italics: true, style: "normal", margin: [10, 0, 0, 4]
            });
          }
          for (const line of snapshotCitationLines(ref.snapshot)) {
            docDefinition.content.push({
              text: `  ${line}`,
              italics: true, style: "normal", margin: [10, 0, 0, 2]
            });
          }
        }
      }
    }

    // ---- DATENQUELLE section ----
    docDefinition.content.push({
      text: "DATENQUELLE",
      style: "subheader"
    });

    docDefinition.content.push({
      text: "Unfallatlas / Open-Data-Downloads. Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0).",
      style: "normal"
    });

    const evidenceSection = [];
    if (evidence) {
      const annexName = evidence.complete ? "Vollständige Unfallliste" : "Nummerierte Unfallliste";
      evidenceSection.push({
        text: `Anlage ${1 + Number(hasMap)} – ${annexName}`,
        style: "motionTitle", headlineLevel: 1, pageBreak: "before"
      });
      evidenceSection.push(...evidenceAnnexIntro(evidence, renderedEvidenceMapRefs.size > 0).map(motionParagraph));
      if (evidence.link) {
        evidenceSection.push({ ...linkedPdfRun({ text: "Nummerierte Karte in der Werkbank öffnen", href: evidence.link }), style: "motionNote" });
      }
      if (evidence.rows.length) {
        const { headers, rows } = evidenceTable(evidence, renderedEvidenceMapRefs, "evidence-map-");
        const dataRows = rows.map(row =>
          row.map(cell => typeof cell === "object" ? linkedPdfRun(cell, 9) : cell));
        evidenceSection.push(makePdfTable(headers, dataRows, undefined, {
          widths: [31, 25, 68, "*", 50, 65, 52, 41, 24].slice(0, headers.length),
          keepRowsTogether: true, layout: EVIDENCE_PDF_LAYOUT
        }));
      }
      for (const line of [evidence.sourceNote, ...evidence.limitations].filter(Boolean)) {
        evidenceSection.push({ ...motionParagraph(line), style: "motionNote" });
      }
    }
    if (formalMotion) docDefinition.content.splice(firstAnnexIndex, 0, ...mapSection, ...evidenceSection);

    // Generate and download PDF
    const citySlug = CITY_RAW
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const titleSlug = docTitle
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const filename = `${titleSlug}_${citySlug}_${today.replace(/\./g, "-")}.pdf`;

    // QA-PR „Export-Semantik vor Layout" — Pre-flight-Gate über den
    // sichtbaren docDefinition-Text. Bricht den Export ab, falls noch
    // Beteiligten-Emojis, FontAwesome-Glyphen, „Fetch is aborted",
    // „Beteiligungsmaske", „Scope" usw. im sichtbaren Output stehen.
    // Akzeptanzkriterium: das erzeugte PDF wirkt wie ein Verwaltungs-
    // dokument und nicht wie ein UI-Dump.
    if (!options || options._skipQAGate !== true) {
      const gate = runExportQAGate(docDefinition.content);
      if (!gate.ok) {
        const head = gate.violations.slice(0, 3).map(v => v.reason).join(" | ");
        const more = gate.violations.length > 3 ? ` (+${gate.violations.length - 3} weitere)` : "";
        const msg = `Export abgebrochen: PDF-Inhalt enthält noch nicht-verwaltungstaugliche Tokens — ${head}${more}.`;
        // Banner für UI-Sichtbarkeit, falls vorhanden.
        try {
          const bar = (typeof document !== "undefined") ? document.getElementById("exportProgress") : null;
          if (bar) { bar.textContent = msg; bar.style.display = "block"; }
        } catch (_) { /* DOM nicht verfügbar (Tests) → still */ }
        const err = new Error(msg);
        err.qaViolations = gate.violations;
        throw err;
      }
    }

    await window.pdfMake.createPdf(docDefinition).download(filename);
  };

  // =====================================================================
  // Helper functions
  // =====================================================================

  /**
   * Extract a section from text lines
   * @param {Array<string>} lines - Text lines
   * @param {string} sectionHeader - Section header to look for
   * @param {Array<string>} [stopSections] - Optional array of section headers to stop at
   * @returns {Array<string>} Section lines
   */
  function extractSection(lines, sectionHeader, stopSections) {
    const result = [];
    let inSection = false;

    // Default stop sections cover every post-Sachverhalt block header
    // emitted by the TEXT renderer in js/ua.export_v2.js — see
    // POST_SACHVERHALT_STOP_HEADERS for rationale and the regression
    // assertion in tests/unit/ua.report_v2.pdfQA.test.js.
    const stopPatterns = stopSections || POST_SACHVERHALT_STOP_HEADERS;
    
    for (const line of lines) {
      if (line.includes(sectionHeader)) {
        inSection = true;
        continue;
      }
      
      if (inSection) {
        // Stop at next major section (check if line starts with any stop pattern)
        const trimmedLine = line.trim();
        const shouldStop = stopPatterns.some(pattern => trimmedLine.startsWith(pattern));
        if (shouldStop) {
          break;
        }
        
        if (line.trim()) {
          result.push(line);
        }
      }
    }
    
    return result;
  }

  /**
   * Initialize export UI bindings for Word/PDF
   * @param {Object} ctx - Application context
   */
  UA.initReportExportUI = function initReportExportUI(ctx) {
    const btnExportWord = document.getElementById("btnExportWord");
    const btnExportPDF = document.getElementById("btnExportPDF");
    const cbIncludeMap = document.getElementById("cbIncludeMap");
    const cbIncludePOIs = document.getElementById("cbIncludePOIs");
    const cbIncludeRefs = document.getElementById("cbIncludeRefs");
    const cbIncludeCosts = document.getElementById("cbIncludeCosts");
    const cbIncludeMeasures = document.getElementById("cbIncludeMeasures");
    const heatExportOpacityEl = document.getElementById("heatExportOpacity");
    const exportProgress = document.getElementById("exportProgress");
    const heatExportOpacityValEl = document.getElementById("heatExportOpacityVal");

    if (!btnExportWord || !btnExportPDF || !exportProgress) {
      console.warn("Export buttons or progress element not found in DOM");
      return;
    }

    // Wire up slider label update (avoids inline oninput in HTML)
    if (heatExportOpacityEl && heatExportOpacityValEl) {
      heatExportOpacityEl.addEventListener("input", function () {
        heatExportOpacityValEl.textContent = heatExportOpacityEl.value + " %";
      });
    }

    /**
     * Attach a generic export handler to a button.
     *
     * @param {HTMLButtonElement} button - The button to bind the handler to.
     * @param {string} inProgressText - Message shown while export is running.
     * @param {string} successText - Message shown when export succeeds.
     * @param {string} consoleErrorPrefix - Prefix for console error logging.
     * @param {string} alertErrorPrefix - Prefix for alert error message.
     * @param {Function} exportFn - Export function (e.g., UA.exportToWord/PDF).
     */
    function attachExportHandler(
      button,
      inProgressText,
      successText,
      consoleErrorPrefix,
      alertErrorPrefix,
      exportFn
    ) {
      button.addEventListener("click", async () => {
        // Collect all export buttons so both can be disabled during load/export
        const allExportButtons = [btnExportWord, btnExportPDF].filter(Boolean);
        function setButtonsDisabled(disabled) {
          allExportButtons.forEach((btn) => {
            btn.style.opacity = disabled ? "0.6" : "1";
            btn.style.cursor = disabled ? "not-allowed" : "pointer";
            btn.disabled = disabled;
          });
        }
        try {
          exportProgress.textContent = "Lade Export-Bibliotheken...";
          setButtonsDisabled(true);

          // Ensure libraries are loaded (with per-library progress indication).
          // Concurrent clicks share the same in-flight Promise via UA._exportLibrariesLoading.
          await UA.ensureExportLibraries(function(msg) {
            exportProgress.textContent = msg;
          });
          
          exportProgress.textContent = inProgressText;

          // Get current report data. Pass cost/measures opt-out via ctx so
          // computeExportReport can honour the modal toggles when building
          // the text/HTML/structured payload (default: include both).
          ctx.exportOptions = Object.assign({}, ctx.exportOptions, {
            includeCosts:    cbIncludeCosts    ? cbIncludeCosts.checked    : true,
            includeMeasures: cbIncludeMeasures ? cbIncludeMeasures.checked : true
          });
          const reportData = await UA.computeExportReport(ctx);

          // Pre-Flight-Konsistenz-Gate (Phase 2.2):
          //  - Invariante 1 (table_exceeds_total): echter Logik-Bug
          //    (Tabelle behauptet mehr Zeilen als die Gesamt-Fallzahl) →
          //    Export wird abgebrochen.
          //  - Invariante 2 (table_map_mismatch): „Tabelle vs. Karte" sind
          //    aktuell aus *unterschiedlichen* Filterpfaden zusammengesetzt
          //    (accidentDetails wendet aktuell den Involvement-Filter nicht
          //    an, viewportPts schon). Eine Abweichung ist daher in der
          //    Praxis erwartbar und KEIN Grund den Export zu blockieren —
          //    sie wird als Warnung im Banner und in der Konsole angezeigt,
          //    der Export läuft regulär weiter.
          if (typeof UA.validateExportConsistency === "function") {
            const consistency = UA.validateExportConsistency(ctx, reportData && reportData.structured);
            if (consistency && consistency.ok === false) {
              if (consistency.kind === "table_exceeds_total") {
                exportProgress.textContent = consistency.message;
                alert(consistency.message);
                setButtonsDisabled(false);
                return;
              }
              // table_map_mismatch → soft warning, do not abort the export.
              console.warn("[Pre-Flight]", consistency.message);
              exportProgress.textContent = `Hinweis: ${consistency.message}`;
            }
          }

          // Get export options
          const rawPct = heatExportOpacityEl ? parseInt(heatExportOpacityEl.value, 10) : 40;
          const heatOpacityPct = Number.isFinite(rawPct) ? Math.max(0, Math.min(100, rawPct)) : 40;
          const options = {
            includeMap: cbIncludeMap ? cbIncludeMap.checked : true,
            includePOIs: cbIncludePOIs ? cbIncludePOIs.checked : true,
            includeReferences: cbIncludeRefs ? cbIncludeRefs.checked : true,
            includeCosts:    cbIncludeCosts    ? cbIncludeCosts.checked    : true,
            includeMeasures: cbIncludeMeasures ? cbIncludeMeasures.checked : true,
            heatmapExportOpacity: heatOpacityPct / 100
          };

          await exportFn(ctx, reportData, options);

          exportProgress.textContent = successText;
        } catch (e) {
          console.error(consoleErrorPrefix, e);
          exportProgress.textContent = `Fehler: ${e.message}`;
          alert(alertErrorPrefix + e.message);
        } finally {
          setButtonsDisabled(false);
        }
      });
    }

    // Word export handler
    attachExportHandler(
      btnExportWord,
      "Word-Dokument wird erstellt...",
      "Word-Dokument erfolgreich erstellt.",
      "Word export failed:",
      "Word-Export fehlgeschlagen: ",
      UA.exportToWord
    );

    // PDF export handler
    attachExportHandler(
      btnExportPDF,
      "PDF wird erstellt...",
      "PDF erfolgreich erstellt.",
      "PDF export failed:",
      "PDF-Export fehlgeschlagen: ",
      UA.exportToPDF
    );
  };

})();
