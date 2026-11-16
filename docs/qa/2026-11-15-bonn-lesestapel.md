# Bonner Lesestapel 001 vom 15. November 2026

Der lokale Abgleich des Bonner RIS-v2-Katalogs mit dem Ratsatlas-Export ergab
23.367 unverortete Vorgänge unter 25.206 amtlichen IDs. Zu 2.546 passen
Volltexthinweise bei identischer Paper-URI und Drucksachennummer, darunter
1.596 mit einem Straßenhinweis. Das sind Prüfkandidaten. Für eine Hochrechnung
der künftig kartierbaren Vorgänge ist der nach diesen Hinweisen priorisierte
Stapel ungeeignet.

## Abruf und Lektüre

Der erste feste Abschnitt der Bonner Warteschlange umfasst 100 Positionen.
Für 90 Hauptdokumente liegen 1.307.328 Textzeichen und einzelne Befunde vor.
Die anderen zehn behalten ihre Plätze 91–100. Neun neue GraphQL-Sammelabfragen
und ein früherer Sammelabruf an OParl-Lite Bonn übertrugen am 15. November
zusammen 1.475.467 Antwortbytes. Für diesen Stapel gab es null kommunale
Serveranfragen. Der identische Offline-Lauf erzeugte einen bytegleichen
100er-Auszug. Ein lokaler 1.000er-Auszug enthielt dieselben 90 verfügbaren
Haupttexte.

Der Textimport prüft die Original-Datei-URI und zugehörige Paper-URI.
Bei neun vorhandenen Versionen war die Beziehung schon aus den lokal
gespeicherten amtlichen Paper-Objekten belegt. Ein Fall aus diesen neun
ist auch Position 1 des neuen Stapels. Die Einzelvermerke enthalten somit
90 gesichtete Fälle im Stapel und acht weitere aus der Vorprüfung. Gesondert
gekennzeichnet sind ausstehende Originalanlagen, nur teilweise gesichtete
Sammeldokumente und nicht textlich erschließbare Bildseiten. Für die acht
Vorprüfungen **außerhalb** der festen 100 Positionen sind jetzt ausdrücklich
konservative Einzelbewertungen hinterlegt. Sie ersetzen weder die vollständige
Lektüre aller Anlagen noch den Nachweis einer Maßnahme oder Geometrie; ihre
früheren Quellverweise, Text- und Versionshashes bleiben unverändert. Ein
regressionsgeprüfter Abgleich der Lesebilanz hält die zehn ungelesenen
Positionen 91–100 und die Trennung von R1–R7 fest. Die Abwesenheit
eines Textes liefert keinen Negativbefund. Jede Angabe zu einem Beschluss,
Antrag, Finanzierungsvorschlag oder Prüfstandort ist an das jeweilige
Dokument gebunden.

[Einzelvermerke mit ursprünglichen Datei-URIs, Seiten, SHA-256 der erhaltenen Texte, Versionskennungen und offenen Positionen](2026-11-15-bonn-lesestapel-001.json)

## Wiederaufbau und Bestandsvergleich

| Bonner Bestand | Vorher, Revision 6 | Offline erzeugt und wieder gelesen, Revision 7 |
| --- | ---: | ---: |
| Amtliche Vorgangs-IDs | 25.206 | 25.206 |
| Vorgänge mit mindestens einer Geometrie | 1.839 | 1.856 |
| Kartenfeatures | 1.840 | 1.869 |

Die 17 zusätzlich kartierten Vorgänge umfassen 16 aus dem 100er-Stapel
und die Vorlage 190001 aus der Vorprüfung. Die 1.840 bisherigen Features
wurden einschließlich Geometrie und Eigenschaften einzeln verglichen. Sie
stimmen vollständig überein. Drei bereits verortete Vorgänge erhalten beim
regulären Wiederaufbau den zusätzlichen Hinweis auf gekürzte gespeicherte
Textauszüge. Der Wiederaufbau selbst erforderte keine Quellabrufe.

* Die Planköpfe der Vorlage 210177 setzen die Schulerweiterung an die Hohe
  Straße 11. Die Rollen des Bauherrn und des Planungsbüros sind getrennt.
  [Vorlage 210177](https://www.bonn.sitzung-online.de/oparl/files/265553)
* Zwei Fördervorlagen betreffen unterschiedliche Leistungen im Haus der
  Vielfalt, Brüdergasse 16–18. Beide Dokumente belegen denselben Standort.
  [Vorlage 210355](https://www.bonn.sitzung-online.de/oparl/files/275267) · [Vorlage 210357](https://www.bonn.sitzung-online.de/oparl/files/275291)
* Für elf neu aufgestellte B-Pläne in 210522-01 ST stimmen Plan-ID,
  Inkrafttretensjahr und amtlicher Geltungsbereich mit der Beschlusstabelle
  überein. Bei fünf Änderungen älterer Pläne fehlt der belegte Umgriff der
  geänderten Fassung. [Amtliche Antwort, Seiten 1–2](https://www.bonn.sitzung-online.de/oparl/files/2011832)
* Der Windeckbunker ist in Vorlage 190001 Gegenstand eines
  Nachnutzungskonzepts und in 190065 ein vorgeschlagener Prüfstandort für ein
  Taubenhaus. Die getrennten Dokumentbelege erhalten diese unterschiedlichen
  Aussagen. [190001, Seite 4](https://www.bonn.sitzung-online.de/oparl/files/4) · [190065, Seite 1](https://www.bonn.sitzung-online.de/oparl/files/1046)
* Marquartstraße 6 (Villa), Am Neuen Lindenhof 13 (Spielplatz) und die
  Eselsfigur am Schickshof sind inhaltlich belegte Orte. Für die Kartenaufnahme
  fehlen im geprüften Material passende Einzelgeometrien. Der Hausnummernindex
  enthält keine Adresskoordinaten.

Bonner Ausgangsgeneration
`ff40877c2189cce18fb4d022cc22ab3a7eabb0a7de71f03602047075d2863280`.
Lokal geprüfte Generation
`4c71e279a6034af7735715684707c4fe7b256998bb5c3ccc9498b785c1f63753`.
SHA-256 des verwendeten Ratsatlas-Exports
`40628ac639482e5fe38f5c94c8f9190ff09b543e7b33c1b58588a883d68abcc3`.

Die Geometrien stammen aus dem amtlichen Bonner B-Plan-Datensatz (CC0 1.0,
Abrufstand 18.10.2026) und dem abgeleiteten Ortsregister aus OpenStreetMap
(© OpenStreetMap-Mitwirkende, ODbL 1.0, Abrufstand 21.10.2026). Ein
repräsentativer Objektpunkt bezeichnet den Standort, die amtlichen Polygone
den ausgewiesenen Geltungsbereich. Grundlage der Textprüfung ist OParl-Lite
Bonn von machdenstaat (CC BY 4.0). Das Protokoll enthält eigenständige
Paraphrasen. [Planregister](https://github.com/daimpad/ratsatlas-bonn/blob/f27d304ed1202b54de454e466f98c9096dc069e8/data/geo/bebauungsplaene_bonn.geojson) · [Ortsregister](https://github.com/daimpad/ratsatlas-bonn/blob/f27d304ed1202b54de454e466f98c9096dc069e8/data/geo/objekte_bonn.json) · [Quellen und Lizenzen](https://github.com/daimpad/ratsatlas-bonn/blob/f27d304ed1202b54de454e466f98c9096dc069e8/data/LICENSE-DATA.md)
