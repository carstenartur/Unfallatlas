# Strukturierte Unfallmuster-Erkennung als Plugin-Pipeline

## Ziel

Die Unfallwerkbank soll typische Unfallmuster **deterministisch, nachvollziehbar und erweiterbar erkennen, bevor eine KI die Befunde bewertet**. Die KI ist damit nicht der erste Detektor und nicht die Quelle amtlicher Tatsachen. Sie übernimmt anschließend Aufgaben, für die ein Sprach-/Bildmodell einen echten Mehrwert bietet:

- mehrere Befunde und Evidenzschichten zusammenführen;
- konkurrierende Erklärungen und Gegenhypothesen formulieren;
- Kartenansichten semantisch prüfen;
- externe Unfall-, Planungs- und politische Quellen recherchieren;
- Maßnahmen priorisieren und in einen kommunalen Prüf- oder Antragstext übersetzen.

## Ausgangslage

Es bestanden bereits mehrere fachlich wertvolle, aber getrennte Mechanismen:

- lokaler Anteil einer Beteiligungskombination gegenüber der stadtweiten Referenz;
- Schweregrad-, Jahres-, Stunden- und Fahrbahnzustandsauswertung;
- Heatmap, Punktcluster und Mehrjahrestrend;
- `UA.contextMeasures` mit einer festen Matrix aus Muster × Ortskontext;
- serverseitige `conflictPatterns.js` mit einer zweiten festen Liste von Konfliktmustern;
- die neue semantische Karten- und Unfallhintergrundrecherche.

Ohne gemeinsamen Vertrag drohen dabei doppelte Regeln, unterschiedliche Begriffe, nicht vergleichbare Konfidenzen und eine KI, die nur den jeweils zufällig übergebenen Teil sieht.

## Architekturentscheidung

Es wird **kein zweites Plugin-System** eingeführt. Die bereits vorhandene `UA.AnalysisPipeline` mit `DataRegistry`, Capability-Prüfung, Abhängigkeiten, Teilresultaten und Provenienz wird zur kanonischen Muster-Pipeline erweitert.

```text
Provider / Auswahlzustand
        │
DataRegistry
        │
Deterministische Detektor-Plugins
        │
patternDetection.v1
        │
KI-Verifikation und Synthese
        │
Maßnahmen, Prüfauftrag und Antrag
```

Die Detektoren dürfen weder DOM noch Leaflet noch konkrete Dateipfade benötigen. Fehlende optionale Daten führen zu `partial`, nicht zu erfundenen Ersatzbefunden.

## Gemeinsamer Befundvertrag

Jeder Befund entspricht `unfallwerkbank.patternFinding.v1` und enthält mindestens:

- stabile `id` und `patternId`;
- Detektor-ID und -Version;
- Musterfamilie;
- Klassifikation `primary`, `secondary` oder `data-quality`;
- Status wie `observed`, `candidate`, `warning` oder `blocking-data-issue`;
- getrennten Kausalstatus;
- numerische Konfidenz plus `high | medium | low`;
- untersuchte Teilmenge und räumlichen Geltungsbereich;
- Kennzahlen und konkrete Evidenzfelder;
- Begründung;
- Grenzen und Alternativerklärungen;
- erforderliche Verifikation.

### Kausalstatus

Die Pipeline trennt ausdrücklich:

1. `descriptive-association` – statistischer/deskriptiver Befund;
2. `spatial-association` – räumliche Übereinstimmung oder Morphologie;
3. `mechanism-candidate` – Infrastruktur und Unfallteilmenge ergeben einen konkreten Prüfmechanismus;
4. `mechanism-plausible` – Fahrlinie, Winkel oder weitere Evidenz stützen den Mechanismus;
5. `causally-confirmed` – Einzelfall-/Primärquelle oder belastbare Vor-Ort-Evidenz bestätigt ihn;
6. `not-assessable` – Daten reichen nicht aus.

Damit darf die Werkbank beispielsweise mehrere Fahrradalleinunfälle an einer Schiene ausdrücklich in Zusammenhang setzen, ohne eine noch nicht belegte Einzelfallursache zu behaupten.

## Erste integrierte Detektoren

### Datenkonsistenz

Prüft unter anderem:

- Gesamtzahl gegen Schweregradsumme;
- Gesamtzahl gegen Jahressumme;
- gekürzte Einzelunfalltabellen;
- Rohpunktzahl gegen strukturierte Auswahlzahl.

Ein fundamentaler Widerspruch setzt den Gesamtstatus auf `blocked-by-data-quality`.

### Beteiligungszusammensetzung

Verwendet den bestehenden methodisch korrekten lokalen/stadtweiten Anteilsvergleich mit:

- `locCnt`, `baseCnt`;
- `locR`, `baseR`;
- Faktor und Wilson-Intervall;
- `isSignificant`.

Nicht signifikante Abweichungen bleiben explizit explorativ. Die Rad-only-Maske wird nicht fälschlich als vollständige Einzelfallrekonstruktion ausgegeben.

### Unfallschwere

Erkennt tödliche Unfälle und einen hohen KSI-Anteil. Kleine Fallzahlen begrenzen die Sicherheit der Interpretation, nicht die amtliche Existenz der dokumentierten Ereignisse.

### Zeit- und Umweltmuster

