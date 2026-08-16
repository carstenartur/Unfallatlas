# Zurückgezogene Erstbewertung der KI-Übergabe

**Ursprüngliche Prüfung:** 15. August 2026  
**Korrektur:** 16. August 2026  
**PR:** #620

Diese Datei bleibt als nachvollziehbarer Korrekturvermerk bestehen. Die frühere Bewertung darf **nicht** mehr als aktuelle QA des Prüffalls verwendet werden.

## Warum die Erstbewertung zurückgezogen wurde

Die erste Prüfung enthielt zwei grundlegende Fehler:

1. Sie missverstand den Anteilvergleich der Beteiligungsmuster als direkten Vergleich absoluter lokaler und stadtweiter Unfallraten. Tatsächlich berechnet die Unfallwerkbank `locR = locCnt / local.total`, `baseR = baseCnt / baseline.total`, den Quotienten `factor = locR / baseR` sowie ein Wilson-95-%-Intervall und `isSignificant`.
2. Sie übernahm den Reverse-Geocoding-Treffer des Auswahlmittelpunkts „Adenauerallee“ als Bezeichnung des gesamten Untersuchungsraums. Die Karten- und Bounds-Evidenz zeigt dagegen einen Bereich rund um Bonn Hauptbahnhof, Münsterplatz, Maximilianstraße und Thomas-Mann-Straße.

Damit waren sowohl die statistische Kritik als auch die darauf aufbauende politische Adenauerallee-Recherche für den realen Prüffall nicht belastbar.

## Verbindliche Nachfolgedokumente

Die korrigierte Methodenprüfung steht in:

- `docs/qa/ai-methodology-contract-regression-2026-08-16.md`

Der tatsächliche Vergleich von deterministischer Unfallwerkbank-Analyse und KI-gestützter Aufbereitung steht in:

- `docs/qa/ai-analysis-comparison-2026-08-16.md`

Dort werden die amtlichen Unfalltatsachen und die reproduzierbaren Berechnungen als verbindliche Baseline behandelt. Die KI muss darüber hinaus einen messbaren Mehrwert liefern: quellengebundene Synthese, Priorisierung, Gegenhypothesen, politische und administrative Anschlussfähigkeit, Maßnahmen mit Voraussetzungen und Zielkonflikten sowie eine explizite Delta-Liste gegenüber dem deterministischen Bericht.
