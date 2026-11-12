# Hannover DGM1 als ElevationProvider

Die Landeshauptstadt Hannover veröffentlicht ihr Digitales Geländemodell DGM1
als regelmäßiges 1‑m-Raster für das gesamte Stadtgebiet. Für Fachanwendungen
werden ASCII-XYZ-Dateien in ETRS89/UTM Zone 32 (`EPSG:25832`) angeboten. Die
Unfallwerkbank bindet diese Daten über
`scripts/providers/hannover_dgm1_xyz_provider.js` an die gemeinsame
`ElevationProvider`-Registry an.

## Warum ein lokaler Snapshot

Die fünf veröffentlichten Teilarchive sind groß. Der Produktionspfad lädt sie
nicht stillschweigend während einer Analyse nach. Ein Betreiber lädt die
benötigte XYZ-Verteilung kontrolliert herunter und legt daneben ein extern
gepinntes Manifest ab. Der Provider prüft vor der ersten Abtastung:

- Manifest-SHA-256 gegen einen außerhalb des Manifests übergebenen Pin,
- HTTPS-Distribution, Dateigröße und SHA-256 der tatsächlichen XYZ-Datei,
- `sourceId: "hannover.dgm1"`, `EPSG:25832` und genau 1 m Rasterweite,
- ganzzahlige Rastergrenzen und eine harte Speicherobergrenze,
- ausschließlich reguläre Dateien innerhalb des freigegebenen Importroots,
- keine Symlinks, Pfadflucht, doppelten Rasterzellen oder fehlorientierten
  Koordinaten.

Erst danach wird die Datei zeilenweise eingelesen. Die Höhen liegen kompakt in
einem `Float32Array`; ein zusätzliches `Uint8Array` erkennt doppelte
Rasterzellen. Der Standardvertrag budgetiert deshalb fünf Byte je Rasterzelle
und höchstens 256 MiB für beide Strukturen zusammen. Größere Teilarchive müssen
vor dem Import räumlich gekachelt werden; ein Manifest darf das Sicherheitslimit
nicht nach oben überschreiben.

Abfragen werden bilinear zwischen den vier umgebenden Rasterpunkten
interpoliert. Fehlt einer dieser Punkte, ist er als NoData markiert oder liegt
eine einzelne Koordinate außerhalb der unterstützten UTM-Zone, liefert der
Provider für diese Koordinate `null` statt eine Höhe zu erfinden oder die
vollständige Profilberechnung abzubrechen.

## Manifest

```json
{
  "schemaVersion": 1,
  "sourceId": "hannover.dgm1",
  "retrievedAt": "2026-07-28T12:00:00Z",
  "distribution": {
    "url": "https://www.hannover.de/<exakter-download-der-verwendeten-xyz-verteilung>",
    "path": "xyz/DGM1_Teil_Mitte_Ausschnitt.xyz",
    "sha256": "<sha256-der-entpackten-xyz-datei>",
    "bytes": 123456789,
    "publicationDate": "2024-01-15"
  },
  "grid": {
    "crs": "EPSG:25832",
    "resolutionMeters": 1,
    "minEasting": 545000,
    "maxEasting": 550000,
    "minNorthing": 5798000,
    "maxNorthing": 5803000,
    "noDataValue": -9999,
    "maxCells": 25010001
  }
}
```

Die Bounds und das NoData-Kennzeichen müssen aus genau der verwendeten Datei
bestimmt werden. `maxCells` darf kleiner als das globale Sicherheitslimit sein,
aber nicht größer. Die Beispielwerte sind keine Produktionsmetadaten.

## Registrierung und robuste Straßenneigung

