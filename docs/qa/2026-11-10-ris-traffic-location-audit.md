# Zweite RIS-Ortsprüfung: feste Verkehrsstichprobe vom 10. November 2026

Dokumentationsstand: lokale Prüfung vor der Veröffentlichung. Die anschließenden CI- und Live-Nachweise werden im Pull Request dieser Änderung festgehalten.

## Ergebnis und Geltungsbereich

Die Kartenabdeckung von **7.037 unter 109.560 Vorgängen, rund 6,4 %**, wird auch durch Fehlklassifikationen, Extraktionslücken und fehlende genaue Ortszuordnungen mitverursacht. Der nicht kartierte Rest darf nicht pauschal als inhaltlich ortslos eingeordnet werden. Diese zweite Diagnose findet konkrete Straßen, eine Adresse, Kreuzungen, Haltestellen und Maßnahmenbereiche unter weiterhin unverorteten Verkehrsvorgängen. Sie bestätigt zusätzliche technische Mechanismen, bestimmt aber **keinen repräsentativen Fehleranteil und keine erreichbare Gesamtzahl kartierbarer Vorgänge**.

Dabei sind drei Ergebnisse auseinanderzuhalten: Ein Text kann einen konkreten Ort nennen; der Mapper kann diesen Ort als Text erhalten; und erst eine ausreichend genaue, belegte Referenz erlaubt eine Kartenlage. Ein wiederhergestellter Straßenname rechtfertigt weder die ganze Straßenlinie noch einen frei gewählten Punkt. Die Fälle 01–04 zeigen außerdem, dass `no_specific_location` und `unmapped_location` unterschiedliche technische Grenzen zusammenfassen. Keiner dieser Statuswerte beweist für sich, dass eine Vorlage keine örtliche Maßnahme enthält.

Die Diagnose am Ausgangsstand und die anschließend durchgeführte **lokale Wiederholung auf identischen Eingaben** sind unten getrennt dokumentiert. Die geprüfte Wiederholung gewinnt in der zweiten Auswahl einen adressgenauen Punkt und einen weiteren Textort; in der ursprünglichen Auswahl kommt ein abgegrenzter Straßenabschnitt hinzu. **Lokaler Replay und unabhängige Review sind abgeschlossen; vollständige CI, Merge und Live-Veröffentlichung der ergänzenden Ortsrevision 8 sind noch offen.** Die ursprüngliche [34er-Stichprobe](2026-11-10-ris-location-audit.md), ihre Auswahl und ihre [Evidenzdatei](ris-location-audit-2026-11-10.json) bleiben unverändert. Die neue [kompakte Evidenzdatei](ris-traffic-location-audit-2026-11-10.json) hält alle 24 IDs, Auswahl-Hashes, Blattreferenzen, Abrufdaten, Belegstufen, Einzelbeurteilungen und die gesonderten Replay-Ergebnisse fest; sie enthält keine Dokumentvolltexte.

## Festgehaltener öffentlicher Ausgangsstand

