# End-to-End-QA: Unfallwerkbank → KI-Auftrag → kommunaler Antrag

**Datum:** 15. August 2026  
**PR:** #620  
**Prüffall:** Adenauerallee, Bonn-Südstadt  
**Status:** Einreichungsreifer Antrag **blockiert**, bis die unten genannten P0-/P1-Mängel behoben beziehungsweise nachvollziehbar aufgelöst sind.

## 1. Was tatsächlich geprüft wurde

Diese QA bewertet nicht nur, ob ein Prompt bestimmte Schlüsselwörter enthält. Geprüft wurden die reale Ausgabekette und ihre fachliche Wirkung:

1. der von der CI erzeugte PDF-/Word-Antrag aus `extended-maven-qa-evidence`,
2. die zugehörigen Karten- und Export-Screenshots,
3. die im Dokument ausgewiesenen Unfallzahlen, Filter, räumlichen Grenzen und Zeitreihen,
4. die argumentative Kette von den Unfalltatsachen zu den Maßnahmen,
5. die politische Vorbefassung des untersuchten Bereichs,
6. der aktuelle KI-Arbeitsauftrag, indem er mit einem Modell auf den realen Prüffall angewandt und das Ergebnis gegen die Ausgangsdaten geprüft wurde.

Die bisherigen Unit-Tests des KI-Handovers verwendeten dagegen einen synthetischen, in sich passenden Bonn-Hauptbahnhof-Snapshot und prüften vor allem Marker, URLs und Summengleichheit. Sie waren sinnvoll als Regressionstest, aber **kein Nachweis**, dass ein Modell aus einer realen, möglicherweise widersprüchlichen Unfallwerkbank-Ausgabe einen guten Antrag erzeugt.

## 2. Gebundener Ausgangsfall

Der CI-Export weist für den markierten Abschnitt der Adenauerallee folgende Daten aus:

- Zeitraum: **2019–2025**
- Filter: **Radverkehr UND Pkw**, alle Schweregrade, alle Wochentage, 0–23 Uhr
- räumliche Grenzen: **50,73000–50,73550° N; 7,09100–7,10100° E**
- **37** polizeilich erfasste Unfälle mit Personenschaden
- **0 Getötete, 1 Schwerverletzte, 36 Leichtverletzte**
- Jahreswerte: **6, 8, 5, 2, 2, 9, 5**
- Trendklassifikation: **stagnierend**, Steigung −0,14/Jahr, R² 0,01
- Hauptcluster: **5** Unfälle
- räumliche Spannweite der dargestellten Achse: rund **523 m**
- sensible Einrichtungen innerhalb 200 m: **7 Kindergärten und 3 Schulen**, aber keine innerhalb des Auswahlrechtecks

Die Unfallzahlen sind zwischen Schweregradtabelle, Jahrgangstabelle, Kreuztabelle und Unfall-Detailtabelle konsistent. Die amtlichen Unfallereignisse bilden daher einen belastbaren Tatsachenkern. Die schwerwiegenden Mängel liegen in der Einordnung und Antragserzeugung, nicht in einer pauschalen Entwertung der Primärdaten.

## 3. Ergebnis der tatsächlichen KI-Probe

Der aktuelle Evidenz-/QA-Auftrag wurde als Modellauftrag auf den realen CI-Export angewandt. Das fachlich vertretbare Resultat lautet:

> **QA-Urteil: blockiert für einen einreichungsreifen Antrag.**  
> Die amtlichen 37 Unfälle sind bestimmt wiederzugeben und begründen eine konkrete verkehrssicherheitsfachliche Prüfung. Der vorliegende Antrag darf jedoch nicht als fertiger Antrag übernommen werden, weil seine zentrale Unfallschwerpunkt-Behauptung dem eigenen Analyseergebnis widerspricht, die politische Vorbefassung fehlt und die vorgeschlagenen Maßnahmen nicht ausreichend aus ortsspezifischen Unfallkonstellationen hergeleitet sind.

Das Modell hat damit nicht bloß „schönere Sätze“ erzeugt, sondern die wesentlichen Produktmängel erkannt. Zugleich zeigt der Test: Ein guter Prompt kann einen widersprüchlichen Ausgangsbericht nicht reparieren, wenn die Anwendung den widersprüchlichen Antrag bereits als scheinbar fertiges Verwaltungsdokument präsentiert oder wichtige Rechercheergebnisse gar nicht übergibt.

## 4. Befunde

