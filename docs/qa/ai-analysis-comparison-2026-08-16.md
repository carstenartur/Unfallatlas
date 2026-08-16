# Vergleichs-QA: deterministische Unfallwerkbank-Analyse und KI-gestützte Aufbereitung

**Datum:** 16. August 2026  
**PR:** #620  
**Realer Prüffall:** markierter Bereich rund um Bonn Hauptbahnhof / Münsterplatz / Maximilianstraße / Thomas-Mann-Straße  
**Filter:** Radverkehr **UND** Pkw, alle Schweregrade, alle Wochentage, 0–23 Uhr, Jahre 2019–2025

## 1. Ziel und Bewertungsmaßstab

Die deterministische Unfallwerkbank-Ausgabe und die KI-gestützte Aufbereitung haben unterschiedliche Aufgaben:

- Die **Unfallwerkbank** muss amtliche Unfalltatsachen, Filter, Zählungen, statistische Verfahren, Karten und Quellen reproduzierbar und widerspruchsfrei ausgeben.
- Die **KI** darf diese Grundlage nicht verwässern oder methodisch umdeuten. Sie muss darüber hinaus belegbare Zusammenhänge synthetisieren, Befunde priorisieren, Gegenhypothesen und Prüfbedarf benennen, politische und administrative Anschlussfähigkeit recherchieren und einen orts- und entscheidungsspezifischen Antrag entwickeln.

Eine KI-Ausgabe, die nur Tabellen in Fließtext umformuliert, liefert keinen ausreichenden Mehrwert.

## 2. Verbindliche deterministische Ausgangsbasis

Der geprüfte Unfallwerkbank-Export weist aus:

- 37 amtlich dokumentierte Unfälle mit Personenschaden im markierten Bereich;
- 0 Getötete, 1 Schwerverletzte, 36 Leichtverletzte;
- Jahreswerte 2019–2025: 6, 8, 5, 2, 2, 9, 5;
- Mehrjahrestrend: `stagnierend`, Steigung rund −0,14 Unfälle/Jahr, R² 0,01, n=7;
- 32 Unfälle an Werktagen und 5 am Wochenende;
- höchste Stunden-/Tagestyp-Zelle: werktags 11 Uhr mit 5 Unfällen;
- räumliche Ausdehnung entlang einer Achse von rund 523 m;
- Hauptcluster mit 5 Unfällen;
- 7 Kindergärten und 3 Schulen im 200-m-Umfeld, keine davon innerhalb des Auswahlrechtecks;
- vollständig konsistente Gesamtzahlen in Schweregrad-, Jahres-, Kreuz- und Detaildarstellung.

### Methodisch korrekt zu bewahren

Der Beteiligungsmustervergleich ist **kein Vergleich absoluter Unfallraten unterschiedlich großer Räume**. Er berechnet für jede Beteiligungskombination:

```text
locR   = locCnt / local.total
baseR  = baseCnt / baseline.total
factor = locR / baseR
```

Dazu kommen Wilson-95-%-Intervall und `isSignificant`. Ein Expositionsnenner ist erst für Aussagen über Unfallraten je Verkehrsleistung, Straßenlänge oder Fläche erforderlich, nicht für diesen Vergleich der Musterzusammensetzung.

Der Mehrjahrestrend wird innerhalb desselben Bereichs aus den Jahreswerten per linearer Regression ermittelt. Die Klassifikation nutzt die relative Steigung `slope / mean`, R² und die Zahl der Datenjahre.

## 3. Fehler der bisherigen deterministischen Darstellung

### 3.1 Falsche Ortsbezeichnung aus dem Mittelpunkt

Der Export bezeichnete den Bereich als „Adenauerallee, 53113, Bonn, Südstadt“. Die tatsächliche Auswahl liegt sichtbar rund um Bonn Hauptbahnhof, Münsterplatz, Maximilianstraße, Thomas-Mann-Straße und angrenzende Innenstadtstraßen.

Ursache ist die Übernahme eines Reverse-Geocoding-Treffers für den **Mittelpunkt** als Bezeichnung des gesamten, mehrere hundert Meter breiten Auswahlbereichs. Ein Mittelpunkt ist keine belastbare Gebietsbezeichnung.

Korrektur:

- explizit bestätigte Bereichsnamen haben Vorrang;
- ohne Bestätigung wird ein neutraler, koordinatengebundener Name ausgegeben;
- der Mittelpunkt-Treffer bleibt nur als technischer Hinweis erhalten und wird nicht als Name des Untersuchungsraums ausgegeben.

