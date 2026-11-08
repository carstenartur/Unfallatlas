# Gemeinsame Ratsdatenkataloge

Bonn und Hannover verwenden denselben Erneuerungs-, Veröffentlichungs- und Lesepfad.
Ein Stadtadapter erschließt die jeweilige amtliche Quelle; räumliche Zuordnung,
Speicherformat, Recherche, Kartenanzeige und Berichtszitate sind gemeinsam.
Eine weitere Stadt benötigt keinen eigenen Karten- oder Dateileser. Ein Berlin-Adapter
ist nicht Bestandteil dieses Ausbaus.

## Dokumentenbestand und Karte

Der vollständige importierte Bestand enthält auch Vorgänge ohne sicher zuordenbaren Ort.
Sie bleiben nach Titel, Drucksachennummer und Ortsangaben durchsuchbar, mit ihren
amtlichen Links, Ortsprüfungen und Beziehungen. Die Karte lädt diese Datensätze erst,
wenn eine angeforderte Detail- oder Beziehungsseite sie benötigt.

Das gilt auch innerhalb eines einzelnen Vorgangs: Ein belegter Straßenabschnitt macht
eine weitere, ungeklärte Ortsangabe nicht automatisch verortbar. Amtliche Geometrien
bleiben unabhängig von abgeleiteten `locations` erhalten. Deshalb wird die Zugehörigkeit
zur Karte anhand der tatsächlich vorhandenen Geometrie bestimmt.

Version 2 trennt diese Zugriffsarten:

| Index | Inhalt | Normaler Ladezeitpunkt |
|---|---|---|
| `records` | Stammdaten und Prüfstatus jedes Vorgangs | Suchtreffer oder geöffnete Detailseite |
| `locations` | Ortsbelege mit stabiler Identität und optionalem Geometrieverweis | Ortsliste eines Vorgangs |
| `search` | Begriff und seitenweise Trefferverweise | Recherche |
| `relations` | Zusammengehörige Vorgänge, einschließlich Rückverweisen | Angeforderte Beziehungsseite |
| `geometry` | Einmal gespeicherte Geometrie mit Darstellungsmerkmalen und Anzahl | Passender Kartenausschnitt oder gezielter Ort |
| `links` | Zuordnung zwischen Geometrien, Vorgängen und Ortsbelegen | Geöffnete Kartenstelle |
| `spatial` | Räumliche Verweise und ausdrücklich gekennzeichnete Übersichtszellen | Kartenausschnitt |

Ein historischer Vorgang behält seine ID, wenn sich Jahrpartition, räumlicher Ausschnitt
oder Reihenfolge ändert. Derselbe Straßenverlauf wird nur einmal als Geometrie gespeichert.
Amtliche und abgeleitete Zuordnungen desselben Verlaufs behalten ihre jeweiligen Belege;
die gemeinsame Darstellung kennzeichnet gemischte Herkunft.

## Begrenzte Dateien und Abfragen

Das Manifest enthält nur Wurzelverweise, Quellen, Zeit- und Abdeckungsangaben sowie Summen.
Auch die Verzeichnisse der Teilbestände sind begrenzt: Ein Indexknoten enthält höchstens
64 Einträge und 256 KiB unkomprimierte JSON-Daten. Wachsende Bestände erzeugen zusätzliche
Blätter und Verzeichnisebenen, keine immer größere globale ID-, Begriffs- oder Kachelliste.
Listen haben höchstens 64 Einträge pro Seite und können wegen der Bytegrenze kleiner sein.
Eine Folgeseite ist ausdrücklich adressierbar.

Alle Teile sind komprimierte JSON-Dateien mit SHA-256 im Dateinamen. Leser prüfen
Dateiname, Größe, Inhaltshash, Indexstruktur und verwendeten Datenstand. Dateien sind
unveränderlich; die Veröffentlichung ersetzt das Manifest erst, wenn alle referenzierten
Teile vorhanden und validiert sind. Suche, Karte und Bericht dürfen keine unterschiedlichen
Generationen miteinander vermischen.

Ein Kartenausschnitt darf für Details bis zu 3 MiB unkomprimierte Teilbestände und
128 unterschiedliche Dateien lesen. Reicht dieses Budget nicht, wird eine räumliche
Übersicht mit einem weiteren Budget von 1 MiB verwendet. Zellen sind als Zusammenfassung
gekennzeichnet und ermöglichen das Näherzoomen. Sie werden nicht als genaue Punktlagen
von Dokumenten ausgegeben. Linien, Straßenabschnitte und mehrteilige Geometrien bleiben
in allen geschnittenen Kacheln auffindbar.

