# Hannover: Welche Ratsvorgänge fehlen auf der Karte?

## Vollzählung des veröffentlichten Bestands

Das Pages-Artefakt 13807398658 zum Commit `bffcd7eaa581e6ce72461433b186147e9dce8e56` und der öffentlich abgerufene [Hannover-Katalog](https://carstenartur.github.io/Unfallatlas/data/ris/hannover.json) enthielten dasselbe Manifest. Ortsrevision 8, Generation `0761cd4f0e0098c8a975ded81eb8e4a3262a33d4a669f104f1ed380cf8e1acf2`, Quellenzeit 8. November 2026, 17:02 UTC. Alle Datensatzpartitionen wurden anhand der referenzierten Größe und SHA-256 geprüft. IDs und Summen stimmen mit dem Manifest überein.

| Quelle | Alle Vorgänge | Mit Kartenlage | Ohne Kartenlage |
|---|---:|---:|---:|
| Stadt Hannover | 95.490 | 7.053 | 88.437 |
| Region Hannover | 14.055 | 4 | 14.051 |
| Niedersächsischer Landtag | 15 | 0 | 15 |
| **Gesamt** | **109.560** | **7.057** | **102.503** |

Die folgende Tabelle zählt jede gespeicherte Begründung pro unkartiertem Vorgang einmal. Ein Vorgang kann mehrere Gründe tragen. Die [maschinell prüfbare Auswertung](ris-location-coverage-2026-11-10.json) enthält zusätzlich sämtliche überschneidungsfreien Kombinationen und die für die Bewertung verwendeten Quellenarten.

| Gespeicherter Grund | Stadt | Region | Land |
|---|---:|---:|---:|
| Kein spezifischer Ort beim automatischen Lesen erkannt | 78.354 | 266 | 4 |
| Erkannter Bezug ohne geeignete Geometrie | 7.027 | 3 | 0 |
| Name nicht eindeutig bestätigt | 1.289 | 0 | 0 |
| Genaue Adresse aufgrund der Relevanz- oder Kontaktadressregel ohne Punkt | 2.132 | 0 | 0 |
| Dokumenttext als nicht verfügbar gekennzeichnet | 2.889 | 710 | 0 |
| Für das Dokument verfügbare Belege gekürzt | 781 | 5 | 0 |
| Ortsverzeichnis nicht sicher für die Maßnahme anwendbar | 0 | 13.782 | 11 |

Die Region veröffentlicht auch Vorgänge zu eigenständigen Gemeinden wie Garbsen, Lehrte und Wennigsen. Das eingecheckte ATKIS-Straßennetz und die Hauskoordinaten decken die Stadt Hannover ab. Bereits im Ausgangsstand dürfen Region und Land diese Geometrien verwenden, wenn die Maßnahme innerhalb desselben Belegs eindeutig zur Stadt gehört. Eine gleichnamige Straße außerhalb der Stadt, ein Sitzungsort oder die Bezeichnung „Region Hannover“ genügen nicht. Zu den 13.782 gehören auch Texte, in denen die vorhandenen Regeln den Stadtbezug nicht sicher erkennen. Für andere Gemeinden fehlen gemeindescharfe Ortsreferenzen; Quellenbeschränkungen kommen teilweise hinzu.

## Zufallsauswahl aus allen 102.503 offenen Vorgängen

Jede offene ID erhielt einen Rang aus SHA-256 über den Seed `hannover-unmapped-all-sources-2026-11-10`, einen Zeilenumbruch und die ID (UTF-8). Die ersten 16 Ränge wurden vor dem Lesen der amtlichen Dokumente gewählt. Es gab keine Vorfilter nach Titel, Thema, Quelle oder konkretem Ort und keinen Ersatz für einen fehlenden Sachtext. Die [Einzelfälle mit amtlichen URLs, Hashes und Befund](ris-location-coverage-2026-11-10.json) dokumentieren die Auswahl. Untersucht wurden die zugänglichen HTML-Sachtexte. Anhänge wurden nicht ausgewertet.

| Einordnung der gelesenen Fälle | Anzahl | Beispiele aus den Vorlagen |
|---|---:|---|
| Straße, Platz, Abschnitt oder Bahnhofsumfeld als Gegenstand | 5 | Parksituation Husarenstraße, Bonifatiusplatz, Baustelle Lange-Feld-Straße, Abbiegen aus der Uferzeile, P+R beim Bahnhof Anderten/Misburg |
| Benannte Einrichtung als Gegenstand oder Projektort | 4 | Lister Bad, Schulstandort In der Steinbreite, Olbersschule, Näh-Café in einer Unterkunft |
| Sammelförderung | 2 | Mehrere Empfänger und Projekte in einem Beschluss |
| Allgemeines Anliegen ohne konkreten Maßnahmenort im Sachtext | 4 | Friedhofsgebühren, politischer Antrag, allgemeine Verkehrskontrollen, bundesrechtliche Forderung |
| Inhalt nicht prüfbar | 1 | Das Regionalportal beantwortete den Abruf mit einer Zugriffsprüfung statt des Sachtexts. |

Für 15 von 16 ausgewählten Vorgängen war der amtliche HTML-Sachtext zugänglich. Die vier Einrichtungsfälle und die fünf Fälle im öffentlichen Raum sind verschieden präzise. Beim P+R-Antrag gehört die Suche nach einem Grundstück zum Auftrag. Zwei historische Entscheidungen verweisen für die Verwaltungsantwort auf eine Anlage. Die Inhalte der Stichprobe werden nicht auf die restlichen Vorgänge hochgerechnet.

## Was die Reparaturen in den festen Stichproben ändern

| Vorgang | Beleg und neue Zuordnung |
|---|---|
| [15-0533/2023](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0533-2023) | Der Parkraumantrag nennt den Ferdinand-Wilhelm-Fricke-Weg ausdrücklich in voller Länge. Die dokumentierte Schreibvariante mit doppeltem „l“ wird auf den eindeutigen LGLN-Straßenschlüssel 0324100100871 aufgelöst. Die Linie umfasst nur diese Straße. Die benachbarten Parkplätze werden dadurch nicht als Straßen kartiert. |
| [15-2140/2020 F1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2140-2020F1) | Titel und Verwaltungsantwort nennen den Knoten Hannoversche Straße / Grenzstraße / Louise-Schroeder-Straße. Nur ein Stützpunkt gehört zu allen drei Straßen: 9,827941° O, 52,384734° N. |
| [15-1619/2025](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-1619-2025) | Standortbezug der Querung Weidetorstraße / Pinkenburger Straße bei 9,807731° O, 52,397536° N. Osterfelddamm ist die Fahrtrichtung. Der Punkt bezeichnet die Straßenecke; der beantragte künftige Schilderstandort ist offen. |
| [2532/2003](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/2532-2003) | Für die Parkplätze vor der Einmündung Große Straße / Sackmannstraße bleibt ein Textort mit Quellenbeleg erhalten. Die Parkplätze liegen vor dem Knoten. |
| [15-1328/2007 S1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-1328-2007S1) | In der neuen Zufallsauswahl nennt der Beschluss das Linksabbiegen aus der Uferzeile in die Hannoversche Straße. Der nur einmal vorhandene gemeinsame Stützpunkt liegt bei 9,834506° O, 52,386716° N. |

Auf identischen archivierten Eingaben steigt die erste frühere Auswahl von 2 auf 3 kartierte Vorgänge (34 Fälle, 26 amtliche HTML-Dokumente und 8 Titel). Die zweite steigt von 1 auf 3 (24 Fälle, 4 amtliche HTML-Dokumente und 20 Titel). Beide neu kartierten Kreuzungen der zweiten Auswahl wurden anschließend zusätzlich gegen ihre erneut abgerufenen amtlichen Sachtexte geprüft. Die ersten beiden Auswahlen waren gezielt diagnostisch zusammengestellt worden.

Für den [regionalen Schulantrag 2000173](https://ris.hannit.de/public/vo020?VOLFDNR=2000173) stimmen Projekt, Straßenname, Hausnummer, Postleitzahl und Kommune mit der [Standortbestätigung der Region](https://www.hannover.de/content/download/1029323/file/Brosch%C3%BCre_Schulsanierungen_04122024.pdf) überein. Das Werkstattgebäude an der Ohestraße 3 B erscheint künftig als Textort. Die Verkehrsbewertung des Vorgangs gibt die präzise Adresse nicht für einen Kartenpunkt frei. Ein abweichender PLZ-/Gemeindebezug, ein Hausnummernbereich oder ein Kontakt-/Sitzungskontext kann diese Standortbestätigung nicht übernehmen.

## Vollständiger lokaler Vergleich der Ortsrevision

Für den gesamten Veröffentlichungssnapshot wurden der Mapper des Ausgangscommits und die reparierte Version auf genau dieselben 109.560 Vorgänge, Titel und gespeicherten Belegauszüge angewandt. Der bestehende Refresh- und Schreibpfad erstellte und validierte beide v2-Kataloge. Die ursprüngliche Quellenzeit blieb erhalten. Das Pages-Artefakt enthält weder die vollständigen amtlichen Sachtexte noch den separaten Actions-Quellcache. Bei dieser lokalen Wiederholung bekommen deshalb auch kartierte Datensätze die Kennzeichnung für unvollständige Evidenz.

| Messgröße | Alter Mapper, gleiche Eingaben | Ortsrevision 9, lokal |
|---|---:|---:|
| Vorgänge mit Kartenlage | 7.057 | 7.282 |
| Unterschiedliche Geometrien | 3.025 | 3.129 |
| Unkartierte Vorgänge | 102.503 | 102.278 |

285 Vorgänge erhalten erstmals einen Kartenbezug, bei 60 entfällt der bisherige letzte Bezug. Im vollständigen ID-Vergleich ging kein zuvor kartierter Hausnummernpunkt verloren. Die 60 Änderungen gliedern sich in 21 mehrarmige Knoten ohne eindeutigen gemeinsamen ATKIS-Stützpunkt, 19 zusätzliche ungeklärte Straßen- oder Wegebezüge, 17 Lagen vor, hinter oder gegenüber einem Knoten, zwei begrenzte Abschnitte anstelle einer ganzen Straße und einen alten Punkt am Richtungsziel Lister Platz. Bei diesem letzten Fall nennt der Text die Kollenrodtstraße und die Ferdinand-Wallbrecht-Straße als eigentliche Ecke. Für sie konnte kein eindeutiger gemeinsamer Punkt gewonnen werden. Die [vollständigen IDs und Gründe](ris-location-coverage-2026-11-10.json) machen die Zu- und Abgänge einzeln überprüfbar.

Alle 34 zuvor belegten Kombinationen aus Ortsart, genauem Namen und Geometrie der 32 kartierten Positivkontrollen blieben erhalten. Hinzu kamen die beiden bisher fehlenden Bezüge zur Ecke Ostergrube/Gollstraße in Antrag und Entscheidung. Der vollständige lokale Wiederaufbau konnte ausschließlich vorhandene Belege verwenden. Für den Ferdinand-Wilhelm-Fricke-Weg und die Parkplätze vor der Einmündung Große Straße/Sackmannstraße enthält er keinen operativen Text. Beide werden im gesonderten Vergleich auf Basis der gespeicherten amtlichen HTML-Quellen nachgewiesen.

## Reproduktion

Mit Node 26 und den Projektabhängigkeiten laufen die Mapper- und Refresh-Prüfungen einschließlich der lokalen Migration von Revision 8 auf 9. Die Vollzählung benötigt nur Python und den entpackten, vollständigen Veröffentlichungsstand.

```sh
python3 scripts/audit-ris-location-coverage.py /pfad/zu/data/ris/hannover.json --sample-size 16
npx jest --runInBand --runTestsByPath tests/unit/risLocation.test.js tests/unit/refreshRisCatalogues.test.js
```

Beim Merge auf `main` erfasst der vorhandene Workflow `deploy-pages-current-data.yml` die Änderungen in Parser, Referenzdaten und Refresh. Der normale manuelle Dispatch desselben Workflows ist ebenfalls möglich. Für die lokale Neubewertung bleibt die amtliche Quellenzeit erhalten.
