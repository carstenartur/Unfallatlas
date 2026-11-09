# Gemeinsame Ratsdatenkataloge

Bonn und Hannover verwenden denselben Erneuerungs-, Veröffentlichungs- und Lesepfad.
Ein Stadtadapter erschließt die jeweilige amtliche Quelle; räumliche Zuordnung,
Speicherformat, Recherche, Kartenanzeige und Berichtszitate sind gemeinsam.
Eine weitere Stadt benötigt keinen eigenen Karten- oder Dateileser. Ein Berlin-Adapter
ist nicht Bestandteil dieses Ausbaus.

## Stadt und Region Hannover

Der Hannover-Katalog führt die öffentlichen Vorlagen der Landeshauptstadt und der
Region im selben Index. Die Herkunft ist ein eigenes Feld; sie wird nicht aus der
Drucksachennummer oder dem Link erraten.

| Quelle | `source` | Stabile Dokumentidentität |
|---|---|---|
| Landeshauptstadt Hannover · SIM | `hannover-sim` | Bestehende SIM-ID |
| Region Hannover · ALLRIS | `region-hannover-ris` | `region-hannover-ris:vo:<VOLFDNR>` |

Gleiche Drucksachennummern verschiedener Quellen bleiben getrennte Vorgänge. Treffer
und Kartenangaben zeigen die Quelle und den amtlichen Original-Link. Der bereits
vorhandene Zusatzimport von regionalen Bekanntmachungen und Landtagsdokumenten bleibt
erhalten. Sein begrenzter Umfang ist je Quelle in `sourceStatuses` ausgewiesen.