| Priorität | Befund | Bewertung | Erforderliche Korrektur |
|---|---|---|---|
| P0 | Titel und Beschluss sprechen von einem „auffälligen Unfallschwerpunkt“ und einer „auffälligen Abweichung“, während die Kurzbewertung ausdrücklich **„kein eindeutiger Unfallschwerpunkt“** feststellt. | Innerer Widerspruch; die stärkste Antragsbehauptung ist durch die eigene Analyse nicht gedeckt. | Antragstitel und Standardbegründung neutral/evidenzbasiert formulieren. Nur bei nachgewiesener Signifikanz und geeigneter räumlicher Referenz einen Unfallschwerpunkt behaupten. |
| P0 | Der Export enthält keine politische Vorbefassung, obwohl zur Adenauerallee bereits Verkehrsversuche, Anträge, Beschlüsse, Evaluationsforderungen und laufende Umgestaltungsentscheidungen existieren. | Ein neuer generischer Antrag kann bestehende Beschlüsse wiederholen, ihnen widersprechen oder einen bereits laufenden Prozess ignorieren. | Politische Recherche verpflichtend in die KI-Evidenzkette aufnehmen; Suchstatus, Suchbegriffe, Treffer und direkte Quellenlinks ausweisen. |
| P1 | Der Vergleich nennt 37 lokale und 1.963 stadtweite Fälle, ohne Exposition, Straßenlänge, Verkehrsleistung oder vergleichbare Referenzflächen als Nenner. | Absolute Fallzahlen unterschiedlicher Räume belegen keine lokale Überrepräsentation. | Vergleich nur mit geeigneter Rate/Referenz und Unsicherheitsmaß als tragende Abweichungsbehauptung verwenden. |
| P1 | Ein Korridor über rund 523 m und ein Cluster mit 5 von 37 Fällen werden zugleich als „Schwerpunkt“ und als räumlich verteiltes Muster beschrieben. | Unklar, ob ein einzelner Knoten, mehrere Teilbereiche oder ein streckenbezogenes Problem vorliegt. | Unfallkonstellationen und Teilcluster getrennt ausweisen; keine einheitliche Ursache voraussetzen. |
| P1 | Markierung, Beschilderung, Signalisierung, Tempoanpassung, Querungen und Umbau werden pauschal verlangt. | Maßnahmen sind nicht sichtbar an konkrete Konflikttypen, Fahrbeziehungen oder aktuelle Gestaltung gebunden. | Befund → Sicherheitsziel → Option → Fach-/Ortsprüfung → Erfolgskriterium für jede Maßnahme dokumentieren. |
| P1 | Die CI-Karte ist eine synthetische QA-Basiskarte und ausdrücklich keine reale Luftbild-/Straßengeometrie. | Sichtbeziehungen, Spurführung, Abbiegekonflikte, Lieferzonen und bauliche Details können daraus nicht bewertet werden. | Reale Kartografie beziehungsweise aktuelle Vor-Ort-/Luftbildprüfung vor konkreten baulichen Aussagen verlangen. |
| P1 | Evaluation ausschließlich nach 12 Monaten anhand der Unfallentwicklung. | Bei kleinen Jahreszahlen ist eine reine Vorher-Nachher-Unfallzahl statistisch schwach und kann zufällig schwanken. | Ergänzende Konflikt-, Geschwindigkeits-, Verkehrs- und Nutzungsindikatoren sowie geeigneten Beobachtungszeitraum definieren. |
| P2 | Die pauschale Dunkelziffer-Aussage „Faktor 2–10“ wird ohne unmittelbar nachvollziehbare, modusspezifische Belegstelle verwendet. | Kann den amtlichen Tatsachenkern unnötig mit einer sehr breiten Schätzung vermischen. | Genaue Quelle, Population und Geltungsbereich nennen oder die Zahl weglassen. |
| P2 | Einzelne Texte sind sprachlich/semantisch unpräzise, beispielsweise „1 Schwerverletzte“. | Qualitätsmangel eines einreichungsreifen Verwaltungsdokuments. | Sprach- und Terminologieprüfung in den Dokument-Golden-Test aufnehmen. |

## 5. Politische Vorbefassung: Warum ein leerer Abschnitt nicht plausibel ist

Bereits eine unabhängige Web-/Quellenprüfung findet für die Adenauerallee unter anderem:

- die städtische Planung zur Kanalsanierung, Fahrbahnerneuerung und Neuverteilung des Straßenraums aus 2023,
- eine politische Initiative für einen dreimonatigen Verkehrsversuch,
- einen Antrag auf schriftliche Evaluation (`DS 240948`) und eine weitere Anfrage (`DS 240614-02`),
- Beschlüsse beziehungsweise politische Entscheidungen zur künftigen Straßenaufteilung,
- weitere Forderungen und Beschlüsse zum Zeitpunkt des Baubeginns und zur Auswertung,
- laufende beziehungsweise spätere Verkehrsversuche und Umsetzungsarbeiten.

Beispielquellen:

- https://www.bonn.de/pressemitteilungen/mai-2023/kanalsanierung-fahrbahnerneuerung-und-umgestaltung-der-adenauerallee.php
- https://www.bonn.sitzung-online.de/public/
- https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=2028269&refresh=false
- https://bbb-im-rat.de/2024/06/06/06-06-2024-nach-ende-des-verkehrsversuches-auf-der-adenauerallee-bbb-koalition-hat-intern-fahrbahnaufteilung-laengst-festgelegt/
- https://www.cdu-ratsfraktion-bonn.de/news/lokal/366/-CDU-fordert-Kein-Baubeginn-auf-der-Adenauerallee-bevor-die-Auswertung-des-Verkehrsversuchs-vorliegt.html
- https://www.linksfraktion-bonn.de/politik/pressemitteilungen/detaildarstellung-pressemitteilungen/news/dreimonatiger-verkehrsversuch-auf-der-adenauerallee-neugestaltung-der-strassenfuehrung-im-fokus/