Der gemeinsame Leser begrenzt gleichzeitige Dateianfragen und seinen Cache nach
unkomprimierten Bytes. Die Module `ua.spatial-grid.js` und `ua.data-budget.js` werden auch
von der vorhandenen Unfall- und Straßenkontextlogik verwendet. Die drei Datenarten behalten
ihre jeweiligen Fachdatenmodelle.

Fehlende oder beschädigte Dateien führen zu einem sichtbaren Fehler beziehungsweise
einem als unvollständig bezeichneten Ergebnis. Sie bedeuten nicht, dass es keine
Vorgänge im Ausschnitt oder zur Suchanfrage gibt. Auch ein verspätet abgeschlossener
Abruf darf keine inzwischen gewechselte Stadt oder neuere Kartenansicht überschreiben.

Die Bytegrenze gilt ebenfalls für einzelne Einträge: Ein Eintrag über 261.120 Bytes kann
nicht unverändert in ein Blatt geschrieben werden. Der Produzent bricht die neue
Veröffentlichung dann mit einer konkreten Fehlermeldung ab; der vorherige gültige
Bestand bleibt verfügbar. Es erfolgt keine stillschweigende Kürzung oder ungeprüfte
Vereinfachung der Geometrie. Außergewöhnlich große einzelne Quellgeometrien benötigen
eine zusätzliche Geometrieaufteilung. Diese Grenze ist von der früheren Obergrenze
für den gesamten Stadtbestand zu unterscheiden.

## Gemeinsamer Zugriff für den Index

Der Offline-Einstiegspunkt bleibt für beide Städte gleich:

```js
const { readRisSnapshot } = require('./server/political-context/services/risSnapshot');
const { manifest, records, features } = await readRisSnapshot('./data/ris', 'hannover');
```

Er erkennt die Formatversion, prüft alle Teile und rekonstruiert die kanonischen
Vorgänge und Kartenobjekte. Für Bonn wird nur der Stadtparameter geändert.
Ein vollständiger Indeximport verarbeitet dabei weiterhin den gesamten Bestand;
die sparsame Kartenanzeige verwendet die einzelnen Abrufmethoden des gemeinsamen
Browserlesers. Verbraucher sollten die Formatentscheidung diesem Leser überlassen
und keine festen Dateinamen für eine einzelne Stadt voraussetzen.

Auch große Suchergebnisse sind seitenweise abrufbar. Ein Ergebnis liefert gegebenenfalls
`meta.nextPage` und `meta.snapshot`; beide werden beim nächsten Aufruf als `page`
und `snapshot` mit derselben Stadt, Suchanfrage und Treffergrenze übergeben. Der Cursor
ist an diesen Datenstand gebunden und funktioniert auch mit einem neuen Leserprozess.
Eine geänderte Anfrage oder Generation benötigt eine neue Suche.

Eine Suchseite untersucht höchstens 256 Kandidaten und 128 zusätzliche Ortsseiten,
mit einem Gesamtbudget von 8 MiB unkomprimierten Daten beziehungsweise 256 Dateien.
Daher kann eine unvollständige Seite zunächst keine Treffer und trotzdem eine
Fortsetzung enthalten. Der Cursor bewahrt den Fortschritt auch innerhalb langer
Ortslisten. Ausgegeben werden keine vermeintlich vollständigen Nulltreffer, wenn das
Arbeitsbudget oder eine fehlende Datei die Prüfung begrenzt hat. Überlappende
Suchbegriffe können denselben Vorgang auf mehreren Seiten liefern; die Oberfläche
führt diese anhand der stabilen ID zusammen und erhält bestehende Auswahlen.

## Historische Quellenarbeit fortsetzen

Der gemeinsame Einstiegspunkt ist:

```sh
node scripts/refresh-ris-catalogues.js --city hannover --history-start-year 2014
```

Ein begrenzter, erneut ausführbarer Durchlauf:

```sh
node scripts/refresh-ris-catalogues.js --city hannover --history-start-year 2014 --work-budget 2000 --max-duration-ms 3480000
```

