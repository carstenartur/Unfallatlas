# Korrigierte End-to-End-QA: Unfallwerkbank → KI-Auftrag → kommunaler Antrag

**Ursprüngliche Prüfung:** 15. August 2026  
**Methodische Korrektur:** 16. August 2026  
**PR:** #620  
**Prüffall:** Adenauerallee, Bonn-Südstadt  
**Status:** Die erste statistische Modellbewertung ist wegen einer falschen Interpretation des Mustervergleichs **zurückgezogen**. Die Einreichungsreife bleibt aus anderen, davon unabhängigen Gründen vorläufig blockiert: ungeklärte politische Recherche, statisch-dynamischer Widerspruch der Antragssprache sowie fehlende reale Ortsgrundlage für konkrete Maßnahmen.

## 1. Korrekturhinweis

Die erste Fassung dieser QA behauptete, die Unfallwerkbank habe 37 lokale und 1.963 stadtweite Fälle ohne geeigneten Nenner beziehungsweise Expositionsbezug als Risikovergleich verwendet. Diese Kritik war sachlich falsch.

Die Unfallwerkbank vergleicht an dieser Stelle **nicht die absoluten Unfallzahlen unterschiedlich großer Räume als Unfallrate**. Sie vergleicht die **Anteile von Beteiligungskombinationen** im ausgewählten Bereich mit den entsprechenden Anteilen in einer stadtweiten Referenzpopulation unter denselben Nicht-Beteiligungsfiltern. Die lokalen und stadtweiten Gesamtzahlen sind dabei die jeweiligen Stichprobenumfänge beziehungsweise Nenner der Anteilsberechnung.

Auch die Trendklassifikation beruht nicht auf einem Vergleich absoluter lokaler und stadtweiter Fallzahlen. Sie beschreibt die zeitliche Entwicklung innerhalb desselben Bereichs und verwendet zur Klassifikation die relative Steigung bezogen auf den Mittelwert sowie das Bestimmtheitsmaß R².

Alle Schlussfolgerungen der ersten Modellprobe, die auf der vermeintlich fehlenden Flächen-, Längen- oder Verkehrsexpositions-Normierung dieses **Musteranteilsvergleichs** beruhten, sind damit nicht belastbar und werden hier ausdrücklich zurückgenommen.

## 2. Tatsächlich implementierte Statistik

### 2.1 Vergleich der Unfallmuster

`topDeviations()` in `js/ua.export_v2.js` bildet:

- eine stadtweite Referenzpopulation unter denselben Schwere-, Zeit-, Straßen- und weiteren Nicht-Beteiligungsfiltern;
- eine lokale Population mit denselben Filtern innerhalb der ausgewählten Geometrie;
- für jede Beteiligungskombination den lokalen Anteil `locCnt / local.total`;
- den stadtweiten Referenzanteil `baseCnt / baseline.total`;
- den Faktor `locR / baseR`;
- ein 95-%-Wilson-Konfidenzintervall für den lokalen Anteil;
- `isSignificant=true`, wenn die untere Intervallgrenze über dem Referenzanteil liegt.

Die Funktion `focus` berücksichtigt derzeit Kombinationen mit mindestens drei lokalen Fällen und einem Faktor von mindestens 1,35. Die stärkere Klassifikation im Executive Summary verlangt zusätzlich Faktor mindestens 1,5 und `isSignificant=true`.

**Fachliche Bedeutung:** Die Aussage betrifft die **Zusammensetzung des Unfallgeschehens**. Sie beantwortet beispielsweise, ob eine bestimmte Beteiligungskombination im ausgewählten Bereich einen höheren Anteil an allen dort unter denselben Filtern betrachteten Unfällen besitzt als im Stadtgebiet. Dafür ist keine Verkehrsleistungs- oder Flächennormierung erforderlich.

Zusätzliche Expositionsdaten wären erforderlich, wenn aus den Daten eine andere Aussage abgeleitet werden soll, etwa:

- absolutes Unfallrisiko je gefahrenem Kilometer,
- Unfallrate je Radfahrenden- oder Kfz-Aufkommen,
- Vergleich der gesamten Unfallhäufigkeit pro Straßenlänge oder Fläche.

Diese Aussagearten sind vom implementierten Musteranteilsvergleich zu trennen.

### 2.2 Mehrjahrestrend

