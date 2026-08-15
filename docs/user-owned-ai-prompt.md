# Nutzerseitige KI-Zusammenarbeit

Die Unfallwerkbank kann einen reproduzierbaren Analysezustand an ChatGPT, Gemini oder ein anderes eigenes KI-Konto übergeben, ohne selbst einen KI-API-Aufruf auszuführen.

## Grundsatz: Link zuerst, Evidenz bewahren

Der **reproduzierbare Analyse-Link ist der primäre Übergabeweg**. Er enthält den aktiven Analysezustand der Unfallwerkbank, insbesondere Stadt, Unfallfilter, Beteiligungsmodus, Kartenmodus, Mittelpunkt, Zoom, Auswahlgrenzen sowie aktivierte Karten- und Kontextansichten. Mit `export=1` öffnet die verlinkte Anwendung zusätzlich den deterministischen Bericht.

Die Übergabe ist nicht mehr nur ein Schreibauftrag. Sie verbindet drei Aufgaben:

1. den Ausgangszustand reproduzieren und die Unfallwerkbank-Auswertung prüfen;
2. den amtlichen Tatsachenkern und davon getrennte Ableitungen bewerten;
3. erst anschließend einen konkreten kommunalpolitischen Antrag formulieren.

Eine browserfähige KI kann dadurch:

- die aktuelle Karte und den Bericht selbst öffnen;
- sichtbare Karten, Legenden, Tabellen, Trend- und Heatmap-Darstellungen prüfen;
- die veröffentlichten Unfall-, POI-, Straßenkontext- und Provenienzdateien direkt laden;
- Unfallzahlen mit denselben Filtern und Auswahlgrenzen unabhängig nachrechnen;
- bei Bedarf andere Zoomstufen, benachbarte Bereiche, Filter und Kontextlayer untersuchen;
- zusätzliche Untersuchungen nachvollziehbar vom ursprünglichen Analysezustand trennen;
- Mängel der Unfallwerkbank-Darstellung benennen, bevor sie einen Antrag erzeugt.

Der Link ist deshalb nicht nur eine „Prüfhilfe“, sondern die eigentliche gemeinsame Arbeitsoberfläche.

## Evidenzstatus der Unfalldaten

Die Datenbasis darf im KI-Auftrag nicht zu einer unverbindlichen Illustration herabgestuft werden.

Der offizielle Unfallatlas enthält Angaben aus der Statistik der Straßenverkehrsunfälle, die auf **Meldungen der Polizeidienststellen** basiert:

- https://www.statistikportal.de/de/karten/unfallatlas

Dargestellt werden **Unfälle mit Personenschaden**. Unfälle, bei denen ausschließlich Sachschaden entstand, sind im Unfallatlas nicht enthalten:

- https://www.destatis.de/DE/Service/Statistik-Visualisiert/unfall-atlas.html

Daraus folgt für die KI-Übergabe:

- Das dokumentierte Unfallereignis, der veröffentlichte Ort, der Zeitraum, die Unfallschwere und kodierte Beteiligungsarten besitzen – soweit im Datensatz vorhanden – einen hohen Evidenzwert.
- Diese Tatsachen sollen mit konkreten Zahlen und Quellen bestimmt wiedergegeben werden. Sie sind nicht nur „mögliche Hinweise“.
- Unsicherheit über die genaue Unfallursache entwertet nicht die dokumentierten Ereignisse, ihre Schwere oder eine reproduzierbare räumliche beziehungsweise zeitliche Häufung.
- Vorsicht ist bei der vollständigen Kausalkette, bei Kontextdeutungen, Zuständigkeiten und Wirkungsprognosen nötig.
- Die Unfallwerkbank-Transformationen, Filter, Zählungen, Karten und Diagramme müssen eigenständig geprüft werden. Ein Darstellungsfehler der Unfallwerkbank ist von der amtlichen Primärdatenbasis zu trennen.
- Nicht polizeilich gemeldete Ereignisse, reine Sachschäden und gegebenenfalls nicht veröffentlichbare Unfallorte sind nicht Teil dieses Tatsachenkerns.

Ein belegtes Unfallgeschehen kann daher einen konkreten Prüf-, Sicherungs-, Pilot- oder Abhilfeauftrag tragen, ohne dass der Antrag eine nicht belegte Alleinursache behaupten muss.

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

- **KI-Auftrag: QA + Antrag + Analyse-Link kopieren**: bevorzugter Weg. Kopiert einen evidenzbasierten Arbeitsauftrag mit öffentlich erreichbarem, reproduzierbarem Link, strukturiertem Ausgangssnapshot, amtlichem Evidenzvertrag, automatischer QA-Vorprüfung und direkten öffentlichen Daten-URLs.
- **Evidenz-/QA-Auftrag .md**: derselbe Auftrag als feste Markdown-Datei.
- **Fakten + Evidenzvertrag .json**: Ausgangssnapshot, Evidenzvertrag, QA-Vertrag und automatische Vorprüfung als JSON.
- **ChatGPT öffnen** / **Gemini öffnen**: öffnet lediglich die jeweilige Oberfläche. Es werden keine Daten automatisch übertragen.

Die alte generische Aktion „Prompt für ChatGPT/Gemini kopieren“ wird im linkbasierten Modul entfernt. Dadurch gibt es nicht parallel einen schwächeren Prompt, der die amtlichen Unfalldaten nur in vorsichtige Prosa umformuliert.

