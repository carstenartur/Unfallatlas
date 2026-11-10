# RIS-Ortsprüfung: Reparatur und feste Stichprobe vom 10. November 2026

## Ergebnis und Geltungsbereich

Die lokale Wiederholung mit dem reparierten Provider und Mapper verortet **1 von 34 zuvor unverorteten Stichprobenfällen neu**: `hannover-sim:15-1541-2026F1`, Kreuzung Elmstraße/Schwarzwaldstraße. Bei **allen 7** ausgewählten städtischen Fällen mit `document_text_unavailable` wird der vorhandene operative Text nun gelesen; daraus entsteht nicht automatisch eine Geometrie. Die 33 verbleibenden Fälle verteilen sich wie folgt:

| Manuelle Einordnung nach Ausschluss des neu verorteten Falls | Anzahl |
|---|---:|
| F: Konkreter Ortsbezug vorhanden, Zuordnung oder zulässige Belegbasis weiter offen | 12 |
| A: Mehrdeutiger Ort oder genauer begrenzter Bereich als die verfügbare Geometrie | 7 |
| K: Verwaltungs- oder bezirksweites Thema ohne konkreten Einzelort | 6 |
| X: Regionaler Sachtext wegen Zugriffsprüfung nicht erneut prüfbar | 8 |
| **Verbleibend** | **33** |

Dies sind **Diagnosezahlen dieser gezielt geschichteten Stichprobe**, keine Schätzung für den Gesamtbestand. F umfasst auch fehlende Einrichtungsdaten, ungelöste Abschnittsgeometrie und zwei Ortsbelege ausschließlich in der Begründung; die zwölf Fälle sind keine zwölf bestätigten Parserfehler. Die acht regionalen Fälle wurden nicht mit einem reparierten Sachtext erneut gerechnet. Die Ergebnisse belegen weder eine Veröffentlichung noch eine bereits aktualisierte Live-Karte.

## Auswahl und Reproduktion