Der [öffentliche Hannover-Index](https://carstenartur.github.io/Unfallatlas/data/ris/hannover.json) wurde am **10. November 2026 um 15:49:33.372 UTC** gelesen. Er enthält 109.560 Vorgänge, 7.037 Vorgänge mit mindestens einer Kartenlage und 3.018 Geometrien bei **Ortsrevision 7**. Der Quellenzeitpunkt lautet `2026-11-08T17:02:48.611Z`; er ist nicht der Abruf- oder Veröffentlichungszeitpunkt.

Die feste Generationskennung lautet:

`a7c0511de4677ad3c8ff1137528974c5acabf42647eadb1d3eafbd74e4ec665d`

SHA-256 der gelesenen Manifest-Bytes:

`9195527e605f02ff2f620f9ea66ba9e70b959e5e35973b09d67b84bb469dcfcb`

Der Nenner 109.560 umfasst den gesamten veröffentlichten Hannover-Katalog, einschließlich verschiedener Quellen und Themen. Die folgende Verkehrsauswahl beschränkt sich dagegen ausdrücklich auf `hannover-sim`. Sie ist keine Messung des Verkehrsanteils im Gesamtbestand.

## Auswahl und Reproduktion

Die Auswahl wurde vor dem Lesen der neuen amtlichen Texte am **15:49:39.687 UTC** festgeschrieben. Es wurden dieselben festen Baumpositionen wie bei der ersten Untersuchung verwendet, aber aus der oben genannten Revision-7-Generation: nullbasierte Wurzelpositionen `0,3,6,9,12,15,18,21,22,23,24,25,26` und jeweils Kindposition `17,47`. Das ergibt **26 Blätter aus 13 ID-Bereichen mit 1.656 Datensätzen**. Die Evidenzdatei enthält für jedes Blatt Pfad, SHA-256, Größe und Datensatzanzahl sowie die zugehörigen Indexwurzeln. Blatt-Hashes und Größen beziehen sich auf die entpackten JSON-Bytes.

Der feste Seed lautet `hannover-unmapped-traffic-diagnostic-2026-11-10-v1`. Die Auswahl erfolgt in diesen Schritten:

1. Den festen Blattpool lesen und die Inhalts-Hashes sowie Größen prüfen. Nur städtische Datensätze der Quelle `hannover-sim` mit Status `unresolved` oder `unavailable` berücksichtigen.
2. Titel deutsch kleinschreiben, mit Unicode NFD zerlegen und kombinierende Zeichen entfernen. Die festgelegten Suchmuster sind `verkehr`, `radweg`, `fahrrad`, `gehweg`, `querung`, `parkplatz`, `ampel`, `kreuzung`, `haltestelle`, `fahrbahn` und `\btempo(?:\b|\d)`. Teilwortsuche erfasst auch Zusammensetzungen; der Verkehrsfilter garantiert weder einen konkreten Ort noch einen Parserfehler.
3. Alle 34 bisherigen IDs und ihre bekannten Vorgangsfamilien ausschließen. Familien entstehen transitiv aus `relatedTo` sowie gemeinsamen SIM-Basis-IDs, nachdem nachgestellte Buchstaben-/Ziffernfolgen wie `F1` oder `N1S1` entfernt wurden. Die genaue Regel und sämtliche ausgeschlossenen IDs stehen in der Evidenzdatei. Von den 134 passenden unverorteten Datensätzen entfallen sieben auf bisherige Familien, darunter vier identische bisherige IDs; es sind nicht elf zusätzliche Ausschlüsse.
4. Das Jahr aus der Drucksachennummer, ersatzweise aus dem Datum bestimmen. Je acht unterschiedliche Familien aus den Epochen vor 2010, 2010–2019 und ab 2020 wählen. Innerhalb jeder Epoche nach `SHA-256(Seed + LF + ID)` aufsteigend sortieren; bei gleichem Hash entscheidet die ID. Der Hash verwendet UTF-8 ohne abschließenden Zeilenumbruch. Bereits ausgewählte Familien überspringen. Nur wenn eine Epoche zu klein wäre, würden freie Plätze aus den verbleibenden Hash-Rängen aufgefüllt.
5. Für die 24 gewählten Datensätze alle vorhandenen Orts- und Geometrieverknüpfungsseiten lesen und **null Geometrieverknüpfungen** bestätigen. Es wurden keine weiteren Blätter oder Titel nach passenden Fehlerfällen durchsucht und keine Quoten nach Fehlergründen verwendet.

Nach dem Familienausschluss blieben **127 Datensätze in 75 Familien**: 21 vor 2010, 52 aus 2010–2019 und 54 ab 2020. Alle drei Epochenquoten von acht Fällen wurden erfüllt. Der Reader prüfte insgesamt 74 verschiedene Assets; die eingestellte Parallelitätsgrenze war acht, beobachtet wurden höchstens sieben gleichzeitige Ladevorgänge.

SHA-256 der geordneten 24 IDs, mit `LF` verbunden und einem abschließenden `LF`:

`ff781c6d59d2c34c58e97d495cb41ae74aa4f511f8582443f9b4a89d0e395595`

Die fixierten Baumpositionen und die bewusste Titel-/Statusauswahl bilden **keine Zufallsstichprobe des Gesamtbestands**. Der Seed macht die Auswahl reproduzierbar, nicht repräsentativ. Spätere Reparaturergebnisse dürfen die Auswahl nicht verändern.

### Einordnung im festen Blattpool

Von den 1.656 Datensätzen des Blattpools stammen 1.216 aus `hannover-sim`. Vor dem Ausschluss bisheriger Familien erfüllen 166 davon den Verkehrs-Titelfilter:

| Status im festen Pool | Mit `document`-Provenienz | Ohne `document`-Provenienz | Gesamt |
|---|---:|---:|---:|
| `mapped` | 23 | 0 | 23 |
| `partial` | 9 | 0 | 9 |
| `unresolved` | 130 | 4 | 134 |
| `unavailable` | 0 | 0 | 0 |
| **Verkehrstitel zusammen** | **162** | **4** | **166** |

Damit sind in diesem festen Ausschnitt 32 Verkehrsvorgänge ganz oder teilweise kartiert und 134 weiter unverortet. Bei 130 der 134 unverorteten Vorgänge enthält `locationAssessment.sources` den Wert `document`. Das ist eine Angabe zur **Provenienz der bisherigen Bewertung**, kein Beweis für vollständigen Dokumenttext, die Erfassung aller relevanten Abschnitte oder einen erneuten amtlichen Abruf in diesem Audit. Aus dieser Kreuztabelle wird keine Quote für alle 109.560 Vorgänge abgeleitet.

## Welche Quellen tatsächlich gelesen wurden

**Nur für 01–04** liegen neu abgerufene amtliche HTML-Dokumente vor; diese wurden inhaltlich gelesen. Die Abrufe von **05–08 endeten mit Timeout**, die von **09–24 mit einer lokalen `CONNECT`-Ablehnung `403 Forbidden`**. Letzteres ist keine verifizierte HTTP-403-Antwort des amtlichen Ursprungsservers. Für die übrigen 20 Fälle wurde kein passender lokaler Quelltext-Cache gefunden. Ihre neue Beurteilung beruht auf den veröffentlichten Titeln, den gespeicherten Bewertungs-/Ortsmetadaten und gegebenenfalls einem lokalen Gazetteer-Namensabgleich.

Die Abrufprotokolle enthalten für jeden Fall URL und Zeitpunkt, für 01–04 außerdem SHA-256 und Bytezahl der tatsächlich gelesenen Antwort. Das ursprünglich `retrievedAt` genannte Feld wird vom Abrufskript am Beginn des Versuchs gesetzt; es ist kein Abschlusszeitpunkt. Es wurden nur die ausgewählten öffentlichen HTML-URLs angefragt, höchstens vier gleichzeitig. Weiterleitungen, Login, Cookies, PDFs, Anlagen und zusätzliche Links wurden nicht genutzt.

Die ursprüngliche Abbrucherkennung erfasste direkte HTTP-Fehler und HTML-Zugriffsprüfungen, erkannte jedoch die als `URLError` gemeldeten Proxy-`CONNECT`-Ablehnungen zunächst nicht. Der Batch war bei der Inspektion bereits beendet. Die Erkennung wurde anschließend berichtigt, **aber der direkte Batch wurde nicht erneut ausgeführt und enthielt selbst keine Retries**.

Für die vier Timeout-URLs **05–08** gab es danach noch je einen Leseversuch über das Recherchetool. Alle vier lieferten „not accessible“ und keinen Inhalt. Für die `CONNECT`-gesperrten URLs **09–24** gab es keine solchen Folgeversuche. Ein Browser wurde nicht verwendet; es folgten keine weiteren Versuche. Die vier zusätzlichen Versuche sind in der Evidenzdatei separat erfasst und verändern die Belegbasis nicht. Es wurden weder Zugriffsgrenzen umgangen noch Fälle oder Quellen ersetzt.

Bei 15 der 20 nicht erneut gelesenen Fälle nennt bereits der Titel einen konkreten Ort oder Korridor; fünf Titel sind allgemein. Das sind **weder 15 bestätigte Parserfehler noch fünf nachgewiesen ortslose Dokumente**. Insbesondere enthalten die gespeicherten Metadaten zu den allgemein betitelten Fällen 06 und 07 bereits unkartierte Textorte. In der getrennten Titelprüfung von 13–24 ergeben sich neun konkrete und drei allgemeine Titel; keiner ihrer Volltexte wurde neu gelesen.

## Bestätigte Mechanismen und verbleibende Grenzen

### 01: Parkplatzbereich vor einer Einmündung

[2532/2003](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/2532-2003) beantragt den Verzicht auf zwei geplante Parkplätze **kurz vor** der Einmündung der Großen Straße in die Sackmannstraße. Der Ausgangsmapper erhält keinen Ort. Die Relationsform „Einmündung X in Y“ wird nicht ausreichend erfasst. Zugleich begrenzt „kurz vor“ die Aussage: Ein aus Straßenlinien berechenbarer Kreuzungspunkt wäre nicht automatisch der belegte Parkplatzstandort. Die fehlende Erkennung und die noch unbestimmte genaue Maßnahmengeometrie sind getrennte Probleme.

### 02: Knotenpunkt erkannt, genaue Referenz fehlt

[15-2726/2009 F1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2726-2009F1) nennt in der Verwaltungsantwort den Knotenpunkt Lister Meile/Kurt-Schumacher-Straße. Dieser ist bereits als Textort vom Typ `junction` gespeichert. Die geprüften ATKIS-Linien besitzen aber keinen gemeinsamen Vertex: Ein gespeicherter Beginn der Lister Meile liegt bei `[9.739993, 52.377187]`, ein Ende der Kurt-Schumacher-Straße bei `[9.739417, 52.37685]`.

Damit ist eine Grenze der aktuellen geometrischen Zuordnung belegt. Nicht belegt sind die historische Ursache, eine Veränderung seit 2009 oder ein genauer Ersatzpunkt. Ein Verbindungsstück, eine geratene Kreuzungsmitte oder eine Aussage zur historischen Straßenführung wird daraus nicht abgeleitet.

### 03: Zusammengesetzter Verkehrsbegriff als vermeintliche Ortsliste

[15-0606/2005](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0606-2005) benennt im Titel einen Geh- und Fahrradweg und im operativen Text einen Fuß- und Fahrradweg an der Wilkenburger Straße. Die [Ausgangsregel `MULTIPLE_LOCATIONS`](https://github.com/carstenartur/Unfallatlas/blob/bc48708e9ff4c97997b4363334b80e515b40c135/server/political-context/services/risLocation.js#L16) behandelt das `und` als mögliche Verknüpfung mehrerer Orte. Dadurch geht hier sogar der belegte Textort verloren.

Eine isolierte Diagnosekontrolle blendet ausschließlich dieses `und` innerhalb eng begrenzter Zusammensetzungen wie `Geh- und Fahrradweg` bzw. `Fuß- und Radweg` für die Abbruchprüfung aus. Originaltitel, Originalbeleg und Geometrieregeln bleiben dabei unverändert. Damit erscheint **Wilkenburger Straße als Textort ohne Geometrie**. Das ist der erwartbare Erkenntnisgewinn; es ist noch keine neue Kartenlage.

Zwölf begleitende Kontrollen änderten ihr bisheriges Ergebnis nicht. Sie betreffen echte Ortslisten und Alternativen, begrenzte Abschnitte, gegenüberliegende Orte, Schrägstrich/Semikolon, Straßenname-Auslassungen, unabhängige Handlungen, vollständig ausgeschriebene koordinierte Begriffe, Hausnummernbereiche, unvollständige Endpunkte und einen weiteren Gemeindebezug. Unverändertes Verhalten bescheinigt diesen Beispielen nicht pauschal semantische Richtigkeit; es begrenzt nur den beobachteten Eingriff. Eine globale Umschreibung des Originals zu `Radweg` wäre ungeeignet, weil sie zusätzlich die Straßenraum-Erkennung und damit die Geometrieentscheidung ändern könnte. Diese isolierte Vorprüfung ist vom gesonderten lokalen Replay unten zu unterscheiden.

### 04: Konkrete Maßnahmen erst in der Begründung

Beim [Nahverkehrsplan 2534/2002](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/2534-2002) enthält der operative Antrag nur die Zustimmung zu einer beigefügten Stellungnahme. Der Provider reicht deshalb nur diesen Zustimmungssatz als Ortsevidenz weiter. Die tatsächlich gelesene HTML-Begründung behandelt dagegen konkrete Maßnahmen und Prüfaufträge: unter anderem Königstraße/Hindenburgstraße, Raschplatz, Fasanenkrug, Anderten, Podbielskistraße, Brabeckstraße sowie den Bereich Altenbekener Damm/Döhrener Turm.

Die Vorlage darf daher **nicht als nachweislich ortsloses Stadtthema** eingeordnet werden. Hier begrenzt die Auswahl des ausgewerteten Textabschnitts den Ortsbefund. Eine spätere Erweiterung müsste die unterschiedlichen Aussagen erhalten: Verzicht, Option, bedingte Maßnahme, Prüfauftrag und Zustimmung sind keine austauschbaren Ortsnennungen. Es wurde keine Anlage oder PDF zusätzlich gelesen.

### 10: Hausnummer vorhanden, Strich mit Prosa wird verworfen

Für [15-2055/2016](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2055-2016) liegt **nur der veröffentlichte Titel** vor. Er nennt Bemeroder Straße 73 und verbindet den Abriss eines Gärtnerhauses mit der Herstellung eines Fuß- und Radwegs. Die Adresse fehlt nicht im Gazetteer: Hausnummer 73 ist unter Straßenkennung `0324100100391` mit `[9.815542, 52.346857]` vorhanden.

Die [Adressauswertung des Ausgangsstands](https://github.com/carstenartur/Unfallatlas/blob/bc48708e9ff4c97997b4363334b80e515b40c135/server/political-context/services/risLocation.js#L289) verwirft den beidseitig beabstandeten Strich vor „Abriss“ als möglichen unvollständigen Zahlenbereich; „Abriss“ fehlt in der Liste bekannter Titelzusätze. Diagnosekontrollen mit Doppelpunkt, direkt angeschlossenem Prosawort oder einem bereits erlaubten Zusatz erhalten den vorhandenen Hausnummernpunkt. Die Compound-Kontrolle aus Fall 03 allein ändert dieses Ergebnis nicht.

Das belegt eine zweite, unabhängige Parserlücke am Titel. Es ist keine neue Volltextprüfung und keine bestätigte produktive Reparatur. Die Kontrollen ändern den Originaltitel nicht. Eine Korrektur muss weiterhin verhindern, dass `73–75` oder ein unvollständiger Bereich wie `73–X` auf die erste Hausnummer verkürzt wird.

### Weitere Titelbezüge und Referenzlücken

Der lokale Namensabgleich für 13–24 verwendet den vorhandenen [ATKIS-Bestand](../../config/ris-locations/hannover-atkis.json.gz), Attribution **LGLN (2026), ATKIS Basis-DLM (CC BY 4.0), bearbeitet**. SHA-256 der entpackten Datei: `1932e4d3e615c8e8765358ff123e86e132554cda673dc6fcc2110fdb7bffc3b2`. Er umfasst 3.253 Einträge. Geprüft wurde jeweils nur der normalisierte ausgeschriebene Name, keine neue Geometrie konstruiert.

Kleestraße, In der Rehre und die ausgeschriebenen Straßen der meisten weiteren Titel sind darin eindeutig vorhanden. Das Fehlen des Namens im Gazetteer erklärt deren fehlenden Textort daher nicht. Die genaue Parserursache ist dort aber noch nicht isoliert bestätigt. Für **Waldchaussee** in Fall 23 fehlt ein Eintrag unter dem exakten Namen; Fritz-Behrens-Allee ist vorhanden. Das ist eine konkrete Referenzlücke, kein Nachweis, dass die Querung nicht existiert.

Richtungsangaben dürfen nicht zu zusätzlichen Kreuzungsarmen werden: Loccumer Straße in 17 und Osterfelddamm in 22 sind zunächst Richtungsbelege. Der Straßeneintrag Feldbuschwende in 21 ist kein geprüfter Schulgebäudepunkt. Die Straßenlinien in 18 belegen keine beiden Brückenstandorte, und die Vahrenwalder Straße in 24 bezeichnet mehrere noch nicht einzeln benannte Kreuzungen.

## Vollständige feste Stichprobe

**V** bedeutet neu gelesener amtlicher HTML-Volltext; **T** bedeutet Titel und gespeicherte Metadaten, ohne neu gelesenen amtlichen Volltext. Alle 24 Fälle hatten im gepinnten öffentlichen Ausgangsstand Status `unresolved` und keine Geometrieverknüpfung. Die Tabelle beschreibt die Ausgangsdiagnose; die Ergebnisse der anschließenden lokalen Reparaturwiederholung stehen im nächsten Abschnitt.

| Nr. | ID und amtliche Quelle | Belegstufe | Diagnose und Grenze |
|---|---|---|---|
| 01 | [hannover-sim:2532-2003](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/2532-2003) | V | Parkplätze kurz vor Große Straße/Sackmannstraße; Relationsform fehlt, Kreuzungspunkt wäre zu genau und am falschen Maßnahmenort. |
| 02 | [hannover-sim:15-2726-2009F1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2726-2009F1) | V | Lister Meile/Kurt-Schumacher-Straße als Textknoten vorhanden; kein gemeinsamer ATKIS-Vertex. |
| 03 | [hannover-sim:15-0606-2005](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0606-2005) | V | `und` im Verkehrsbegriff verdrängt Wilkenburger Straße; isolierte Kontrolle erhält nur den Textort. |
| 04 | [hannover-sim:2534-2002](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/2534-2002) | V | Nahverkehrsplan: konkrete Maßnahmen in gelesener Begründung, operativ nur Anlagenzustimmung; kein bewiesen ortsloses Thema. |
| 05 | [hannover-sim:15-2056-2003S1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2056-2003S1) | T · Timeout | Haltestellenbereich Kronsberg im Titel; genaue Extraktion und Referenz ungeprüft. |
| 06 | [hannover-sim:0147-2007](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/0147-2007) | T · Timeout | Allgemeiner Taxentariftitel; bereits gespeicherter Textort Messegelände und gekürzte Evidenz. Volltextinhalt offen. |
| 07 | [hannover-sim:15-2140-2001N1S1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2140-2001N1S1) | T · Timeout | Allgemeiner Tempo-30-Titel; bereits gespeicherter Abschnitt Lenther Chaussee. Nicht als ortsloser Vorgang beurteilt. |
| 08 | [hannover-sim:15-0076-2009](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0076-2009) | T · Timeout | Konkreter Korridor Alte Stöckener Straße, Mecklenheide-/Weizenfeldstraße; Abkürzungen und genaue Abschnittsgrenzen offen. |
| 09 | [hannover-sim:15-0605-2012S1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0605-2012S1) | T · CONNECT | Im Othfelde im Titel; genaue Parserursache und Maßnahmenausdehnung ungeprüft. |
| 10 | [hannover-sim:15-2055-2016](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2055-2016) | T · CONNECT | Bemeroder Straße 73 im Gazetteer vorhanden; Strich/Prosa-Suffix „Abriss“ wird verworfen. Nur Titeldiagnose. |
| 11 | [hannover-sim:15-0151-2011](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0151-2011) | T · CONNECT | Querungshilfe Großer Kolonnenweg; genaue Querungsstelle aus Titel nicht bestimmbar. |
| 12 | [hannover-sim:15-2723-2015](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2723-2015) | T · CONNECT | Nikolaiviertel benannt; Straßen, Maßnahmen und genaue Quartiersgeometrie ungeprüft. |
| 13 | [hannover-sim:15-0604-2012](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0604-2012) | T · CONNECT | Allgemeiner Titel zu Zählstellen an Radverkehrsmagistralen; konkrete Standorte im Volltext unbekannt. |
| 14 | [hannover-sim:15-1126-2018](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-1126-2018) | T · CONNECT | Kurzzeitparkplätze Kleestraße; eindeutiger Gazetteer-Name, konkrete Parkplatzlage nicht geprüft. |
| 15 | [hannover-sim:15-1045-2010F1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-1045-2010F1) | T · CONNECT | Allgemeiner Radverkehrstitel; Sitzungsbezirk ist kein belegter Maßnahmenort. Volltext offen. |
| 16 | [hannover-sim:15-2724-2019N1S1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2724-2019N1S1) | T · CONNECT | Öffnung In der Rehre; Straße eindeutig vorhanden, Parserursache nicht isoliert. |
| 17 | [hannover-sim:15-2054-2022](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2054-2022) | T · CONNECT | Signalanlage Thurnithistraße/Garkenburgstraße mit Richtung Loccumer Straße; keine geprüfte Punktgeometrie. |
| 18 | [hannover-sim:15-2055-2024](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2055-2024) | T · CONNECT | Kanalbrücken Wunstorfer Straße und Eichenbrink; beide Straßen vorhanden, Brückenstandorte ungeprüft. |
| 19 | [hannover-sim:15-2140-2020F1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2140-2020F1) | T · CONNECT | Kreuzung Hannoversche Straße/Grenzstraße/Louise-Schroeder-Straße; Namen vorhanden, Geometrie ungeprüft. |
| 20 | [hannover-sim:15-0605-2022](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0605-2022) | T · CONNECT | Allgemeiner Titel zu schweren SUV auf Gehwegen; mögliche Beispiele im Volltext unbekannt. |
| 21 | [hannover-sim:15-0534-2021F1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0534-2021F1) | T · CONNECT | Oheriedentrift zur Grundschule Feldbuschwende; Straßenname belegt keinen Schulgebäude- oder Querungspunkt. |
| 22 | [hannover-sim:15-1619-2025](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-1619-2025) | T · CONNECT | Zebrastreifen Weidetorstraße/Pinkenburger Straße, Richtung Osterfelddamm; Richtungsbezug erhalten. |
| 23 | [hannover-sim:15-1126-2020S2](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-1126-2020S2) | T · CONNECT | Querung Waldchaussee/Fritz-Behrens-Allee; erster exakter Name fehlt im geprüften Gazetteer, zweiter vorhanden. |
| 24 | [hannover-sim:15-0605-2026N1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0605-2026N1) | T · CONNECT | Schutzblinker an mehreren Kreuzungen der Vahrenwalder Straße; einzelne Maßnahmenpunkte im Titel nicht benannt. |

## Gesonderter lokaler Reparaturnachweis auf identischen Eingaben

Am **10. November 2026 um 16:20:48.011 UTC** wurde die unveränderte Auswahl beider Audits vor und nach der Mapperänderung erneut gerechnet. Der Vergleich endete erfolgreich mit Exit-Code 0. Ausgangscode war `bc48708e9ff4c97997b4363334b80e515b40c135`; SHA-256 der geprüften neuen Mapperdatei:

`f9dda6fa55557e11af80ca14e6d510760e7456ae5f13ab1cba58cf46e7f86fee`

Für jeden Datensatz waren die Eingaben vor und nach der Änderung identisch. Die SHA-256-Werte aller **30 vorhandenen amtlichen HTML-Dateien** wurden geprüft: 26 aus der ursprünglichen Auswahl und vier aus der zweiten. Die acht regionalen Fälle der ersten Auswahl sowie 20 Fälle der zweiten wurden ausschließlich mit ihren veröffentlichten Titeln wiederholt. Es gab für den Replay keinen Quellenabruf und keinen Austausch von Fällen.

**In den 20 Titel-Replays der zweiten Auswahl fehlen die früher im veröffentlichten Datensatz bewerteten Dokumentauszüge bewusst.** Diese Ergebnisse sind deshalb kein vollständiges Remapping der betreffenden veröffentlichten Vorgänge. Das gilt entsprechend für die acht regionalen Titel-Replays. Insbesondere darf ein im Replay unveränderter allgemeiner Titel nicht die gespeicherte Dokumentprovenienz oder einen früheren Textort widerlegen. Die Evidenzdatei trennt den öffentlichen Ausgangsbefund vom Vorher-/Nachher-Ergebnis dieser begrenzten Eingaben.

| Feste Auswahl | Vorhandenes amtliches HTML | Nur Titel | Geänderte Fälle | Mit Geometrie vorher | Mit Geometrie nachher | Zuvor vorhandene Kartenlagen entfernt |
|---|---:|---:|---:|---:|---:|---:|
| Ursprüngliche 34 | 26 | 8 | 3 | 1 | 2 | 0 |
| Zweite 24 | 4 | 20 | 2 | 0 | 1 | 0 |

Die fünf geänderten Ergebnisse sind konkret nachvollziehbar:

| Auswahl / Fall | Lokales Ergebnis mit identischer Eingabe | Verbleibende Grenze |
|---|---|---|
| Ursprünglich 11 · `hannover-sim:15-2724-2022` | **Eckerstraße zwischen Hallerstraße und Fridastraße** wird als abgegrenzter Linienabschnitt erhalten und kartiert. | Sodenstraße bleibt ungeklärt; deren Mehrdeutigkeit unterdrückt den unabhängigen Eckerstraßenabschnitt nicht mehr. |
| Ursprünglich 12 · `hannover-sim:15-1618-2025` | **Clemensstraße und Feuerwehrstraße** werden mit ihren jeweiligen Dokumentbelegen als getrennte Textorte erhalten. | Beide bleiben ohne Geometrie; keine ganze Straßenlinie oder ein unbelegter Maßnahmenpunkt wird ergänzt. |
| Ursprünglich 18 · `hannover-sim:15-2054-2024` | Der Liepmannstraßen-Beleg bleibt jetzt über `bzw.` hinaus bis zum alternativen Endpunkt **Hurlebuschweg** vollständig. | Weiterhin Textabschnitt ohne Geometrie; der alternative Endpunkt wird nicht stillschweigend aufgelöst. |
| Zweite 03 · `hannover-sim:15-0606-2005` | **Wilkenburger Straße** wird aus dem unveränderten amtlichen Beleg als Textort erhalten. | Weiterhin ohne Geometrie; keine Ausweitung auf die ganze Straße. |
| Zweite 10 · `hannover-sim:15-2055-2016` | **Bemeroder Straße 73** wird aus dem unveränderten Titel als Punkt `[9.815542, 52.346857]` erhalten. | Nur Titelbeleg; der Replay bleibt wegen fehlendem Dokumenttext `partial` mit `document_text_unavailable`. |

Die übrigen Fälle änderten sich in diesem Vergleich nicht. Die beschriebenen Grenzen bei Einmündungsnähe, fehlendem gemeinsamen Vertex, Begründungsabschnitten, Einrichtungsdaten und ungeprüften Titelfällen werden damit nicht für gelöst erklärt. Aus zwei neu kartierten Vorgängen in zwei unterschiedlich aufgebauten Diagnoseauswahlen wird keine Zahl für den Gesamtbestand hochgerechnet.

Für diesen Mapperstand bestanden die gezielten lokalen Prüfungen: **321 Mapper-Tests** (13,171 s), **140 Refresh-Tests** (27,576 s) und die beiden vorhandenen UI-Suiten mit **9 und 32 Tests**, zusammen 41 UI-Tests. Die UI verwendet im geprüften lokalen Stand **„Der Karte noch nicht zugeordnet“**, damit eine fehlende Kartenlage nicht pauschal als fehlender Ortsbezug bezeichnet wird. Das sind lokale Implementierungs- und Testnachweise. **Vollständige CI, Merge und die Live-Veröffentlichung der Ortsrevision 8 sind weiterhin offen**; die oben festgehaltenen öffentlichen Zahlen bleiben der Revision-7-Ausgangsstand.

Die unabhängige abschließende Review prüfte den Produktdiff und fünf gezielte Assertions zu `e.V.`, `u. a.` und `weder … noch` gegen denselben Mapper; es blieb kein blockierender Befund. Die entsprechenden Regressionen sichern Satzgrenzen nach Abkürzungen und die gemeinsame Verneinung koordinierter Abschnitte. Sie verhindern dabei auch, dass der Hannover-Bezug eines regionalen Satzes auf einen folgenden Satz übergeht oder eine verneinte Maßnahme durch die Aufteilung eine Geometrie erhält. Diese Schutzprüfungen erweitern nicht die amtliche Belegbasis der Stichprobe.