### 3.2 Statischer Antrag widersprach der dynamischen Kurzbewertung

Der ältere Export trug „Auffälliger Unfallschwerpunkt“, während die dynamische Kurzbewertung feststellte, dass kein eindeutiger Unfallschwerpunkt erkennbar sei. Die aktuellen Templates in PR #620 sind neutralisiert. Künftig muss die dynamische, methodengerechte Klassifikation den Antragstitel steuern.

### 3.3 Nicht signifikante Muster dürfen nicht als statistisch bewiesene Häufung erscheinen

`focus` enthält bewusst auch explorative Abweichungen ab Faktor 1,35 und mindestens drei lokalen Fällen. Deshalb muss jede Darstellung `isSignificant` beachten. Ein exploratives Muster kann einen Prüfhinweis begründen, aber keine statistisch abgesicherte Schwerpunktbehauptung.

## 4. Direkter Vergleich der beiden Analyseebenen

| Dimension | Deterministische Unfallwerkbank | Erwartete KI-Aufbereitung | Tatsächlicher zusätzlicher Wert |
|---|---|---|---|
| Amtliche Unfalltatsachen | Exakte Zahlen, Schwere, Jahre, Koordinaten und Beteiligungen | unverändert bestätigen und knapp zitieren | kein Mehrwert durch Umformulierung; Mehrwert erst durch Einordnung für die Entscheidung |
| Mustervergleich | `locR`, `baseR`, Faktor, Wilson-Intervall, Signifikanz | Methode korrekt wiedergeben; signifikant und explorativ trennen | erklärt, welche Muster politisch/fachlich priorisiert werden und welche nur Prüfhinweise sind |
| Zeittrend | Jahreswerte, Steigung, R², Klassifikation | nicht nur „stagnierend“ wiederholen | herausarbeiten, dass trotz Schwankungen kein belastbarer Rückgang erkennbar ist und daher ein bloßer Beobachtungsverweis nicht genügt |
| Tages-/Stundenverteilung | vollständige Heatmap | Spitzen und Verteilung synthetisieren | hier: kein einzelnes enges Zeitfenster; überwiegend werktägliches, über den Tag verteiltes Konfliktgeschehen |
| Raum | Punkte, Detailkarte, Cluster, Spannweite | Korridor, Teilcluster und einzelne Knoten getrennt behandeln | 5er-Cluster ist nur Teil des 37-Fälle-Korridors; Prüfung muss segmentiert erfolgen |
| Kontext | POI, OSM, Steigung, Verkehrshinweise, Kartenlayer | mehrere Evidenzschichten verbinden, ohne Ursachen zu erfinden | formuliert konkurrierende Hypothesen und konkrete Vor-Ort-/Datenprüfungen |
| Politik/Verwaltung | bisher unzuverlässig oder leer | OParl/RIS und laufende Projekte recherchieren | verhindert Doppelanträge und nutzt reale Planungs-, Bau- oder Evaluationsfenster |
| Maßnahmen | regelbasierte Vorauswahl | priorisieren, Voraussetzungen und Zielkonflikte erklären | aus einer Liste wird eine entscheidungsfähige Maßnahmenmatrix |
| Antrag | deterministischer Vorentwurf | orts-, gremien- und verfahrensgerecht überarbeiten | konkrete Verwaltungsaufträge, Fristen, Berichtswege, Quellen und Erfolgskriterien |

## 5. Ergebnis des korrigierten KI-Selbsttests

Die folgende Aufbereitung ist ein GPT-5.6-Pro-Selbsttest auf Grundlage des realen deterministischen Exports, der Karte und ergänzender Quellenrecherche. Sie ist kein unabhängiges Zweitgutachten, zeigt aber den erwarteten Mehrwert gegenüber einer bloßen Textglättung.

### 5.1 Bestätigter Tatsachenkern

1. Im markierten Bereich wurden 2019–2025 insgesamt 37 polizeilich erfasste Unfälle mit Personenschaden dokumentiert, an denen sowohl Radverkehr als auch Pkw beteiligt waren.
2. Die Zählungen sind über die verschiedenen Tabellen und Kartenansichten konsistent.
3. Die Unfallzahl zeigt über sieben Jahre keinen statistisch belastbaren Rückgang. Die geringe negative Regressionssteigung bei R² 0,01 trägt keine Rückgangsaussage.
4. Das Geschehen verteilt sich überwiegend auf Werktage und auf mehrere Tagesstunden. Es gibt keinen einzelnen, klar isolierten Stundenpeak, der die Gesamtlage allein erklären würde.
5. Die Unfälle verteilen sich über einen Korridor von rund 523 m. Der größte dargestellte Cluster umfasst 5 und damit nur rund 13,5 % der 37 Fälle. Ein einzelner Knoten erklärt den Gesamtbefund daher nicht.

