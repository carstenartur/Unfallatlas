# Hannoveraner Straßenknoten, Schulen und Kitas in Ortsrevision 11

Ausgangspunkt ist [Revision 10](2026-11-11-ris-public-sites.md) auf dem Quellenstand vom 08.11.2026, 17:02:48 UTC. 101.789 Vorgänge hatten keine Kartenlage. Davon kamen 87.750 aus dem städtischen Sitzungsmanagement, 14.024 aus dem Regions-RIS und 15 aus dem Landtag.

| Sichtung der unkartierten Titel | Ergebnis |
|---|---:|
| Städtische Verkehrstitel mit zwei amtlichen Straßennamen, getrennt durch einen Schrägstrich, und einem eindeutigen gemeinsamen Straßenknoten | 193 |
| Entsprechend formulierte Titel ohne eindeutigen gemeinsamen Knoten | 37 |
| Städtische Titel zu Radverkehr, Tempo 30 oder Straßenerneuerung mit genau einem erkannten Straßennamen | 796 |
| Bau-, Sanierungs- oder Erweiterungsbegriffe zusammen mit Schul- oder Kita-Begriffen | 498 Stadt, 21 Region |
| Städtische Sanierungstitel mit Kindertagesstätte, Straßenname und Hausnummer im Wortlaut | 6 |

Die Gruppen überschneiden sich. Eine genannte Straße kann die Zufahrt zu einem Bauwerk, einen Wegabschnitt oder lediglich eine Vergleichsstelle bezeichnen. Bei Schul- und Kita-Titeln kann eine Erweiterung auch zusätzliche Gruppen oder Schulzüge meinen.

## Ampeln und Querungen

Eine engere Prüfung auf singuläre Ampel- und Querungsbetreffe ergab 102 potenzielle neue Kartenfälle. Für jeden dieser Vorgänge wurden die Inhaltsabsätze der amtlichen Drucksache gesondert gelesen. 85 Vorgänge mit 86 Kartenbezügen sind durch eine konkrete Textstelle und einen eindeutigen gemeinsamen Knoten aller genannten Straßenachsen belegt. Im [Belegregister](../../config/ris-locations/hannover-verkehrsknoten.json) stehen die Vorgangs-ID, der Titel, die Straßen und der kurze Originalauszug. Die kartierte Kreuzung bezeichnet den Orientierungspunkt auf den amtlichen Straßenachsen. Die Fundstelle in der Werkbank nennt den Originaltext. Am 11. November 2026 wurden alle 85 amtlichen HTML-Seiten erneut abgerufen. Alle 86 Auszüge waren wörtlich in den Inhaltsabsätzen enthalten. Zwei Anfragen benötigten nach einem Timeout einen zweiten Abruf. Ein geänderter aktueller Betreff hebt die Zuordnung zum geprüften Projekt auf, auch wenn ein früherer Betreff noch gespeichert ist.

- [15-0054/2007](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0054-2007) fordert die Installation einer Lichtsignalanlage an der Einmündung Davenstedter Markt/Carlo-Schmid-Allee. [15-0265/2012](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0265-2012) nennt die Kreuzung Abelmannstraße/Landwehrstraße als Ort des vorgeschlagenen Fußgängerüberwegs.
- [15-0147/2006](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0147-2006) trägt den Betreff „Ampelanlage Emslandstraße / Bemeroder Straße“. Im Text stehen zwei räumlich getrennte Kreuzungen. Lange-Hop-Straße/Bemeroder Straße liegt bei 9,821157° O, 52,346094° N und Alte Bemeroder Straße/Emslandstraße bei 9,821194° O, 52,345165° N. Beide erhalten einen getrennten Beleg.
- In [15-0449/2009 F1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0449-2009F1) treffen Hildesheimer Straße, Wilkenburger Straße und Behnstraße an einem amtlichen Knoten zusammen. Entsprechendes gilt für Bünteweg, Bemeroder Straße und Aspelweg in [15-0533/2024 F1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0533-2024F1).
- 17 der 102 geprüften Titel ergeben über diese Regel keine zusätzliche Karte. So beschreibt [15-0372/2025](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0372-2025) den Fußgängerzugang zum Hochbahnsteig Riechersstraße. Bei [15-1087/2013](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-1087-2013) wechselt der Ortsbezug vom Straßennamen im Titel zum Weißekreuzplatz im Beschlusstext. Straßennamen aus einer Überschrift oder einem anderen Vorgang reichen hierfür nicht aus.

## Regionale Radverkehrsvorlagen