Erkennt zunächst:

- kanonischen Mehrjahrestrend;
- Konzentration in einem Drei-Stunden-Fenster;
- erhöhten Anteil bei nasser oder glatter Fahrbahn;
- ungewöhnlich hohen Wochenendanteil.

### Räumliche Morphologie

Unterscheidet:

- dominanten lokalen Teilcluster;
- linearen Korridor statt reinem Punktproblem;
- dieselben Strukturen gesondert für die Rad-only-/Fahrradalleinunfall-Teilkohorte.

Für große Punktmengen degradiert die teure exakte 35-m-Komponentenanalyse transparent auf `partial`.

### Muster × Infrastruktur-/Ortskontext

Die erste Kombinationsebene erzeugt konkrete, aber vorsichtige Mechanismuskandidaten:

- Fahrradalleinunfälle × Schiene/Gleisquerung;
- Fahrradalleinunfälle × problematischer Belag;
- Fuß-/Radkonflikt × Schule/Kita;
- vulnerable Verkehrsmuster × Bahnhof/Busbahnhof/ÖPNV.

Eine bloße Ko-Präsenz im Auswahlraum ist ausdrücklich kein Kausalnachweis. Beim Schienenmuster werden deshalb als nächste Schritte Punkt-Schiene-Abstand, befahrbare Schienenachse, Fahrlinie, Parallelfahrt/Querung, Kurve, Weiche und Querungswinkel verlangt.

## Übergabe an die KI

Der aggregierte Vertrag `unfallwerkbank.patternDetection.v1` enthält:

- alle Befunde;
- Zusammenfassung nach Familie und Priorität;
- Status jedes Detektors;
- fehlende optionale Daten und Warnungen;
- einen verbindlichen KI-Auswertungsvertrag.

Die KI muss jeden primären und jeden Kandidatenbefund als

- bestätigt,
- präzisiert,
- widerlegt oder
- offen

klassifizieren. Sie darf deterministische Evidenz nicht stillschweigend verwerfen und fehlende Geometrie-/Expositionsdaten nicht durch freie Spekulation ersetzen.

Für die bestehende serverseitige KI bleibt während der Migration eine Kompatibilitätsbrücke erhalten: Die wichtigsten Plugin-Befunde, Kennzahlen und Prüfaufträge werden zusätzlich in `structured.contextualMeasures` gespiegelt. Das vollständige Faktenpaket enthält parallel den neuen strukturierten Vertrag.

## Erweiterung um weitere typische Muster

Neue Muster sollen als kleine, unabhängig testbare Plugins ergänzt werden. Priorisierte nächste Familien:

1. **Knoten- und Fahrmanöver**: Abbiegen, Einbiegen/Kreuzen, Fahrstreifenwechsel, Kreisverkehr, Grundstücks- und Lieferzufahrten.
2. **Radverkehr**: Dooring, Radwegende, Seitenwechsel, Gegenrichtung, Schiene, Bord-/Rinnenkontakt, Gefälle/Kurve, Ausweichsturz.
3. **Fußverkehr**: Wunschlinien, Haltestellenquerung, Sichtabschattung, Kinder-/Seniorenumfeld, mehrstreifige Querung.
4. **ÖPNV und Schwerverkehr**: Bussteig/Fahrgasse, Haltestellenkap, Lkw-Abbiegen, Lieferzeiten, Rückwärtsbewegungen.
5. **Umwelt und Betrieb**: Dunkelheit, Blendung, Nässe, Winterglätte, Baustellenphasen, Veranstaltungsspitzen.
6. **Netz- und Exposition**: Unfallzahl je Verkehrsleistung, Straßenlänge oder Schienenkontaktstrecke, sobald belastbare Nenner verfügbar sind.
7. **Vorher/Nachher**: Infrastrukturänderung oder Maßnahme gegen zeitlich und räumlich passende Kontrollbereiche.
8. **Datenqualitätsmuster**: Koordinatenversatz, wechselnde Kodierung, fehlende Jahre, ungewöhnliche Attributausfälle.

## Plugin-Beispiel

```javascript
const detector = UA.AnalysisPipeline.createPlugin({
  id: 'pattern-bike-rail-geometry',
  requiredData: ['accidents', 'railGeometry'],
  optionalData: ['cycleNetwork', 'orthophotoObservations', 'officialIncidentReports'],
  requiredCapabilities: ['hasAccidentData', 'hasRailData'],
  optionalCapabilities: ['hasSurfaceData', 'hasMapSnapshot'],
  producedArtifacts: ['patternFindings.bikeRailGeometry'],
  supportsPartialData: true,
  run(context) {
    // Pure, deterministic geometry analysis.
    // Return findings, warnings, confidence, completeness and provenance.
  }
});
```

## Fachliche Leitregel

Nicht jede typische Unfallursache lässt sich aus den veröffentlichten Unfallatlasattributen direkt erkennen. Die strukturierte Pipeline soll deshalb weder zu wenig noch zu viel behaupten:

- **sichtbare/statistische Zusammenhänge benennen**;
- **Mechanismen als prüfbare Hypothesen operationalisieren**;
- **Bestätigung nur bei entsprechender Evidenz vergeben**;
- **fehlende Daten als konkreten nächsten Prüfschritt ausgeben**.