### 5.2 Zusätzliche Synthesen der KI

#### Synthese A: Persistentes Korridorproblem statt einzelner Spitzenlage

Die Kombination aus fehlendem Mehrjahresrückgang, räumlicher Ausdehnung und einem Hauptcluster von nur 5/37 Fällen spricht dafür, die Achse in Teilabschnitte und Konflikträume zu zerlegen. Eine einzige pauschale „Unfallschwerpunktmaßnahme“ wäre weniger belastbar als eine segmentierte Prüfung von Knoten, Querungen, Zu- und Abfahrten, Gleis-/Haltestellenbereichen und wiederkehrenden Führungswechseln.

**Gegenhypothese:** Die Verteilung könnte aus mehreren voneinander unabhängigen Einzelfaktoren bestehen.  
**Trennende Prüfung:** Unfälle nach exakten Teilräumen, Bewegungsrichtungen, Unfalltyp und straßenräumlicher Situation clustern; soweit zugänglich, Unfallhergang aus der amtlichen Unfallkommissionsarbeit ergänzen.

#### Synthese B: Keine reine Pendlerzeitproblematik

32 von 37 Unfällen liegen an Werktagen, die Fälle verteilen sich jedoch von den frühen Morgenstunden bis in den Abend. Der größte Einzelwert liegt werktags um 11 Uhr; weitere Häufungen treten unter anderem um 9, 13, 14, 17 und 18 Uhr auf. Das spricht gegen eine ausschließlich auf eine kurze morgendliche oder abendliche Pendlerzeit begrenzte Erklärung.

**Gegenhypothese:** Unterschiedliche Nutzergruppen oder Nutzungszwecke könnten zu verschiedenen Zeiten dieselben Konfliktstellen nutzen.  
**Trennende Prüfung:** Richtungs-, Abbiege-, Liefer-, Bus-, Taxi- und Fußverkehrsbeobachtung in mehreren Zeitfenstern statt nur während einer Spitzenstunde.

#### Synthese C: Aktuelles Planungsfenster erhöht die Handlungsrelevanz

Für die Straße „Am Hauptbahnhof“ besteht ein laufendes Umbauprojekt; der neue ZOB soll ausdrücklich sicherer und barrierefrei werden und geeignete konfliktfreie Radverkehrsführungen berücksichtigen. Der Unfallbefund ist deshalb nicht nur Anlass für eine abstrakte Prüfung, sondern sollte als nachvollziehbare Evidenz in laufende Entwurfs-, Ausschreibungs-, Bauphasen- und Baustellenverkehrsentscheidungen eingebunden werden.

**Gegenhypothese:** Teile der 37 Unfälle liegen außerhalb des eigentlichen Projektperimeters oder betreffen Konflikte, die durch die laufende Planung bereits gelöst werden.  
**Trennende Prüfung:** jeden Unfallpunkt und jedes Teilcluster gegen Projektgrenzen, Planstände und vorgesehene Verkehrsführungen legen; für bereits adressierte Konflikte den vorgesehenen Lösungsmechanismus dokumentieren.

### 5.3 Priorisierte Entscheidungsfragen

1. **Welche Teilräume und Bewegungsbeziehungen tragen den 37-Fälle-Befund?**  
   Priorität hoch, weil davon abhängt, ob die laufende Planung die dokumentierten Konflikte tatsächlich erfasst.
2. **Wie wird der Radverkehr während Umbau und Bauzeit sicher und kontinuierlich geführt?**  
   Priorität hoch, weil eine Übergangsführung selbst ein neues Risiko erzeugen oder bestehende Konflikte verlagern kann.
3. **Welche bestehenden politischen Beschlüsse und Planungsstände decken die Befunde bereits ab?**  
   Priorität hoch, damit ein neuer Antrag nicht nur bekannte Planungen wiederholt, sondern konkrete Nachweise, Ergänzungen und Berichtspflichten verlangt.

### 5.4 Maßnahmen- und Entscheidungsmatrix

