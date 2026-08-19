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
4. Kartenbeobachtungen dürfen nicht sich selbst oder ausschließlich andere Kartenbeobachtungen als Beleg verwenden.
5. Schichtenübergreifende Einsichten benötigen mindestens zwei tatsächlich verschiedene Evidenzschichten. Mehrere IDs oder Aliasse derselben Karte beziehungsweise desselben Pattern-Detektors zählen nicht mehrfach.
6. Maßnahmen dürfen in `findingRefs` nur auf echte Karten-, Pattern- oder Synthesebefunde verweisen; eine rohe Kartenressource ist kein Maßnahmenbefund.
7. `results-found` ist nur mit mindestens einem absoluten HTTP(S)-Direktlink zu einem Vorgang oder Verwaltungsprojekt vollständig. Freitext, relative Pfade und andere Protokolle gelten nicht als verlinkte Evidenz.
8. Politische Suchspuren müssen strukturiert Suchbegriff und Quelle, Provider, Portal oder absolute Portal-URL enthalten. Eine Stringliste belegt keine reproduzierbare Recherche.
9. `completed` oder `complete` kann nicht allein durch die KI-Felder `manualVerificationCompleted` oder `alternativeVerificationCompleted` freigeschaltet werden.
10. `searched-no-results` ist lediglich `conditional`; es beweist keine fehlende politische Vorbefassung.
11. Fehlgeschlagene, nicht gestartete oder nicht erreichbare politische Recherche blockiert die Antragserzeugung.
12. Ein bedingter Entwurf ist nur möglich, wenn keine Fehler vorliegen und die noch offenen Bedingungen sichtbar übernommen werden. `filingReady` wird ausschließlich bei vollständig grünem lokalen Gate gesetzt.

## Gemeinsamer Maschinenvertrag

`schemas/ai-investigation-result.schema.json` veröffentlicht denselben Mindestvertrag wie das lokale Gate:

- strukturierte politische Suchobjekte statt freier Stringlisten,
- HTTP(S)-Direktlinks für politische Vorgänge und Projekte,
- nicht leere und eindeutige Evidenzreferenzen,
- mindestens zwei Referenzen für schichtenübergreifende Einsichten,
- mindestens ein Befundverweis je Maßnahmenkandidat.

Das JSON-Schema beschreibt die Form. Das lokale Gate prüft zusätzlich Auflösbarkeit, Snapshotbindung, Schichtzugehörigkeit und Statussemantik; ein schemaformal gültiges Objekt ist deshalb noch nicht automatisch einreichungsreif.

## Ergebnisverwendung

Die UI speichert Untersuchung, Validierung und Gate-Status gemeinsam im strukturierten Faktenpaket. Der zweite KI-Schritt erhält den lokalen Status, die Analyse-QA, die politische Recherche und die Modell-Selbsteinschätzung getrennt. Word-/PDF-Export und weitere Antragspfade können denselben Gate-Vertrag verwenden, statt eigene, widersprüchliche Freigaben abzuleiten.

## Regressionen

Die Tests decken insbesondere ab:

- exakte URL-Bindung aller Kartenmodi;
- politische Nulltreffer als bedingt statt fertig;
- behauptete politische Treffer ohne verifizierbaren HTTP(S)-Link als Blocker;
- fehlende oder nur als String gelieferte Suchspuren;
- vollständige Abdeckung beobachteter und nicht beurteilbarer Muster;
- erfundene, leere oder zirkuläre Evidenzreferenzen;
- Mehrfachzählung derselben Evidenzschicht;
- Maßnahmenverweise auf rohe Ressourcen statt Befunde;
- Drift zwischen lokalem Gate und veröffentlichtem JSON-Schema;
- Verbot einer Hochstufung durch das Modell.
