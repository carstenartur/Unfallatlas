# Gerichtetes Matching der Kölner Kfz-Zählsegmente auf OSM

Der Producer `scripts/producers/koeln_kfz_osm_line_match_producer.js` verbindet die bereits positionsgleich validierten amtlichen Kölner Zählwerte und Liniengeometrien mit dem vorhandenen OSM-Straßennetz.

## Eingaben

- ein Artefakt vom Typ `koeln-kfz-official-geometry-join` aus dem amtlichen SHP-/SHX-/DBF- und CSV-Join;
- ein OSM-Stadtdatensatz mit identischen Way-IDs in `ways` und `wayGeometries`.

Beide Dateien müssen reguläre Dateien ohne symbolische Links sein. Ihre SHA-256-Werte werden in das Ergebnis übernommen.

## Verfahren

Jede gerichtete amtliche Segmentgeometrie wird nur einmal bewertet, auch wenn mehrere Jahresbeobachtungen dieselbe Geometrie verwenden. Der Matcher:

1. schränkt Kandidaten über räumlich gepufferte Bounding-Boxes ein;
2. tastet die amtliche Linie in reproduzierbaren Abständen ab;
3. projiziert jeden Abtastpunkt auf die OSM-Kandidatenlinie;
4. bewertet Mittelwert, 95-%-Distanz, Maximaldistanz, Richtungswinkel und abgedeckte Linienlänge;
5. bestimmt unabhängig von der OSM-Speicherreihenfolge `same` oder `reverse`;
6. akzeptiert nur Kandidaten innerhalb aller deklarierten Schwellen.

Nahezu gleich gute Kandidaten werden als `ambiguous` gespeichert. Sie werden nicht stillschweigend als Way-Zuordnung verwendet. Räumlich oder geometrisch ungeeignete Kandidaten ergeben ein typisiertes `unmatched`-Ergebnis.

## Aufruf

```bash
node scripts/producers/koeln_kfz_osm_line_match_producer.js \
  --traffic out/koeln-kfz-official-geometry.json \
  --osm .enrichment-cache/osm/osm_koeln.json \
  --generated-at 2026-07-31T12:00:00Z \
  --output out/koeln-kfz-osm-matches.json
```

Optionale Schwellen:

```text
--sample-spacing <m>
--search-radius <m>
--max-p95-distance <m>
--max-mean-distance <m>
--max-angle <Grad>
--min-coverage <0..1>
--ambiguity-margin <Score>
--json
```

Die verwendeten Parameter werden kanonisch gehasht. Das Ergebnis enthält Abdeckungszähler, gerichtete Gruppenmatches, unveränderte Beobachtungen mit zusätzlichem `osmMatch`, Konflikte zwischen Richtungsgegenpaaren und gemeinsam verwendete OSM-Ways.

## Wahrheitsgrenze

Der Producer behauptet ausdrücklich keine Fahrspurzuordnung und kein Unfallpunkt→Way-Matching. Amtliche Zählwerte, Zeitbezüge und synthetische Quellkennungen werden nicht verändert. Mehrdeutige Zuordnungen bleiben sichtbar mehrdeutig.