| Belegter Befund | Sicherheitsziel | Option / Verwaltungsauftrag | Voraussetzung / Gegenprüfung | Zielkonflikt | Erfolgskriterium |
|---|---|---|---|---|---|
| 37 Rad-Pkw-Unfälle mit Personenschaden, kein belastbarer Rückgang | dokumentierte Konflikte in laufender Planung vollständig adressieren | Unfallpunkte und Teilcluster verbindlich mit den Planunterlagen „Am Hauptbahnhof“ und ZOB abgleichen; Abdeckungsmatrix veröffentlichen | genaue Projektgrenzen und Planstand | Zeit-/Kostenfolgen bei Nachplanung | jeder relevante Unfallkontext ist einer Planungslösung oder einem offenen Prüfpunkt zugeordnet |
| Korridor von rund 523 m, größter Cluster nur 5 Fälle | keine Überfokussierung auf einen Einzelpunkt | Achse in fachlich sinnvolle Segmente gliedern und je Segment Konfliktmuster, Führung und Maßnahmen prüfen | reale Karte, Bewegungsrichtungen, Unfalltypen | zusätzliche Untersuchungstiefe | segmentierter Bericht mit priorisierten Teilräumen |
| werktägige, über mehrere Tageszeiten verteilte Fälle | Maßnahmen für unterschiedliche Nutzungszustände belastbar machen | Vor-Ort-Beobachtung in mehreren Zeitfenstern einschließlich Bus-/Taxi-/Liefer- und Spitzenverkehr | abgestimmtes Beobachtungsdesign | Personalaufwand | dokumentierte Konfliktbeobachtungen und belastbare Verkehrs-/Geschwindigkeitsdaten |
| bevorstehende beziehungsweise laufende Umbauvorbereitung | während der Bauzeit keine neue Gefahrenlage schaffen | durchgängige, verständliche und richtliniengerechte Radverkehrsführung für alle Bauphasen vor Baubeginn veröffentlichen und auditieren | Baustellenphasenplan | Flächenkonkurrenz, ÖPNV-Betrieb | keine ungeklärten Unterbrechungen; Audit und Mängelbeseitigung vor Freigabe |
| amtliche Unfallzahlen reagieren zeitverzögert | Wirkung früher und robuster erkennen | Unfallentwicklung mit Konfliktbeobachtung, Geschwindigkeiten, Verkehrsmenge und Nutzungsqualität kombinieren | definierte Vorher-Nachher-Erhebung | Messaufwand | öffentliches Monitoring mit Ausgangswert, Zielwert und Termin |

## 6. Beispiel eines KI-seitig verbesserten Antragskerns

### Betreff

**Amtliche Unfallauswertung in die laufenden Planungen und die Baustellenverkehrsführung am Bonner Hauptbahnhof integrieren**

### Beschlussvorschlag

Die Bezirksvertretung Bonn bittet die Verwaltung,

1. die 37 im Zeitraum 2019–2025 im markierten Umfeld des Bonner Hauptbahnhofs dokumentierten Rad-Pkw-Unfälle mit Personenschaden räumlich und nach Konfliktkonstellationen den Teilabschnitten der laufenden Planungen für die Straße „Am Hauptbahnhof“, den ZOB und die angrenzenden Verkehrsflächen zuzuordnen;
2. in einer öffentlich nachvollziehbaren Abdeckungsmatrix darzustellen, welche dokumentierten Konflikte durch bestehende Planungen bereits adressiert werden, welche Gegenprüfung noch erforderlich ist und wo Planergänzungen notwendig sind;
3. die Radverkehrsführung für sämtliche Bauphasen vor Beginn der jeweiligen Phase einer Verkehrssicherheitsprüfung zu unterziehen und die geplante durchgängige Führung einschließlich Umleitungen, Querungen, Sichtbeziehungen und Übergängen zu veröffentlichen;
4. die Achse wegen der räumlichen Verteilung nicht nur als einzelnen Punkt, sondern segmentiert nach Knoten, Querungs-, Haltestellen-, Gleis- und Führungswechselbereichen zu prüfen;
5. der Bezirksvertretung innerhalb einer festzulegenden Frist über Ergebnisse, bereits beschlossene Maßnahmen, offene Zielkonflikte, Zuständigkeiten, Zeitplan und Erfolgskriterien zu berichten;
6. die spätere Wirkung nicht ausschließlich anhand einer einzelnen 12-Monats-Unfallzahl, sondern ergänzend anhand geeigneter Konflikt-, Geschwindigkeits-, Verkehrs- und Nutzungsindikatoren zu evaluieren.

### Begründung