Für Bonn gilt derselbe Einstiegspunkt mit `--city bonn`. Dort zählt das Arbeitsbudget
Quellseiten, bei Hannover neu versuchte Dokumentdetails. Ohne `--city` werden beide
konfigurierten Städte bearbeitet.

Erfolgreiche öffentliche Antworten werden mit Quell- und Parserrevision im vorhandenen
Cache gespeichert. Zusätzliche Arbeitsstände unter `.cache/ris-sources/checkpoints/`
halten Quelle, Suchumfang, Jahr, Cursor, bereits gelesene Metadaten und offene Details
fest. Zeit- oder Arbeitslimits beenden einen fortsetzbaren Durchlauf. Bereits bekannte
ältere Jahrgänge bleiben erhalten, auch wenn ein späterer Aufruf einen neueren Beginn
anfordert. Die bestehenden CI-Cachepfade sichern diese Arbeitsstände mit.

Hannover vergleicht jeden Jahrgang mit der von der amtlichen Suche angegebenen
Tabellenzeilenzahl. Nicht verfügbare Detailseiten behalten die unabhängig geprüften
Listendaten und eine sichtbare Einschränkung. Die stadtweite Suche verwendet
`coverage.scope: "citywide"`; sie belegt keine Vollständigkeit des gesamten amtlichen
Archivs, deshalb bleibt `coverage.complete: false`.

Die Höchstdauer eines Hannover-Quelldurchlaufs beträgt regulär 58 Minuten mit einer
harten Worker-Grenze von 60 Minuten. Bonn verwendet 18 beziehungsweise 20 Minuten.
Ortsabgleich, Aufbau und Validierung der Veröffentlichung folgen anschließend.
Die Grenzen der amtlichen Quellen bleiben bestehen: Drosselung, fehlende Dokumenttexte,
geänderte Suchformulare und nichtöffentliche Inhalte werden nicht durch die Aufteilung
des lokalen Index beseitigt. Ein vollständiges PDF-Archiv wird nicht gespiegelt.

## Migration und Gültigkeit

Der Browser und der gemeinsame Offline-Leser unterstützen Version 1 weiterhin.
Der reguläre Erneuerungspfad schreibt Version 2. Eine reine Formatmigration erhält
alle kanonischen Vorgänge und Kartenobjekte sowie Quellenzeit, Abdeckung, Ortsprüfungen
und einen vorhandenen Fehler-/Ablaufvermerk. Eine neue Ortsprüfrevision ist ein eigener
Schritt: Sie bewertet vorhandene Titel, gespeicherte Belege und amtliche Lagen gegen
das aktuelle geprüfte Ortsverzeichnis. Begrenzte Belege werden entsprechend bezeichnet.

Ein Quellenfehler oder eine lokale Formatänderung erzeugt keine neue Quellenzeit.
Der Datenstand gilt nach acht Tagen als veraltet und läuft nach vierzehn Tagen ab.
Ein tatsächlich unterbrochener historischer Ausbau darf die Gültigkeit des alten
Bestands nicht verlängern. Der dokumentierte Wiederholungsabstand nach Quellenfehlern
bleibt erhalten. `--restore-only` übernimmt exakt einen geprüften veröffentlichten
Bestand.

Die vollständige Veröffentlichung lässt sich unabhängig von der Anzeige prüfen:

```sh
node scripts/refresh-ris-catalogues.js --validate data/ris --require-all
```

Die Prüfung verfolgt alle Indexwurzeln rekursiv und erkennt fehlende, beschädigte oder
nicht referenzierte Dateien. Ein normaler Website-Build übernimmt vorhandene geprüfte
Daten ohne einen eigenen Netzimport. Generierte Stadtbestände werden nicht in Git
eingecheckt.

## Gemeinsames Kartenmenü

Die schwebende Schaltfläche **Karte** bündelt Hintergrund, Unfalldarstellung, Umgebung,
Straßeninformationen und Ratsvorgänge. Cluster und Heatmap bleiben unabhängig
einschaltbar. Hintergrundmodi, Deckkraft, URL-Zustand, Quellenangaben und die bestehenden
Exportregeln verwenden dieselben Zustände wie zuvor. Datenfilter und Aktionstools
bleiben bei ihrer jeweiligen Aufgabe.

