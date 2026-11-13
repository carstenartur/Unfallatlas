# Hannover – DGM1-Profile und Brückenübergänge

[Öffentliche Vergleichstabelle mit allen 292 interpolierten Geländehöhen](hannover-dgm1-profile.html)

## Vergleich mit dem amtlichen Landes-DGM1 am 13. November 2026

Für sechs OSM-Abschnitte wurden alle fünf kommunalen Originalarchive erneut mit ihren SHA-256-Prüfsummen abgeglichen. Die unabhängige QGIS-Auswertung reproduzierte alle 292 veröffentlichten Geländehöhen bytegenau. Vier zusätzlich geladene GeoTIFF-Kacheln des LGLN enthalten dieselben Abschnitte. Jede originale Kachel-XML nennt den 18.04.2016 als Erfassungsstand und `DE_DHHN2016_NH` als vertikalen Bezug. Im kommunalen DGM1 der Befliegung 2010 ist der vertikale Bezug weiterhin offen. Die Neigung wird aus den Höhenunterschieden **innerhalb** eines Bestands berechnet. Ein absoluter Höhenversatz zwischen den Erhebungen lässt sich daraus nicht bestimmen. [Kommunales Produktblatt](https://www.hannover.de/content/download/641402/file/Produktblatt_DGM.pdf) · [Landes-DGM1](https://dgm.stac.lgln.niedersachsen.de/collections/dgm1) · [Kachel-URLs und Datei-Prüfsummen](../../config/hannover-dgm1-lgln-reference-tiles.json)

| OSM-Weg | QGIS Stadt 2010 | QGIS Land 2016 | Öffentliche Hannover-Kacheln am 13.11., 07:15 UTC |
|---|---:|---:|---|
| Friedrichswall, 4697937 | +0,022 % | −0,042 % | 0,0 %, Qualität hoch |
| Hardenbergstraße, 6138345 | +2,801 % | +2,963 % | +2,8 %, Qualität hoch |
| Am Lindener Berge, 23101052 | −4,403 % | −4,520 % | −4,4 %, Qualität hoch |
| Am Lindener Berge, 24855098 | −23,307 % | −15,128 % | −26,1 %, Qualität niedrig, Unsicherheit ±19,1 Prozentpunkte |
| Friederikenbrücke, 24011492 | ≈ 0 % | −0,550 % | Fahrbahnzahl wegen Brücke ausgeschlossen |
| B 6, 23838108 | +22,266 % | +7,044 % | Fahrbahnzahl wegen Brückenübergang ausgeschlossen |

Die QGIS-Spalten verwenden dasselbe ±50-m-Fenster mit 1 m Abtastabstand, auf die vorhandene OSM-Linie begrenzt. Zusätzlich wurden beide Zeitstände in ±20 m und ±50 m mit 1, 2 und 5 m Abstand ausgewertet. Bei der Hardenbergstraße bleibt der Anstieg über diese Varianten zwischen +2,766 und +2,968 %. Beim kurzen Lindener Abschnitt reichen die Geländewerte über beide Zeitstände und alle Abstände von −33,944 bis −15,128 %. Die stabile Richtung allein trägt dort keine belastbare Angabe für die heutige Fahrbahn. Die zwei Geländemodelle liefern auch keine Messung der Brückendecks. Ein Vor-Ort-Aufmaß der heutigen Fahrbahn liegt für diese Fälle nicht vor. [292 Höhenpaare, 36 Varianten und Profilprüfsummen](hannover-dgm1-survey-comparison.json)

Für jeden Weg enthält die Vergleichsdatei die Landes-Kachel-IDs, die 1-m-Reihe im großen Fenster und ihren SHA-256. Die Prüfsumme gilt für UTF-8-Zeilen `Wegstation,Stadthöhe,Landeshöhe` mit 3, 4 und 4 Dezimalstellen und je einem LF. Die getrennten Hashes für die beiden Quellenkataloge und beide Geometriedateien binden sämtliche Eingaben. Die vier Raster und XML-Begleitdateien des LGLN werden anhand der URLs im Katalog in ein lokales Verzeichnis geladen. Der folgende Aufruf prüft deren Hashes, Höhenbezug und Erfassungsstand und erzeugt den Vergleich erneut.

```sh
/usr/bin/python3 scripts/qa-hannover-dgm1-qgis.py \
  --archives /pfad/zu/kommunalen-originalarchiven \
  --state-tiles /pfad/zu/lgln-originaldateien \
  --comparison /tmp/hannover-dgm1-survey-comparison.json
cmp /tmp/hannover-dgm1-survey-comparison.json docs/qa/hannover-dgm1-survey-comparison.json
```

Die öffentliche Metadatendatei, der Way-Index und die drei zuständigen Gzip-Kacheln waren beim HTTP-Abruf bytegleich mit dem Git-Stand `2b5a3bc6`. Für Straßenprofile nennt die Metadatendatei `hannover.dgm1`, 64.246 nutzbare von 81.678 Kachelzeilen und 79.158 eindeutige Wege. Wege an Kachelgrenzen können mehrfach vorkommen. `global.srtm30` beschreibt separat das Gelände im Umfeld. [Metadaten](https://carstenartur.github.io/Unfallatlas/out/output_all_years_hannover.enrichment.meta.json.gz) · [Index](https://carstenartur.github.io/Unfallatlas/out/ctxtiles/hannover/index.json.gz) · [Innenstadt](https://carstenartur.github.io/Unfallatlas/out/ctxtiles/hannover/4317/2692.json.gz) · [Lindener Berg](https://carstenartur.github.io/Unfallatlas/out/ctxtiles/hannover/4316/2692.json.gz) · [B 6](https://carstenartur.github.io/Unfallatlas/out/ctxtiles/hannover/4316/2691.json.gz)

Landesgeländehöhen und abgeleitete Neigungen: Quelle: LGLN 2026, CC BY 4.0. Stadtgeländehöhen: Bereich Geoinformation – LH Hannover (2026), CC BY 4.0. Weggeometrien: © OpenStreetMap contributors, ODbL 1.0. Interpolation, Regressionsrechnung und Vergleich sind eigene Bearbeitungen.

## Unabhängige Berechnung mit QGIS

PyQGIS 3.40.6 hat die OSM-Linien aus EPSG:4326 mittels PROJ nach EPSG:25832 transformiert und die Stationierungen entlang der projizierten Linie in Metern berechnet. Vier Originalkacheln aus den fünf SHA-256-geprüften kommunalen Vollarchiven wurden direkt anhand ihrer XYZ-Koordinaten als Float64-GeoTIFF angeordnet. QGIS las die vier nächstgelegenen Rasterzellmittelpunkte für jeden Stationspunkt. Bilineare Interpolation und SciPy-Theil-Sen lieferten die folgenden **Geländeprofile**. Jeder Prüfweg wurde auch im ±20-m-Fenster ausgewertet. Das Skript nutzt eigenständige Koordinaten, Stationierungen, Rasterleser und Regressionsberechnungen. Der Vergleich überprüft die Geländerechnung. Die tatsächliche Fahrbahnoberfläche wurde vor Ort bisher nicht vermessen.

| Weg | Tatsächliche Länge im ±50-m-Fenster | QGIS / Originalgelände | Produkt am Vollraster |
|---|---:|---:|---|
| Friedrichswall, 4697937 | 81,40 m | +0,022 % | 0,0 % |
| Hardenbergstraße, 6138345 | 33,50 m | +2,801 % | +2,8 % |
| Am Lindener Berge, 23101052 | 100,00 m | −4,403 % | −4,4 % |
| Friederikenbrücke, 24011492 | 35,90 m | ≈ 0,0 % | Brücke, keine Fahrbahnzahl |
| Am Lindener Berge, 24855098 | 25,40 m | −23,307 %, Residual-MAD 1,302 m | −26,1 %, MAD 1,625 m, Qualität niedrig |
| B 6 Westschnellweg, 23838108 | 7,48 m | +22,266 %, MAD 0,255 m | Brückenübergang, keine Fahrbahnzahl |

Das unabhängige Verfahren bestätigt die starke Unregelmäßigkeit bei Way 24855098. Auf nur rund 25 m reagieren Richtung und Betrag der lokalen Geländeänderungen auf die Stationierung. Die physische Ursache und die heutige Fahrbahnhöhe sind offen. Die Vergleichsdaten stammen aus der Laserscanbefliegung 2010. Der vertikale Höhenbezug ist in den gefundenen kommunalen DGM-Metadaten weiterhin unbenannt. Eine manuelle Abnahme durch eine vermessungskundige Person steht aus.

Zur Wiederholung werden das System-Python für QGIS, die GDAL-Bindings, NumPy und SciPy sowie die fünf Originalarchive aus `config/hannover-dgm1-city-archives.json` benötigt.

```sh
/usr/bin/python3 scripts/qa-hannover-dgm1-qgis.py --archives /pfad/zu/originalarchiven --samples docs/qa/hannover-dgm1-samples.json
```

## Westschnellweg an der Schwanenburgbrücke

Der kurze B-6-Way 23838108 führt zum Abzweig Limmerstraße. Sein nördlicher Knoten 258316371 gehört im originalen OSM-Ausschnitt gleichzeitig zum Brücken-Way 23838107 (`bridge=yes`, `layer=1`) und zum Umriss der Schwanenburgbrücke 702877983 (`man_made=bridge`). Der 7,48-m-Way selbst trägt kein Brückentag. Seine früher als `high` ausgegebenen +22,6 % (±9,5 Prozentpunkte) folgen den Geländepixeln am Übergang. Beide gewählten Fenster erreichen den gemeinsamen Brückenendpunkt und geben jetzt keine Fahrbahnneigung aus. Der maschinenlesbare Grund lautet `bridge_transition_surface_not_represented_by_dtm`.

Die Verknüpfung ist für den konkreten Fall über die gemeinsame OSM-Knoten-ID und über die Geometrie belegt. Im übrigen Netz ermittelt der Producer exakt deckungsgleiche Endpunkte der unbearbeiteten Way-Geometrien. Auch bei identischen Endkoordinaten und unterschiedlichen OSM-Knoten wird der Übergang vorsorglich ausgeschlossen. Ein bloß benachbarter oder kreuzender Weg löst den Ausschluss nicht aus. Bei langen anschließenden Wegen bleibt jedes Fenster, das den Übergang verfehlt, eigenständig auswertbar. Fehlende Brückentags oder Datenstände mit anderer Linienführung bleiben mögliche Ursachen für übersehene Übergänge.

Die Straßenbauverwaltung dokumentiert die Schwanenburgbrücke als B-6-Querung der Leine. Das OSM-Original enthält die einzelnen Linien, ihren gemeinsamen Knoten und den Umriss. [NLStBV – Leinequerung Schwanenburgbrücke](https://www.strassenbau.niedersachsen.de/startseite/projekte/bundesstrassen/schnellwege_in_hannover/westschnellweg/informationen_zum_projekt/leinequerung_schwanenburgbrucke/leinequerung-schwanenburgbrucke-214073.html) · [OSM-Way 23838108](https://www.openstreetmap.org/way/23838108) · [Brücken-Way 23838107](https://www.openstreetmap.org/way/23838107) · [Originalnachweis mit Hash](../../tests/fixtures/hannover-dgm1-real/westschnellweg-transition.json)

## Abdeckung des stadtweiten Prüflaufs

Der veröffentlichte Hannoveraner Index vom 10. November enthält 79.118 Wege. Im [Hannover-Extrakt von BBBike](https://download.bbbike.org/osm/bbbike/Hannover/Hannover.osm.pbf) mit OSM-Replikationsstand 7. November, 00:00 UTC, sind 79.097 dieser IDs enthalten. Die vollständigen Koordinaten aller Wegknoten wurden mit pyosmium aus dem 83.033.521 Byte großen PBF gelesen (SHA-256 `befc9974468800df3d10d518b68df8cfa56c7cf4a83820f45d86e4444ccf2a26`). Der Vergleich benutzte `douglasPeucker` mit der produktiven 3-m-Toleranz, dieselbe Rundung und die OSM-Straßenklasse. 41 Linien und eine Straßenklasse wichen ab. In den Prüflauf gingen 79.055 Wege ein, deren nach dieser Methode codierte Geometrie und Klasse identisch waren. Die Profilrechnung selbst verwendete deren vollständige OSM-Knoten, die Struktur-Tags des PBF und das kommunale 1-m-Vollraster. OSM-Änderungen unterhalb der öffentlichen Geometriegenauigkeit bleiben möglich.

| Ergebnis für den jeweiligen Way-Mittelpunkt | ±20 m | ±50 m |
|---|---:|---:|
| Qualität hoch | 61.701 | 61.201 |
| Qualität mittel | 186 | 415 |
| Qualität niedrig | 18 | 38 |
| Wegen Bauwerksrisiko unbrauchbar | 2.840 | 3.145 |
| Zu wenig Höhenwerte im Fenster | 4.100 | 4.046 |
| Zu kurze Geometrie | 10.207 | 10.207 |
| Ungültiger OSM-Layer | 3 | 3 |
| Geprüfte Ways | 79.055 | 79.055 |

Bei ±50 m unterdrückt der Brückenübergang zusätzlich 752 vorab als Zahlen ausgegebene Profile. Dazu gehören die B 6 und die folgenden Beispiele mit jeweils deckungsgleichem Endpunkt: Schloßstraße 10677751 an 46817955 (vorher −79,5 %), An der Schleuse 23272758 an 23272759 (+27,9 %) und Fischerhof 23515375 an 23515374 (+23,2 %). Die Werte stammen aus einer offline durchgeführten Prüfung. Eine Straßenneigung wird für diese vier Fenster nicht ausgewiesen.

Von 21.539 veröffentlichten Unfallpunkten verweisen 20.743 auf einen überprüften Way mit numerischem ±50-m-Mittelpunktprofil, davon 20.721 hoch, 20 mittel, 2 niedrig eingestuft. Die übrigen 796 verteilen sich auf 550 Bauwerksausschlüsse, 29 mit zu wenig Höhenwerten, 26 mit zu kurzer Geometrie und 191 ohne geprüfte Way-Zuordnung. Die Zahlen beschreiben das Profil in der Mitte des zugeordneten Ways. Sie eignen sich nicht als am jeweiligen Unfallpunkt gemessene Neigung.

Die OSM-Wege 59312041 und 271478069 tragen `layer=-0,7`, Weg 1443504097 trägt `layer=0.5`. Alle drei erhalten einen identifizierbaren Ausschluss. Die Zuverlässigkeit für die heutige Fahrbahnoberfläche, die Übertragbarkeit auf Unfallpunkte und die fachliche Kalibrierung der übrigen auffälligen Profile bleiben offene Kriterien vor einer stadtweiten Freigabe.

Datenquelle: CC-BY-4.0 – Bereich Geoinformation – LH Hannover (2026), Befliegung 2010. Transformation, Rasteraufbereitung, räumliche Zuordnung und Profilberechnung sind eigene Bearbeitungen. Straßengeometrien und Tags: © OpenStreetMap contributors, ODbL 1.0.