`js/ua.trend.js` berechnet eine lineare Regression über die jährlichen Unfallzahlen im betrachteten, gefilterten Bereich. Die qualitative Klassifikation verwendet:

- `slope / mean` als relative jährliche Steigung;
- eine Stagnationsschwelle von fünf Prozent pro Jahr;
- R² mindestens 0,3 für eine steigende oder rückläufige Klassifikation;
- mindestens drei Datenjahre.

Die Klassifikation ist damit gegenüber einer gemeinsamen Skalierung der gesamten Reihe invariant: Werden alle Jahreswerte mit demselben Faktor multipliziert, ändern sich absolute Steigung und Mittelwert im selben Verhältnis, während `slope / mean` und R² gleich bleiben.

Die Trendanalyse benötigt daher keinen stadtweiten Nenner. Für die Interpretation als **Entwicklung des Risikos je Verkehrsleistung** wären Veränderungen von Verkehrsaufkommen, Modal Split oder Datenerfassung jedoch ergänzend zu betrachten. Das entwertet nicht die deskriptive Aussage über die Entwicklung der dokumentierten Unfallzahlen im festen Analysebereich.

## 3. Gebundener Ausgangsfall

Der CI-Export weist für den markierten Abschnitt der Adenauerallee aus:

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

Die Unfallzahlen sind zwischen Schweregradtabelle, Jahrgangstabelle, Kreuztabelle und Unfall-Detailtabelle konsistent. Die amtlichen Unfallereignisse bilden einen belastbaren Tatsachenkern.

Für eine abschließende Beurteilung der Musterauffälligkeit müssen aus dem real erzeugten strukturierten Bericht zusätzlich die konkreten Werte `locR`, `baseR`, `factor`, `ciLow`, `ciHigh` und `isSignificant` übernommen und bewertet werden. Die bloßen Gesamtzahlen 37 und 1.963 erlauben weder eine Bestätigung noch eine Widerlegung der Musterüberrepräsentation.

## 4. Was die erste KI-Probe tatsächlich gezeigt hat

Der erste Modelllauf ist **kein positiver Qualitätsnachweis für den Prompt**. Das Modell interpretierte die beiden Stichprobenumfänge fälschlich als direkten absoluten Risikovergleich und leitete daraus einen nicht vorhandenen methodischen Mangel ab.

Damit hat der Test vor allem einen Promptmangel offengelegt: Die KI erhielt zwar strukturierte Kennzahlen, aber keinen ausreichend ausdrücklichen Methodenvertrag, der die Bedeutung von Lokalanteil, Referenzanteil, Faktor, Wilson-Intervall, Signifikanz und relativer Trendsteigung erklärt und klar von Unfallraten je Exposition trennt.

Der Modelltest muss nach Ergänzung dieses Methodenvertrags erneut ausgeführt werden. Eine fachlich korrekte KI-Ausgabe muss:

1. die Musteranteile und ihre Unsicherheit als solche auswerten;
2. keine Expositionsnormierung für den Anteilsvergleich verlangen;
3. Expositionsdaten nur bei Aussagen über absolute Unfallraten oder Risiko je Verkehrsleistung einfordern;
4. den Trend als relative Entwicklung innerhalb desselben Bereichs interpretieren;
5. die konkrete Auffälligkeitsaussage aus `factor`, Konfidenzintervall und `isSignificant` ableiten.

## 5. Korrigierte Befunde

