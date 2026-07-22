# Quellenprovenienz der Exporte

CSV-, GeoJSON-, KML-, PDF- und DOCX-Downloads verwenden denselben versionierten
`SourceManifest`-Snapshot. Das Manifest wird aus dem tatsächlichen Exportbereich,
den angewendeten Schwere-, Zeit-, Zustands- und Kontextfiltern sowie den
exportierten Unfallstellen gebildet. Beteiligungsfilter werden als
Szenariokontext dokumentiert; der tabellarische Datenexport bewahrt weiterhin
alle Beteiligungskombinationen im übrigen Filterumfang.

Der Export bricht ab, wenn die Quellen- oder Lizenzangaben nicht vollständig
validiert werden können. In diesem Fall wird auch die vom älteren Exportmodul
bereits erzeugte Zwischendatei nicht an den Browser weitergegeben. Das gilt
auch für PDF und DOCX: Die Dokument-Renderer werden erst aufgerufen, nachdem
der Manifest-Snapshot validiert, mit SHA-256 gebunden und durch das gemeinsame
Veröffentlichungs-QA-Gate geprüft wurde.

Während die optionalen Provenienzmodule geladen werden, sind alle Exportwege
gesperrt. Bereits früh gebundene Word-/PDF-Schaltflächen warten auf diesen
Bereitschaftszustand und delegieren danach an den installierten Exporter. Ein
Ladefehler führt weiterhin zum kontrollierten Exportabbruch und nicht zum
Rückfall auf eine Datei ohne Quellenangaben.

## CSV

CSV wird als deterministisches ZIP-Paket ausgeliefert:

- `Unfallatlas_<stadt>_<datum>.csv`
- `sources.json`
- `README.txt`

`sources.json` enthält das vollständige Manifest. Die README nennt
Datensatz- und Lizenzadressen, Änderungsvermerk und den SHA-256-Hash des
kanonischen Manifests.

## GeoJSON

Das Manifest und sein SHA-256-Hash stehen unter `metadata`. Jedes Feature trägt
`unfallatlas:sourceIds`. Benannte Source-IDs müssen im eingebetteten Manifest
vorhanden sein; unbekannte oder bereits widersprüchlich vorhandene Provenienz
führt zum Abbruch.

## KML

Das `Document` erhält ein `ExtendedData`-Element mit Manifest-Hash, Source-IDs,
Kurzvermerk, verlinkbaren Quelldetails und dem kanonischen Manifest-JSON. Eine
zweite oder bereits vorhandene Unfallwerkbank-Provenienz wird nicht
überschrieben.

## PDF und DOCX

Beide Dokumentformate erhalten einen eigenen Abschnitt
„Datenquellen, Methodik und Nachvollziehbarkeit“. Er enthält:

- Dokument-ID sowie Manifest-, Build- und Daten-Fingerprint,
- Stadt, Jahrgänge, räumlichen Ausschnitt und aktive Filter,
- jede verwendete Quelle mit Source-ID, Herausgeber, Datensatz, Lizenz,
  Abrufzeitpunkt, Abdeckung und vorgeschriebenem Quellenvermerk,
- Änderungsvermerke, Qualitätshinweise und dokumentierte Transformationen.

Der frühere pauschale Abschnitt „Unfallatlas / Open-Data-Downloads“ wird ersetzt
und nicht als zweite, unabhängig gepflegte Quellenangabe beibehalten.
Datensatz-, Distributions- und Lizenzadressen erscheinen nicht als lange rohe
URLs. DOCX verwendet echte externe OOXML-Hyperlink-Beziehungen; PDF verwendet
Linkannotationen. Die CI öffnet die erzeugte DOCX-Datei als OOXML-Paket und
liest die erzeugte PDF-Datei mit pdf.js in einem ESM-fähigen Node-Prozess, um
sichtbaren Inhalt, Linkziele und Manifest-Hash direkt aus den Binärartefakten zu
prüfen.

Die deterministische Sortierung und Fingerabdruckbildung über alle exportierten
Unfallpunkte beginnt bereits beim Öffnen des Exportdialogs parallel zur
Berichtsvorschau. Der spätere PDF- oder DOCX-Klick übernimmt genau dieses
validierte Manifest; er erzeugt nicht erneut einen zweiten Datenfingerabdruck.
Der Cache ist an Stadt, Datenbestand, Datenzeitpunkt, Grenzen und sämtliche
fachlichen Filter gebunden. Ändert sich dieser Zustand während der Berechnung,
wird das veraltete Ergebnis verworfen und neu erstellt. Fehlerhafte Versuche
werden nicht gecacht. Ein bereits ausdrücklich vom Aufrufer gesetztes Manifest
bleibt unverändert und hat Vorrang.

Ein zusätzlicher Chromium-Regressionsfall erzeugt einen realen PDF-Download mit
kombinierten Steigungs- und Verkehrsfiltern, aktivem „nur gematchte Straßen“-Modus
sowie den für den Videoexport verwendeten Karten- und Darstellungsparametern. Er
prüft sowohl den beim Dialogöffnen vorab erzeugten Manifestzustand als auch den
tatsächlichen Browser-Download und meldet einen sichtbaren Exportfehler
unmittelbar statt erst nach einem unspezifischen Download-Timeout.

Gleichzeitige PDF- und DOCX-Exporte werden serialisiert. Die Dokumentbibliotheken
werden nur innerhalb des jeweiligen Exports durch lokale Proxies ergänzt; ihre
Modul-Exporte werden nicht dauerhaft verändert. Dadurch kann der aktive
Manifest-Snapshot nicht in ein anderes Dokument geraten.

## Build- und Datenbindung

Der Build-Fingerprint stammt aus `build-manifest.json`. Der Daten-Fingerprint
wird deterministisch über Stadt, Bereich, Filter, Jahrgänge und die
normalisierten exportierten Unfallstellen berechnet. Mehrere unmittelbar
aufeinanderfolgende Formatexporte desselben Zustands verwenden denselben
Manifest-Snapshot.