Auf kleinen Bildschirmen öffnet sich jeweils ein Kartenmenü. Das Analysepanel wird
vorübergehend eingeklappt und erhält anschließend seinen bisherigen Zustand zurück.
Das Schließen des Menüs schaltet keine Karteninhalte ab. Lesbare Beschriftungen,
Tastaturbedienung, Fokusrückgabe und mindestens 44 CSS-Pixel große Berührungsziele
ergänzen die zurückhaltend durchscheinende Oberfläche.

## Skalierung einordnen

Zusätzliche Indizes und kleine komprimierte Teile erhöhen den Speicherbedarf der
vollständigen Veröffentlichung. Ihr Nutzen ist der gezielte Zugriff: Mehr nicht
verortete Vorgänge oder ältere Antworten erzwingen keinen vollständigen Download
beim Öffnen der Karte. Der gesamte Export und eine vollständige Integritätsprüfung
müssen dagegen weiterhin den gesamten Bestand verarbeiten.

Große Städte benötigen zusätzlich eine tragfähige Quellerschließung, geprüfte
Ortsdaten und ausreichend Build- und Veröffentlichungskapazität. Das gemeinsame
Format beseitigt die Abhängigkeit der ersten Kartenansicht von einer einzigen großen
Stadtdatei; es macht die amtlichen Quellen und die Hosting-Grenzen nicht unbegrenzt.

## Gemessener Prüfstand vom 8. November 2026

Der tatsächlich erhobene und lokal validierte Bestand umfasst:

| Stadt | Vorgänge | Vorgänge mit Geometrie | Eindeutige Geometrien | Alle komprimierten Teile |
|---|---:|---:|---:|---:|
| Bonn | 25.206 | 1.837 | 740 | 4.617.039 Bytes |
| Hannover | 54.217 | 3.895 | 1.992 | 10.661.288 Bytes |

Hannovers jährliche öffentliche Suche wurde für 2014 bis 2026 ausgeführt. Gegenüber
dem zuvor importierten Bestand kamen 29.950 Vorgänge hinzu. Jeder Vorgang erhielt
eine Ortsprüfung; 50.322 haben bislang keine darstellbare Geometrie. Vier Detailseiten
(eine aus 2018, drei aus 2020) blieben nach erneutem Abruf mit HTTP 503 unerreichbar;
ihre unabhängig geprüften Listendaten und die Einschränkungen bleiben erhalten.
461 Prüfungen kennzeichnen begrenzte Textbelege. Dies ist keine Zusage eines
vollständigen amtlichen Archivs oder einer vollständigen PDF-Texterfassung.

Die Migration verlor keine bereits vorhandene ID, Beziehung oder einen der 3.497
gespeicherten Hannover-Dokumentbelege. Alle 1.829 ursprünglichen amtlichen Bonn-
Geometrien blieben erhalten. Bonn behielt seinen verifizierten Quellenstand vom
7. November und den bestehenden Aktualisierungsfehler samt Ablaufdatum.

Für einen repräsentativen Detailausschnitt lud der gemeinsame Leser in Bonn
121 Geometrien über 15 Anfragen mit 88.826 komprimierten Bytes. In Hannover waren
es im erweiterten Bestand 249 Geometrien über 35 Anfragen mit 399.281 Bytes.
Dabei wurden nur Manifest, räumlicher Index und Geometrien gelesen, keine
Vorgangs-, Orts-, Beziehungs-, Zuordnungs- oder Suchdateien. Diese Messung verwendet
lokale verifizierte Dateien und ist keine Aussage über Netzlatenz.

Ein zusätzlicher synthetischer Belastungsfall hielt die zehn sichtbaren Geometrien
konstant und erhöhte den Bestand von 10.000 auf 100.000 Vorgänge, davon jeweils
zehn Prozent mit Ortsbezug. Die erste Kartenansicht benötigte in beiden Fällen drei
Anfragen; die komprimierten Bytes stiegen von 3.974 auf 3.987. Die zugehörigen
Vorgänge und 90.000 verknüpften Antworten blieben seitenweise erreichbar. Dieser
Fall belegt die Trennung von Archivumfang und Kartenlast; er ersetzt keine
Messung sämtlicher denkbarer Großstadt-Geometrien.

Diese Zahlen beschreiben den lokalen Erhebungs- und Prüfstand. Die veröffentlichten
Manifeste geben den jeweils tatsächlich ausgelieferten Quellenstand an.