```js
const elevation = require("../js/ua.elevation_provider");
const dgm1 = require("../scripts/providers/hannover_dgm1_xyz_provider");

const registry = elevation.createRegistry();
registry.register(
  dgm1.createHannoverDgm1XyzProvider({
    allowedRoot: "/srv/unfallwerkbank/elevation/hannover",
    manifestPath: "manifest-mitte.json",
    expectedManifestSha256: process.env.HANNOVER_DGM1_MANIFEST_SHA256,
  }),
);

const provider = await registry.resolve({ city: "Hannover" });
const result = await elevation.computeRoadGradient(
  provider,
  matchedRoadGeometry,
  accidentCoordinate,
  {
    windowMeters: 50,
    spacingMeters: 5,
    matchQuality: "high",
    osmTags: matchedWayTags,
    context: { city: "Hannover" },
  },
);
```

Damit wird der bereits vorhandene gemeinsame Algorithmus genutzt:

- Profil entlang der gematchten Straßenlinie statt Pixelgefälle am Unfallpunkt,
- standardmäßig ungefähr ±50 m,
- Theil-Sen-Schätzung gegen einzelne Ausreißer,
- Residual-MAD und explizites Unsicherheitsintervall,
- Brücken und Tunnel als nicht belastbar,
- Trennung von Fahrbahnlängsneigung und grobem Geländekontext,
- vollständige Quellen-, Auflösungs-, Methoden- und Qualitätsangabe.

## Goldfälle

`tests/unit/hannoverDgm1XyzProvider.test.js` und
`tests/unit/hannoverDgm1XyzProviderSafety.test.js` prüfen:

- drei unabhängig erzeugte WGS84→EPSG:25832-Referenzkoordinaten auf
  Zentimeterniveau,
- bilineare Interpolation in einem bekannten 1‑m-Raster,
- einen synthetischen 10‑%-Hang über dem gemeinsamen robusten Profilalgorithmus,
- NoData, Hash- und Größenabweichung, doppelte Zellen, Rasterfehlausrichtung,
  Pfadflucht und Speichergrenzen,
- verständliche Root-Fehler, punktweises `null` außerhalb UTM32 und sicheres
  Schließen des Datenstreams auch nach einem Parserfehler.

Diese synthetischen Fälle sichern Mathematik und Datenvertrag. Der
[unabhängige QGIS-Vergleich](qa/hannover-dgm1-qgis-city.md) ergänzt sie mit
Profilen aus den Originaldaten. Die fachliche Abnahme für heutige Fahrbahnen
steht aus. Ein DGM1-Ergebnis erfordert einen vollständig verifizierten
Snapshot.

## Reale, begrenzte Quellenauszüge (November 2026)

`tests/fixtures/hannover-dgm1-real/` ergänzt die synthetischen Prüfungen um echte,
hashgebundene Höhenzeilen und OSM-Geometrien: Friedrichswall, Hardenbergstraße,
Friederikenbrücke und Am Lindener Berge. Die amtlichen Testdateien besitzen eine
erste Kopfzeile `x y z`; diese wird genau an erster Stelle akzeptiert. Halbmeter-
Zellmittelpunkte bleiben unverändert. Eine wiederholte Kopfzeile ist ein Fehler.

Der lokale Erprobungslauf hat zusätzlich zwei Originalkacheln aus dem großen
Mitte-Archiv mit regulären HTTP-Teilabfragen und `If-Match` gewonnen. ZIP-
Verzeichnis, ETag, CRC, entpackte Größe und lokale SHA-256-Pins binden diese
Auswahl; das gesamte Archiv wurde nicht geladen. Die genaue Quelle und die
verbleibenden fachlichen Grenzen beschreibt [die Quellenprüfung](qa/hannover-dgm1-source-evidence.md).

Diese automatisierten Realdatenfälle ersetzen keine manuell geprüften
QGIS-/Fahrbahnprofile. Die DGM-Metadaten nennen die Laserscannerbefliegung 2010
und die Veröffentlichung 2024. Ein vertikales Bezugssystem ist dort nicht
angegeben. Die heutige Fahrbahnoberfläche benötigt einen separaten Nachweis.

## Stadtweiter Originalbestand

