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

## Einbindung in das gemeinsame Traffic-Modell

`scripts/providers/koeln_kfz_osm_matched_provider.js` liest ausschließlich ein extern SHA-256-gepinntes Matcher-Artefakt und prüft zusätzlich dessen internen kanonischen Artefaktfingerabdruck. Der Provider:

- veröffentlicht nur Beobachtungen mit `osmMatch.status="matched"`;
- setzt deren gemeinsamen `wayId` auf den eindeutig ermittelten OSM-Way;
- bewahrt amtlichen Wert, Jahr, Zeitraum, Richtung und Liniengeometrie;
- übernimmt Richtungslage, Qualitätsklasse, Mittel-/P95-/Maximaldistanz, Winkel und Abdeckung in die Qualitätsangaben;
- weist mehrdeutige und nicht gematchte Beobachtungen in Abdeckungszählern aus, veröffentlicht sie aber nicht als Way-Messwert;
- kann für kontrollierte Produktionsläufe mit `requireFullCoverage:true` bei jeder Restlücke fail-closed abbrechen.

Dadurch verwendet die Kölner Quelle ohne Sonderpfad dieselbe bestehende Hierarchie wie andere Traffic-Provider:

1. frischer Messwert,
2. amtlicher Modellwert,
3. älterer Messwert mit sichtbarer Warnung,
4. qualitativer OSM-Proxy ohne erfundenen DTV-Wert,
5. keine Angabe.

Die Quellbeschreibung bindet den Originaldatensatz, seine Lizenz und das abgeleitete Matcher-Artefakt. Die Messwerte von 2016–2019 werden bei einem späteren Bezugsjahr weiterhin als alt bewertet und nicht künstlich aktualisiert.

## Wahrheitsgrenze

Der Producer behauptet ausdrücklich keine Fahrspurzuordnung und kein Unfallpunkt→Way-Matching. Amtliche Zählwerte, Zeitbezüge und synthetische Quellkennungen werden nicht verändert. Mehrdeutige Zuordnungen bleiben sichtbar mehrdeutig. Der Provider macht nur eindeutige Matches für die vorhandene Messwert-/Modell-/Proxy-Auswahl nutzbar; er verwandelt Restlücken nicht in Messwerte.

## Bindung an die tatsächlich veröffentlichten Way-Geometrien

Der Anwendungsadapter benötigt neben dem extern gepinnten Match-Artefakt die
ursprüngliche OSM-Matching-Eingabedatei. Standardmäßig liegt sie mit dem im
Artefakt angegebenen Basename neben dem Artefakt; `--osm-input` erlaubt einen
expliziten Pfad. Ihr SHA-256 muss exakt dem transitiv gebundenen
`sources.osm.sha256` entsprechen.

Vor jedem Schreiben prüft der Adapter sämtliche betroffenen Way-Geometrien und
die Unfallzuordnungen. Die geordnete öffentliche Koordinatenfolge muss exakt der
gepinnten Eingabe entsprechen. Falls die öffentliche Geometrie aus rohen OSM-
Koordinaten vereinfacht wird, muss die Eingabe dies ausdrücklich deklarieren:

```json
"publicGeometry": {
  "format": "ua-encodeGeometry-v1",
  "method": "douglas-peucker",
  "toleranceMeters": 3
}
```

Dies verwendet die bestehenden `douglasPeucker`-/`encodeGeometry`-Funktionen des
Enrichers. Die Matchbewertung selbst bleibt auf der originalen Rohgeometrie.
Ohne Deklaration wird keine Vereinfachung angenommen. Geänderte Koordinaten,
umgekehrte Reihenfolge, fehlende Geometrien oder ein abweichender Eingabepin
brechen vor der ersten Ausgabeänderung ab. Die Metadaten bewahren den geprüften
Eingabepin, die Darstellungsregel, den Hash der geordneten Geometrien und die Zahl
der tatsächlich geprüften Ways. Nicht verwendete Quell-Ways außerhalb des
aktuellen Ausgabebestands werden nicht als veröffentlichte Way-Abdeckung gezählt.