Die amtliche Unfallstatistik dokumentiert für den gewählten Bereich in sieben Jahren 37 Unfälle mit Personenschaden unter Beteiligung von Radverkehr und Pkw. Die Unfallzahlen gehen im Mehrjahresvergleich nicht belastbar zurück. Die Vorfälle verteilen sich über einen längeren Korridor und mehrere Tageszeiten; der größte einzelne Cluster bildet nur einen Teil des Gesamtgeschehens. Gleichzeitig bestehen konkrete Planungs- und Umbauprozesse im Hauptbahnhofsumfeld. Der Antrag verlangt deshalb keine pauschale, von der örtlichen Planung losgelöste Maßnahmenliste, sondern die nachvollziehbare Verknüpfung der amtlichen Unfallbefunde mit den bereits laufenden Entscheidungen, eine sichere Bauphasenführung und eine überprüfbare Berichterstattung.

## 7. Delta gegenüber dem deterministischen Bericht

### Unverändert bestätigt

- amtliche Unfallzahlen und Schweregrade;
- Filter und Zeitraum;
- Mustervergleichsmethodik;
- Trendberechnung;
- räumliche und zeitliche Grunddaten.

### Präzisiert

- Untersuchungsraum ist nicht „Adenauerallee“, sondern der markierte Hauptbahnhof-/Innenstadtbereich;
- „stagnierend“ bedeutet hier: kein belastbarer Rückgang, nicht eine konstante jährliche Fallzahl;
- Cluster, Korridor und statistisches Beteiligungsmuster sind getrennte Analysegegenstände.

### Neu ergänzt

- Synthese von räumlicher Verteilung, Zeitprofil und Trend;
- Gegenhypothesen und trennende Prüfungen;
- politische/administrative Einbindung in laufende Hauptbahnhof- und ZOB-Planungen;
- priorisierte Entscheidungsfragen;
- Maßnahmenmatrix mit Voraussetzungen, Zielkonflikten und Erfolgskriterien;
- auf laufende Verfahren zugeschnittener Antragskern.

### Verworfen

- pauschale statische Behauptung eines einzelnen „auffälligen Unfallschwerpunkts“;
- generische Maßnahmenliste ohne Zuordnung zu Teilraum und Befund;
- Mittelpunktadresse als Name des gesamten Untersuchungsraums;
- reine 12-Monats-Unfallzahl als alleiniger Wirkungsnachweis.

### Offen

- echte politische OParl-/RIS-Treffer einschließlich Beschlussnummern und direkter Vorgangslinks;
- genaue Zuordnung der 37 Unfallorte zu aktuellen Projektperimetern und Planständen;
- Unfalltypen, Bewegungsrichtungen und amtliche Unfallhergänge, soweit öffentlich beziehungsweise durch die Unfallkommission zugänglich;
- reale Verkehrs-, Geschwindigkeits- und Konfliktdaten;
- aktuelle Baustellenphasen und verbindliche Radverkehrsführung.

## 8. Produktanforderung aus dem Vergleich

Die KI-Übergabe muss künftig einen maschinenlesbaren Mehrwertvertrag enthalten. Mindestanforderungen:

1. Gegenüberstellung von deterministischem Befund und KI-Ergebnis;
2. mindestens drei quellengebundene, mehrschichtige Synthesen;
3. Priorisierung statt ungewichteter Befundliste;
4. Gegenhypothesen und trennende Prüfungen;
5. politische und administrative Vorbefassung;
6. Maßnahmenmatrix mit Voraussetzungen und Zielkonflikten;
7. explizite Delta-Liste;
8. automatisches Durchfallen bei Methodenfehlern oder bloßer Paraphrase.

Der Vertrag ist in PR #620 als `unfallwerkbank.aiAnalysisComparisonContract.v1` implementiert und wird gemeinsam mit einem maschinenlesbaren Digest der deterministischen Analyse an den nutzerseitigen KI-Pfad übergeben.

## 9. Quellen für die ergänzende Kontextrecherche

- Unfallatlas – amtliche Datengrundlage: https://www.statistikportal.de/de/karten/unfallatlas
- Bonn OParl-System: https://www.bonn.sitzung-online.de/public/oparl/system
- Bundesstadt Bonn, Planung neuer ZOB am Hauptbahnhof: https://www.bonn.de/themen-entdecken/verkehr-mobilitaet/ZOB.php
- ADFC Bonn/Rhein-Sieg, aktueller Sachstand Straße Am Hauptbahnhof und Bauphasen-Radverkehr, 12.05.2026: https://bonn-rhein-sieg.adfc.de/pressemitteilung/adfc-sanierung-der-strasse-vor-dem-bonner-hauptbahnhof-verzoegert-sich-weiter-1
