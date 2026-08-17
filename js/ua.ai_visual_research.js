/** Semantic map reading and accident-background research for the AI handoff. */
(() => {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  const UA = (root.UA = root.UA || {});
  const VISUAL_SCENE_SCHEMA = 'unfallwerkbank.visualSceneAnalysis.v1';
  const ACCIDENT_BACKGROUND_SCHEMA = 'unfallwerkbank.accidentBackgroundResearch.v1';
  const ENHANCED_HANDOFF_SCHEMA = 'unfallwerkbank.aiResearchHandoff.v3';
  const MARKERS = Object.freeze([
    'SEMANTISCHE KARTENINTERPRETATION', 'Schienen/Gleise',
    'Fahrradalleinunfälle', 'räumliche Assoziation',
    'Kurven und Verschwenkungen', 'Kopfsteinpflaster',
    'UNFALLHINTERGRUNDRECHERCHE', 'amtlichen Polizeimeldungen',
    'gleicher Ort', 'keine Ursache für die gesamte Häufung',
  ]);
  const clean = value => String(value == null ? '' : value).trim();
  const unique = (...lists) => [...new Set(lists.flat().map(clean).filter(Boolean))];

  function stableJson(value) {
    const base = UA.aiLinkHandoff?._internal?.stableJson;
    if (typeof base === 'function') return base(value);
    const sort = item => {
      if (!item || typeof item !== 'object') return item;
      if (Array.isArray(item)) return item.map(sort);
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])]));
    };
    return JSON.stringify(sort(value), null, 2);
  }

  function safeUrl(value) {
    try { return new URL(String(value || ''), root.location?.href || undefined); }
    catch (_) { return null; }
  }

  function createInspectionView(analysisUrl, definition) {
    const url = safeUrl(analysisUrl);
    if (!url) return { ...definition, url: clean(analysisUrl) };
    url.searchParams.set('mapMode', definition.mapMode);
    url.searchParams.set('showCluster', definition.showCluster ? '1' : '0');
    url.searchParams.set('showHeatmap', definition.showHeatmap ? '1' : '0');
    url.searchParams.delete('export');
    url.searchParams.delete('tour');
    return { id: definition.id, label: definition.label, purpose: definition.purpose,
      mapMode: definition.mapMode, url: url.href };
  }

  function buildInspectionViews(analysisUrl) {
    return [
      ['standard-structure', 'Standardkarte – Netztopologie und Straßennamen', 'standard', false, false,
        'Straßennamen, Knoten, Gleisachsen, Wegebeziehungen und Unfallpunkte nachvollziehen.'],
      ['hybrid-conflict-space', 'Hybridkarte – Luftbild mit lesbarer Beschriftung', 'hybrid', false, false,
        'Geometrie, Haltestellen, Schienen, Kurven und querende Bewegungen gemeinsam lesen.'],
      ['orthophoto-layout', 'Orthofoto – reale Flächengeometrie', 'orthophoto', false, false,
        'Fahrspuren, Inseln, Bussteigkanten, Radführungen, Abbiegeradien und Sichtbarrieren prüfen.'],
      ['analysis-density', 'Analyseansicht – Unfallpunkte, Cluster und Dichte', 'analysis', true, true,
        'Infrastrukturmerkmale räumlich mit Unfallpunkten und Teilclustern verknüpfen.'],
    ].map(([id, label, mapMode, showCluster, showHeatmap, purpose]) =>
      createInspectionView(analysisUrl, { id, label, mapMode, showCluster, showHeatmap, purpose }));
  }

  function feature(id, label, questions) { return { id, label, questions }; }

  function buildVisualSceneAnalysisContract(inspectionViews) {
    return {
      schemaVersion: VISUAL_SCENE_SCHEMA,
      status: 'required-not-yet-executed',
      purpose: 'Karten als multimodale Verkehrsszene lesen und sichtbare Besonderheiten mit Unfallpunkten abgleichen.',
      inspectionViews: inspectionViews || [],
      requiredProcedure: [
        'Standard-, Hybrid-, Orthofoto- und Analyseansicht mit identischen Filtern und Grenzen öffnen.',
        'Relevante Stellen in Übersicht und näherer Zoomstufe prüfen.',
        'Unfallpunkte nach Beteiligungskonstellation trennen; insbesondere Fahrradalleinunfälle gesondert auf Schienen-, Oberflächen- und Kurvenbezug prüfen.',
        'Jeden Bildbefund räumlich auf Unfallpunkte, Teilcluster oder Bewegungsbeziehungen beziehen.',
        'Räumliche Koinzidenzen ausdrücklich als Befund und Mechanismushypothese benennen; den Kausalstatus davon getrennt ausweisen.',
        'Beobachtung, Hypothese und extern bestätigten Kontext trennen.',
        'Strukturierte Straßendaten gegenprüfen; unsichtbare Bilddetails nicht schätzen.',
      ],
      requiredFeatureClasses: [
        feature('rails-and-track-interface', 'Schienen/Gleise und Querungswinkel', [
          'Liegt eine befahrbare/zu querende Rillenschiene in einer plausiblen Radfahrlinie?',
          'Liegen mehrere Fahrradalleinunfälle auf, unmittelbar an oder in der Anfahrts-/Querungszone derselben befahrbaren Schiene?',
          'Folgen Unfallpunkte derselben Schienenachse oder konzentrieren sie sich an Kurve, Weiche, Querung oder Führungssprung?',
          'Ist der Winkel flach oder durch Kurve/Verschwenkung räumlich erzwungen?',
          'Nur Bahntrasse/Barriere oder tatsächlich befahrbare Schiene?',
        ]),
        feature('curvature-and-deflection', 'Kurven und Verschwenkungen', [
          'Enge Kurven, S-Kurven, Seitenwechsel oder kleine Abbiegeradien?',
          'Kombination mit Querung, Gefälle, Schiene, Haltestelle oder Sichtabschattung?',
        ]),
        feature('junction-turning-merging', 'Knoten, Abbiegen, Einfädeln und Fahrstreifenwechsel', [
          'Kreuzen sich Geradeaus-/Abbiegebeziehungen oder endet die Radführung im Kfz-Verkehr?',
          'Taxi-, Liefer-, Park-, Bus- oder Grundstückszufahrten?',
        ]),
        feature('walking-cycling-motor-crossings', 'Kreuzungen von Kfz-, Fuß- und Radverkehr', [
          'Überlagern sich Wunschlinien von Fuß-, Rad- und Kfz/ÖPNV-Verkehr?',
          'Radführung durch Warte-, Ein-/Ausstiegs- oder Querungsbereiche?',
          'Querung signalisiert, versetzt oder aus der Annäherung schlecht erkennbar?',
        ]),
        feature('transit-platform-and-stop-edge', 'Haltestellen und Bus-/Bahnsteigkanten', [
          'Müssen Fahrgäste Bus- oder Radfahrspuren queren?',
          'Warteflächen unmittelbar an Fahrgassen oder in engen Mischflächen?',
        ]),
        feature('cycle-facility-continuity', 'Kontinuität der Radverkehrsführung', [
          'Beginn, Ende, Seitenwechsel, Gegenrichtung oder unklarer Übergang?',
          'Entstehen Mischflächen oder erzwungene Einordnungen?',
        ]),
        feature('visibility-and-constrained-space', 'Sicht und Engstellen', [
          'Gebäude, Bäume, Einbauten, parkende Fahrzeuge oder Kurven als Sichtbarrieren?',
          'Verengt sich der nutzbare Raum an Unfallpunkten/Querungen?',
        ]),
        feature('surface-and-drainage', 'Oberfläche, Kanten und Entwässerung', [
          'Fugen, Rinnen, Schienen, Kanten, Aufpflasterung oder Materialwechsel eindeutig sichtbar?',
          'Kopfsteinpflaster braucht ausreichende Auflösung, ein aktuelles Bild und eine zweite Quelle; andernfalls „nicht sicher beurteilbar“.',
        ]),
      ],
      observationSchema: {
        requiredFields: ['featureClass', 'locationDescription', 'viewIdAndZoom',
          'visibleEvidence', 'accidentSubset', 'spatialRelationToAccidents',
          'proximityOrOverlap', 'mechanismHypothesis', 'causalStatus',
          'confidence', 'evidenceLevel', 'alternativeExplanation', 'requiredVerification'],
        confidenceValues: ['high', 'medium', 'low', 'not-assessable'],
        evidenceLevelValues: ['C1-multiple-map-views', 'C2-one-map-view',
          'C3-external-or-structured-corroboration', 'D-needs-field-check'],
        causalStatusValues: ['spatial-association', 'mechanism-plausible',
          'externally-corroborated', 'causally-confirmed', 'not-assessable'],
      },
      interpretationRules: [
        'Kartensicht und Unfallpunkte dürfen einen Zusammenhang belegen: räumliche Assoziation und mechanistische Plausibilität sind auszugeben; eine bestätigte Ursache braucht zusätzliche Evidenz.',
        'Mehrere Fahrradalleinunfälle an derselben befahrbaren Schiene sind ein eigenständiger priorisierungsrelevanter Befund und lösen zwingend eine Schienenhypothese aus.',
        'Hauptbahntrasse ist nicht automatisch Schienensturzgefahr; relevant ist eine befahrbare/zu querende Schiene.',
        'Einzelne sichtbare Fahrzeuge sind keine belastbare Verkehrsmenge.',
        'Befliegungsstand prüfen und aktuelle Infrastruktur/Planung gegenhalten.',
        'Bei schlechter Auflösung „nicht beurteilbar“ statt raten.',
      ],
      minimumOutput: { openedMapModes: 3, zoomLevelsPerMaterialFeature: 2,
        locatedFeatureObservations: 3, observationsLinkedToAccidentPointsOrClusters: 2,
        accidentSubsetComparisons: 1, explicitNotAssessableFindings: true,
        prioritisedVisualChecks: 3,
        requiredWhenPresent: ['bike-solo-near-rideable-rail'] },
      automaticFailure: [
        'Nur Kartenlesbarkeit geprüft, ohne semantische Szenenanalyse.',
        'Schienen, Oberfläche oder Führung ohne sichtbare Evidenz behauptet.',
        'Kopfsteinpflaster oder Material aus unscharfem Bild abgeleitet.',
        'Mehrere Fahrradalleinunfälle an oder nahe einer befahrbaren Schiene ohne explizite räumliche und mechanistische Zusammenhangsprüfung.',
        'Räumliche Koinzidenz verschwiegen, nur weil sie noch kein bestätigter Kausalnachweis ist.',
        'Merkmal ohne räumlichen Unfallbezug als Erklärung der Häufung ausgegeben.',
        'Bildbeobachtung als gesicherte Unfallursache formuliert.',
      ],
    };
  }

  function extractResearchSeeds(facts) {
    const structured = facts?.structured || {};
    const meta = facts?.deterministicAnalysisDigest?.meta
      || structured?.deterministicAnalysisDigest?.meta || structured?.meta || {};
    return {
      city: clean(meta.city || facts?.city) || null,
      area: clean(meta.areaName) || null,
      involvement: clean(meta?.filters?.involvement || meta?.involvementMode
        || structured?.meta?.filters?.involvement) || null,
      featureTerms: ['Unfall', 'Radfahrer', 'Fahrradalleinunfall', 'Fußgänger',
        'Pkw', 'Bus', 'Straßenbahn', 'Schiene', 'Kurve', 'Kreuzung', 'Querung', 'Radweg'],
    };
  }

  function buildAccidentBackgroundResearchContract(facts) {
    return {
      schemaVersion: ACCIDENT_BACKGROUND_SCHEMA,
      status: 'required-not-yet-executed',
      purpose: 'Ortsgenaue Recherche nach Unfallmeldungen, Kontrollen, Planungen und Sicherheitsdiskussionen.',
      searchSeeds: extractResearchSeeds(facts),
      sourcePriority: [
        { rank: 1, sourceType: 'official-police-or-fire-service',
          instruction: 'Amtliche Polizeimeldungen/Feuerwehr zuerst; Ort, Datum und Ermittlungsstand exakt.' },
        { rank: 2, sourceType: 'official-city-council-project-or-operator',
          instruction: 'Stadt, RIS, Unfallkommission, Verkehrsunternehmen und Projektseiten.' },
        { rank: 3, sourceType: 'reputable-local-journalism-or-association',
          instruction: 'Nur ergänzend; Primärquelle bevorzugen und Abhängigkeit kenntlich machen.' },
      ],
      queryPlan: [
        'Exakten Bereich/Straßennamen plus Unfall und beteiligte Verkehrsarten suchen.',
        'Zusätzlich visuelle Merkmale wie Schiene, Kurve, Bussteig, Querung oder Radweg suchen.',
        'Bei Fahrradalleinunfällen gezielt nach Schienensturz, Rillenschiene, Querungswinkel, Ausweichbewegung und Oberflächenzustand suchen.',
        'Amtliche Unfallmeldungen, politische Vorgänge und laufende Planungen getrennt recherchieren.',
        'Suchbegriffe, Zeitraum, Quellen und Nulltreffer dokumentieren; kein Treffer ist kein Negativbeweis.',
      ],
      spatialMatchClasses: [
        { id: 'inside-selection', label: 'gleicher Ort / innerhalb der Auswahl', use: 'stärkster Kontextbezug, keine automatische Aggregaterklärung' },
        { id: 'immediate-adjacency', label: 'angrenzender Knoten/Korridor', use: 'fortgesetzte Bewegung oder verlagerten Konflikt prüfen' },
        { id: 'citywide-analogue', label: 'stadtweiter Analogiefall', use: 'nur Mechanismus-/Prüfhinweis' },
        { id: 'unknown-or-unrelated', label: 'unklar/unpassend', use: 'nicht zur örtlichen Begründung verwenden' },
      ],
      resultSchema: { requiredFields: ['eventDate', 'publicationDate', 'exactLocation',
        'spatialMatchClass', 'participants', 'injurySeverity', 'reportedMechanism',
        'investigationStatus', 'sourceTitle', 'sourceUrl', 'sourceType',
        'relationToVisualObservation', 'relationToDeterministicAccidents', 'limitations'] },
      interpretationRules: [
        'Ein einzelner Pressebericht plausibilisiert höchstens eine Konfliktart und ist keine Ursache für die gesamte Häufung.',
        'Gleichen Ort, angrenzenden Korridor und stadtweiten Analogiefall ausdrücklich trennen.',
        'Polizeiliche Vorbehalte wie „könnte“ und laufende Ermittlungen bewahren.',
        'Beteiligung, Jahr, Schwere und räumliche Lage gegen das gefilterte Kollektiv prüfen.',
        'Keine für die Sicherheitsanalyse unnötigen personenbezogenen Details übernehmen.',
      ],
      minimumOutput: { documentedQueries: 4, officialSourceSearches: 2,
        incidentTable: true, noHitLog: true, visualFeatureCrossCheck: true,
        explicitAggregateCausalityCaveat: true },
      automaticFailure: [
        'Allgemeine Websuche ohne genaue Orts-/Merkmalsbegriffe.',
        'Sekundärmeldung trotz auffindbarer Primärquelle.',
        'Anderer Stadtteil als lokaler Beleg ausgegeben.',
        'Presseereignis ungeprüft dem Unfallkollektiv zugerechnet.',
        'Einzelereignis als Erklärung der gesamten Häufung dargestellt.',
      ],
    };
  }

  function augmentComparisonContract(contract) {
    const current = contract && typeof contract === 'object' ? contract : {};
    const required = [...(current.requiredAiAddedValue || [])];
    const ids = new Set(required.map(item => clean(item?.id)));
    for (const item of [
      { id: 'semantic-visual-scene-analysis', requirement: 'Mehrere Kartenmodi semantisch auf Schienen, Kurven, Kreuzungen, Führungswechsel und Sicht prüfen.' },
      { id: 'bike-solo-infrastructure-association', requirement: 'Fahrradalleinunfälle räumlich und mechanistisch mit befahrbaren Schienen, Kurven und Oberflächen abgleichen.' },
      { id: 'accident-background-research', requirement: 'Amtliche Unfall-/Planungsrecherche mit räumlicher Passklasse und Quellenkritik.' },
    ]) if (!ids.has(item.id)) required.push(item);
    return { ...current, requiredAiAddedValue: required,
      prohibitedShortcuts: unique(current.prohibitedShortcuts, [
        'Kartenlesbarkeit als semantische Bildanalyse ausgeben.',
        'Räumliche Koinzidenz von Fahrradalleinunfällen und befahrbarer Schiene wegen fehlenden Kausalnachweises ignorieren.',
        'Kopfsteinpflaster/Oberfläche aus niedriger Auflösung ableiten.',
        'Ein Presseereignis als Ursache des Gesamtmusters ausgeben.',
        'Exakte und nur analoge Ereignisse ohne räumliche Klasse mischen.',
      ]),
      minimumOutput: { ...(current.minimumOutput || {}), semanticVisualSceneAnalysis: true,
        bikeSoloInfrastructureAssociation: true, accidentBackgroundResearchLog: true,
        locatedVisualObservations: 3, visualToIncidentCrossChecks: 2 } };
  }

  function enhanceFactsPackage(facts, analysisUrl) {
    if (!facts || typeof facts !== 'object') return facts;
    const visualInspectionViews = buildInspectionViews(analysisUrl || facts.mapUrl || facts.analysisUrl || '');
    return { ...facts, visualInspectionViews,
      visualSceneAnalysisContract: buildVisualSceneAnalysisContract(visualInspectionViews),
      accidentBackgroundResearchContract: buildAccidentBackgroundResearchContract(facts),
      aiAnalysisComparisonContract: augmentComparisonContract(
        facts.aiAnalysisComparisonContract || facts?.structured?.aiAnalysisComparisonContract),
      visualAndResearchReadiness: {
        visualSceneStatus: 'pending-model-inspection',
        accidentBackgroundStatus: 'pending-web-research', filingReady: false,
        rule: 'Einreichungsreife setzt dokumentierte Karten-/Unfallrecherche oder begründete Nichtdurchführbarkeit voraus.',
      } };
  }

  function promptSection(views, visual, background) {
    return ['', '## SEMANTISCHE KARTENINTERPRETATION – NICHT NUR SICHTBARKEITS-QA',
      'Lies Standard-, Hybrid- und Orthofotokarte inhaltlich; prüfe relevante Stellen in Übersicht und Detailzoom.',
      '- **Schienen/Gleise:** befahrbare Rillenschiene, Radfahrlinie und Querungswinkel; Hauptbahntrasse nicht verwechseln.',
      '- **Fahrradalleinunfälle:** Punkte als eigenes Teilkollektiv prüfen. Liegen mehrere auf, unmittelbar an oder in der Anfahrts-/Querungszone derselben Schiene, ist dieser Zusammenhang ausdrücklich zu benennen und zu priorisieren.',
      '- **Kurven und Verschwenkungen:** enge Radien, S-Kurven, Seitenwechsel und verdeckte Annäherungen.',
      '- **Kreuzende Bewegungen:** Kfz-/Bus-/Taxi-/Liefer-, Fuß- und Radverkehr, Wunschlinien, Zu-/Ausfahrten, Abbiegen und Radwegenden.',
      '- **Sicht und Engstellen:** Gebäude, Einbauten, Vegetation, Parken und Kurven.',
      '- **Oberfläche:** Kopfsteinpflaster, Rinnen und Kanten nur mit hoher Auflösung und zweiter Quelle; sonst „nicht sicher beurteilbar“.',
      'Trenne drei Stufen: **räumliche Assoziation** (Karte und Punkte), **mechanistische Plausibilität** (Fahrlinie, Winkel, Kurve, Ausweichen) und **bestätigte Ursache** (zusätzliche Unfall-/Vor-Ort-Evidenz).',
      'Je Befund: genaue Lage, Ansicht/Zoom, sichtbare Evidenz, Unfall-Teilmengenbezug, Nähe/Überlagerung, Mechanismushypothese, Kausalstatus, Konfidenz, Alternative und Verifikation.',
      '', 'Prüfansichten:', ...views.map(view => `- **${view.label}** (${view.id}): ${view.url}\n  ${view.purpose}`),
      '', '## UNFALLHINTERGRUNDRECHERCHE – KURZ, ORTSGENAU UND QUELLENKRITISCH',
      'Suche nach Unfallmeldungen, Kontrollen, Sicherheitsdiskussionen und Planungen; beginne mit amtlichen Polizeimeldungen und Primärquellen.',
      'Kombiniere genaue Ortsnamen mit beteiligten Verkehrsarten und sichtbaren Merkmalen.',
      'Ordne jeden Treffer als **gleicher Ort**, **angrenzender Korridor**, **stadtweiter Analogiefall** oder **unklar/unpassend** ein.',
      'Prüfe Filter, Zeitraum, Schwere und Mechanismus. Ein einzelner Bericht ist keine Ursache für die gesamte Häufung.',
      'Dokumentiere Suchbegriffe, Quellen und Nulltreffer; kein Treffer bedeutet nicht keine Vorbefassung.',
      '', '## Zusätzliche Pflichtausgabe',
      '9. Kartenbeobachtungstabelle mit Teilkollektiv, Nähe/Überlagerung, Mechanismushypothese, Kausalstatus und Konfidenz',
      '10. Unfall-/Kontexttabelle mit räumlicher Passklasse und Quelle',
      '11. Kreuzvalidierung: gestützt | widerlegt | offen',
      '12. Liste „nicht sicher aus der Karte beurteilbar“',
      '', '## Maschinenlesbare Verträge', '```json',
      stableJson({ visualSceneAnalysisContract: visual,
        accidentBackgroundResearchContract: background }), '```'].join('\n');
  }

  function auditEnhancedPrompt(prompt) {
    const missingMarkers = MARKERS.filter(marker => !clean(prompt).includes(marker));
    return { schemaVersion: 'unfallwerkbank.aiVisualResearchPromptAudit.v1',
      passed: missingMarkers.length === 0, requiredMarkers: [...MARKERS], missingMarkers };
  }

  function enhanceHandoff(base) {
    if (!base || typeof base !== 'object') return base;
    const views = buildInspectionViews(base.analysisUrl || base?.facts?.mapUrl || '');
    const facts = enhanceFactsPackage(base.facts || {}, base.analysisUrl);
    const prompt = `${clean(base.prompt)}${promptSection(views,
      facts.visualSceneAnalysisContract, facts.accidentBackgroundResearchContract)}`;
    const visualAudit = auditEnhancedPrompt(prompt);
    const baseAudit = base.promptAudit || { passed: true, missingMarkers: [] };
    return { ...base, schemaVersion: ENHANCED_HANDOFF_SCHEMA, facts,
      visualInspectionViews: views,
      visualSceneAnalysisContract: facts.visualSceneAnalysisContract,
      accidentBackgroundResearchContract: facts.accidentBackgroundResearchContract,
      visualResearchPromptAudit: visualAudit, prompt,
      promptAudit: { ...baseAudit, passed: baseAudit.passed !== false && visualAudit.passed,
        missingMarkers: unique(baseAudit.missingMarkers, visualAudit.missingMarkers),
        visualResearchAudit: visualAudit } };
  }

  async function generateResearchHandoff(UAValue, ctx) {
    const base = UAValue?.aiLinkHandoff;
    if (typeof base?.generateResearchHandoff !== 'function') throw new Error('missing_link_handoff');
    const enhanced = enhanceHandoff(await base.generateResearchHandoff(UAValue, ctx || {}));
    if (!enhanced?.promptAudit?.passed) throw new Error('visual_research_contract_incomplete');
    return enhanced;
  }

  function setStatus(text) {
    const node = root.document?.getElementById('aiPromptStatus');
    if (node) node.textContent = text || '';
  }
  function runtimeContext() { return UA.getRuntimeContext?.() || {}; }
  function bindButton(id, action) {
    let button = root.document?.getElementById(id);
    if (!button) return false;
    if (button.dataset.uaVisualResearch === '1') return true;
    const clone = button.cloneNode(true);
    clone.dataset.uaVisualResearch = '1';
    button.replaceWith(clone); button = clone;
    button.addEventListener('click', async () => {
      const old = button.innerHTML; button.disabled = true;
      button.innerHTML = '<span aria-hidden="true">⏳</span> Karten-/Unfallrecherche wird erzeugt …';
      try { await action(await generateResearchHandoff(UA, runtimeContext())); }
      catch (error) { setStatus(`Erweiterte KI-Übergabe fehlgeschlagen: ${error?.message || error}`); }
      finally { button.disabled = false; button.innerHTML = old; }
    });
    return true;
  }

  function bindEnhancedControls() {
    const documentValue = root.document;
    const internal = UA.aiLinkHandoff?._internal;
    if (!documentValue?.getElementById('btnAiResearchLinkCopy') || !internal) return false;
    bindButton('btnAiResearchLinkCopy', async handoff => {
      await internal.writeClipboard(handoff.prompt);
      setStatus(`KI-Auftrag mit ${handoff.visualInspectionViews.length} Kartenansichten und Unfallrecherche kopiert.`);
    });
    bindButton('btnAiPromptDownloadMd', async handoff => {
      const date = String(handoff.createdAt || new Date().toISOString()).slice(0, 10);
      internal.downloadTextFile(`${internal.safeFilename(handoff.city)}_${date}_karten_unfallrecherche.md`,
        'text/markdown;charset=utf-8', handoff.prompt);
      setStatus('Erweiterter Karten-/Unfallrechercheauftrag heruntergeladen.');
    });
    bindButton('btnAiFactsDownloadJson', async handoff => {
      const date = String(handoff.createdAt || new Date().toISOString()).slice(0, 10);
      internal.downloadTextFile(`${internal.safeFilename(handoff.city)}_${date}_fakten_karten_recherche.json`,
        'application/json;charset=utf-8', `${stableJson(handoff.facts)}\n`);
      setStatus('Faktenpaket mit Karten-/Unfallrecherchevertrag heruntergeladen.');
    });
    const note = documentValue.getElementById('aiLinkHandoffNote');
    if (note && note.dataset.uaVisualResearch !== '1') {
      note.dataset.uaVisualResearch = '1';
      note.textContent += ' Zusätzlich muss die KI Hybrid-/Orthofoto-Karten semantisch auf Schienen, Kurven, querende Bewegungen, Radführungswechsel, Haltestellen- und Sichtkonflikte lesen, Fahrradalleinunfälle mit der Infrastruktur in Zusammenhang setzen und eine kurze amtliche Unfallhintergrundrecherche durchführen. Unsichere Oberflächenmerkmale dürfen nicht geraten werden.';
    }
    return true;
  }

  function wrapFactsBuilder() {
    const internal = UA.aiProposal?._internal;
    const original = internal?.buildExternalAiFactsPackage;
    if (typeof original !== 'function') return false;
    if (original._uaVisualResearchWrapped) return true;
    const wrapped = input => enhanceFactsPackage(original.call(internal, input),
      input?.mapUrl || root.location?.href || '');
    wrapped._uaVisualResearchWrapped = true; wrapped._uaOriginal = original;
    internal.buildExternalAiFactsPackage = wrapped; return true;
  }

  function wrapReport() {
    const original = UA.computeExportReport;
    if (typeof original !== 'function') return false;
    if (original._uaVisualResearchWrapped) return true;
    const wrapped = async function wrappedReport(ctx, ...args) {
      const report = await original.call(this, ctx, ...args);
      const structured = report?.structured;
      if (structured && typeof structured === 'object') {
        const views = buildInspectionViews(root.location?.href || structured?.meta?.link || '');
        structured.visualInspectionViews = views;
        structured.visualSceneAnalysisContract = buildVisualSceneAnalysisContract(views);
        structured.accidentBackgroundResearchContract = buildAccidentBackgroundResearchContract({ structured });
        structured.aiAnalysisComparisonContract = augmentComparisonContract(structured.aiAnalysisComparisonContract);
      }
      return report;
    };
    wrapped._uaVisualResearchWrapped = true; wrapped._uaOriginal = original;
    UA.computeExportReport = wrapped; return true;
  }

  let observer = null;
  function observeControls() {
    if (!root.document) return false;
    bindEnhancedControls();
    if (!observer && typeof root.MutationObserver === 'function') {
      observer = new root.MutationObserver(bindEnhancedControls);
      observer.observe(root.document.documentElement, { childList: true, subtree: true });
    }
    return true;
  }
  function install() { return wrapFactsBuilder() && wrapReport() && observeControls(); }

  UA.aiVisualResearch = Object.freeze({ VISUAL_SCENE_SCHEMA, ACCIDENT_BACKGROUND_SCHEMA,
    ENHANCED_HANDOFF_SCHEMA, ENHANCED_PROMPT_MARKERS: MARKERS, install,
    buildInspectionViews, buildVisualSceneAnalysisContract,
    buildAccidentBackgroundResearchContract, augmentComparisonContract,
    enhanceFactsPackage, enhanceHandoff, generateResearchHandoff, auditEnhancedPrompt,
    _internal: Object.freeze({ cleanText: clean, stableJson, safeUrl,
      createInspectionView, extractResearchSeeds, mergeUniqueStrings: unique,
      visualResearchPromptSection: promptSection, bindEnhancedControls,
      wrapFactsBuilder, wrapReport, observeControls }) });

  let attempts = 0;
  const retry = () => {
    if (install()) return;
    if (attempts++ < 240 && typeof root.setTimeout === 'function') root.setTimeout(retry, 25);
  };
  retry();
})();
