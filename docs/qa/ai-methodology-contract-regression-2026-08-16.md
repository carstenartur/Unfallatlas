# Regressionstest: Statistikvertrag Unfallwerkbank → KI

**Datum:** 16. August 2026  
**Bezug:** PR #620, Issue #622  
**Status:** fokussierter Produktionsformat-Test bestanden; vollständiger Modell-End-to-End-Test mit dem real erzeugten Adenauerallee-Faktenpaket bleibt gesondert nachzuweisen.

## Anlass

Die erste KI-QA des Adenauerallee-Falls interpretierte die lokalen und stadtweiten Gesamtzahlen fälschlich als direkten Vergleich absoluter Unfallraten unterschiedlich großer Räume. Diese Interpretation widerspricht der implementierten Unfallwerkbank-Methodik:

- `topDeviations()` vergleicht lokale und stadtweite **Anteile von Beteiligungskombinationen**;
- `local.total` und `baseline.total` sind Stichprobenumfänge/Nenner dieser Anteilsberechnung;
- der Faktor ist `locR / baseR`;
- die Unsicherheit des lokalen Anteils wird durch ein Wilson-95-%-Intervall ausgedrückt;
- `isSignificant` gilt, wenn `ciLow > baseR`;
- der Mehrjahrestrend wird innerhalb desselben Bereichs über relative Steigung und R² klassifiziert.

## Zusätzlich gefundener Integrationsfehler

Der reale Export verwendet für Musterabweichungen insbesondere:

- `locCnt`
- `baseCnt`
- `locR`
- `baseR`
- `factor`
- `ciLow`
- `ciHigh`
- `isSignificant`

Die bisherige serverseitige Feature-Ableitung erwartete in ihren synthetischen Fixtures dagegen vor allem `localCount` und `relativeDiff` sowie teilweise `localCnt`. Das reale Feld `locCnt` wurde nicht zuverlässig gelesen; Faktor, Anteile, Konfidenzintervall und Signifikanz wurden nicht vollständig an die KI weitergereicht. Dadurch konnte ein realer Mustervergleich im KI-Pfad zu einer bloßen lokalen Häufigkeitsliste degradiert werden.

Die Feature-Ableitung akzeptiert nun das Produktionsformat, bewahrt alle genannten Kennzahlen und kennzeichnet einen Cross-Table-Fallback ausdrücklich als reine lokale Häufigkeitsrangfolge ohne Lokal-vs.-Referenz-Aussage.

## Eingeführter Methodenvertrag

Beide KI-Wege erhalten nun ausdrücklich:

```text
locR = locCnt / local.total
baseR = baseCnt / baseline.total
factor = locR / baseR
```

Zusätzlich:

- Wilson-95-%-Intervall des lokalen Anteils;
- Bedeutung von `isSignificant`;
- klare Abgrenzung zwischen Musterzusammensetzung und absoluter Unfallrate je Exposition;
- Trendformel `relativeSlope = slope / mean(yearly totals)`;
- R², Zahl der Datenjahre und Klassifikation;
- Negativregel: Für den Musteranteilsvergleich nicht pauschal Fläche, Straßenlänge oder Verkehrsleistung als Nenner verlangen;
- Expositionsdaten nur für ausdrücklich beabsichtigte Aussagen über absolutes Risiko oder Unfallraten je Verkehrsleistung verlangen.

## Fokussierte Produktionsformat-Fixture

Der neue Test `tests/unit/aiAnalysisMethodologyContract.test.js` verwendet die echten Feldnamen und prüft zwei bewusst unterschiedliche Fälle:

### Statistisch abgesichertes Beispiel

- lokal: `8 / 37 = 21,62 %`
- Referenz: `150 / 1.963 = 7,64 %`
- Faktor: `2,83`
- Wilson-Intervall lokal: `11,2–38,5 %`
- `isSignificant = true`, weil die untere Intervallgrenze über dem Referenzanteil liegt.

Erwartete KI-Einordnung: anteilige Überrepräsentation nach der implementierten Regel; kein Einwand wegen fehlender Flächen- oder Verkehrsleistungsnormierung.

### Exploratives Beispiel

- lokal: `4 / 37 = 10,81 %`
- Referenz: `150 / 1.963 = 7,64 %`
- Faktor: `1,41`
- Wilson-Intervall lokal: `4,3–24,7 %`
- `isSignificant = false`, weil die untere Intervallgrenze unter dem Referenzanteil liegt.

Erwartete KI-Einordnung: explorative Abweichung, nicht als statistisch abgesicherte Überrepräsentation oder gesicherter Schwerpunkt formulieren.

### Trendbeispiel

Jahreswerte: `6, 8, 5, 2, 2, 9, 5`

- Mittelwert: `37 / 7 = 5,29`
- absolute Steigung: rund `−0,14 Unfälle/Jahr`
- relative Steigung: rund `−2,7 % des Jahresmittels pro Jahr`
- R²: `0,01`
- Klassifikation: `stagnierend`

Damit wird geprüft, dass die KI die relative Entwicklung innerhalb desselben Bereichs interpretiert und keinen stadtweiten oder expositionsbezogenen Nenner für diese deskriptive Trendklassifikation erfindet.

## Geprüfte Verträge

Der fokussierte Test sichert:

1. Produktionsfelder gehen nicht verloren.
2. Serverprompt enthält Formeln, Stichproben, Wilson-Intervall und Signifikanzstatus.
3. Signifikante und explorative Muster werden sprachlich getrennt.
4. Der kanonische Trend enthält relative Steigung und R².
5. Der nutzerseitige Faktenexport enthält den Methodenvertrag auf oberster Ebene.
6. Ein ausdrückliches QA-Gate verwirft Antworten, die den Anteilsvergleich als direkten Vergleich absoluter Unfallraten missverstehen.

## Aussagekraft und Grenze

Dieser Regressionstest beweist, dass Code und Prompt die Methodik nun korrekt und vollständig transportieren. Er ersetzt nicht den noch ausstehenden erneuten Modell-End-to-End-Test mit dem **real aus der Unfallwerkbank erzeugten Adenauerallee-Faktenpaket einschließlich seiner tatsächlichen `deviations`-Werte**. Der frühere Modelllauf darf wegen seines methodischen Missverständnisses nicht als Qualitätsnachweis verwendet werden.
