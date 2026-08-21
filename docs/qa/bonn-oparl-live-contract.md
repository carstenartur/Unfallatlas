# Bonn: produktionsnaher OParl-/RIS-Evidenzvertrag

Stand: 21. August 2026

## Ziel

Die politische Kontextrecherche für Bonn muss zwischen drei grundsätzlich
verschiedenen Ergebnissen unterscheiden:

1. Ein amtlicher Quellenpfad wurde vollständig durchsucht und lieferte Treffer.
2. Ein amtlicher Quellenpfad wurde vollständig durchsucht und lieferte keine Treffer.
3. Kein vorgesehener Quellenpfad konnte vollständig abgearbeitet werden.

Nur Fall 2 darf als `searched-no-results` erscheinen. Fall 3 ist ein
Providerfehler beziehungsweise eine unvollständige Recherche und blockiert die
Einreichungsreife. In keinem Fall ist „keine Treffer“ ein Beleg dafür, dass es
keine politische Vorbefassung gibt.

## Quellenreihenfolge

Der Bonner Provider verwendet diese Reihenfolge:

1. **OParl 1.1** über das amtliche Systemobjekt
   `https://www.bonn.sitzung-online.de/public/oparl/system`.
2. Moderne amtliche Portalsuche unter
   `https://www.bonn.sitzung-online.de/public/tr010`.
3. Historischer Bonner Bürgerinfo-Endpunkt als dokumentierter HTML-Fallback.

Die OParl-Implementierung folgt `System → Body → Paper`, unterstützt externe
Objektlisten und `links.next`, verwendet die standardisierten Filter
`created_since`, `omit_internal` und `limit` und begrenzt den Lauf bewusst. Ein
abgeschnittener Listenlauf wird als `partial-results` oder `incomplete`
gekennzeichnet und niemals als abgeschlossene Nulltreffersuche.

## Sicherheits- und Evidenzregeln

- Netzwerkabrufe und Weiterleitungen bleiben auf amtliche Bonner
  Ratsinformations-Hosts beschränkt.
- Direkte Evidenzlinks müssen absolute HTTP(S)-URLs auf amtlichen Bonner Domains
  sein.
- Jeder ausgeführte Suchbegriff erhält einen Eintrag in `meta.queryLog` mit
  Quelle, Quellentyp, URL und Status.
- `meta.attempts` hält auch fehlgeschlagene OParl-/HTML-Pfade fest.
- `meta.pagesFetched`, `meta.scannedItems` und `meta.truncated` dokumentieren die
  Vollständigkeit des strukturierten Laufs.
- Bestehende Array-Provider bleiben kompatibel; evidenzfähige Provider können
  `{ results, meta }` zurückgeben.

## Live-QA

Der Workflow **Bonn political context live QA** führt die reale Suche gegen den
amtlichen Bonner Dienst aus. Er verlangt:

- einen erfolgreich nutzbaren OParl-Lauf oder einen dokumentierten partiellen
  OParl-Lauf mit anschließend vollständig abgearbeitetem amtlichen Fallback,
- ein nicht leeres reproduzierbares Suchprotokoll,
- mindestens einen Treffer für die stabilen Prüfterme `Adenauerallee` und
  `Radverkehr`,
- direkte amtliche Bonner Links,
- ein als Workflow-Artefakt gespeichertes JSON-Protokoll.

Die Netzprüfung wird mehrfach mit begrenztem Backoff versucht. Sie ersetzt
keine deterministischen Unit-Tests; diese prüfen Paginierung, Deduplizierung,
Hostbeschränkung, Fallbackreihenfolge und die Unterscheidung zwischen
Nulltreffer und Providerfehler ohne externes Netz.

## KI-/Antragsübergabe

Ältere reale Browser-Faktenpakete enthielten `searchTerms`, Portal-URLs und
Referenzen, aber kein Feld `queries`. Der serverseitige Mehrwertvertrag erwartet
ein dokumentiertes Suchprotokoll. Die Evidenzbrücke normalisiert deshalb echte
Laufzeitdaten additiv in `queries`, ohne einen Status hochzustufen. Ungeeignete
oder durch das deterministische Traffic-/AI-Gate verworfene Treffer werden
nicht als politische Evidenz übernommen.