| Priorität | Befund | Bewertung | Erforderliche Korrektur |
|---|---|---|---|
| P0 | Der Export enthält keine belastbar dokumentierte politische Vorbefassung, obwohl zur Adenauerallee bereits Verkehrsversuche, Anträge, Beschlüsse, Evaluationsforderungen und laufende Umgestaltungsentscheidungen existieren. | Ein neuer Antrag kann bestehende Beschlüsse wiederholen, ihnen widersprechen oder einen laufenden Prozess ignorieren. | Politische Recherche verpflichtend in die KI-Evidenzkette aufnehmen; Suchstatus, Suchbegriffe, Treffer und direkte Quellenlinks ausweisen. |
| P0 | Ein statischer Antragstitel behauptete unabhängig vom konkreten Analyseergebnis einen „auffälligen Unfallschwerpunkt“, während die dynamische Kurzbewertung im Prüffall „kein eindeutiger Unfallschwerpunkt“ ausgab. | Tatsächlicher semantischer Widerspruch zwischen statischem Template und dynamischer Analyse. | Titel und Begründung dynamisch aus der Analyseklassifikation ableiten oder neutral formulieren. |
| P1 | Der KI-Auftrag erklärt die implementierte statistische Methodik nicht ausdrücklich genug. | Der reale Modelllauf missverstand einen Musteranteilsvergleich als Rohfallzahl-/Expositionsvergleich. | Maschinenlesbaren und menschenlesbaren Methodenvertrag in beide KI-Pfade aufnehmen und mit Negativtests absichern. |
| P1 | `deviations.focus` verlangt Faktor ≥ 1,35 und mindestens drei lokale Fälle, aber nicht zwingend `isSignificant=true`; `buildExecutiveSummary()` kann daraus bereits einen „lokalen Häufungspunkt“ formulieren. | Explorative Abweichung und statistisch abgesicherte Auffälligkeit können sprachlich zu dicht beieinanderliegen. | Entweder Signifikanz für die Häufungspunkt-Klassifikation verlangen oder den nicht signifikanten Status ausdrücklich als explorativ kennzeichnen. |
| P1 | Die stadtweite Referenzpopulation enthält regelmäßig auch die lokale Teilmenge; das Wilson-Intervall berücksichtigt nur die Unsicherheit des lokalen Anteils, und mehrere Beteiligungsmuster werden parallel geprüft. | Kein Beleg für eine falsche Berechnung, aber ein sinnvoller statistischer Härtungspunkt: Abhängigkeit, Referenzunsicherheit und multiples Testen sollten transparent geprüft werden. | Vergleich „lokal gegen übriges Stadtgebiet“, Zwei-Stichproben-/Resampling-Verfahren und Korrektur beziehungsweise Kennzeichnung multipler explorativer Vergleiche evaluieren. |
| P1 | Ein Korridor über rund 523 m und ein Cluster mit 5 von 37 Fällen müssen räumlich getrennt von der Musteranteilsanalyse interpretiert werden. | Beteiligungsmuster-Auffälligkeit, räumlicher Cluster und amtlicher Unfallschwerpunkt sind unterschiedliche Konzepte. | Im Datenmodell und Antrag getrennte Klassifikationen und Bezeichnungen verwenden. |
| P1 | Markierung, Beschilderung, Signalisierung, Tempoanpassung, Querungen und Umbau wurden pauschal verlangt. | Maßnahmen waren nicht sichtbar an konkrete Konflikttypen, Fahrbeziehungen oder aktuelle Gestaltung gebunden. | Befund → Sicherheitsziel → Option → Fach-/Ortsprüfung → Erfolgskriterium für jede Maßnahme dokumentieren. |
| P1 | Die CI-Karte ist eine synthetische QA-Basiskarte und keine reale Luftbild-/Straßengeometrie. | Sichtbeziehungen, Spurführung, Abbiegekonflikte, Lieferzonen und bauliche Details können daraus nicht abschließend bewertet werden. | Reale Kartografie beziehungsweise aktuelle Vor-Ort-/Luftbildprüfung vor konkreten baulichen Aussagen verlangen. |
| P2 | Die Trendfunktion bildet nur Jahre ab, die in der übergebenen Punktmenge vorkommen. | Ein tatsächlich unfallfreies Jahr könnte fehlen, sofern die aufrufende Datenkette nicht explizit Nulljahre ergänzt. | Vollständige Datenjahresachse aus dem Analysezeitraum verwenden und Nulljahre explizit eintragen. |
| P2 | Evaluation ausschließlich nach zwölf Monaten anhand der Unfallentwicklung ist bei kleinen Jahreszahlen schwach. | Das betrifft die Maßnahmenwirkung, nicht die Gültigkeit des bestehenden Mehrjahrestrends. | Ergänzende Konflikt-, Geschwindigkeits-, Verkehrs- und Nutzungsindikatoren sowie geeigneten Beobachtungszeitraum definieren. |
| P2 | Einzelne Texte sind sprachlich unpräzise, beispielsweise „1 Schwerverletzte“. | Qualitätsmangel eines einreichungsreifen Verwaltungsdokuments. | Sprach- und Terminologieprüfung in den Dokument-Golden-Test aufnehmen. |