`scripts/prepare-hannover-dgm1.py` beschafft die fünf vollständigen XYZ-Archive der
Landeshauptstadt. Der Katalog `config/hannover-dgm1-city-archives.json` bindet
Download-URLs, Originalgrößen, SHA-256 und die geprüften Ableitungen. Die
929 Gitterkacheln enthalten 232.250.000 Höhen. Jede 500-m-Kachel wird auf die
Originalkoordinaten, Reihenfolge und vollständige Belegung geprüft. Die
seekbare, little-endian Float32-Datei verwendet dieselbe numerische Präzision
wie der Einzelraster-Provider. Die Lageinterpolation berücksichtigt angrenzende
Kacheln und gibt außerhalb der verfügbaren Rasterzellen keinen Wert aus.
Der Leser prüft den vollständigen Rasterhash und hält bis zu 16 Kacheln im Speicher.

```sh
python3 scripts/prepare-hannover-dgm1.py --archives /tmp/hannover/xyz --output /tmp/hannover/raster
```

Die letzte Ausgabezeile ist der externe SHA-256 für `manifest.json`. Python ab
3.11 genügt. NumPy beschleunigt die Verarbeitung. Der Quellenzeitpunkt im
Manifest bezeichnet die erste dokumentierte Beschaffung dieser identischen
Archivbytes am 11. November 2026. Ein neuer Workflowlauf oder Cachetreffer
aktualisiert dieses Datum nicht. Der Höhenbezug der kommunalen Befliegung
von 2010 bleibt unbekannt. Bei automatischen Kontextläufen für Hannover ist
DGM1 Pflicht. Der Workflow erstellt das Stadtraster aus den fünf gepinnten
Archiven oder lädt die hashgebundene Ableitung aus dem Actions-Cache. Ein
vollständiger, vom Betreiber konfigurierter Snapshot kann verwendet werden.
Bei einem DGM1-Lauf übernimmt der Stadtgenerator die Bauwerksmerkmale aus derselben Overpass-Antwort
wie die Straßengeometrien. Die Profilrechnung prüft und verwendet diesen
gemeinsamen OSM-Datenstand.
Bei einem temporären OSM-Ausfall darf der Workflow für Hannover ausschließlich
einen bereits validierten DGM1-Stand übernehmen. Für einen ausdrücklich
gewünschten Vergleichslauf kann `require_hannover_dgm1` beim manuellen Start
deaktiviert werden, sofern der Betreiber DGM1 nicht erzwungen hat.

Auf dem vollständigen Raster lagen 21.495 der 21.539 geprüften Hannoveraner
Unfallkoordinaten innerhalb interpolierbarer Zellen, 44 außerhalb. Diese
Zählung beschreibt die Verfügbarkeit von Geländehöhen an Koordinaten.
Das vollständige OSM-Way-Profil und seine produktive Veröffentlichung sind
eigene Schritte. Die gespeicherten 1-m-Referenzen ergaben im 50-m-Fenster
0,0 % am Friedrichswall, +2,8 % an der Hardenbergstraße und −4,4 % am
Lindener Berg. Für die Friederikenbrücke wurde der Fahrbahnwert unterdrückt.
Bei Way 24855098 wurden −26,1 % über 25,3 m mit 27 Punkten, MAD 1,625 m
und Unsicherheit 19,1 Prozentpunkten gemessen. Die Profilqualität ist gering.
Bei 2 m und 5 m Abtastabstand ergeben sich −20,9 % und −33,9 %, jeweils
mit geringer Profilqualität. Die archivierten Originalhöhen und die
OSM-Geometrie befinden sich unter `tests/fixtures/hannover-dgm1-real/`.
Eine unabhängige vermessungstechnische oder heutige Fahrbahnprüfung steht aus.

Eine vom Produktionsleser getrennte Prüfung hat für jede der 929 Kacheln
drei räumlich verschiedene Original-XYZ-Zeilen gegen die konvertierte
Float32-Zelle geprüft. Alle 2.787 Zellen stimmten überein. Der
SHA-256 der vollständigen 929.000.000 Rasterbytes lautet
`492a90154f4fd1791dd81d8eb1044717af108c8ecba38a8206bdbfa24ff6c7fb`.
