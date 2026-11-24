# Ortsbezüge für Ratsvorgänge

Die stadtspezifischen JSON-Dateien enthalten geprüfte Straßen und Orte. Amtliche Geometrien eines Vorgangs haben Vorrang. Bei einem reinen Straßenbezug dient der Straßenverlauf als Orientierung. Eindeutige Kreuzungen und Abschnitte erhalten eigene Geometrien.

`hannover-atkis.json.gz` bündelt die Straßenachsen des ATKIS Basis-DLM und die Hauskoordinaten des INSPIRE-Adressdienstes für Hannover. Die Geodaten stammen vom LGLN und werden unter CC BY 4.0 bereitgestellt. Das Paket enthält die Herkunft und Attribution. `python3 scripts/generate-hannover-ris-gazetteer.py` erneuert es aus den amtlichen Diensten und prüft die Abdeckung, bevor die Datei ersetzt wird. Der reguläre Ratsdaten-Import verwendet das eingecheckte Paket.

`python3 scripts/generate-hannover-ris-gazetteer.py --tram-context-output data/mobility/hannover-tram-context.json` aktualisiert die amtlichen Liniengeometrien für Stadt- und Straßenbahngleise. Der Antragsexport nutzt sie, wenn ihm für Hannover kein Gleisnachweis aus OpenStreetMap vorliegt.

`bash scripts/generate-hannover-district-boundaries.sh data/mobility/hannover-stadtbezirke.geojson` konvertiert die benannten Stadtbezirke aus der amtlichen SKH5-Gliederung nach WGS 84. Die Quellen- und Lizenzangaben stehen im GeoJSON. Die Zuordnung im Antrag setzt eine markierte Fläche voraus, die vollständig in einem Stadtbezirk liegt.

Eine größere, geprüfte Datei kann im selben Format übergeben werden: `enrichRisLocations(records, { city, gazetteer })`. `gazetteer.city` muss der Stadt des Katalogs entsprechen. Jeder Eintrag in `entries` enthält `name`, `kind` und `geometry` in GeoJSON-Koordinaten `[Längengrad, Breitengrad]`. `kind: "street"` erwartet einen `LineString` oder `MultiLineString`; mit `extent: "part"` wird ein kartierter Teil der Straße kenntlich gemacht. `kind: "place"` eignet sich für eindeutig benannte öffentliche Orte mit belegtem Standort oder Umriss. Namensgleiche Orte werden als getrennte Einträge erfasst und führen zu keiner Ableitung. `attribution` am Eintrag oder an der Datei wird in der Karte angezeigt. Links zur Herkunft und Lizenz gehören mit in die Datei.

Die einzelnen OSM-Einträge in den JSON-Dateien beruhen auf geprüften Namen und zusammenhängenden Wegen aus den verlinkten OpenStreetMap-Auszügen. Die zugehörigen Geometrien stammen aus den versionierten Unfallatlas-Kacheln. `evidence` nennt die Herkunft. Der Bonner Vorgang `260920-01 ST` nennt „Am Hauptbahnhof“. Die Hannoveraner Anfragen `1047/2026` und `1047/2026 F1` nennen zwei Kanäle. Sie erscheinen als Ortsangaben in der Recherche, solange die Lage der Radwegabschnitte offen ist.

Unter `publicFacilities` stehen die amtlich belegten Adressen der Berufsfeuerwehr Hannover. Der Import verbindet einen Einrichtungsnamen oder eine eindeutige Bezeichnung wie „Feuerwache“ mit der direkt zugehörigen Straße aus derselben Fundstelle. Er verwendet die amtliche Hauskoordinate oder den veröffentlichten Standortmarker der Stadt. `from` begrenzt die Ableitung einer fehlenden Hausnummer auf den Zeitraum, für den diese Anschrift belegt ist. Mehrdeutige Kombinationen bleiben offen. Die jeweilige Quelle steht unter `sourceUrl`.


`streetAliases` belegt einzelne Schreibvarianten amtlicher Vorlagen durch den eindeutigen Namen und den Straßenschlüssel des Landesverzeichnisses. Vorhandene amtliche Straßennamen behalten Vorrang. Für `regionalProjectAddresses` muss eine amtliche Quelle öffentliche Einrichtung, Standort und Postleitzahl gemeinsam bestätigen. Der Parser prüft den regionalen Projekttitel und die exakte Hausnummer und verwendet anschließend die reguläre Relevanzprüfung für Adresspunkte.