Die Regionsquelle wird über das [öffentliche Vorlagenverzeichnis](https://ris.hannit.de/public/vo040)
erschlossen. Der Import verwendet den gemeinsamen ALLRIS-Sitzungsclient und die von
der Quelle angebotene Seitennavigation. Sitzungscookies, Prüfantworten und kurzlebige
Navigationslinks bleiben im Arbeitsspeicher. Der fortsetzbare Arbeitsstand speichert
die beobachteten Vorlagen und bereits geprüfte Details nach Jahrgang.

Zuerst werden die Listeneinträge aufgenommen. Die begrenzten Detailabrufe priorisieren
Verkehrsthemen und liefern öffentliche Textbelege, Beratungsereignisse und Original-PDF-
Links, soweit die jeweilige Vorlage sie tatsächlich enthält. Ein Freigabedatum wird
als `sourceContext.publicationDate` geführt; ein Sitzungstermin wird nicht als
Dokumentdatum ausgegeben. Eine Beschlussvorlage allein gilt nicht als gefasster Beschluss.
Fehlende Details bleiben gekennzeichnet, und es wird kein vollständiges PDF-Archiv kopiert.

Das Hannoveraner Straßenverzeichnis deckt die Landeshauptstadt ab. Bei einer regionalen
Vorlage muss deshalb der konkrete Straßen- oder Ortsbeleg unmittelbar mit „in Hannover“,
„in der Stadt Hannover“ oder „in der Landeshauptstadt Hannover“ qualifiziert sein, bevor
dieses Verzeichnis eine Lage ableitet. Ein Herausgeber „Region Hannover“, eine
Verwaltungsadresse oder eine Stadtangabe in einem anderen Absatz reichen nicht aus.
Diese konservative Prüfung lässt auch manche tatsächlich lokalen Vorgänge unkartiert;
sie bleiben vollständig im durchsuchbaren Dokumentenbestand. Amtliche Geometrien werden
unabhängig davon erhalten.

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
| `geometry` | Stabile Geometrie-ID mit Verweis auf das räumliche Blatt | Gezielter Ort eines Vorgangs |
| `links` | Zuordnung zwischen Geometrien, Vorgängen und Ortsbelegen | Geöffnete Kartenstelle |
| `spatial` | Räumlich gruppierte, einmal gespeicherte Geometrien mit begrenzten Verzeichniszweigen und gekennzeichneten Übersichtszellen | Kartenausschnitt |

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

Der räumliche Index verwendet `spatialFormat: "packed-bounds-v1"`. Jeder Zweig
beschreibt die räumlichen Grenzen und die Anzahl der enthaltenen Geometrien.
Der Leser schließt unpassende Zweige aus, bevor er deren Geometriedateien lädt.
Die Blätter gruppieren benachbarte Geometrien; ihre stabilen IDs bleiben unabhängig
von dieser Speicherreihenfolge. Der zusätzliche `geometry`-Index verweist auf
dasselbe Blatt und speichert keine zweite Kopie der Form. So erzwingen viele
verschiedene Orte in einer groben Kachel keinen Download aller Kachelgeometrien,
wenn nur ein kleiner Ausschnitt angefordert wird.

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
anhand ihrer vollständigen räumlichen Grenzen auch über Blattgrenzen hinweg auffindbar.
Die Vergrößerungsaktion verwendet den sichtbaren Teil einer Übersichtszelle, erhöht
die Zoomstufe und respektiert die tatsächliche Kartengrenze. Am maximalen Zoom erklärt
die Oberfläche, dass keine weitere Vergrößerung möglich ist.

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
node scripts/refresh-ris-catalogues.js --city hannover
```

Ein begrenzter, erneut ausführbarer Durchlauf:

```sh
node scripts/refresh-ris-catalogues.js --city hannover --work-budget 2000 --max-duration-ms 3480000
```

Hannover beginnt standardmäßig mit dem ältesten angebotenen SIM-Jahr 1999.
`--history-start-year` setzt bei Bedarf einen anderen Beginn. Für Bonn gilt
derselbe Einstiegspunkt mit `--city bonn` und dem bisherigen Standardjahr 2014. Dort zählt das Arbeitsbudget
Quellseiten. Hannover teilt ein gesetztes Budget zwischen SIM und ALLRIS: SIM zählt neu
versuchte Dokumentdetails, ALLRIS die öffentlichen Seiten- und Detailabrufe. Die bestehende
ergänzende Landtags-/Bekanntmachungssuche hat eigene Grenzen von zwei Katalogseiten und
vier Bekanntmachungen zuzüglich der RSS-Ausschnitte. `--work-budget 0` ruft auch dort keine
neuen Quellen ab. Ohne `--city` werden beide konfigurierten Städte bearbeitet.

Erfolgreiche öffentliche Antworten werden mit Quell- und Parserrevision im vorhandenen
Cache gespeichert. Zusätzliche Arbeitsstände unter `.cache/ris-sources/checkpoints/`
halten Quelle, Suchumfang, Jahr, Cursor, bereits gelesene Metadaten und offene Details
fest. Zeit- oder Arbeitslimits beenden einen fortsetzbaren Durchlauf. Bereits bekannte
ältere Jahrgänge bleiben erhalten, auch wenn ein späterer Aufruf einen neueren Beginn
anfordert. Die bestehenden CI-Cachepfade sichern diese Arbeitsstände mit.

### Explizite Wiederherstellung aus Hannover-Checkpoints

Wenn die amtlichen Abrufe bereits gesichert sind, aber ein nachgelagerter
Validierungsfehler ihre Veröffentlichung verhindert hat, kann der manuelle
Workflow **„04 · Aktuelle Daten veröffentlichen“** diese Arbeitsstände erneut
durch den kanonischen Maven- und Pages-Pfad prüfen. Dafür werden drei Eingaben
gesetzt:

- `hannover_checkpoint_retry=true`
- `ris_source_cache_key`: der **exakte** zuvor erfolgreich gespeicherte Cache-Key,
  beispielsweise `ris-sources-v1-Linux-42502618892-1`
- `ris_min_records`: die für diese Wiederherstellung erforderliche Mindestzahl
  veröffentlichter Hannover-Datensätze, beispielsweise `674`

Dieser Modus verwendet keinen Cache-Prefix als Ersatz. Ein fehlender exakter
Cache-Treffer lässt den Lauf scheitern. Die Eingaben werden als Umgebungswerte
validiert, nicht in Shell-Kommandos interpoliert. Der entsprechende CLI-Aufruf
nach Wiederherstellung des benannten Caches lautet:

```sh
node scripts/refresh-ris-catalogues.js --checkpoint-retry hannover --source-cache-key ris-sources-v1-Linux-42502618892-1 --min-records 674
```

Nur dieser ausdrückliche Modus darf die sechsstündige Sperre nach einem
Quellenfehler übergehen. Er erzwingt Arbeitsbudget **0**, verlangt passende
SIM-Jahrescheckpoints für den angeforderten Zeitraum und sperrt den amtlichen
Quelltransport zusätzlich. Er verwendet vorhandene Fakten, ohne fehlende
Dokumente oder weitere amtliche Quellen neu abzufragen. Bonn wird dabei nur aus
dem veröffentlichten Bestand wiederhergestellt. Die Prüfungen für Quellalter,
Ortsbewertungen, Abdeckung und Herkunft bleiben unverändert.

Der Hannover-Ausgang muss `published` sein und die eingegebene Mindestzahl
erreichen. Ein erneuter Fehler, `retained` oder ein zu kleiner Kandidat macht den
Wiederherstellungslauf rot; ein grüner Erhalt des alten kleinen Bestands reicht
nicht. Der Modus erneuert keine Quellzeit und behauptet keine Archivvollständigkeit.
Normaler Push, Wochenlauf und regulärer CLI-Aufruf behalten ihren bisherigen
Retry-Vertrag. Nach der tatsächlichen Veröffentlichung werden Manifest,
Datensatzanzahl und öffentlicher Build-Fingerprint gegen das CI-Artefakt geprüft.

Hannover prüft zuerst alle Jahreslisten und ruft anschließend die Details im
verbleibenden Arbeitsbudget ab. Erreicht eine Jahresliste die SIM-Grenze von
5.000 Zeilen, fragt der Importer die Veröffentlichungen vor, am und nach dem
1. Juli getrennt ab. Die Teilabfragen müssen unter der Grenze bleiben und gemeinsam
alle bereits beobachteten IDs enthalten. Die amtliche Vorlagennummer dient als
Anzeige, wenn der Titel in der Liste fehlt und die Detailseite nicht verfügbar ist.
Nicht verfügbare Details bleiben als Einschränkung sichtbar. Die stadtweite Suche verwendet
`coverage.scope: "citywide"`; sie belegt keine Vollständigkeit des gesamten amtlichen
Archivs, deshalb bleibt `coverage.complete: false`.

Die Höchstdauer eines Hannover-Quelldurchlaufs beträgt regulär 58 Minuten mit einer
harten Worker-Grenze von 60 Minuten. SIM und ALLRIS laufen unabhängig parallel; ALLRIS
hat innerhalb dieses Rahmens höchstens 15 Minuten und 2.000 neue Detailabrufe pro Lauf.
Der bestehende Pages-Workflow setzt die Quellenarbeit montags bis samstags um
04:17 UTC fort; sonntags übernimmt der vorhandene vollständige Datenlauf.
Damit stehen täglich begrenzte Abrufe für noch fehlende Details und die Erneuerung
älterer Belege bereit. Die tatsächlichen Prüfzeiten bleiben erhalten; fehlgeschlagene
oder lediglich aus dem Cache gelesene Belege bekommen keine neue Quellenzeit.
Ein Listenlauf gilt erst mit der amtlichen Anzahl eindeutiger IDs dieses Durchlaufs
als abgeschlossen. Überlappungen werden erneut geprüft; historische Einträge
gleichen keine fehlenden aktuellen IDs aus.
Bonn verwendet 18 beziehungsweise 20 Minuten.
Ortsabgleich, Aufbau und Validierung der Veröffentlichung folgen anschließend.
Die Grenzen der amtlichen Quellen bleiben bestehen: Drosselung, fehlende Dokumenttexte,
geänderte Suchformulare und nichtöffentliche Inhalte werden nicht durch die Aufteilung
des lokalen Index beseitigt. Ein vollständiges PDF-Archiv wird nicht gespiegelt.

## Migration und Gültigkeit

Bestätigte Rücknahmen erhalten im Manifest einen optionalen Importzeitpunkt
`withdrawalsRecordedAt`. Er enthält keine Dokumentidentitäten oder Inhalte und
erneuert weder `generatedAt` noch den Ablaufzeitpunkt. Dieser getrennte Wert
verhindert, dass ein älterer lokaler oder veröffentlichter Bestand entfernte
Dokumente wieder einführt; auch eine teilweise Rücknahme bleibt so wirksam.
Eine tatsächlich spätere Quellenprüfung kann die öffentliche Verfügbarkeit erneut
feststellen. Formatmigrationen und reine Ortsprüfungen bewahren den Wert unverändert.

Der Browser und der gemeinsame Offline-Leser unterstützen Version 1 und frühere
Version-2-Bestände mit festem Kachelindex weiterhin. Das Manifest kennzeichnet den
neuen räumlichen Aufbau ausdrücklich; ein fehlendes `spatialFormat` verwendet den
bisherigen Version-2-Lesepfad. Der reguläre Erneuerungspfad schreibt Version 2 mit
räumlich gruppierten Geometrien. Eine reine Formatmigration erhält
alle kanonischen Vorgänge und Kartenobjekte sowie Quellenzeit, Abdeckung, Ortsprüfungen
und einen vorhandenen Fehler-/Ablaufvermerk. Eine neue Ortsprüfrevision ist ein eigener
Schritt: Sie bewertet vorhandene Titel, gespeicherte Belege und amtliche Lagen gegen
das aktuelle geprüfte Ortsverzeichnis. Begrenzte Belege werden entsprechend bezeichnet.

Hausnummern einschließlich Zusätzen, Listen und Angaben wie `12-14`, `12 bis 14`,
`12/14` oder `12+14` sowie Buchstabenbereiche/-verbindungen wie `20 A-F` und `3 A+B`
bleiben vollständig als Adressbezug mit ihrer Fundstelle erhalten. Eine Kartenposition
entsteht nur aus dem vollständigen passenden Adressschlüssel im geprüften
Ortsverzeichnis; ein unbekannter Bereich wird weder auf seine erste Hausnummer noch
auf den ganzen Straßenverlauf gelegt. `Nr.12` und `Hausnr. 12` werden ebenfalls
erkannt. Die in amtlichen Titeln belegten Verfahrens-/Sachuntertitel und ausgeglichenen
Planungstitel-Trennstriche beenden eine vollständige Adresse; unbekannte Endpunkte
bleiben ungeklärt. Postleitzahl, Stadtteil und die belegten nachfolgenden Titelzusätze
werden nicht als weitere Hausnummern gelesen. Eine klar bezeichnete Anschrift der
Verfasser einer schriftlichen Petition vor „zum Thema“ bleibt als Adressangabe
erhalten, erhält aber keine Lage der beantragten Maßnahme. Eine tatsächlich nach
dieser Themenmarkierung benannte Maßnahmenadresse bleibt verortbar. Auch die
Übernahme älterer Kartenbelege setzt diese Unterscheidung nicht außer Kraft.
Bei Regionsvorlagen muss die unmittelbare Stadtzuordnung im selben Satz
auch zur vollständigen Adressangabe passen. Ortsprüfrevision 5 bewertet dafür ältere
Bestände erneut, auch wenn ein erfolgreicher Katalogabruf einzelne Detailseiten nicht
erneut liefern konnte. Bereits mit Revision 4 veröffentlichte, unverändert übernommene
Ortsangaben werden dabei ebenfalls geprüft. Die Prüfung verwendet die zuvor
gespeicherten Titelbelege und begrenzten Dokumentzitate; neue Listenmetadaten ersetzen
keinen fehlenden Sachtext. Unveränderte verifizierte Kartenbelege bleiben erhalten,
korrigierte Hausnummernbereiche übernehmen keinen Punkt ihrer früheren Anfangsnummer.
Quellenzeiten werden nicht erneuert und fehlende Volltexte nicht ergänzt.

Ein Quellenfehler oder eine lokale Formatänderung erzeugt keine neue Quellenzeit.
Auch beibehaltene Vorgänge, die im nächsten Abruf fehlen, behalten ihre ursprüngliche
Verifikationszeit. Ein frisch aktualisierter Stadtteil des Katalogs erneuert keine
älteren Regionsbelege. Ein früherer Regionslink ohne importierte Datensätze löst den
ersten echten Regionsimport aus, selbst wenn der Stadtkatalog noch frisch ist.
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

## Ratsvorgänge über die URL teilen

Die Ebene **Ratsvorgänge** ist Bestandteil des gemeinsamen URL-Zustands:
`mapLayer=ris` schaltet sie ein; mehrere Ebenen werden beispielsweise als
`mapLayer=slope,traffic,ris` gespeichert. Das Weitergeben der Adresse erhält
auch die bestehenden Unfallfilter, den Kartenausschnitt und die markierte Fläche.
Ein expliziter Link hat Vorrang vor zuvor lokal gespeicherten Einstellungen.

Karten-Popups und Suchtreffer öffnen über **Verlauf und Zusammenhänge** dieselbe
eigenständige Vorgangsansicht. Dafür ist keine Geometrie erforderlich. Das Öffnen
eines Dokuments verändert weder die gewählten Kartenebenen noch den Ausschnitt.
**Ansicht teilen** kopiert die vollständige aktuelle URL. Ein- und Ausklappen ist
ebenfalls teilbar; **Schließen** entfernt die Dokumentauswahl aus dem Link.

| URL-Parameter | Bedeutung | Standard |
|---|---|---|
| `mapLayer` | Aktive zusätzliche Ebenen, einschließlich `ris` | Keine |
| `risSelectionOnly=1` | RIS-Karte auf die markierte Fläche beschränken | Aus |
| `risRecord` | Stabile ID des geöffneten Vorgangs im Stadtkatalog | Kein Vorgang |
| `risView` | `history`, `relations` oder `locations` | `history` |
| `risCollapsed=1` | Detailansicht eingeklappt | Aus |
| `risEventsPage` | Sichtbare Seite der Beratungen, ab 0 | 0 |
| `risRelationsPage` | Sichtbare Seite direkter Querverweise, ab 0 | 0 |
| `risRelatedPage` | Sichtbare Seite verknüpfter Vorgänge, ab 0 | 0 |
| `risLocationsPage` | Sichtbare Seite der Ortsbelege/Kartenlagen, ab 0 | 0 |

Standardwerte werden weggelassen. Jede Datenseite wird gezielt geladen; eine große
Seitenzahl in einem Link löst keinen Nachladezyklus über sämtliche Vorgänger aus.
Die Seitengrenzen stammen aus dem Katalog: Große Quellenbelege können bereits vor
der maximalen Eintragszahl eine neue Datenseite erfordern.
Ungültige Seiten werden berichtigt. Beim Stadtwechsel werden Dokumentauswahl,
Detailseiten und Flächenfilter zurückgesetzt, die gewünschte RIS-Ebene bleibt erhalten.

Die Prozesslinie zeigt für jede dokumentierte Beratung Datum, Gremium, Ergebnis,
Quellenbeleg und Link zum amtlichen Sitzungsnachweis. Datumslose Angaben stehen
gesondert. Eine fehlende Historie, ein belegter leerer Bestand und ein unvollständiger
Abruf werden unterschiedlich erläutert. Die Dokumentart wird nicht als
Verfahrensfortschritt ausgelegt. Die zeitliche Sortierung bezieht sich ausdrücklich
auf die gerade sichtbare Seite.

**Zusammenhänge** trennt direkte amtliche Querverweise von Vorgängen, die über weitere
Dokumente verbunden sind. Eine Verbindung allein belegt keine Reihenfolge oder
Zuständigkeit. Verfügbare Ziele lassen sich intern öffnen; amtliche Quellen bleiben
direkt erreichbar. **Orte** zeigt Fundstellen und bietet für verortete Einträge den
Übergang zur Karte. Auf Telefon und Tablet ist die Ansicht einklappbar und schließbar.

Gestalterische Referenz für die vertikale Prozesslinie:
[Ratsatlas Bonn von Damian Paderta](https://github.com/daimpad/ratsatlas-bonn/tree/bcefc9e9e5931689ba10da55ebe56c92f01761d6),
insbesondere `site/app.js` (`stepHtml`) und `site/style.css`. Die Unfallwerkbank
verwendet eine eigene Umsetzung für ihre stadtübergreifenden, seitenweise geladenen
Katalogdaten. Quellenmodell und Verfahrensannahmen des Ratsatlas werden nicht
übertragen; siehe [Drittanbieterhinweise](THIRD_PARTY_NOTICES.md).

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

Der tatsächlich erhobene und lokal validierte räumliche Prüfstand um 14:13 UTC
(vor der anschließenden Providerkorrektur) umfasst:

| Stadt | Vorgänge | Vorgänge mit Geometrie | Eindeutige Geometrien | Alle komprimierten Teile |
|---|---:|---:|---:|---:|
| Bonn | 25.206 | 1.837 | 740 | 4.640.150 Bytes |
| Hannover | 54.217 | 3.895 | 1.992 | 10.729.555 Bytes |

Hannovers jährliche öffentliche Suche wurde für 2014 bis 2026 ausgeführt. Gegenüber
dem zuvor importierten Bestand kamen 29.950 Vorgänge hinzu. Jeder Vorgang erhielt
eine Ortsprüfung; 50.322 haben bislang keine darstellbare Geometrie. Vier Detailseiten
(eine aus 2018, drei aus 2020) blieben nach erneutem Abruf mit HTTP 503 unerreichbar;
ihre unabhängig geprüften Listendaten und die Einschränkungen bleiben erhalten.
461 Prüfungen kennzeichnen begrenzte Textbelege. Dies ist keine Zusage eines
vollständigen amtlichen Archivs oder einer vollständigen PDF-Texterfassung.

Die anschließende Providerprüfung korrigiert zusätzlich die Qualität der
Metadaten: Verwertbare Typangaben aus den geprüften Jahreslisten bleiben auch
bei erfolgreichen Detailabrufen und älteren Cachetreffern erhalten;
Verwaltungsantworten haben weiterhin Vorrang. Ein vorhandener Dokumentbereich
ohne auswertbaren operativen Text wird ausdrücklich als nicht verfügbar markiert.
Eine allein aus dem Titel abgeleitete Ortszuordnung gilt dann als teilweise
geprüft. Bekannte ursprüngliche Detailzeitpunkte bleiben erhalten, auch beim
Wiederaufbau ausschließlich aus historischen Checkpoints. Fehlgeschlagene
Detailabrufe werden im toleranten Archivmodus übersprungen und einmal gemeldet,
ohne einen Cacheerfolg zu erzeugen; der strikte Modus bricht weiterhin ab.

Im ursprünglichen Bestand betrifft die nachgeholte Textqualifikation 11.213
Vorgänge, davon 146 zuvor vollständig verortete Einträge mit ausschließlich
titelbasierten Belegen. Bei 5.656 als „Sonstige“ eingeordneten Vorgängen ist ein
verwertbarer spezifischer Listentyp nachgewiesen. Die Quellbezeichnung
„Entscheidung“ bleibt bei fehlender zusätzlicher Typinformation „Sonstige“;
sie wird nicht pauschal als Verwaltungsantwort ausgegeben.

Spezifische Änderungsanträge bleiben auch dann Änderungsanträge, wenn die
Jahresliste sie unter der allgemeineren Bezeichnung „Haushaltsantrag“ aufführt.
Beim Zusammenführen mehrerer Jahre bleiben amtliche Jahreslistenangaben von
generischen verknüpften Einträgen unterscheidbar. Neuere, nicht auswertbare
Details verdrängen weder bereits geprüfte Belege noch deren ursprüngliche Uhr.
Bei erhaltenen Ortszuordnungen werden vollständige Kartenbeschriftungen samt
Quellenangabe und Hinweis auf einen kartierten Teilabschnitt übernommen.

Alte Checkpoints können einen späteren Arbeitszeitpunkt als ihr ursprünglicher
Quellencache enthalten. Ein begrenzter, ausschließlich lesender Metadatenabgleich
übernimmt dafür den frühesten bekannten Zeitpunkt. Auch eine abgelaufene
Cachehülle kann diesen früheren Zeitpunkt belegen; dadurch wird ihr Inhalt
nicht wieder als aktuell freigegeben. Die Korrektur wird im Checkpoint gespeichert
und erneuert weder Quelldateien noch deren Ablaufdatum.

Die Migration verlor keine bereits vorhandene ID, Beziehung oder einen der 3.497
gespeicherten Hannover-Dokumentbelege. Alle 1.829 ursprünglichen amtlichen Bonn-
Geometrien blieben erhalten. Bonn behielt seinen verifizierten Quellenstand vom
7. November und den bestehenden Aktualisierungsfehler samt Ablaufdatum.

Für einen repräsentativen Detailausschnitt lud der gemeinsame Leser in Bonn
121 Geometrien über 10 Anfragen mit 45.491 komprimierten Bytes. In Hannover waren
es im erweiterten Bestand 249 Geometrien über 17 Anfragen mit 151.410 Bytes.
Dabei wurden nur Manifest und räumliche Blätter mit Geometrien gelesen, keine
Vorgangs-, Orts-, Beziehungs-, Zuordnungs- oder Suchdateien. Diese Messung verwendet
lokale verifizierte Dateien und ist keine Aussage über Netzlatenz.

Ein zusätzlicher synthetischer Belastungsfall hielt die zehn sichtbaren Geometrien
konstant und erhöhte den Bestand von 10.000 auf 100.000 Vorgänge, davon jeweils
zehn Prozent mit Ortsbezug. Die erste Kartenansicht benötigte in beiden Fällen zwei
Anfragen; die komprimierten Bytes stiegen von 3.651 auf 3.663. Die zugehörigen
Vorgänge und 90.000 verknüpften Antworten blieben seitenweise erreichbar. Dieser
Fall belegt die Trennung von Archivumfang und Kartenlast; er ersetzt keine
Messung sämtlicher denkbarer Großstadt-Geometrien.

Eine zweite Belastungsprüfung verteilte 12.000 verschiedene Punktgeometrien in
derselben früheren Zoom-12-Kachel. Ein enger Ausschnitt mit genau einem Ort
lieferte diesen Ort bei Zoom 18 und bei weiterem Vergrößern auf Zoom 22 jeweils
als Detail: sieben Anfragen, 27.645 komprimierte und 136.085 entpackte Bytes bei
kaltem Cache. Der bisherige feste Kachelzugriff hatte für denselben Fall
3.287.274 entpackte Bytes gelesen und nur die Übersicht zurückgegeben. Ein
Ausschnitt mit neun Orten benötigte im neuen Aufbau zwölf Anfragen und 270.890
entpackte Bytes. Der Blick auf die gesamte dichte Kachel lieferte dagegen bewusst
eine Übersicht mit der korrekten Anzahl 12.000.

Ein zusätzlicher Linienfall enthielt 320 außerhalb des Ausschnitts liegende
Linien mit jeweils 1.000 Stützpunkten, einen sichtbaren Punkt und einen langen
kreuzenden mehrteiligen Verlauf. Die beiden passenden Geometrien blieben über
drei Anfragen und 257.823 entpackte Bytes erreichbar. Diese Fälle prüfen die
räumliche Auswahl zusätzlich zur getrennten Skalierung des Dokumentenarchivs.
Der Aufbau der räumlichen Eintragsliste wurde zusätzlich mit 150.001 verschiedenen
Punktgeometrien geprüft. Dabei entstehen keine von der Gesamtzahl abhängigen
Funktionsargumentlisten. Diese Prüfung des Erzeugers ist keine Behauptung, einen
vollständigen Großstadtkatalog mit 150.001 Geometrien veröffentlicht zu haben.

Diese Zahlen beschreiben den lokalen Erhebungs- und Prüfstand. Die veröffentlichten
Manifeste geben den jeweils tatsächlich ausgelieferten Quellenstand an.

## Herkunft und exakter Exportbezug

Neu gesammelte Kataloge ergänzen das weiterhin gültige Snapshotformat
`schemaVersion: 2` um ein optionales `provenance`-Objekt mit eigener
`schemaVersion: 1`. Vorhandene v1-/v2-Manifeste bleiben ohne dieses Objekt
lesbar. Eine lokale Migration erfindet keine historische Herkunftsmetadaten.
Ist das Objekt vorhanden, lehnen Server und Browser unbekannte Versionen,
unbekannte Felder, ungültige Zeiten, überlange Texte und unsichere Zähler ab.
Der gemeinsame Validator liegt in `ua.ris-partitions.js`.

| Feld | Bedeutung |
|---|---|
| `producer` | Generator `unfallwerkbank-ris` mit expliziter Revision `ris-provenance-v1`; keine behauptete Paketversion |
| `builtAt` | Zeitpunkt dieses Asset-Builds, unabhängig vom Alter der amtlichen Quelle |
| `sourceVerifiedAt` | Identisch mit `generatedAt`; ältester bekannter verwendeter Quellen-/Detailstand, niemals nach `builtAt` |
| `provider`, `normalizationRevision` | Quellenkennung und explizite Revision der zitierten Metadatenprojektion; getrennt von `locationRevision` |
| `sourceFingerprint` | SHA-256 der kanonischen Providerprojektion vor der Ortsanreicherung, bezeichnet als `provider-projection-v1` |
| `collection` | Beobachtete Seiten, rohe Eingabezeilen, normalisierte Vorgänge, angefragter Zeitraum, angewandte Limits und begrenzter Fortsetzungsstatus |
| `rights` | Verifizierte Lizenzkennung und Quellenhinweise, sofern bekannt; andernfalls `not-specified`, `license: null` |
| `distribution` | gzip-Dateianzahl, komprimierte und unkomprimierte Gesamtbytes aller eindeutig referenzierten Assets einschließlich Indexdateien |

Nicht überlieferte Zähler und Limits sind `null`. Insbesondere sind Bonns
`cache.items` bereits projizierte beziehungsweise anhand stabiler IDs
abgeglichene Vorgänge und kein Rohzeilenzähler. Sie werden deshalb nicht als
`rawItems` ausgegeben. Bonns logische `cache.pages` kann dagegen als
Seitenanzahl übernommen werden; fehlende Hannover-Seitenzähler bleiben
unbekannt. Angewandte Produktionslimits stammen aus dem Aufruf des jeweiligen
Sammlers. Unbegrenzte oder nicht anwendbare Werte werden als `null`, niemals
als `Infinity` serialisiert. Fortsetzungsmetadaten enthalten nur Status,
Jahrgänge und einen begrenzten Grund, keine lokalen Pfade, Cookies, Rohfehler
oder internen Cursor.

Der Quellenfingerabdruck bindet nach stabiler ID sortierte Vorgänge und
rekursiv sortierte Objektschlüssel. Er umfasst Zitatfelder, Beziehungen,
verwendete amtliche Textbelege und amtliche Geometrien. Er ist kein Hash
unverfügbarer HTTP-Rohbytes. Cache-Status, Abruf-/Buildzeiten und abgeleitete
Ortsgeometrien gehören nicht zur Projektion. Dagegen bezeichnet die vorhandene
`generation` weiterhin exakt die ausgelieferten Inhaltsverzeichnisse; ein
neuer Buildzeitpunkt allein ändert sie nicht.

Bei der Größenrechnung zählt jeder Assetpfad genau einmal, auch wenn ein
Geometrieverzeichnis zusätzlich auf ein räumliches Blatt verweist. Das mutable
Manifest selbst ist ausgeschlossen, damit keine selbstbezügliche Summe
entsteht. Die Rechnung verwendet tatsächlich installierte gzip-Bytes, auch
wenn ein bereits vorhandenes adressiertes Asset mit anderer, aber gültiger
Kompression wiederverwendet wird. Der Server prüft die Summen bei vollständiger
Assetvalidierung gegen die Dateien; beim partiellen Browserzugriff bleibt der
jeweilige Dateihash maßgeblich.

Fallback und unveränderte Wiederherstellung bewahren die Herkunftsfakten.
Eine lokale Neuverortung oder v1-Migration darf Buildzeit, Generatorrevision
und Assetgrößen aktualisieren; Quellenzeit, Quellenfingerabdruck,
Erhebungszähler und Erhebungsscope bleiben erhalten. Der Frischezustand wird
weiterhin ausschließlich aus `generatedAt`, `coverage.complete` und
`refreshFailure` abgeleitet, nicht aus einem zweiten eingefrorenen Status.

Text-, HTML-, DOCX- und PDF-Ausgaben kennzeichnen übernommene Vorgänge mit
`Recherchequelle: veröffentlichter Ratsdaten-Snapshot` und dem vollständigen
`Snapshot-SHA-256`. Bei v2 ist dies `generation`; bei v1 ist es der Records-Hash.
Ein davon abweichender v1-Kartenhash erscheint zusätzlich vollständig als
`Karten-SHA-256`. Zeilenumbruch ist erlaubt, Kürzung des prüfbaren Digests
nicht. Katalogdatum, Einschränkungen, Warnungen und amtliche Vorgangslinks
bleiben Teil desselben Quellenbelegs. Der Snapshothash bezeichnet den konkret
verwendeten lokalen Datenstand und behauptet keine erneute Prüfung des
amtlichen Links beim Export.