Daraus folgt nicht, dass jede dieser politischen Quellen sachlich richtig oder für den konkreten Ausschnitt gleich relevant ist. Es folgt aber eindeutig, dass **„kein politischer Abschnitt“ nicht als „keine politische Vorbefassung“ interpretiert werden darf**.

## 6. Technische Ursache des fehlenden politischen Abschnitts

Die politische Suche war bisher ein separater UI-Nebenprozess:

1. Das Recherche-Panel musste geöffnet werden.
2. Die Suche musste erfolgreich gegen `/api/political-context/search` laufen.
3. Treffer mussten manuell angehakt werden.
4. Erst der Button „Übernehmen“ schrieb sie nach `ctx.politicalReferences`.
5. Nur dieser manuell ausgewählte Zustand gelangte in den Export.

Bonn ist im Backend als unterstützte Stadt registriert. Trotzdem kann der Export leer bleiben, wenn das Panel nicht geöffnet, die Suche nicht ausgeführt, der API-Endpunkt in einer statischen Pages-Laufzeit nicht vorhanden, der Provider fehlgeschlagen oder kein Treffer manuell übernommen wurde. Der leere Export sagte daher bisher nichts Verlässliches über das Vorhandensein politischer Vorgänge aus.

## 7. Im PR umgesetzte Korrekturen

- Neuer Adapter `js/ua.ai_political_evidence.js`:
  - startet die politische Recherche automatisch für beide KI-Wege,
  - wartet vor der Berichterzeugung auf den Suchstatus,
  - übernimmt geeignete, verkehrsrelevante und AI-gegatete Treffer in den strukturierten Bericht,
  - unterscheidet `not-searched`, `not-searchable`, `unavailable`, `failed`, `unsupported`, `searched-no-results`, `results-found-unusable` und `results-found`,
  - legt offizielle Portal- und Such-URLs als Fallback bei,
  - verhindert die Gleichsetzung von „keine Treffer“ und „keine Vorbefassung“.
- Standardantrag neutralisiert:
  - kein pauschaler Titel „Auffälliger Unfallschwerpunkt“ mehr,
  - amtliche Unfalltatsachen bleiben tragender Tatsachenkern,
  - Ursachen, räumliche Typologie und Maßnahmen werden als zu prüfende Ableitung behandelt,
  - politische Vorbefassung und Quellenlinks werden ausdrücklich verlangt.
- Regressionstests sichern:
  - erfolgreich gebundene politische Treffer,
  - leere, fehlgeschlagene und unbrauchbare Suchergebnisse,
  - offizielle Fallback-URLs,
  - Verbot der unbelegten Standard-Unfallschwerpunktbehauptung,
  - Trennung von Unfalltatsache und Maßnahmenprüfung.

## 8. Noch erforderlicher Live-Nachweis

Der Bonn-Provider muss zusätzlich in einem serverfähigen End-to-End-Lauf gegen das aktuelle Ratsinformationssystem geprüft werden. Ein Unit-Test des HTML-Parsers oder ein erfolgreicher synthetischer Suchtest beweist noch nicht, dass sich URL, Markup, Pagination oder Schutzmechanismen des Portals nicht geändert haben.

Der Live-Abnahmetest muss mindestens nachweisen:

1. Suche mit `Bonn`, `Adenauerallee` und `Südstadt`,
2. dokumentierter HTTP-/Providerstatus,
3. direkte, erreichbare Vorgangslinks,
4. plausible Klassifikation und Deduplizierung,
5. Übergabe der Treffer an Faktenpaket, KI-QA und Export,
6. blockierender, ausdrücklich sichtbarer Status bei Ausfall oder unvollständiger Recherche.

## 9. Fachlich angemessene Antragsrichtung für diesen Prüffall

Die 37 amtlich dokumentierten Rad-Pkw-Unfälle dürfen nicht relativiert oder in allgemeine Verkehrssicherheitsprosa aufgelöst werden. Die vorliegenden Daten tragen einen konkreten Auftrag. Der gegenwärtig belastbare Antrag sollte aber nicht behaupten, dass bereits ein einzelner Unfallschwerpunkt und seine Ursache bewiesen seien.

Angemessen ist zunächst ein Antrag, der

- die Unfallkonstellationen und Teilräume entlang der Adenauerallee fachlich prüfen lässt,
- sie mit den laufenden Verkehrsversuchen, Beschlüssen und Umgestaltungsplanungen abgleicht,
- kurzfristige risikoarme Sicherungen bei fachlich belegter Eignung ermöglicht,
- dauerhafte Maßnahmen aus konkreten Konfliktbildern ableitet,
- Berichtspflicht, Quellenbezug und mehrdimensionale Erfolgskontrolle festlegt.