Ein eigenes KI-Medien-ZIP ist für den normalen Ablauf nicht erforderlich. Wenn ein KI-Werkzeug die öffentliche Seite nicht öffnen oder die dynamische Karte nicht visuell auswerten kann, können der bereits vorhandene PDF-/Word-Export oder gezielt einzelne Screenshots hochgeladen werden.

## Automatische QA-Vorprüfung der Unfallwerkbank

Bevor der Auftrag kopiert oder heruntergeladen wird, erzeugt die Unfallwerkbank eine strukturierte Vorprüfung. Sie kontrolliert unter anderem:

- ob ein strukturierter Bericht vorhanden ist;
- ob Kommune und räumlicher Untersuchungsraum erkennbar sind;
- ob eine zentrale Unfallzahl vorliegt;
- ob Gesamtzahlen aus Schweregrad-, Kreuz-, Jahrgangs- und Detaildarstellung miteinander vereinbar sind;
- ob der Auswertungszeitraum ableitbar ist;
- ob ein substanzieller deterministischer Bericht vorliegt;
- ob eine öffentliche Analyse-URL und eine Unfall-Rohdaten-URL verfügbar sind.

Widersprüchliche zentrale Zählungen führen zum Vorprüfstatus `blocked`. Die visuelle Prüfung bleibt immer `pending`, weil Karte, Legenden und Diagramme in einem echten Browser kontrolliert werden müssen. Die Vorprüfung ersetzt daher nicht die unabhängige QA durch die KI oder einen Menschen.

## Verbindlicher QA-Ablauf der KI

Der Auftrag verlangt vor jeder Antragserstellung:

1. **Abrufprotokoll:** Welche Web- und Daten-URLs konnten tatsächlich geöffnet werden?
2. **Reproduktionsprüfung:** Stimmen Stadt, Zeitraum, Auswahl, Filter, Beteiligungsmodus, Kartenmodus, Zoom und Layer mit dem Ausgangssnapshot überein?
3. **Zählprüfung:** Stimmen Gesamtzahl, Schweregrade, Jahrgangssummen, Beteiligungstabelle und Unfall-Detailzeilen überein? Bei Bedarf ist das Unfall-GeoJSON selbst nachzuzählen.
4. **Visuelle QA:** Sind Karte, Unfallpunkte, Auswahlgrenze, Legende, Cluster-/Detailkarten, Trendgrafik und Stunden-/Tagestyp-Heatmap vollständig, lesbar und widerspruchsfrei?
5. **Inhaltliche QA:** Fehlen ortsspezifische Befunde, Kennzahlen, Einheiten, Quellen oder passende Deep-Links? Sind Texte generisch oder Maßnahmen ohne Befundbezug vorgeschlagen?
6. **Evidenzmatrix:** Jede tragende Aussage wird klassifiziert als:
   - A: amtliche Unfalltatsache;
   - B: reproduzierbare Berechnung/Aggregation der Unfallwerkbank;
   - C: ergänzender GIS-, Bild- oder Kontextbefund;
   - D: Hypothese oder Maßnahmenoption.
7. **QA-Urteil:** `bestanden`, `bestanden mit Mängeln` oder `blockiert`.

Bei einem blockierenden Mangel soll kein fertiger Antrag erzeugt werden. Stattdessen muss die KI eine konkrete Fehler- und Nachforderungsliste ausgeben.

## Maßnahmenlogik statt allgemeiner Sätze

Nach bestandener QA muss jede Maßnahme sichtbar auf einen belegten Befund zurückgeführt werden. Der Auftrag verlangt eine Maßnahmenmatrix:

`Befund → Sicherheitsziel → Maßnahme/Prüfoption → noch nötige Fachprüfung → Erfolgskriterium`

Dabei sind mindestens zu unterscheiden:

- kurzfristige, risikoarme Sicherungsmaßnahmen;
- vertiefte Prüfung durch Verwaltung beziehungsweise Unfallkommission;
- zeitlich begrenzter Pilot mit Evaluation;
- dauerhafte bauliche oder verkehrsrechtliche Maßnahme.

Der Antrag soll konkrete Zahlen, Zeitraum, Untersuchungsraum, Schwere und Beteiligung soweit vorhanden, Verwaltungsaufträge, Fristen, Berichtspflicht, Erfolgskontrolle und Anlagen enthalten. Allgemeine Verkehrssicherheitsfloskeln oder eine bloße sprachliche Verschönerung des deterministischen Berichts erfüllen den Auftrag nicht.

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

Weder der Link- noch der Dateisnapshot sendet automatisch Daten an ChatGPT, Gemini oder einen anderen KI-Dienst. Erst wenn Nutzer:innen den Auftrag selbst einfügen, einen Link übergeben oder Dateien hochladen, verlassen die Daten die Unfallwerkbank. Dadurch entstehen dem Betreiber keine nutzerseitigen KI-API-Kosten.

## Abgrenzung zum serverseitigen KI-Modus

Der Button „Antragsentwurf erstellen“ kann weiterhin den optionalen serverseitigen KI-Endpunkt verwenden, sofern dieser konfiguriert ist. Die linkbasierte Zusammenarbeit benötigt keinen `GEMINI_API_KEY` im Unfallwerkbank-Backend.