## 6. Politische Vorbefassung

Eine unabhängige Quellenprüfung findet für die Adenauerallee unter anderem:

- die städtische Planung zur Kanalsanierung, Fahrbahnerneuerung und Neuverteilung des Straßenraums aus 2023,
- eine politische Initiative für einen Verkehrsversuch,
- einen Antrag auf schriftliche Evaluation (`DS 240948`) und eine weitere Anfrage (`DS 240614-02`),
- Beschlüsse beziehungsweise politische Entscheidungen zur künftigen Straßenaufteilung,
- weitere Forderungen zum Baubeginn und zur Auswertung,
- laufende beziehungsweise spätere Verkehrsversuche und Umsetzungsarbeiten.

Beispielquellen:

- https://www.bonn.de/pressemitteilungen/mai-2023/kanalsanierung-fahrbahnerneuerung-und-umgestaltung-der-adenauerallee.php
- https://www.bonn.sitzung-online.de/public/
- https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=2028269&refresh=false
- https://bbb-im-rat.de/2024/06/06/06-06-2024-nach-ende-des-verkehrsversuches-auf-der-adenauerallee-bbb-koalition-hat-intern-fahrbahnaufteilung-laengst-festgelegt/
- https://www.cdu-ratsfraktion-bonn.de/news/lokal/366/-CDU-fordert-Kein-Baubeginn-auf-der-Adenauerallee-bevor-die-Auswertung-des-Verkehrsversuchs-vorliegt.html
- https://www.linksfraktion-bonn.de/politik/pressemitteilungen/detaildarstellung-pressemitteilungen/news/dreimonatiger-verkehrsversuch-auf-der-adenauerallee-neugestaltung-der-strassenfuehrung-im-fokus/

Daraus folgt nicht, dass jede politische Quelle sachlich richtig oder für den konkreten Ausschnitt gleich relevant ist. Es folgt aber, dass ein leerer politischer Abschnitt nicht als fehlende politische Vorbefassung interpretiert werden darf.

## 7. Technische Ursache des fehlenden politischen Abschnitts

Die politische Suche war bisher ein separater UI-Nebenprozess:

1. Recherche-Panel öffnen,
2. Suche gegen `/api/political-context/search`,
3. Treffer manuell auswählen,
4. Treffer mit „Übernehmen“ nach `ctx.politicalReferences` schreiben,
5. nur diesen Zustand exportieren.

Ein leerer Export konnte deshalb „nicht gesucht“, „Endpunkt nicht verfügbar“, „Provider fehlgeschlagen“, „keine Treffer“, „Treffer fachlich verworfen“ oder „Treffer nicht übernommen“ bedeuten.

## 8. Im PR umgesetzte beziehungsweise korrigierte Arbeiten

- Automatische politische Recherche und explizite Suchstatus für beide KI-Wege.
- Überführung geeigneter politischer Referenzen in den serverseitig gelesenen Referenzpfad.
- Neutralisierung eines statisch immer behaupteten Unfallschwerpunkt-Titels.
- Korrigierte Beschreibung des tatsächlichen Musteranteilsvergleichs und des relativen Mehrjahrestrends in `templates/sachverhalt.txt`.
- Regressionstest, der den Anteilsvergleich ausdrücklich von einer Unfallrate je Exposition trennt.

Noch ausstehend ist der explizite Methodenvertrag im tatsächlich kopierten KI-Auftrag sowie dessen erneuter Modell-End-to-End-Test.

## 9. Erforderliche erneute Modellprüfung

Der nächste Test muss den realen strukturierten Bericht einschließlich sämtlicher Abweichungsfelder verwenden und zwei Kontrollfragen enthalten:

1. **Was wird verglichen?** Erwartete Antwort: lokale und stadtweite Anteile von Beteiligungskombinationen unter konsistenten Filtern, nicht absolute Unfallraten unterschiedlich großer Räume.
2. **Wie wird der Trend klassifiziert?** Erwartete Antwort: lineare Entwicklung der Jahreszahlen im selben Bereich, klassifiziert über relative Steigung und R².

Erst wenn das Modell diese Methodik korrekt wiedergibt, dürfen seine inhaltliche Kritik und der daraus erzeugte Antrag als aussagekräftiger End-to-End-Test des Prompts gelten.