Ausgangspunkt war der [öffentliche Hannover-Index](https://carstenartur.github.io/Unfallatlas/data/ris/hannover.json), Ortsrevision **5**, Quellenstand `2026-11-08T17:02:48.611Z`, mit 109.560 Vorgängen, 6.771 kartierten Vorgängen und 2.791 Geometrien. Seine SHA-256-Generationskennung der Indexwurzeln lautet:

`8b4e6b769a52546b2b0481593e0cc378961851f1e90f84bfa2dbf53c161971cf`

Der feste Seed ist `hannover-unmapped-diagnostic-2026-11-10-v1`. Aus dem sortierten Datensatzbaum wurden die nullbasierten Wurzelpositionen `0,3,6,9,12,15,18,21,22,23,24,25,26` und jeweils Kindposition `17,47` gelesen: **26 Blätter, 13 ID-Bereiche, 1.656 Kandidaten**. Blätter und Datensätze wurden mit dem öffentlichen Reader und ihren Inhalts-Hashes geprüft.

Berücksichtigt wurden nur `unresolved` oder `unavailable`. Städtische Gründe wurden exklusiv in der Reihenfolge `document_text_unavailable`, `unverified_name`, `unmapped_location`, `no_specific_location` zugeordnet; die regionale Schicht verlangt `gazetteer_unavailable`. Zielgrößen: NS 7, UN 5, UL 7, DT 7, RG 8. UN wurde von 7 auf 5 reduziert, weil der feste Pool nur sechs entsprechende Datensätze in fünf verschiedenen Vorgangsfamilien enthielt; es wurden keine passenden Titel nachgesucht.

Innerhalb der Schicht und Jahresepoche wurde nach `SHA-256(Seed + LF + ID)` sortiert. Epochen sind vor 2010, 2010–2019 und ab 2020; das Jahr stammt aus der Drucksachennummer, ersatzweise dem Datum. Epochenquoten: städtisch `2/2/3`, UN `1/2/2`, regional `2/3/3`; offene Plätze werden aus den übrigen Hash-Rängen derselben Schicht besetzt. Familienkennung ist `relatedTo || id`, global dedupliziert in der Auswahlreihenfolge NS, UN, UL, DT, RG. Titel und Adressen waren keine Auswahlkriterien. Die [kompakte Evidenzdatei](ris-location-audit-2026-11-10.json) enthält die unveränderliche Datensatzwurzel und Blattpositionen, alle IDs, Gründe vor/nach der lokalen Wiederholung sowie amtliche URLs, Abrufzeiten und SHA-256-Werte der Antworten.

## Reparaturen und verbleibende Schwächen

**Gustav-Adolf-Straße, außerhalb der Stichprobe:** Der unveränderte amtliche Antworttext von [15-1782/2019 F1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-1782-2019F1) enthält die Adresse unmittelbar vor dem angeschlossenen Fließtextwort in `6 -bearbeitet`. Die eng begrenzte Parserkorrektur erhält **Gustav-Adolf-Straße 6** mit dem geprüften Punkt `[9.726686, 52.381992]`; unvollständige Hausnummernbereiche dürfen weiterhin nicht auf ihre erste Nummer verkürzt werden. Dies rekonstruiert nicht, welchen historischen Marker der Nutzer zuvor gesehen hatte.

**Getrennt umbrochener Straßenname:** In [15-1567/2024](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-1567-2024) wird ein einzelner Layoutumbruch innerhalb von Gustav-Adolf-Straße wieder verbunden. Absatzgrenzen, doppelte Umbrüche und verschiedene Listeneinträge bleiben getrennt. Ein wiederhergestellter Name löst noch nicht jede mehrteilige Straßenliste.

**Operative Überschriften:** Sechs Stichprobenquellen verwenden `Antrag,`, eine `Antrag zu beschließen:`. Diese Varianten werden nun gelesen. Ebenso wird die tatsächliche Verwaltungsantwort unter ihrer entsprechenden Einleitungsüberschrift erkannt; dadurch gewinnt Fall 06 die belegte Kreuzung. Die Änderung liest weiterhin ausgewählte operative Abschnitte. Ein pauschales Entfernen von Sitzungsangaben aus Titeln wäre kein ausreichender Ersatz: Bei Fall 15 ergäbe das die ganze Straße, obwohl die Entscheidung einen Punkt bei einem nicht benannten Kindergarten betrifft.

**Weiter offen:** Mehrere unabhängige Maßnahmen oder Straßenabschnitte müssen getrennt erhalten bleiben (08, 11, 12, 18). Bei 11 darf die mehrdeutige Angerstraße nicht die unabhängig beschriebene Eckerstraße verdrängen. Bei 18 endet der erhaltene Beleg an `bzw.` und verliert den folgenden alternativen Endpunkt. Bei 21 muss die vollständige Aussage einschließlich ihrer Verneinung erhalten bleiben: Der zunächst erfasste Straßenabschnitt wird ausdrücklich nicht umbenannt. Holzwiesen und Sonnenweg haben ebenfalls jeweils zwei Straßenkennungen im geprüften ATKIS-Bestandteil. Benannte Einrichtungen, neue Platznamen und Bäckereien als Abschnittsanker benötigen zusätzliche verifizierte Ortsdaten. Ein Straßenverlauf ist kein Ersatz für einen unbelegten genauen Maßnahmenort.

**Quellenschreibweise und komplexe Ortsliste (05):** Der amtliche Text schreibt `Ferdinand-Willhelm-Fricke-Weg`, der Gazetteer dagegen `Ferdinand-Wilhelm-Fricke-Weg`. Die Namenszuordnung scheitert auch bei einem isolierten eindeutigen Straßenbezug. Wird ausschließlich die Schreibweise im vollständigen Text korrigiert, bleibt dessen gemischte Liste aus Straßen, Parkplätzen und Einrichtungen ebenfalls ungelöst. Hier fehlen somit eine abgesicherte Namenszuordnung und eine genauere Verarbeitung des Listeneintrags; es ist kein einfacher Verlust einer bereits erkannten Straßenklausel.

**Belegumfang (02, 23):** Der entscheidende Veranstaltungsort steht jeweils erst in der Begründung. Fall 02 nennt die Eisfabrik im operativen Antrag zunächst als Zuschussempfänger, Fall 23 nennt das Katholische Internationale Zentrum erst in der Begründung. Diese Fälle bleiben unter der bestehenden Beschränkung auf operative Ortsbelege nachvollziehbar offen. Eine spätere Erweiterung braucht eine ausdrückliche Regel für maßnahmenbezogene Begründungssätze mit eigener Quellenkennzeichnung.

**Quellenzugriff:** Alle 26 städtischen Artikel waren abrufbar und wurden manuell gelesen. Acht regionale Abrufe lieferten HTTP 200 mit einer Zugriffsprüfung statt dem Dokument. Das ist von ihrem bisherigen Indexgrund `gazetteer_unavailable` zu unterscheiden; aus Katalogtiteln wurde keine neue Sach- oder Ortsprüfung abgeleitet. PDF-Anlagen wurden nicht geprüft. Manuelle Kontextprüfung und die technisch begrenzte Auswahl operativen HTMLs sind getrennte Evidenzstufen.

Die zugehörigen Regressionen liegen in [Provider-Tests](../../tests/unit/hannoverSimCatalogue.test.js) und [Mapper-Tests](../../tests/unit/risLocation.test.js). Dieser Bericht behauptet keinen darüber hinausgehenden Test- oder Veröffentlichungsstatus.

## Zusätzlich geprüft: dauerhafte Speicherung des Importfortschritts

Die Speicher-Schritte der Veröffentlichungen [42793009408](https://github.com/carstenartur/Unfallatlas/actions/runs/42793009408/job/129766402725) und [42806710672](https://github.com/carstenartur/Unfallatlas/actions/runs/42806710672/job/129815162432) melden `Maximum call stack size exceeded`, bevor ein Archivierungs- oder Upload-Aufruf erscheint. Eine Bestätigung eines neu gespeicherten Caches fehlt. Beide Läufe hatten denselben älteren Cache `ris-sources-v1-Linux-42536474119-1` geladen. Der [gepinnt verwendete Action-Code](https://github.com/actions/cache/blob/55cc8345863c7cc4c66a329aec7e433d2d1c52a9/src/saveImpl.ts) behandelt die Ausnahme als Warnung; ein grüner Schritt allein belegt daher keinen erfolgreichen Speicherlauf.

Die isolierte Pfadauflösung aus dem unveränderten [Save-only-Bundle](https://github.com/actions/cache/blob/55cc8345863c7cc4c66a329aec7e433d2d1c52a9/dist/save-only/index.js) von `actions/cache` 6.1.0 reproduziert unter Node 24.22.1 den Fehler mit 140.000 simulierten direkten Dateien. Der Stack zeigt auf `stack.push(...childItems.reverse())` im gebündelten Glob-Helfer. 110.000 simulierte alte Dateien plus 256 Präfixordner werden erfolgreich aufgelöst. Das ist ein nachgewiesener Mechanismus, der zu den Veröffentlichungsfehlern passt; die tatsächliche Dateizahl und der vollständige Stack des betroffenen Runners wurden nicht protokolliert.

Ohne einen gespeicherten neuen Cache können spätere Runner wiederholt dieselben frühen Jahrgänge abarbeiten. Bereits veröffentlichte Ergebnisse bleiben im öffentlichen Katalog erhalten, dessen normalisierte Datensätze jedoch nicht sämtliche Import-Evidenz ersetzen. Die kleine Speicherreparatur verteilt deshalb neue Parsed-Cache-Dateien auf Hash-Präfixordner und liest alte flache Dateien einschließlich ihrer ursprünglichen Prüfzeitpunkte weiterhin. Checkpoints, Workflow-Cache-Pfad, Cache-Schlüssel und Archivformat bleiben kompatibel. Ein erfolgreicher künftiger Speicherlauf muss zusätzlich am tatsächlichen Veröffentlichungsprotokoll geprüft werden.

## Zusätzlich geprüft: Zeitbudget der Veröffentlichung

Der erste Veröffentlichungslauf der Ortsreparatur, [42820266666](https://github.com/carstenartur/Unfallatlas/actions/runs/42820266666/job/129843723806), wurde am 10. November 2026 nach 65 Minuten im RIS-Refresh beendet. Der Prozess begann um 13:04:26.947 UTC; der erste Hannover-Quellenfortschritt erschien erst um 13:15:48.952. Beim Abbruch um 14:09:27.120 lief noch der Dokumentabruf. Der Quellen-Worker startet im Code erst nach Wiederherstellung und Prüfung des vorhandenen Katalogs sowie der Vorbereitung des Kandidaten. Seine eigene 60-Minuten-Grenze und das 58-Minuten-Quellenbudget waren deshalb noch nicht erreicht. Ein eingefrorener Quellenzeitpunkt ist hier nicht die Ursache: Die Historienabfrage misst ihre Laufzeit bereits monoton.

Die ergänzende Budgetkorrektur gibt Pages deshalb ein ausdrückliches Gesamtbudget mit gemeinsamem monotonem Startpunkt. Beim tatsächlichen Quellenstart werden die bereits verbrauchte Vorlaufzeit, zwei Minuten Worker-Nachlauf und fünf Minuten Abschlussreserve berücksichtigt. Vorhandene Quellenobergrenzen werden dabei nur verkürzt. Bei ausgeschöpftem Quellenfenster greift der bestehende geprüfte Fallbackpfad; ohne die neue Option bleibt das Verhalten einzelner Standalone-Aufrufe erhalten. Die äußere 65-Minuten-Grenze und die 120-Minuten-Grenze des Workflows bleiben bestehen.

Zur Einordnung der Abschlussreserve: Im vorherigen erfolgreichen [109.560-Vorgänge-Lauf](https://github.com/carstenartur/Unfallatlas/actions/runs/42806710672/job/129815162432) lagen rund 78,4 Sekunden zwischen dem letzten Dokumentfortschritt und der Meldung des fertig geschriebenen Hannover-Katalogs. Das ist ein gemessener Vergleichswert, keine garantierte Obergrenze für beliebige Datenbestände. Der abgebrochene Lauf verwendete noch die alte flache Cache-Speicherung und meldete auch dort erneut `Maximum call stack size exceeded`; seine Reparaturdaten wurden nicht veröffentlicht. Die Stichprobenzahlen dieses Berichts bleiben davon unverändert lokale Prüfergebnisse.

## Vollständige feste Stichprobe

Strata: **NS** `no_specific_location`, **UN** `unverified_name`, **UL** `unmapped_location`, **DT** `document_text_unavailable`, **RG** regional `gazetteer_unavailable`. „Offen“ bezeichnet die lokale Wiederholung; F/A/K entsprechen der obigen manuellen Einordnung. X wurde wegen fehlendem Sachtext nicht erneut gerechnet. Alle 34 hatten im geprüften öffentlichen Ausgangsbestand keine Geometrie.

| Nr. | ID und amtliche Quelle | Stratum | Kurzer Befund | Nach Reparatur |
|---|---|---|---|---|
| 01 | [hannover-sim:15-1044-2007S1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-1044-2007S1) | NS | Zentrum Bemerode gewünscht; kein konkretes Gebäude gewählt. | offen · A |
| 02 | [hannover-sim:15-2726-2007](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2726-2007) | NS | Eisfabrik operativ als Empfänger; Ausstellungsort erst in Begründung. | offen · F |
| 03 | [hannover-sim:15-0075-2014](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0075-2014) | NS | Bezirksweite Statistik zu Energiesperren, keine Einzeladresse. | offen · K |
| 04 | [hannover-sim:15-2723-2018S1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2723-2018S1) | NS | Verkehrszeichen im gesamten Bezirk, keine konkrete Straße. | offen · K |
| 05 | [hannover-sim:15-0533-2023](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0533-2023) | NS | Quellenschreibweise „Willhelm“ und komplexe Ortsliste; Fricke-Weg in voller Länge. | offen · F |
| 06 | [hannover-sim:15-1541-2026F1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-1541-2026F1) | NS | Amtliche Antwort enthält Kreuzung Elmstraße/Schwarzwaldstraße. | **verortet** |
| 07 | [hannover-sim:2535-2020](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/2535-2020) | NS | Geschäftsordnung des Rates, kein räumliches Vorhaben. | offen · K |
| 08 | [hannover-sim:15-2725-2008](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2725-2008) | UN | Zwei Wege zwischen Straßen; Abkürzungen und Hausnummernanker. | offen · F |
| 09 | [hannover-sim:15-1046-2010S1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-1046-2010S1) | UN | Rodelberg am Märchensee; Holzwiesen hat zwei Straßenkennungen. | offen · A |
| 10 | [hannover-sim:15-2139-2018](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2139-2018) | UN | Schulstandort am Sonnenweg; Titel nennt eine größere Radroute. | offen · A |
| 11 | [hannover-sim:15-2724-2022](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2724-2022) | UN | Zwei Straßenabschnitte; Eckerstraße geht neben Sodenstraße verloren. | offen · F |
| 12 | [hannover-sim:15-1618-2025](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-1618-2025) | UN | Clemensstraße/Feuerwehrstraße neben Quartiersgrenzen genannt. | offen · F |
| 13 | [hannover-sim:15-2723-2009](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2723-2009) | UL | Umleitung über Holzmarkt; Straße nur als Text erkannt. | offen · F |
| 14 | [hannover-sim:15-2609-2007](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2609-2007) | UL | Begrenzter Bereich der Wülfeler Straße beim Annastift. | offen · A |
| 15 | [hannover-sim:15-2723-2019S1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2723-2019S1) | UL | Display nahe unbenanntem Kindergarten; ganze Straße wäre zu weit. | offen · A |
| 16 | [hannover-sim:15-1127-2018](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-1127-2018) | UL | Radfurt an abknickender Vorfahrt beim Autohaus; nur Straßentext. | offen · F |
| 17 | [hannover-sim:2990-2020F1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/2990-2020F1) | UL | Häuser in Schulenburger Landstraße; Hausnummern fehlen. | offen · A |
| 18 | [hannover-sim:15-2054-2024](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2054-2024) | UL | Querung Liepmannstraße; alternative Endpunkte und Häuser 17/19. | offen · F |
| 19 | [hannover-sim:15-2055-2025](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2055-2025) | UL | Abschnitt beginnt an einer benannten Bäckerei; Punkt ungeprüft. | offen · A |
| 20 | [hannover-sim:2536-2003](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/2536-2003) | DT | Operativer Text wieder da; Bestellung von Unternehmensvertretern. | offen · K |
| 21 | [hannover-sim:0423-2002](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/0423-2002) | DT | Operativer Text wieder da; Weg/Platz mit Endpunkten, noch ohne Geometrie. | offen · F |
| 22 | [hannover-sim:0424-2010](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/0424-2010) | DT | Operativer Text wieder da; Verlagerung zwischen zwei Schulstandorten. | offen · F |
| 23 | [hannover-sim:15-1541-2017](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-1541-2017) | DT | Operativer Antrag wieder da; Veranstaltungsort erst in Begründung. | offen · F |
| 24 | [hannover-sim:H-0605-2021](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/H-0605-2021) | DT | Operativer Text wieder da; Förderpolitik ohne konkretes Bauvorhaben. | offen · K |
| 25 | [hannover-sim:15-1619-2021](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-1619-2021) | DT | Operativer Text wieder da; Vorhänge in benannter Kultureinrichtung. | offen · F |
| 26 | [hannover-sim:H-0169-2021](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/H-0169-2021) | DT | Operativer Text wieder da; Haushaltssteuerung ohne Einzelort. | offen · K |
| 27 | [region-hannover-ris:vo:3120](https://ris.hannit.de/public/vo020?VOLFDNR=3120) | RG | Zugriffsprüfung statt Vorlage; Schulversuch laut Katalogtitel. | nicht prüfbar · X |
| 28 | [region-hannover-ris:vo:3135](https://ris.hannit.de/public/vo020?VOLFDNR=3135) | RG | Zugriffsprüfung statt Vorlage; Tournee laut Katalogtitel. | nicht prüfbar · X |
| 29 | [region-hannover-ris:vo:5513](https://ris.hannit.de/public/vo020?VOLFDNR=5513) | RG | Zugriffsprüfung statt Vorlage; Personalqualifizierung laut Titel. | nicht prüfbar · X |
| 30 | [region-hannover-ris:vo:1004946](https://ris.hannit.de/public/vo020?VOLFDNR=1004946) | RG | Zugriffsprüfung statt Vorlage; Jahresabschluss laut Katalogtitel. | nicht prüfbar · X |
| 31 | [region-hannover-ris:vo:1004929](https://ris.hannit.de/public/vo020?VOLFDNR=1004929) | RG | Zugriffsprüfung statt Vorlage; Bergwerksfrage laut Katalogtitel. | nicht prüfbar · X |
| 32 | [region-hannover-ris:vo:2004948](https://ris.hannit.de/public/vo020?VOLFDNR=2004948) | RG | Zugriffsprüfung statt Vorlage; Maschseeflotte laut Katalogtitel. | nicht prüfbar · X |
| 33 | [region-hannover-ris:vo:1007252](https://ris.hannit.de/public/vo020?VOLFDNR=1007252) | RG | Zugriffsprüfung statt Vorlage; Förderprogramm laut Katalogtitel. | nicht prüfbar · X |
| 34 | [region-hannover-ris:vo:1007262](https://ris.hannit.de/public/vo020?VOLFDNR=1007262) | RG | Zugriffsprüfung statt Vorlage; Änderungsantrag laut Katalogtitel. | nicht prüfbar · X |
