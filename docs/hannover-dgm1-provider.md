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

Diese synthetischen Fälle sichern Mathematik und Datenvertrag. Für den
vollständigen Abschluss von #412 fehlen weiterhin manuell gegen reale
Hannover-DGM1-Höhen und bekannte Straßenprofile geprüfte Referenzfälle sowie
die Übernahme des Providers in den standardmäßigen Stadtproduktionslauf. Bis
dahin bleibt SRTM der automatische Fallback; ein DGM1-Ergebnis wird nur erzeugt,
wenn ein ausdrücklich registrierter und vollständig verifizierter Snapshot
vorliegt.
