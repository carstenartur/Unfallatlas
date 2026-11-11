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

`--help` und `-h` geben denselben vollständigen Optionsvertrag aus. Ein
Regressionstest vergleicht Parser und Hilfetext, damit künftig kein akzeptierter
Produktionsparameter undokumentiert bleibt.

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

Die Qualität des linearen Fits begrenzt die Qualitätsklasse auch bei feinem
Raster und vielen Proben. Die bestehenden Residual-MAD-Bänder gelten als
Obergrenzen: bis einschließlich 0,25 m höchstens `high`, darüber bis
einschließlich 0,75 m höchstens `medium`, darüber höchstens `low`. Andere
Quellen-/Matchingrisiken können die Klasse weiter abwerten. Über 0,25 m bleibt
`elevated_profile_residual` als ausdrücklicher Unsicherheitsgrund erhalten und
wird auch im lesbaren Profil-/Laufzeittext erläutert. Dies beschreibt die
Abweichung vom linearen Fit, ohne deren physikalische Ursache zu behaupten.
Gradient und numerische Unsicherheit werden weiterhin unverändert berechnet;
eine niedrige Qualitätsklasse allein setzt `usable` nicht auf `false`.
Die Regel ist eine konservative Softwarekennzeichnung, keine fachliche
Kalibrierung oder Abnahme der alten DGM-Daten als heutige Fahrbahnoberfläche.
Sie gilt für neu berechnete Profile; bereits gespeicherte Artefakte werden
dadurch nicht nachträglich neu bewertet oder produktiv neu veröffentlicht.

Brücken und Tunnel erhalten keine vermeintliche Fahrbahnneigung: Der vorhandene
Gradientenalgorithmus markiert sie als `usable:false` und nennt den konkreten
Unsicherheitsgrund. Zu kurze Geometrien oder unvollständige Rasterabdeckung
werden je Fenster als `status:"unavailable"` gespeichert. Es wird weder mit
Nullwerten noch mit Nachbar-Ways aufgefüllt.

Ein Profilfenster wird auch dann als Brückenübergang ausgeschlossen, wenn es an
seinem Way einen Endpunkt eines als Brücke markierten OSM-Ways erreicht. Beide
Geometrien müssen im ungerundeten OSM-Eingang exakt dieselbe Endkoordinate
haben. Der Producer hält die zugehörigen Brücken-Way-IDs fest. Beim Prüfen der
Fenster verwendet er die Distanz entlang der Linie. So kann bei einem längeren
Weg das 20-m-Fenster eine Zahl liefern und das 50-m-Fenster an der Brücke enden.
Ein ungültiges OSM-`layer` wie `-0,7` oder `0.5` bleibt im Quellensatz erhalten.
Beide Fenster dieses Wegs erhalten `invalid_osm_layer` und keine Zahl. Fehlende
Strukturabdeckung oder manipulierte abgeleitete Risikotags lassen die Validierung
weiterhin scheitern. [QGIS-Vergleich und Befund im Hannoveraner Straßennetz](qa/hannover-dgm1-qgis-city.md)

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
