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

## Öffentlich erreichbare Adresse

Ist die Unfallwerkbank bereits unter einer öffentlichen HTTP(S)-Adresse geöffnet, wird genau diese Installation verwendet. Läuft sie dagegen unter `localhost`, einer privaten IP-Adresse oder einem `.local`-Namen, werden dieselben Abfrageparameter auf die öffentliche Unfallwerkbank übertragen:

`https://carstenartur.github.io/Unfallatlas/werkbank_v2.html`

Eigeninstallationen können eine andere öffentliche Zieladresse über `UA.PUBLIC_APP_URL`, `UA.publicAppUrl` oder folgendes Meta-Element vorgeben:

```html
<meta name="unfallwerkbank:public-app-url" content="https://example.org/unfallwerkbank/werkbank_v2.html">
```

Damit erhält die KI keinen für sie unerreichbaren Docker-/Localhost-Link.

## Bedienung

Im Exportdialog unter „Zusatzanalysen“ stehen folgende Wege bereit:

- **KI-Auftrag + Analyse-Link kopieren**: bevorzugter Weg. Kopiert einen Arbeitsauftrag mit öffentlich erreichbarem, reproduzierbarem Link, strukturiertem Ausgangssnapshot und direkten öffentlichen Daten-URLs.
- **Text-Snapshot kopieren** und **Text-Snapshot .md**: sekundärer, fester Text-/JSON-Stand ohne explorative Webuntersuchung.
- **Fakten .json**: nur die strukturierte Faktenbasis.
- **ChatGPT öffnen** / **Gemini öffnen**: öffnet lediglich die jeweilige Oberfläche. Es werden keine Daten automatisch übertragen.

Ein eigenes KI-Medien-ZIP ist nicht erforderlich. Wenn ein KI-Werkzeug die öffentliche Seite nicht öffnen oder die dynamische Karte nicht visuell auswerten kann, können der bereits vorhandene PDF-/Word-Export oder gezielt einzelne Screenshots hochgeladen werden.

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

Die Anwendung lädt komprimierte Ressourcen selbst zuerst als `.gz`. Deshalb wird auch der KI die tatsächlich veröffentlichte `.gz`-Adresse als bevorzugte URL genannt; die logische Rohdatenadresse bleibt nur als lokaler Entwicklungs-Fallback aufgeführt. Die KI soll die Datei vor der JSON-/GeoJSON-Auswertung dekomprimieren.

Damit kann sie nicht nur die vorhandene Darstellung ansehen, sondern bei weitergehenden Fragestellungen selbst räumlich oder statistisch nachrechnen.

## Warum die Bilder nicht als einzelne dauerhafte URLs benötigt werden

Die Übersicht, Auswahl, Unfallpunkte, Cluster und Kontextlayer werden in der Webanwendung aus Kartenkacheln und strukturierten Daten zusammengesetzt. Sie sind daher keine unveränderlichen, bereits auf dem Server liegenden PNG-Dateien. Eine browserfähige KI kann die verlinkte Seite jedoch selbst rendern und visuell untersuchen.

Ein eigener Screenshot- oder Renderdienst wäre nur erforderlich, wenn jede dynamische Ansicht zusätzlich eine dauerhafte öffentliche PNG-URL erhalten sollte. Für die normale KI-Zusammenarbeit erzeugte das zusätzliche Infrastruktur, Betriebskosten und Synchronisationsrisiken, ohne einen Vorteil gegenüber der interaktiven URL zu bieten.

## Grenzen des Linkwegs

Ein Link funktioniert nur, wenn das KI-Werkzeug einen öffentlichen Browserzugriff besitzt und die Seite nicht durch Anmeldung, CAPTCHA, Netzwerkrichtlinien oder technische Einschränkungen blockiert wird. In diesem Fall soll die KI den konkreten Abruffehler melden und gezielt den vorhandenen PDF-/Word-Export oder die tatsächlich benötigten Screenshots anfordern.

## Datenschutz und Kosten

Weder der Link- noch der Textweg sendet automatisch Daten an ChatGPT, Gemini oder einen anderen KI-Dienst. Erst wenn Nutzer:innen den Auftrag selbst einfügen, einen Link übergeben oder Dateien hochladen, verlassen die Daten die Unfallwerkbank. Dadurch entstehen dem Betreiber keine nutzerseitigen KI-API-Kosten.

## Abgrenzung zum serverseitigen KI-Modus

Der Button „Antragsentwurf erstellen“ kann weiterhin den optionalen serverseitigen KI-Endpunkt verwenden, sofern dieser konfiguriert ist. Die linkbasierte Zusammenarbeit benötigt keinen `GEMINI_API_KEY` im Unfallwerkbank-Backend.
