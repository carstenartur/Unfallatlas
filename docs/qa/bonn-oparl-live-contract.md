# Bonn: produktionsnaher OParl-/RIS-Evidenzvertrag

Stand: 8. November 2026

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

## Quellenreihenfolge des Produktionsproviders

Der Bonner Provider verwendet diese Reihenfolge. Die nachfolgende öffentliche
OParl-Abnahme gibt HTML-Zugriffsschranken ausdrücklich nicht frei:

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

Der Workflow **Bonn political context live QA** nutzt ausschließlich das
Maven-Profil `bonn-oparl-live` und die exakt ausgewählte Datei
`tests/unit/bonnPoliticalContextLive.test.js`. Die normale vollständige Unit-CI
bleibt unverändert. Die Live-Flags gelten nur für diese ausgewählte
npm-Ausführung, nicht mehr für alle Unit-Tests des Reaktors.

Für eine gesondert autorisierte öffentliche Abnahme:

```sh
# Begrenzter öffentlicher OParl-Ausschnitt (Profilstandard):
mvn -B -ntp -N test -Pbonn-oparl-live -Dbonn.oparl.scope=snapshot
# Vollständige öffentliche OParl-Archivabnahme, nur explizit autorisiert:
mvn -B -ntp -N test -Pbonn-oparl-live -Dbonn.oparl.scope=archive
```

Die Live-Flags dürfen nicht global für einen breiten Unit-Lauf gesetzt werden.
Maven lehnt andere Scope-Werte bereits bei `validate` ab. `-N` begrenzt den
Aufruf auf das Root-Projekt. Pull Requests wählen `snapshot`; geplante und
manuelle Workflow-Läufe wählen ausdrücklich `archive`. Das Profil installiert
weiterhin die gepinnte Node-/npm-Umgebung über den bestehenden Maven-Lebenszyklus.

Der Snapshot-Lauf erzeugt aus höchstens zwei öffentlichen Paper-Seiten einen
Ratsdatenindex, prüft die Prüfsumme und sucht eine eingelesene Drucksache.
Treffer bleiben `partial-results`, ein fehlender Treffer bleibt `incomplete`.
Ein Abruf ohne nutzbare Vorgänge wird einmal wiederholt.

Der Archivlauf bewahrt die vollständigen bestehenden Adenauerallee-/Radverkehr-
und Direktlink-Prüfungen. Im selben Prozess folgen eine unterschiedliche
parallele Suche und eine unterschiedliche warme Suche. Der äußere Query-Cache
bleibt dabei aus. Das Artefakt weist echte monotone Dauern, Quellenzeit,
`miss/coalesced/hit`, Seiten-/Vorgangszähler und unabhängig gezählte Transport-
aufrufe aus. Ein warmer oder koaleszierter Aufruf darf kein neues HTTP auslösen.
Ein kalter, vollständiger Archivaufbau wird dadurch nicht als schnelle
interaktive Suche bezeichnet.

**HTML-Gate-, ALTCHA-/Solve- und sonstige HTML-Discovery-Probes sind kein Teil
dieser öffentlichen OParl-Abnahme.** Sie werden weder ausgeführt noch als deren
Artefakte hochgeladen. Eine sichtbare Zugriffsschranke wird nicht automatisiert
umgangen. Der Snapshot-QA-Transport einschließlich Wiederholung und der kalte
Archiv-QA-Transport verwenden denselben Guard und erlauben ausschließlich den offiziellen
HTTPS-Origin `https://www.bonn.sitzung-online.de` und Pfade unter `/oparl/`.
Auch Weiterleitungen und Node-URL-/Options-Überladungen werden vor dem Aufruf
geprüft. HTML-/Gate-/Fremdhost-Versuche werden vor der Übertragung blockiert,
als fehlgeschlagene Evidenz gespeichert und niemals als abgeschlossene
Nulltreffersuche gewertet. Der Produktionsprovider selbst wird nicht umgebaut.
Auch wenn der Snapshot-Collector nach einem blockierten Redirect noch öffentliche
OParl-Vorgänge findet, bleibt die Abnahme fehlgeschlagen. Das Snapshot-Artefakt
hält den Fehler und die erlaubten beziehungsweise blockierten Transportzähler fest;
alle vier HTTP-/HTTPS-Transportfunktionen werden auch im Fehlerfall wiederhergestellt.

Das Workflow-Artefakt enthält ausschließlich die jeweils erzeugte
`bonn-political-context-live.json` beziehungsweise `bonn-ris-snapshot-live.json`.
Der frühere Lauf #131 / `42504123331` verwendete noch die breitere alte
Unit-Ausführung und enthält auch Gate-/Solve-Probes. Sein tatsächlicher
Archivnachweis und seine kalte Dauer von 618,925 Sekunden bleiben historische
Evidenz; er ist kein Nachweis und keine Aufrufvorlage für die neue isolierte
Abnahme.

Der Archivlauf behält maximal 300 Seiten mit höchstens 100 Vorgängen, 20 Minuten
Prozessbudget und 25 Minuten Jobbudget. Eine erfolgreiche kalte Suche mit
fehlgeschlagenem Cache-Nachweis wird nicht für einen Reparaturversuch erneut
vollständig abgerufen. Deterministische Tests prüfen weiterhin Paginierung,
Host-/Transportgrenzen, Cache-/Quellenzeit und unvollständige Nulltreffer.

## KI-/Antragsübergabe

Ältere reale Browser-Faktenpakete enthielten `searchTerms`, Portal-URLs und
Referenzen, aber kein Feld `queries`. Der serverseitige Mehrwertvertrag erwartet
ein dokumentiertes Suchprotokoll. Die Evidenzbrücke normalisiert deshalb echte
Laufzeitdaten additiv in `queries`, ohne einen Status hochzustufen. Ungeeignete
oder durch das deterministische Traffic-/AI-Gate verworfene Treffer werden
nicht als politische Evidenz übernommen.
