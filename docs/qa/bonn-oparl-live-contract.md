# Bonn: produktionsnaher OParl-/RIS-Evidenzvertrag

Stand: 7. November 2026

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
   `https://www.bonn.sitzung-online.de/oparl/system`; falls dieses Discovery-
   Dokument vorübergehend nicht nutzbar ist, über die amtliche Paper-Sammlung
   `https://www.bonn.sitzung-online.de/oparl/bodies/1/papers`.
2. Moderne amtliche Portalsuche unter
   `https://www.bonn.sitzung-online.de/public/tr010`.
3. Historischer Bonner Bürgerinfo-Endpunkt als dokumentierter HTML-Fallback.

Die OParl-Implementierung folgt `System → Body → Paper` und unterstützt externe
Objektlisten. Die reale Bonner Paper-Sammlung ignoriert derzeit `limit`, erkennt
aber den Spring-kompatiblen Parameter `size` bis maximal 100. Der Client sendet
deshalb den OParl-Parameter `limit` und den beobachteten Alias `size`, liest den
amtlichen `last`-Link und durchläuft die Sammlung von den neuesten Seiten über
`prev` rückwärts. Importierte `created`-Zeitstempel sind für historische
Vorgänge nicht belastbar; das fachliche Zeitfenster wird daher lokal anhand von
`Paper.date` beziehungsweise ersatzweise `Paper.modified` geprüft.
`omit_internal` wird bei Paper-Abfragen bewusst nicht gesetzt, damit Orts- und
Dateimetadaten für die lokale Evidenzsuche erhalten bleiben. Ein am Seitenlimit
abgeschnittener Lauf wird als `partial-results` oder `incomplete` gekennzeichnet
und niemals als abgeschlossene Nulltreffersuche.

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

Der Workflow **Bonn political context live QA** prüft den amtlichen Bonner Dienst
über den kanonischen Maven-Build. In Pull Requests erzeugt er aus bis zu zwei
Paper-Seiten am Ende des Archivs einen Ratsdatenindex, prüft dessen Prüfsumme
und sucht nach einer eingelesenen Drucksache. Die Treffer tragen den Status
`partial-results`. Eine Suche ohne Treffer im Teilbestand liefert `incomplete`.
Ein Abruf ohne nutzbare Vorgänge wird einmal wiederholt.

Geplante und manuell gestartete Läufe prüfen die vollständige Archivsuche.

- Der OParl-Lauf wird erfolgreich abgeschlossen oder ein amtlicher Fallback
  ergänzt den dokumentierten partiellen OParl-Lauf vollständig.
- Das Suchprotokoll dokumentiert die Abfragen reproduzierbar und enthält für
  `Adenauerallee` und `Radverkehr` jeweils mindestens einen Treffer.
- Die Treffer führen direkt zu amtlichen Bonner Seiten. Das JSON-Protokoll
  wird als Workflow-Artefakt gespeichert.

Der Archivlauf erlaubt bis zu 300 Seiten zu jeweils höchstens 100 Vorgängen.
Für den Abruf gelten 20 Minuten Prozessbudget wie beim Datenimport und 25 Minuten
für den gesamten CI-Job. Das Prozessbudget schließt höchstens einen
Wiederholungsversuch mit Wartezeit ein. Deterministische Unit-Tests prüfen
Paginierung, Deduplizierung, Hostbeschränkung, Fallbackreihenfolge und die
Unterscheidung zwischen Nulltreffer und Providerfehler.

## KI-/Antragsübergabe

Ältere reale Browser-Faktenpakete enthielten `searchTerms`, Portal-URLs und
Referenzen, aber kein Feld `queries`. Der serverseitige Mehrwertvertrag erwartet
ein dokumentiertes Suchprotokoll. Die Evidenzbrücke normalisiert deshalb echte
Laufzeitdaten additiv in `queries`, ohne einen Status hochzustufen. Ungeeignete
oder durch das deterministische Traffic-/AI-Gate verworfene Treffer werden
nicht als politische Evidenz übernommen.
