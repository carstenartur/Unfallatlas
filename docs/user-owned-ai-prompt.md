# Nutzerseitige KI-Zusammenarbeit

Die Unfallwerkbank kann einen reproduzierbaren Analysezustand an ChatGPT, Gemini oder ein anderes eigenes KI-Konto übergeben, ohne selbst einen KI-API-Aufruf auszuführen.

## Grundsatz: Link zuerst

Der **reproduzierbare Analyse-Link ist der primäre Übergabeweg**. Er enthält den aktiven Analysezustand der Unfallwerkbank, insbesondere Stadt, Unfallfilter, Beteiligungsmodus, Kartenmodus, Mittelpunkt, Zoom, Auswahlgrenzen sowie aktivierte Karten- und Kontextansichten. Mit `export=1` öffnet die verlinkte Anwendung zusätzlich den deterministischen Bericht.

Eine browserfähige KI kann dadurch:

- die aktuelle Karte und den Bericht selbst öffnen;
- sichtbare Karten, Legenden, Tabellen, Trend- und Heatmap-Darstellungen prüfen;
- bei Bedarf andere Zoomstufen, benachbarte Bereiche, Filter und Kontextlayer untersuchen;
- die veröffentlichten Unfall-, POI-, Straßenkontext- und Provenienzdateien direkt laden;
- zusätzliche Untersuchungen nachvollziehbar vom ursprünglichen Analysezustand trennen.

Der Link ist deshalb nicht nur eine „Prüfhilfe“, sondern die eigentliche gemeinsame Arbeitsoberfläche.

## Bedienung

Im Exportdialog unter „Zusatzanalysen“ stehen folgende Wege bereit:

- **KI-Auftrag + Analyse-Link kopieren**: bevorzugter Weg. Kopiert einen Arbeitsauftrag mit reproduzierbarem Link, strukturiertem Ausgangssnapshot und direkten öffentlichen Daten-URLs.
- **Text-Snapshot kopieren** und **Text-Snapshot .md**: sekundärer, fester Text-/JSON-Stand ohne explorative Webuntersuchung.
- **Fakten .json**: nur die strukturierte Faktenbasis.
- **Beleg-/Offline-Paket (.zip)**: optionaler unveränderlicher Snapshot mit Karten- und Grafikdateien.
- **ChatGPT öffnen** / **Gemini öffnen**: öffnet lediglich die jeweilige Oberfläche. Es werden keine Daten automatisch übertragen.

## Was der KI-Auftrag verlangt

Die KI soll zuerst den Analyse-Link öffnen und bestätigen, welche Ansicht und welche Datenquellen tatsächlich erreichbar waren. Anschließend soll sie:

1. die Ausgangsansicht objektiv beschreiben;
2. sichtbare Grafiken und Karten selbst prüfen, statt ihr Fehlen allein aus dem Textprompt abzuleiten;
3. weitere Untersuchungen nur ausdrücklich als Varianten durchführen;
4. für jede Variante geänderte Filter, Ausschnitt, Zoomstufe oder Layer nennen;
5. verwendete URLs und Datenquellen dokumentieren;
6. amtliche Unfallattribute, GIS-Ableitungen, sichtbare Kontextindizien und Empfehlungen klar trennen;
7. keine gesicherten Unfallursachen allein aus Karte, Orthofoto, räumlicher Nähe oder Korrelation behaupten;
8. einen fehlgeschlagenen Web- oder Bildzugriff offen benennen.

## Direkte Datenquellen

Soweit die aktuelle Laufzeit sie veröffentlicht, enthält der kopierte KI-Auftrag direkte URLs zu:

- Unfall-GeoJSON der aktiven Stadt;
- POI-GeoJSON;
- Straßenkontext einschließlich verfügbarer Steigungs- und Verkehrshinweise;
- Anreicherungs- und Provenienzmetadaten;
- Unfallkachelindex;
- Kontextkachelindex.

Damit kann die KI nicht nur vorhandene Bilder ansehen, sondern bei weitergehenden Fragestellungen selbst räumlich oder statistisch nachrechnen.

## Warum es das Beleg-/Offline-Paket trotzdem gibt

Das ZIP ist **nicht** der vorgesehene Normalweg. Es hat nur drei besondere Aufgaben:

1. **Fallback**, wenn das verwendete KI-Werkzeug keine Webseiten öffnen oder die dynamische Kartenansicht nicht zuverlässig visuell auswerten kann;
2. **Archivierung**, wenn der genaue damalige Bildstand unabhängig von später aktualisierten Daten oder Basiskarten festgehalten werden soll;
3. **Belegführung**, wenn Karten und Grafiken mit Dateinamen, Metadaten und SHA-256-Prüfsummen an einen Vorgang angehängt werden müssen.

Die Übersicht-, Detail- und Clusterkarten werden derzeit im Browser erzeugt. Solche Canvas-/PNG-Aufnahmen besitzen ohne zusätzlichen Renderdienst keine dauerhafte öffentliche Bild-URL. Das ZIP friert diese flüchtigen Aufnahmen ein. Für die normale explorative Zusammenarbeit genügt dagegen der Analyse-Link.

## Grenzen des Linkwegs

Ein Link funktioniert nur, wenn das KI-Werkzeug einen öffentlichen Browserzugriff besitzt und die Seite nicht durch Anmeldung, CAPTCHA, Netzwerkrichtlinien oder technische Einschränkungen blockiert wird. In diesem Fall soll die KI den konkreten Abruffehler melden und gezielt das Beleg-/Offline-Paket anfordern.

## Datenschutz und Kosten

Weder der Link- noch der Paketweg sendet automatisch Daten an ChatGPT, Gemini oder einen anderen KI-Dienst. Erst wenn Nutzer:innen den Auftrag selbst einfügen, einen Link übergeben oder Dateien hochladen, verlassen die Daten die Unfallwerkbank. Dadurch entstehen dem Betreiber keine nutzerseitigen KI-API-Kosten.

## Abgrenzung zum serverseitigen KI-Modus

Der Button „Antragsentwurf erstellen“ kann weiterhin den optionalen serverseitigen KI-Endpunkt verwenden, sofern dieser konfiguriert ist. Die linkbasierte Zusammenarbeit und das optionale Belegpaket benötigen keinen `GEMINI_API_KEY` im Unfallwerkbank-Backend.
