/**
 * UA.aiVisualResearch — semantic map reading and accident-background research
 * for the user-owned AI handoff.
 *
 * The deterministic Unfallwerkbank can restore maps and calculate statistics,
 * but it does not interpret pixels. This adapter turns standard, hybrid,
 * orthophoto and analysis views into an explicit multimodal inspection task and
 * requires a short, source-critical search for reported crashes and official
 * context around the same place.
 */
(() => {
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;
  const UA = (root.UA = root.UA || {});

  const VISUAL_SCENE_SCHEMA = 'unfallwerkbank.visualSceneAnalysis.v1';
  const ACCIDENT_BACKGROUND_SCHEMA = 'unfallwerkbank.accidentBackgroundResearch.v1';
  const ENHANCED_HANDOFF_SCHEMA = 'unfallwerkbank.aiResearchHandoff.v3';
  const POLL_INTERVAL_MS = 25;
  const MAX_INSTALL_ATTEMPTS = 240;

  const ENHANCED_PROMPT_MARKERS = Object.freeze([
    'SEMANTISCHE KARTENINTERPRETATION',
    'Schienen/Gleise',
    'Kurven und Verschwenkungen',
    'Kopfsteinpflaster',
    'UNFALLHINTERGRUNDRECHERCHE',
    'amtliche Polizeimeldungen',
    'gleicher Ort',
    'keine Ursache für die gesamte Häufung',
  ]);

  function cleanText(value) {
    return String(value == null ? '' : value).trim();
  }

  function stableJson(value) {
    const base = UA.aiLinkHandoff?._internal?.stableJson;
    if (typeof base === 'function') return base(value);

    function sort(valueToSort) {
      if (!valueToSort || typeof valueToSort !== 'object') return valueToSort;
      if (Array.isArray(valueToSort)) return valueToSort.map(sort);
      const out = {};
      Object.keys(valueToSort).sort().forEach(key => {
        out[key] = sort(valueToSort[key]);
      });
      return out;
    }
    return JSON.stringify(sort(value), null, 2);
  }

  function safeUrl(value) {
    try {
      return new URL(String(value || ''), root.location?.href || undefined);
    } catch (_) {
      return null;
    }
  }

  function createInspectionView(analysisUrl, definition) {
    const url = safeUrl(analysisUrl);
    if (!url) {
      return {
        id: definition.id,
        label: definition.label,
        purpose: definition.purpose,
        mapMode: definition.mapMode,
        url: cleanText(analysisUrl),
      };
    }

    url.searchParams.set('mapMode', definition.mapMode);
    url.searchParams.set('showCluster', definition.showCluster ? '1' : '0');
    url.searchParams.set('showHeatmap', definition.showHeatmap ? '1' : '0');
    url.searchParams.delete('export');
    url.searchParams.delete('tour');

    return {
      id: definition.id,
      label: definition.label,
      purpose: definition.purpose,
      mapMode: definition.mapMode,
      url: url.href,
    };
  }

  function buildInspectionViews(analysisUrl) {
    const definitions = [
      {
        id: 'standard-structure',
        label: 'Standardkarte – Netztopologie und Straßennamen',
        mapMode: 'standard',
        showCluster: false,
        showHeatmap: false,
        purpose: 'Straßennamen, Knoten, Gleisachsen, Wegebeziehungen und die genaue Lage der Unfallpunkte nachvollziehen.',
      },
      {
        id: 'hybrid-conflict-space',
        label: 'Hybridkarte – Luftbild mit lesbarer Beschriftung',
        mapMode: 'hybrid',
        showCluster: false,
        showHeatmap: false,
        purpose: 'Bauliche Geometrie, Fahr- und Gehflächen, Haltestellen, Schienen, Kurven und querende Bewegungen gemeinsam lesen.',
      },
      {
        id: 'orthophoto-layout',
        label: 'Orthofoto – reale Oberflächen- und Flächengeometrie',
        mapMode: 'orthophoto',
        showCluster: false,
        showHeatmap: false,
        purpose: 'Sichtbare Fahrspuren, Inseln, Bahnsteig-/Bussteigkanten, Radführungen, Abbiegeradien und mögliche Sichtbarrieren prüfen.',
      },
      {
        id: 'analysis-density',
        label: 'Analyseansicht – Unfallpunkte, Cluster und Dichte',
        mapMode: 'analysis',
        showCluster: true,
        showHeatmap: true,
        purpose: 'Visuelle Infrastrukturmerkmale räumlich mit Unfallpunkten, Teilclustern und Korridoren verknüpfen.',
      },
    ];

    return definitions.map(definition => createInspectionView(analysisUrl, definition));
  }

  function buildVisualSceneAnalysisContract(inspectionViews) {
    return {
      schemaVersion: VISUAL_SCENE_SCHEMA,
      status: 'required-not-yet-executed',
      purpose: 'Die Karte nicht nur auf Vollständigkeit prüfen, sondern als multimodale Verkehrsszene lesen und sichtbare Besonderheiten räumlich mit den dokumentierten Unfällen abgleichen.',
      inspectionViews: Array.isArray(inspectionViews) ? inspectionViews : [],
      requiredProcedure: [
        'Öffne Standard-, Hybrid-, Orthofoto- und Analyseansicht mit identischen Filtern und Auswahlgrenzen.',
        'Prüfe jede potenziell relevante Stelle mindestens in einer Übersicht und einer näheren Zoomstufe.',
        'Unterscheide sichtbare Beobachtung, plausible Hypothese und durch externe Quelle bestätigten Kontext.',
        'Verknüpfe eine Beobachtung nur dann mit dem Unfallgeschehen, wenn ihre Lage zu konkreten Unfallpunkten, Teilclustern oder Bewegungsbeziehungen nachvollziehbar beschrieben wird.',
        'Nutze strukturierte Straßen-/OSM-Daten zur Gegenprüfung, schätze daraus aber keine unsichtbaren Details des Bildes.',
      ],
      requiredFeatureClasses: [
        {
          id: 'rails-and-track-interface',
          label: 'Schienen/Gleise und Querungswinkel',
          questions: [
            'Verlaufen Schienen in einer von Radfahrenden befahrbaren Fläche oder kreuzt eine plausible Radfahrlinie die Schiene?',
            'Ist der Querungswinkel flach, gibt es Verschwenkungen unmittelbar vor der Schiene oder räumlichen Zwang zu einem ungünstigen Winkel?',
            'Handelt es sich nur um eine räumliche Bahntrasse/Barriere oder tatsächlich um eine im Straßenraum befahrbare Rillenschiene?',
          ],
        },
        {
          id: 'curvature-and-deflection',
          label: 'Kurven und Verschwenkungen',
          questions: [
            'Gibt es enge Kurven, S-Kurven, abrupte Verschwenkungen oder kleine Abbiegeradien?',
            'Fallen Kurve, Querung, Gefälle, Schiene, Haltestelle oder Sichtabschattung räumlich zusammen?',
          ],
        },
        {
          id: 'junction-turning-merging',
          label: 'Knoten, Abbiegen, Einfädeln und Fahrstreifenwechsel',
          questions: [
            'Kreuzen sich Geradeaus- und Abbiegebeziehungen oder werden Radfahrende in den Kfz-Verkehr geführt?',
            'Gibt es Zu-/Ausfahrten, Taxi-, Liefer-, Park- oder Busbewegungen mit Konfliktpotenzial?',
          ],
        },
        {
          id: 'walking-cycling-motor-crossings',
          label: 'Kreuzungen von Kfz-, Fuß- und Radverkehr',
          questions: [
            'Überlagern sich erkennbare Wunschlinien von Fußverkehr, Radverkehr und Kfz/ÖPNV?',
            'Führen Radwege durch Warte-, Ein-/Ausstiegs- oder Querungsbereiche?',
            'Sind Querungen kanalisiert, signalisiert, versetzt oder aus der jeweiligen Annäherung schlecht erkennbar?',
          ],
        },
        {
          id: 'transit-platform-and-stop-edge',
          label: 'Haltestellen, Bussteige, Bahnsteig- und Fahrbahnkanten',
          questions: [
            'Müssen Fahrgäste Bus- oder Radfahrspuren queren?',
            'Liegen Warteflächen unmittelbar an Fahrgassen oder in engen Mischflächen?',
          ],
        },
        {
          id: 'cycle-facility-continuity',
          label: 'Kontinuität und Verständlichkeit der Radverkehrsführung',
          questions: [
            'Beginnt, endet oder wechselt die Radführung im Untersuchungsbereich?',
            'Entstehen Mischflächen, Gegenrichtungsführungen, unvermittelte Seitenwechsel oder unklare Übergänge?',
          ],
        },
        {
          id: 'visibility-and-constrained-space',
          label: 'Sicht, Engstellen und verdeckte Annäherungen',
          questions: [
            'Verdecken Gebäude, Bäume, Haltestelleneinbauten, parkende Fahrzeuge oder Kurven die Sicht?',
            'Verengt sich der nutzbare Raum an Unfallpunkten oder wichtigen Querungen?',
          ],
        },
        {
          id: 'surface-and-drainage',
          label: 'Oberfläche, Kanten und Entwässerung',
          questions: [
            'Sind Fugen, Schienen, Rinnen, Kanten, Aufpflasterungen oder Materialwechsel eindeutig sichtbar?',
            'Kopfsteinpflaster oder eine konkrete Oberflächenqualität nur benennen, wenn Auflösung, aktuelle Aufnahme und mindestens eine zweite Quelle dies tragen; sonst ausdrücklich „nicht sicher beurteilbar“ ausgeben.',
          ],
        },
      ],
      observationSchema: {
        requiredFields: [
          'featureClass',
          'locationDescription',
          'viewIdAndZoom',
          'visibleEvidence',
          'spatialRelationToAccidents',
          'confidence',
          'evidenceLevel',
          'alternativeExplanation',
          'requiredVerification',
        ],
        confidenceValues: ['high', 'medium', 'low', 'not-assessable'],
        evidenceLevelValues: [
          'C1-visible-in-multiple-map-views',
          'C2-visible-in-one-map-view',
          'C3-corroborated-by-structured-or-external-source',
          'D-hypothesis-needs-field-check',
        ],
      },
      interpretationRules: [
        'Ein Bildbefund ist keine Unfallursache. Formuliere zunächst nur, was sichtbar ist und welche Konflikthypothese daraus entsteht.',
        'Eine Hauptbahntrasse neben einer Straße ist nicht automatisch eine Schienensturzgefahr; relevant wird sie erst bei einer tatsächlich befahrbaren oder zu querenden Schiene.',
        'Verkehrsteilnehmer oder Fahrzeuge auf einem einzelnen Luftbild sind keine belastbare Verkehrsmenge.',
        'Orthofotos können veraltet sein. Prüfe Befliegungsstand und gleiche sichtbare Infrastruktur mit aktuellen Planungen oder amtlichen Meldungen ab.',
        'Bei schlechter Auflösung oder verdeckter Stelle ist „nicht beurteilbar“ die richtige Antwort; nicht raten.',
      ],
      minimumOutput: {
        openedMapModes: 3,
        zoomLevelsPerMaterialFeature: 2,
        locatedFeatureObservations: 3,
        observationsLinkedToAccidentPointsOrClusters: 2,
        explicitNotAssessableFindings: true,
        prioritisedVisualChecks: 3,
      },
      automaticFailure: [
        'Nur Lesbarkeit/Vollständigkeit der Karte geprüft, ohne die Szene semantisch zu interpretieren.',
        'Schienen, Oberfläche oder Verkehrsführung behauptet, obwohl sie in keiner geöffneten Ansicht erkennbar waren.',
        'Kopfsteinpflaster oder anderes Material aus einem unscharfen Bild abgeleitet.',
        'Eine sichtbare Besonderheit ohne räumlichen Bezug zu Unfallpunkten als Erklärung der Häufung ausgegeben.',
        'Bildbeobachtung als gesicherte Unfallursache formuliert.',
      ],
    };
  }

  function extractResearchSeeds(facts) {
    const structured = facts?.structured || {};
    const digest = facts?.deterministicAnalysisDigest || structured?.deterministicAnalysisDigest || {};
    const meta = digest?.meta || structured?.meta || {};
    const city = cleanText(meta.city || structured?.meta?.city || facts?.city);
    const area = cleanText(meta.areaName || structured?.meta?.areaName);
    const involvement = cleanText(
      meta?.filters?.involvement
      || meta?.involvementMode
      || structured?.meta?.filters?.involvement
    );

    return {
      city: city || null,
      area: area || null,
      involvement: involvement || null,
      featureTerms: [
        'Unfall', 'Verkehrsunfall', 'Radfahrer', 'Fußgänger', 'Pkw', 'Bus',
        'Straßenbahn', 'Schiene', 'Kurve', 'Kreuzung', 'Querung', 'Radweg',
      ],
    };
  }

  function buildAccidentBackgroundResearchContract(facts) {
    const seeds = extractResearchSeeds(facts);
    return {
      schemaVersion: ACCIDENT_BACKGROUND_SCHEMA,
      status: 'required-not-yet-executed',
      purpose: 'Kurze externe Recherche nach konkreten Unfällen, Beinahe-/Konfliktmeldungen, Kontrollen, Planungen und Sicherheitsdiskussionen, die sichtbare Kartenmerkmale erklären oder Gegenhypothesen liefern können.',
      searchSeeds: seeds,
      sourcePriority: [
        {
          rank: 1,
          sourceType: 'official-police-or-fire-service',
          instruction: 'Amtliche Polizeimeldungen und Feuerwehr-/Rettungsdienstmeldungen zuerst verwenden; Datum, Ort und Ermittlungsstand exakt wiedergeben.',
        },
        {
          rank: 2,
          sourceType: 'official-city-council-project-or-operator',
          instruction: 'Stadt, Ratsinformationssystem, Unfallkommission, Verkehrsunternehmen und offizielle Projektseiten nach Umbau, Bauphasen, Sicherheitsprüfungen und bekannten Konflikten durchsuchen.',
        },
        {
          rank: 3,
          sourceType: 'reputable-local-journalism-or-association',
          instruction: 'Lokale Medien und Fachverbände nur ergänzend nutzen und Primärquellen bevorzugen beziehungsweise kenntlich machen.',
        },
      ],
      queryPlan: [
        'Kombiniere exakten Bereichs-/Straßennamen und Kommune mit Unfall, Radfahrer, Fußgänger, Pkw, Bus oder Straßenbahn.',
        'Suche zusätzlich nach den visuell erkannten Merkmalen, zum Beispiel Schiene, Kurve, Abbiegen, Bussteig, Radweg, Querung oder Baustelle.',
        'Suche getrennt nach amtlichen Unfallmeldungen, politischen Vorgängen/Verwaltungsantworten und laufenden Planungen.',
        'Dokumentiere auch eine erfolglose Suche mit Suchbegriffen, Zeitraum und Quellen; „kein Treffer“ ist kein Beweis für „kein Ereignis“.',
      ],
      spatialMatchClasses: [
        {
          id: 'inside-selection',
          label: 'gleicher Ort / innerhalb der Auswahl',
          use: 'stärkster Kontextbezug; dennoch nicht automatisch Erklärung aller aggregierten Unfälle',
        },
        {
          id: 'immediate-adjacency',
          label: 'unmittelbar angrenzender Knoten oder Korridor',
          use: 'kann eine fortgesetzte Bewegungsbeziehung oder verlagerten Konflikt zeigen',
        },
        {
          id: 'citywide-analogue',
          label: 'vergleichbarer Mechanismus an anderem Ort der Stadt',
          use: 'nur als Mechanismus-/Prüfhinweis, nicht als lokaler Tatsachenbeleg',
        },
        {
          id: 'unknown-or-unrelated',
          label: 'räumlich unklar oder nicht passend',
          use: 'nicht zur Begründung des örtlichen Antrags verwenden',
        },
      ],
      resultSchema: {
        requiredFields: [
          'eventDate',
          'publicationDate',
          'exactLocation',
          'spatialMatchClass',
          'participants',
          'injurySeverity',
          'reportedMechanism',
          'investigationStatus',
          'sourceTitle',
          'sourceUrl',
          'sourceType',
          'relationToVisualObservation',
          'relationToDeterministicAccidents',
          'limitations',
        ],
      },
      interpretationRules: [
        'Ein einzelner Pressebericht kann eine sichtbare Konfliktart plausibilisieren, ist aber keine Ursache für die gesamte Häufung.',
        'Unterscheide ausdrücklich zwischen gleichem Ort, angrenzendem Korridor und nur stadtweitem Analogiefall.',
        'Übernimm polizeiliche Formulierungen wie „nach bisherigem Stand“ oder „könnte“ und mache laufende Ermittlungen kenntlich.',
        'Nicht jeder gefundene Unfall gehört zum gefilterten Unfallkollektiv; Beteiligung, Jahr, Schwere und räumliche Lage sind separat abzugleichen.',
        'Keine personenbezogenen Details übernehmen, die für die Verkehrssicherheitsanalyse nicht erforderlich sind.',
      ],
      minimumOutput: {
        documentedQueries: 4,
        officialSourceSearches: 2,
        incidentTable: true,
        noHitLog: true,
        visualFeatureCrossCheck: true,
        explicitAggregateCausalityCaveat: true,
      },
      automaticFailure: [
        'Nur allgemeine Websuche ohne genaue Orts- oder Merkmalsbegriffe.',
        'Sekundärmeldung verwendet, obwohl eine amtliche Primärmeldung auffindbar ist.',
        'Ereignis aus einem anderen Stadtteil als Beleg für den konkreten Ort ausgegeben.',
        'Presseereignis ungeprüft dem gefilterten Unfallkollektiv zugerechnet.',
        'Einzelereignis als Erklärung der gesamten Unfallhäufung dargestellt.',
      ],
    };
  }

  function mergeUniqueStrings(first, second) {
    return [...new Set([...(first || []), ...(second || [])].map(cleanText).filter(Boolean))];
  }

  function augmentComparisonContract(contract) {
    const current = contract && typeof contract === 'object' ? contract : {};
    const required = Array.isArray(current.requiredAiAddedValue)
      ? [...current.requiredAiAddedValue]
      : [];
    const byId = new Set(required.map(item => cleanText(item?.id)));

    const additions = [
      {
        id: 'semantic-visual-scene-analysis',
        requirement: 'Read standard, hybrid and orthophoto maps semantically; locate rails, curves, multimodal crossings, facility discontinuities and visibility constraints, with confidence and map-view evidence.',
      },
      {
        id: 'accident-background-research',
        requirement: 'Perform a short source-critical search for official crash reports and planning context; distinguish exact location, adjacent corridor and citywide analogues.',
      },
    ];
    for (const addition of additions) {
      if (!byId.has(addition.id)) required.push(addition);
    }

    return {
      ...current,
      requiredAiAddedValue: required,
      prohibitedShortcuts: mergeUniqueStrings(current.prohibitedShortcuts, [
        'Treating map readability or layer availability as semantic visual analysis.',
        'Inferring cobblestone or another surface material from low-resolution imagery.',
        'Using one press-reported crash as the cause of the complete aggregate pattern.',
        'Mixing exact-area incidents with adjacent or citywide analogues without spatial classification.',
      ]),
      minimumOutput: {
        ...(current.minimumOutput || {}),
        semanticVisualSceneAnalysis: true,
        accidentBackgroundResearchLog: true,
        locatedVisualObservations: 3,
        visualToIncidentCrossChecks: 2,
      },
    };
  }

  function enhanceFactsPackage(facts, analysisUrl) {
    if (!facts || typeof facts !== 'object') return facts;
    const views = buildInspectionViews(analysisUrl || facts?.mapUrl || facts?.analysisUrl || '');
    const visualSceneAnalysisContract = buildVisualSceneAnalysisContract(views);
    const accidentBackgroundResearchContract = buildAccidentBackgroundResearchContract(facts);
    const comparison = augmentComparisonContract(
      facts.aiAnalysisComparisonContract
      || facts?.structured?.aiAnalysisComparisonContract
    );

    return {
      ...facts,
      visualInspectionViews: views,
      visualSceneAnalysisContract,
      accidentBackgroundResearchContract,
      aiAnalysisComparisonContract: comparison,
      visualAndResearchReadiness: {
        visualSceneStatus: 'pending-model-inspection',
        accidentBackgroundStatus: 'pending-web-research',
        filingReady: false,
        rule: 'Ein einreichungsreifer Antrag setzt dokumentierte Karteninterpretation und Unfallhintergrundrecherche oder eine ausdrücklich begründete Nichtdurchführbarkeit voraus.',
      },
    };
  }

  function visualResearchPromptSection(views, visualContract, backgroundContract) {
    return [
      '',
      '## SEMANTISCHE KARTENINTERPRETATION – NICHT NUR SICHTBARKEITS-QA',
      'Die bisherige visuelle QA („Karte vorhanden, lesbar, nicht abgeschnitten“) reicht nicht. Lies die hybride Verkehrsszene inhaltlich und räumlich.',
      'Öffne mindestens Standardkarte, Hybridkarte und Orthofoto mit identischer Auswahl und identischen Unfallfiltern. Prüfe relevante Stellen jeweils in Übersicht und näherer Zoomstufe.',
      '',
      'Pflichtfragen:',
      '- **Schienen/Gleise:** Liegen befahrbare Rillenschienen oder Schienenquerungen in einer plausiblen Radfahrlinie? Wie ist der Querungswinkel? Verwechsle eine benachbarte Hauptbahntrasse nicht mit einer befahrbaren Straßenbahnschiene.',
      '- **Kurven und Verschwenkungen:** Gibt es enge Radien, S-Kurven, abrupte Seitenwechsel oder verdeckte Annäherungen – insbesondere zusammen mit Schienen, Querungen, Gefälle oder Haltestellen?',
      '- **Kreuzende Bewegungen:** Wo kreuzen oder überlagern sich Kfz-, Bus-/Taxi-/Liefer-, Fuß- und Radverkehr? Prüfe Wunschlinien, Ein-/Ausstiegsbereiche, Zu-/Ausfahrten, Abbiegebeziehungen und Radwegenden.',
      '- **Sicht und Engstellen:** Welche Gebäude, Einbauten, Vegetation, parkenden Fahrzeuge oder Kurven können Sichtbeziehungen begrenzen?',
      '- **Oberfläche:** Kopfsteinpflaster, Belagszustand, Rinnen oder kleine Kanten nur dann benennen, wenn sie in ausreichend hoher Auflösung und durch eine zweite Quelle erkennbar sind. Sonst „nicht sicher beurteilbar“ ausgeben.',
      '',
      'Für jede Beobachtung: genaue Lage, verwendete Ansicht und Zoom, sichtbare Evidenz, räumlicher Bezug zu Unfallpunkten/Teilclustern, Konfidenz, alternative Erklärung und erforderliche Vor-Ort- oder Datenprüfung. Formuliere Bildmerkmale nie unmittelbar als Unfallursache.',
      '',
      'Vorgegebene Prüfansichten:',
      ...views.map(view => `- **${view.label}** (${view.id}): ${view.url}\n  Zweck: ${view.purpose}`),
      '',
      '## UNFALLHINTERGRUNDRECHERCHE – KURZ, ORTSGENAU UND QUELLENKRITISCH',
      'Suche ergänzend nach konkreten Unfallmeldungen, Verkehrskontrollen, Sicherheitsdiskussionen und laufenden Planungen im selben Bereich. Beginne mit amtlichen Polizeimeldungen und anderen Primärquellen.',
      'Kombiniere exakte Orts-/Straßennamen mit Unfall, Radfahrer, Fußgänger, Pkw, Bus, Straßenbahn sowie den visuell erkannten Merkmalen wie Schiene, Kurve, Querung, Bussteig oder Radweg.',
      'Ordne jeden Treffer ein als **gleicher Ort / innerhalb der Auswahl**, **unmittelbar angrenzender Korridor**, **nur stadtweiter Analogiefall** oder **unpassend/unklar**.',
      'Prüfe Beteiligung, Zeitraum, Schwere und Mechanismus separat gegen das deterministische Unfallkollektiv. Ein einzelner Bericht kann eine Konfliktart plausibilisieren, ist aber keine Ursache für die gesamte Häufung.',
      'Dokumentiere Suchbegriffe, Quellen, Treffer und Nulltreffer. „Keine Treffer“ bedeutet nicht „keine Vorbefassung oder keine weiteren Unfälle“.',
      '',
      '## Zusätzliche Pflichtausgabe',
      '9. Tabelle der semantischen Kartenbeobachtungen mit Konfidenz und räumlichem Unfallbezug',
      '10. Tabelle der recherchierten Unfall-/Kontextmeldungen mit räumlicher Passklasse und Quellenstatus',
      '11. Kreuzvalidierung: Welche Bildhypothese wird durch strukturierte Daten oder einen externen Bericht gestützt, widerlegt oder bleibt offen?',
      '12. Explizite Liste „nicht sicher aus der Karte beurteilbar“ – insbesondere Oberfläche, aktuelle Markierungen oder verdeckte Bereiche',
      '',
      '## Verträge für die maschinenlesbare Prüfung',
      '```json',
      stableJson({
        visualSceneAnalysisContract: visualContract,
        accidentBackgroundResearchContract: backgroundContract,
      }),
      '```',
    ].join('\n');
  }

  function auditEnhancedPrompt(prompt) {
    const text = cleanText(prompt);
    const missingMarkers = ENHANCED_PROMPT_MARKERS.filter(marker => !text.includes(marker));
    return {
      schemaVersion: 'unfallwerkbank.aiVisualResearchPromptAudit.v1',
      passed: missingMarkers.length === 0,
      requiredMarkers: [...ENHANCED_PROMPT_MARKERS],
      missingMarkers,
    };
  }

  function enhanceHandoff(baseHandoff) {
    if (!baseHandoff || typeof baseHandoff !== 'object') return baseHandoff;
    const views = buildInspectionViews(baseHandoff.analysisUrl || baseHandoff?.facts?.mapUrl || '');
    const facts = enhanceFactsPackage(baseHandoff.facts || {}, baseHandoff.analysisUrl);
    const visualContract = facts.visualSceneAnalysisContract || buildVisualSceneAnalysisContract(views);
    const backgroundContract = facts.accidentBackgroundResearchContract
      || buildAccidentBackgroundResearchContract(facts);
    const prompt = `${cleanText(baseHandoff.prompt)}${visualResearchPromptSection(
      views,
      visualContract,
      backgroundContract
    )}`;
    const visualAudit = auditEnhancedPrompt(prompt);
    const baseAudit = baseHandoff.promptAudit || { passed: true, missingMarkers: [] };

    return {
      ...baseHandoff,
      schemaVersion: ENHANCED_HANDOFF_SCHEMA,
      facts,
      visualInspectionViews: views,
      visualSceneAnalysisContract: visualContract,
      accidentBackgroundResearchContract: backgroundContract,
      visualResearchPromptAudit: visualAudit,
      promptAudit: {
        ...baseAudit,
        passed: baseAudit.passed !== false && visualAudit.passed,
        missingMarkers: mergeUniqueStrings(baseAudit.missingMarkers, visualAudit.missingMarkers),
        visualResearchAudit: visualAudit,
      },
      prompt,
    };
  }

  async function generateResearchHandoff(UAValue, ctx) {
    const baseApi = UAValue?.aiLinkHandoff;
    if (!baseApi || typeof baseApi.generateResearchHandoff !== 'function') {
      throw new Error('missing_link_handoff: Basis-KI-Übergabe ist nicht geladen');
    }
    const base = await baseApi.generateResearchHandoff(UAValue, ctx || {});
    const enhanced = enhanceHandoff(base);
    if (!enhanced?.promptAudit?.passed) {
      throw new Error('visual_research_contract_incomplete: Erweiterter KI-Auftrag erfüllt den Karten-/Recherchevertrag nicht');
    }
    return enhanced;
  }

  function runtimeContext(fallback) {
    return fallback
      || (typeof UA.getRuntimeContext === 'function' ? UA.getRuntimeContext() : null)
      || {};
  }

  function setStatus(message) {
    const status = root.document?.getElementById('aiPromptStatus');
    if (status) status.textContent = message || '';
  }

  function bindButton(id, handler) {
    const documentValue = root.document;
    let button = documentValue?.getElementById(id);
    if (!button) return false;
    if (button.dataset.uaVisualResearch === '1') return true;

    const clone = button.cloneNode(true);
    clone.dataset.uaVisualResearch = '1';
    button.replaceWith(clone);
    button = clone;

    button.addEventListener('click', async () => {
      button.disabled = true;
      const original = button.innerHTML;
      button.innerHTML = '<span aria-hidden="true">⏳</span> Karten- und Unfallrechercheauftrag wird erzeugt …';
      try {
        const handoff = await generateResearchHandoff(UA, runtimeContext());
        await handler(handoff);
      } catch (error) {
        setStatus(`Erweiterte KI-Übergabe fehlgeschlagen: ${error?.message || error}`);
      } finally {
        button.disabled = false;
        button.innerHTML = original;
      }
    });
    return true;
  }

  function bindEnhancedControls() {
    const documentValue = root.document;
    if (!documentValue?.getElementById('btnAiResearchLinkCopy')) return false;
    const internal = UA.aiLinkHandoff?._internal;
    if (!internal) return false;

    bindButton('btnAiResearchLinkCopy', async handoff => {
      await internal.writeClipboard(handoff.prompt);
      setStatus(`KI-Auftrag mit ${handoff.visualInspectionViews.length} Kartenansichten, semantischer Szenenanalyse und Unfallhintergrundrecherche kopiert.`);
    });

    bindButton('btnAiPromptDownloadMd', async handoff => {
      const date = String(handoff.createdAt || new Date().toISOString()).slice(0, 10);
      internal.downloadTextFile(
        `${internal.safeFilename(handoff.city)}_${date}_karten_unfallrecherche_auftrag.md`,
        'text/markdown;charset=utf-8',
        handoff.prompt
      );
      setStatus('Erweiterter Karten- und Unfallrechercheauftrag als Markdown heruntergeladen.');
    });

    bindButton('btnAiFactsDownloadJson', async handoff => {
      const date = String(handoff.createdAt || new Date().toISOString()).slice(0, 10);
      internal.downloadTextFile(
        `${internal.safeFilename(handoff.city)}_${date}_fakten_karten_recherche.json`,
        'application/json;charset=utf-8',
        `${stableJson(handoff.facts)}\n`
      );
      setStatus('Faktenpaket mit Karten- und Unfallrecherchevertrag heruntergeladen.');
    });

    const note = documentValue.getElementById('aiLinkHandoffNote');
    if (note && note.dataset.uaVisualResearch !== '1') {
      note.dataset.uaVisualResearch = '1';
      note.textContent += ' Zusätzlich muss die KI Hybrid-/Orthofoto-Karten semantisch auf Schienen, Kurven, querende Bewegungen, Radführungswechsel, Haltestellen- und Sichtkonflikte lesen und eine kurze amtliche Unfallhintergrundrecherche durchführen. Unsichere Oberflächenmerkmale dürfen nicht geraten werden.';
    }
    return true;
  }

  function wrapFactsBuilder() {
    const internal = UA.aiProposal?._internal;
    if (!internal || typeof internal.buildExternalAiFactsPackage !== 'function') return false;
    if (internal.buildExternalAiFactsPackage._uaVisualResearchWrapped) return true;

    const original = internal.buildExternalAiFactsPackage;
    const wrapped = function factsWithVisualResearch(input) {
      const facts = original.call(internal, input);
      return enhanceFactsPackage(facts, input?.mapUrl || facts?.mapUrl || root.location?.href || '');
    };
    wrapped._uaVisualResearchWrapped = true;
    wrapped._uaOriginal = original;
    internal.buildExternalAiFactsPackage = wrapped;
    return true;
  }

  function wrapReport() {
    if (typeof UA.computeExportReport !== 'function') return false;
    if (UA.computeExportReport._uaVisualResearchWrapped) return true;

    const original = UA.computeExportReport;
    const wrapped = async function reportWithVisualResearch(ctx, ...args) {
      const report = await original.call(this, ctx, ...args);
      const structured = report?.structured;
      if (structured && typeof structured === 'object') {
        const analysisUrl = root.location?.href || structured?.meta?.link || '';
        const views = buildInspectionViews(analysisUrl);
        structured.visualInspectionViews = views;
        structured.visualSceneAnalysisContract = buildVisualSceneAnalysisContract(views);
        structured.accidentBackgroundResearchContract = buildAccidentBackgroundResearchContract({
          city: structured?.meta?.city,
          structured,
        });
        if (structured.aiAnalysisComparisonContract) {
          structured.aiAnalysisComparisonContract = augmentComparisonContract(
            structured.aiAnalysisComparisonContract
          );
        }
      }
      return report;
    };
    wrapped._uaVisualResearchWrapped = true;
    wrapped._uaOriginal = original;
    UA.computeExportReport = wrapped;
    return true;
  }

  function install() {
    const factsReady = wrapFactsBuilder();
    const reportReady = wrapReport();
    const controlsReady = bindEnhancedControls();
    return factsReady && reportReady && controlsReady;
  }

  UA.aiVisualResearch = Object.freeze({
    VISUAL_SCENE_SCHEMA,
    ACCIDENT_BACKGROUND_SCHEMA,
    ENHANCED_HANDOFF_SCHEMA,
    ENHANCED_PROMPT_MARKERS,
    install,
    buildInspectionViews,
    buildVisualSceneAnalysisContract,
    buildAccidentBackgroundResearchContract,
    augmentComparisonContract,
    enhanceFactsPackage,
    enhanceHandoff,
    generateResearchHandoff,
    auditEnhancedPrompt,
    _internal: Object.freeze({
      cleanText,
      stableJson,
      safeUrl,
      createInspectionView,
      extractResearchSeeds,
      mergeUniqueStrings,
      visualResearchPromptSection,
      bindEnhancedControls,
      wrapFactsBuilder,
      wrapReport,
    }),
  });

  let attempts = 0;
  const installWhenReady = () => {
    if (install()) return;
    if (attempts++ < MAX_INSTALL_ATTEMPTS && typeof root.setTimeout === 'function') {
      root.setTimeout(installWhenReady, POLL_INTERVAL_MS);
    }
  };
  installWhenReady();
})();
