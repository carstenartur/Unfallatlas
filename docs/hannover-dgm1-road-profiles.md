# Hannover-DGM1-Straßenprofile

`scripts/producers/hannover_dgm1_road_profile_producer.js` verbindet die bereits
getrennt abgesicherten Bausteine des Topographie-Epics #412 zu einem
checkout-lokal ausführbaren Produktionslauf:

1. vollständige OSM-Strukturtags und normalisierte Risikotags,
2. hashgepinntes amtliches Hannover-DGM1,
3. robuste Längsprofile je OSM-Way.

Der Producer ist absichtlich **nur für Hannover** vorgesehen. Andere Städte und
der globale SRTM-Fallback erhalten durch diesen Befehl keine zusätzliche
Overpass-Last.

## Aufruf

```bash
npm run generate:hannover-dgm1-road-profiles -- \
  --osm .enrichment-cache/osm/osm_hannover.json \
  --dgm-root /srv/unfallwerkbank/elevation/hannover \
  --dgm-manifest hannover-dgm1-manifest.json \
  --dgm-manifest-sha256 <extern-gepinnter-manifest-hash> \
  --output out/hannover-dgm1-road-profiles.json
```

Für reproduzierbare kontrollierte Läufe stehen zusätzlich zur Verfügung:

```text
--generated-at <ISO>
--structure-retrieved-at <ISO>
--risk-derived-at <ISO>
--batch-size <n>
--delay <ms>
--endpoint <URL>
--retries <n>
--backoff <ms>
--timeout <ms>
--force-context
--json
```

## Verbindliche Reihenfolge

Vor dem ersten DGM-Zugriff ruft der Producer die atomische
`osm_elevation_context_producer`-Kette auf. Anschließend werden der vollständige
Top-Level-Vertrag und **jeder** `ways[wayId].elevationRiskTags`-Eintrag erneut
validiert. `wayGeometries` muss genau dieselben Way-IDs enthalten; fehlende oder
zusätzliche Geometrien brechen den Lauf ab.

Erst danach lädt der Hannover-Provider Manifest und XYZ-Datei, prüft externe
Manifest-Pin, Distributionshash, Bytezahl, EPSG:25832 und das deklarierte
1-m-Raster und führt `preload()` aus.

## Profile

Für jeden Way werden zwei robuste Theil-Sen-Profile erzeugt:

- ±20 m um den Profilanker,
- ±50 m um den Profilanker.

Der Abtastabstand entspricht der 1-m-Auflösung des DGM1. Das Ergebnis bewahrt:

- Gradientenwert und Richtung,
- tatsächlich abgedeckte Profillänge,
- Stichprobenzahl,
- Residual-MAD und Unsicherheit,
- Qualitätsklasse,
- OSM-Risikogründe,
- vollständigen DGM1-Quellenvertrag.

Brücken und Tunnel erhalten keine vermeintliche Fahrbahnneigung: Der vorhandene
Gradientenalgorithmus markiert sie als `usable:false` und nennt den konkreten
Unsicherheitsgrund. Zu kurze Geometrien oder unvollständige Rasterabdeckung
werden je Fenster als `status:"unavailable"` gespeichert. Es wird weder mit
Nullwerten noch mit Nachbar-Ways aufgefüllt.

## Abdeckung und Atomarität

Das Top-Level-Artefakt enthält für jeden validierten Way exakt einen 20-m- und
einen 50-m-Eintrag sowie aggregierte Zähler für:

- berechnete Profile,
- belastbar nutzbare Profile,
- wegen Brücke/Tunnel unbrauchbare Profile,
- geometrie- oder rasterbedingt nicht verfügbare Profile.

Die Ausgabedatei wird erst nach vollständiger Berechnung und erneuter
Artefaktvalidierung atomar ersetzt. Ein Fehler lässt ein vorhandenes früheres
Profilbyte unverändert.

## Wahrheitsgrenze

Dieser Slice berechnet Profile für vorhandene OSM-Ways. Er führt noch **kein**
Unfallpunkt→Way-Matching durch. Das Artefakt behauptet außerdem ausdrücklich
keine Querneigung, Fahrbahnüberhöhung oder aus dem DGM rekonstruierte
Brücken-/Tunneloberfläche.

Der nächste #412-Slice kann diese Profile an den vorhandenen räumlichen
Unfall→Way-Bezug anbinden und anschließend GeoJSON, Tiles, Popups und Exporte mit
einheitlicher Quellen-/Qualitätssemantik versorgen.