Unter den 14.024 regionalen Vorgängen ohne Kartenlage stehen auch konkrete Verkehrsmaßnahmen. Für den [Radweg an der K 102 zwischen Resse und Scherenbostel](https://ris.hannit.de/public/vo020?VOLFDNR=1004102) nennt der veröffentlichte Betreff zwei Orte. Für die [Verbindung Hannover–Lehrte](https://ris.hannit.de/public/vo020?VOLFDNR=2005251) beschränkt er die Asphaltierung auf den ersten Teilabschnitt. Für die [neuen Radverkehrszählstellen](https://ris.hannit.de/public/vo020?VOLFDNR=2005298) fehlt im Betreff die Standortliste. Die drei Detailabrufe endeten bei dieser Nachprüfung mit einem Timeout. Für die beiden Strecken fehlen hier die belegten Baugrenzen, für die Zählstellen die einzelnen Standorte. Alle drei Vorgänge bleiben recherchierbar. Die Karte erhält aus diesen Betreffen keine Koordinaten.

## Schulgebäude und historische Kita-Standorte

Für 15 Grundschulen stimmen Name und Adresse zwischen der [städtischen Schulbezirksanlage von 2015](https://e-government.hannover-stadt.de/lhhsimwebdd.nsf/2A4004DA5D6B5BC8C1257E000026F9A0/%24FILE/0594-2015_Anlage1.pdf), dem [Schulentwicklungsplan von 2025](https://e-government.hannover-stadt.de/lhhsimwebdd.nsf/D05888E9E1D719B7C1258CAD001B4714/%24FILE/1078-2025-N1_Anlage1.pdf) und dem [städtischen Schulverzeichnis](https://www.hannover.de/Leben-in-der-Region-Hannover/Bildung/Schulen/Allgemeinbildende-Schulen-Stadt/Grundschulen) überein. Jede Adresse hat eine bestätigte LGLN-Hauskoordinate. Berücksichtigt werden standortgebundene Arbeiten am Bestand ab 2016. Für Wettbergen belegt bereits die [Vorlage vom 04.03.2010](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/0721-2010) den Standort In der Rehre 43. Beispiele sind [Brandschutzmaßnahmen in Wettbergen](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/1282-2025) sowie [Unterdecken im Treppenhaus der Grundschule Ahlem](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/0239-2026). Ein Interimsstandort wie in [0089/2026](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/0089-2026) benötigt einen eigenen Adressbeleg.

Alle sechs genannten Kita-Vorlagen wurden einzeln geprüft. Das [Ortsverzeichnis](../../config/ris-locations/hannover.json) bindet die historische Maßnahmenadresse an Vorgangs-ID, Originaltitel und amtlichen Straßenschlüssel. [15-0422/2010](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0422-2010) nennt den Stadtbezirk Misburg-Anderten. Zwei amtliche Straßen namens Waldstraße führen die Hausnummer 11. Die Gebäude in der List (30163) und in Misburg-Nord (30629) liegen etwa 6,9 km auseinander. Für die Kindertagesstätte ergibt die Prüfung 9,853711° O, 52,392847° N. Die [Misburger Adresse](https://www.openstreetmap.org/relation/14287012) und die [List-Adresse](https://www.openstreetmap.org/node/1971450299) lassen sich unabhängig vergleichen. Die Karte bezeichnet jeweils den historischen Gebäudestandort oder die dazugehörigen Außenanlagen.

## Vollständiger Datenvergleich

| Hannover | Revision 10 | Revision 11 |
|---|---:|---:|
| Vorgänge | 109.569 | 109.569 |
| Stadt mit Kartenlage | 7.749 | 7.864 |
| Region mit Kartenlage | 31 | 31 |
| Land mit Kartenlage | 0 | 0 |
| Insgesamt mit Kartenlage | 7.780 | 7.895 |
| Unterschiedliche Geometrien | 3.315 | 3.343 |

Die reguläre Neubeurteilung und der Vergleich aller IDs ergeben 115 zusätzliche Kartenfälle (85 Verkehrsvorgänge, 24 Schulvorlagen, 6 Kita-Vorlagen). Alle zuvor kartierten Vorgänge behielten mindestens eine Kartenlage. Alle 91 in den beiden Vorgangsregistern geführten Datensätze hatten in beiden Beständen den aktuell geprüften Titel. Die Quellzeit blieb unverändert. Die lokale Generation lautet `80169652e3a1403e9d22080b3cb840d2c2707578643290c40482c0ebbd7b4b64`.
