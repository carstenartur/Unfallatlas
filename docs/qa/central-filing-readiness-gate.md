# Zentrales Gate für Einreichungsreife

## Zweck

Die KI darf ihre eigene Untersuchung nicht selbst zur einreichungsreifen Grundlage erklären. `unfallwerkbank.filingReadiness.v1` leitet den maßgeblichen Status lokal aus der reproduzierbaren Unfallwerkbank-Analyse und der strukturierten KI-Untersuchung ab.

Der Gate-Status unterscheidet:

- `analysisQaStatus`: methodische, visuelle, räumliche, Pattern- und Quellenqualität;
- `politicalResearchStatus`: belastbare politische/administrative Vorbefassung;
- `filingReadinessStatus`: strengstes Gesamtergebnis;
- `modelFilingReadinessStatus`: Selbsteinschätzung der KI, nur als mögliche Herabstufung.

Die KI kann `ready` niemals gegen ein lokales `conditional` oder `blocked` durchsetzen.

## Verbindliche Prüfungen

1. Alle vier Kartenmodi müssen mit den für den konkreten Analysesnapshot erzeugten URLs geöffnet worden sein.
2. Alle relevanten deterministischen Muster- und Datenqualitätsbefunde müssen bewertet sein. Dazu gehören auch `observed`, `warning`, `frequency-observed`, `blocking-data-issue` und `not-assessable`.
3. Evidenzreferenzen in Kartenbeobachtungen, Synthesen und Maßnahmen müssen auf tatsächlich protokollierte Karten, Pattern-Befunde oder Quellen auflösbar sein.
4. `results-found` ist nur mit direkt verlinkten Vorgängen oder Verwaltungsprojekten vollständig.
5. `searched-no-results` ist lediglich `conditional`; es beweist keine fehlende politische Vorbefassung.
6. Fehlgeschlagene, nicht gestartete oder nicht erreichbare politische Recherche blockiert die Antragserzeugung.
7. Ein bedingter Entwurf ist nur möglich, wenn keine Fehler vorliegen und die noch offenen Bedingungen sichtbar übernommen werden. `filingReady` wird ausschließlich bei vollständig grünem lokalen Gate gesetzt.

## Ergebnisverwendung

Die UI speichert Untersuchung, Validierung und Gate-Status gemeinsam im strukturierten Faktenpaket. Der zweite KI-Schritt erhält den lokalen Status, die Analyse-QA, die politische Recherche und die Modell-Selbsteinschätzung getrennt. Word-/PDF-Export und weitere Antragspfade können denselben Gate-Vertrag verwenden, statt eigene, widersprüchliche Freigaben abzuleiten.

## Regressionen

Die Tests decken insbesondere ab:

- exakte URL-Bindung aller Kartenmodi;
- politische Nulltreffer als bedingt statt fertig;
- behauptete politische Treffer ohne Quellenlink als Blocker;
- vollständige Abdeckung beobachteter und nicht beurteilbarer Muster;
- erfundene Evidenzreferenzen;
- Verbot einer Hochstufung durch das Modell.