Die Dateien `bonn-reviewed-sites.json` und `hannover-reviewed-sites.json` verbinden einzeln geprüfte Vorgänge mit belegten Maßnahmenorten. `sites` führt die Geometrien mit Quellenverweis, räumlicher Bedeutung und Attribution. `records` bindet eine Fundstelle über Vorgangs-ID, Herkunft und aktuellen Originaltitel an einen oder mehrere dieser Orte. Verwandte Vorlagen benötigen jeweils einen eigenen Nachweis. Ein Bezug auf die Anlage eines anderen Vorgangs ist ausdrücklich gekennzeichnet. Die Punkte und Straßenachsen sind entsprechend der Genauigkeit ihrer Quelle beschriftet. Die Prüfung vom November 2026 ist im [Stichprobenprotokoll](../../docs/qa/2026-11-14-ris-stichproben.md) nachvollziehbar.

## Kartenbezüge aus dem Ratsatlas Hannover

`hannover-ratsatlas.json.gz` enthält die geprüften Ergänzungen des Ratsatlas zu
bestehenden städtischen SIM-Vorgängen. Die Verknüpfung verwendet Dokument-ID,
Quelle und unveränderten Titel. Der Import übernimmt den Ortsbeleg mit amtlicher
URL, Methode, räumlicher Genauigkeit, Geodatenquelle und Namensnennung. Bei
einer neuen Registerfassung entfallen zurückgezogene Zuordnungen. Eine neu
belegte Hausnummer kann einen bestehenden Bezug zur selben Straße ergänzen.
Gebietsnennungen erscheinen als Stadtbezirks- oder Stadtteilfläche.

Der Stand vom 21. November 2026 ergänzt im Quellkatalog 6.526 der 109.605
Vorgänge. Davon haben 2.469 nur einen Gebietsbezug, 3.514 einen Straßenverlauf,
183 einen Kreuzungsbereich, 341 eine Hauskoordinate oder die Endadressen einer
Spanne und 19 den belegten Bumke-Projektstandort. Die Stufen geben die Genauigkeit
der amtlichen Ortsangabe für den jeweiligen Ratsvorgang an. Der
Quellenprüfstand des Ratskatalogs behält sein ursprüngliches Datum.
[Prüfbericht und Rücknahmen](https://github.com/carstenartur/ratsatlas-Hannover/blob/437733d455bdfede122b93aa0c89accd3704dd80/docs/qa/2026-11-21-weitere-kartenorte/data-audit.json)

Die Ortsgrundlagen stammen von LGLN (2026), ATKIS Basis-DLM und INSPIRE
Hauskoordinaten aus ALKIS, bearbeitet, und von der Landeshauptstadt Hannover,
Bereich Geoinformation, Statistische Gliederung SKH5, für die Karte in WGS 84
übertragen und vereinfacht. Der Projektmarker E-Damm 5 und 9 stammt von
„Hannover baut“. [Geodaten, Bearbeitung und Lizenzen](https://github.com/carstenartur/ratsatlas-Hannover/blob/437733d455bdfede122b93aa0c89accd3704dd80/NOTICE.md#amtliche-orts--und-gebietsgrundlagen) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

Zum Wiederaufbau vom Stammverzeichnis der Unfallwerkbank aus einen benachbarten
Ratsatlas-Checkout verwenden. `snapshot_bundle.py` prüft das dort versionierte
Archiv. Der Import prüft die SHA-256 der drei erzeugten Datenprojektionen
gegen den Prüfbericht im angegebenen Git-Commit. Er benötigt keine Abrufe bei
der Stadt oder Region.

```sh
git clone https://github.com/carstenartur/ratsatlas-Hannover.git ../ratsatlas-Hannover
git -C ../ratsatlas-Hannover checkout --detach 437733d455bdfede122b93aa0c89accd3704dd80
(
  cd ../ratsatlas-Hannover || exit 1
  python3 -m venv .venv
  .venv/bin/pip install -r requirements-geo.txt
  .venv/bin/python scripts/snapshot_bundle.py unpack
  .venv/bin/python scripts/enrich_locations.py
)
python3 scripts/import-ratsatlas-locations.py ../ratsatlas-Hannover
```

Für einen neuen geprüften Stand `--revision` und `--audit` des Importeurs
setzen und die Hannover-Ortsrevision im Aktualisierungsskript erhöhen. Die
Registerfassung ist im Ortsbeleg jedes übernommenen Vorgangs hinterlegt.
