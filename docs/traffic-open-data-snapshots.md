# Lizenzierte Verkehrsdaten-Snapshots

Die Unfallwerkbank verwendet numerische Verkehrswerte nur aus explizit
geprüften, offen lizenzierten Fachdatensätzen. Der bundesweite
OpenStreetMap-Fallback bleibt davon getrennt und liefert ausschließlich eine
qualitative Straßenklassen-Proxyklasse.

## Vertrauensgrenze

`scripts/providers/traffic_snapshot_provider.js` lädt keine beliebigen
Live-URLs. Ein importierbarer **generischer Snapshot** benötigt gleichzeitig:

1. einen im Quellcode geprüften Source-Descriptor mit Herausgeber, Datensatz,
   Distribution, Lizenz, Messart, Einheit und maximaler räumlich-zeitlicher
   Abdeckung;
2. den SHA-256 der heruntergeladenen Originaldistribution;
3. einen normalisierten JSON-Snapshot mit explizitem Abrufzeitpunkt,
   Distribution-Metadaten, Coverage und typisierten Beobachtungen;
4. einen zweiten, extern in der Registry gepinnten SHA-256 über genau diesen
   normalisierten Snapshot;
5. einen Pfad innerhalb eines ausdrücklich freigegebenen Importverzeichnisses.

Hashdrift, eine andere Download-URL, unbekannte Felder, Coverage-Erweiterung,
Beobachtungen außerhalb des Zeitraums oder Modus sowie Pfadflucht führen zum
Fehler. Erst danach validiert `js/ua.traffic_provider.js` jede Beobachtung und
die vollständige SourceManifest-Provenienz erneut.

## Aktiver generischer Quellenkatalog

| Source-ID | Typ | Abdeckung | Einheit | Lizenz |
|---|---|---|---|---|
| `traffic.model.hamburg-hvs-2019` | DTV aus dem Verkehrsmodell | Hamburg, amtlicher HVS-Abschnitt 1, 2019 | `Kfz/24 h` | DL-DE-BY-2.0 |
| `traffic.count.berlin-bicycle-hourly-2012-2025` | Rad-Dauerzählstelle | Berlin, 2012–2025 | `Fahrräder/Stunde` | DL-DE-Zero-2.0 |

Für den Hamburger Modellabschnitt enthält das Repository die abgerufenen
Originalbytes und den geprüften Snapshot. Der Provider vergleicht dessen
Prüfsumme zusätzlich mit dem Katalogeintrag. Für die Berliner Radzählungen
muss der Aufrufer einen eigenen geprüften Snapshot registrieren.

## Zurückgezogene Kölner Knotendatei

Die frühere Source-ID

```text
traffic.count.koeln-kfz-2010-2019
```

verwies auf:

```text
KFZ_Zaheldaten_2016-2019_node.csv
```

Diese Datei enthält Knotenkennungen und projizierte Koordinaten, aber keine
richtungsbezogenen numerischen Kfz-Zählwerte. Sie ist deshalb aus
`OPEN_DATA_SOURCE_CATALOG` entfernt. Ein altes Registry-Manifest scheitert mit
`retired_source` und enthält als maschinenlesbaren Ersatz:

```text
traffic.count.koeln-kfz-links-2016-2019
```

Die wirklichen Werte werden durch den formatbezogenen, hashgepinnten Provider
`scripts/providers/koeln_kfz_link_csv_provider.js` aus
`KFZ_Zaehldaten_2016-2019_link.csv` gelesen. Siehe
`docs/koeln-kfz-link-csv-provider.md`.

Die alte Source-ID wird nicht still auf eine andere Distribution umgebogen:
Ein vorhandener Snapshot könnte sonst trotz identischer ID eine völlig andere
Zeilen- und Richtungssemantik erhalten.

## Amtlicher Modellfall und vier Referenzfälle

Der [Hamburger Quellenkatalog](https://suche.transparenz.hamburg.de/dataset/verkehrsmengen-auf-hauptverkehrsstrassen-in-hamburg46)
beschreibt für 2019 die Umrechnung der werktäglichen Kfz-Modellwerte auf
Montag bis Sonntag und den anschließenden fachlichen Abgleich. Der
[amtliche Abschnitt 1](https://api.hamburg.de/datasets/v1/verkehrsmengen/collections/verkehrsmengen_dtv_hvs_2019/items/1?f=json)
enthält 4.000 Kfz/24 h und eine Liniengeometrie. Die Namensnennung lautet
„Freie und Hansestadt Hamburg, Behörde für Verkehr und Mobilitätswende, (BVM)“.
Der Wochentagsbezug des Schwerverkehrsanteils weicht vom DTV ab. Er geht
nicht in den Kfz-Modellwert ein.

Die [unveränderten Originalbytes und der normalisierte Snapshot](../tests/fixtures/traffic/hamburg-model/)
bilden den Bezugsfall für den optionalen Modellprovider. Die Registry muss
explizit auf den Snapshot mit seiner Prüfsumme zeigen. Er enthält weder
eine OSM-Weg-ID noch eine Zuordnung zu Unfallpunkten. Die früher verwendete
Kennung `traffic.model.berlin-dtvw-2023` ist für Modellwerte gesperrt.
Der [Berliner Methodenbericht, Abschnitt 7.2](https://www.berlin.de/sen/uvk/_assets/verkehr/verkehrsmanagement/verkehrserhebungen/ergebnisbericht-2023.pdf)
belegt die Hochrechnung von Zählungen. Eine neue Zuordnung solcher Daten
erfordert die belegte Herleitung für den jeweiligen Abschnitt.

| Typ | Referenzfall | Ergebnis |
|---|---|---|
| Messwert | Hamburg, Kollaustraße, BASt 2201, Unfall 9757 (2023) | 45.865 Kfz/24 h am Querschnitt. Die beiden Richtungszählungen bleiben separat. |
| Modellwert | Hamburg, amtlicher Hauptstraßenabschnitt 1 (2019) | 4.000 Kfz/24 h auf der amtlichen Modelllinie. |
| Historischer Messwert | Köln, Unfall 96301 (2019), Bayenthalgürtel | 5.830 Kfz/24 h aus einer DTVw-Hochrechnung 2019. Der mit Referenzjahr 2026 veröffentlichte Straßenbezug hat niedrige Qualität und eine Alterswarnung. |
| Straßenklassenproxy | Köln, Unfall 95521 (2019) | Hohe qualitative Klasse aus `highway=secondary`, ohne numerische Verkehrsmenge. |

Der Test `trafficPublishedGold.test.js` liest die Hamburger und Kölner
Unfallfälle aus den eingecheckten Stadtdateien und prüft den Modellfall mit
dem echten Registry-Aufruf gegen die amtliche GeoJSON-Antwort.

## Registry-Schema

Die Hashes der normalisierten Snapshots liegen außerhalb der Snapshots selbst:

```json
{
  "schemaVersion": 1,
  "snapshots": [
    {
      "sourceId": "traffic.model.hamburg-hvs-2019",
      "path": "snapshots/feature-1.snapshot.json",
      "sha256": "<sha256-des-normalisierten-snapshots>"
    }
  ]
}
```

Node-Integration:

```js
const traffic = require("../js/ua.traffic_provider");
const snapshots = require("../scripts/providers/traffic_snapshot_provider");

const registry = traffic.createRegistry();
snapshots.registerSnapshotManifest(registry, {
  allowedRoot: "/absoluter/pfad/zum/importverzeichnis",
  registryPath: "registry.json",
});

const observations = await registry.collect({
  city: "Hamburg",
  failOnProviderError: true,
});
```

`failOnProviderError: true` ist für Produktion verpflichtend. Ein beschädigter
oder nicht mehr reproduzierbarer Provider darf nicht stillschweigend den
qualitativen Fallback verdecken.

## Veröffentlichtes Straßenmatching und offene Zuordnungen

Die [Kölner Metadaten](https://carstenartur.github.io/Unfallatlas/out/output_all_years_koeln.enrichment.meta.json.gz)
vom 12. November 2026 weisen 2.716 eindeutig zugeordnete historische
Zählbeobachtungen unter 5.197 aus. Weitere 213 sind mehrdeutig, 2.268
konnten keinem Weg zugeordnet werden. Sie bleiben von der Messwertausgabe
ausgeschlossen. Insgesamt enthalten 3.957 Unfallpunkte historische
Kfz-Zählwerte. Quelle, Lizenz, Beobachtungszeitraum und Abrufzeitpunkt
stehen in `sources.trafficMatched.source`; die Güte der Zuordnung ist je
Beobachtung dokumentiert.

Die [Hamburger Metadaten](https://carstenartur.github.io/Unfallatlas/out/output_all_years_hamburg.enrichment.meta.json.gz)
weisen die BASt-Zuordnung von Station 2201 an einen Unfallpunkt im Messjahr
2023 aus, darunter beide getrennten Richtungskanäle. Sieben Stationen blieben
mehrdeutig. Vor einer weiteren Zuordnung sind belastbare Straßenreferenzen
und eindeutige Parallel- und Richtungsbezüge erforderlich.
Die [Düsseldorfer Radzählreihe](duesseldorf-bicycle-hourly-provider.md)
ist auf den amtlichen Zählpunkt und seinen belegten Radweg begrenzt.

Neue OSM-Abfragen speichern die verwendete Overpass-Adresse und den
Abrufzeitpunkt nach der letzten erfolgreichen Kachelabfrage. Vom Abruf zu
unterscheiden ist der Stand des OSM-Replikats. Der Erzeuger liest dafür
`osm3s.timestamp_osm_base` aus jeder erfolgreichen Kachelantwort. Der
Verkehrsproxy übernimmt den angegebenen Zeitpunkt bzw. die Spanne von der
frühesten bis zur spätesten Quellzeit. Fehlt auch nur ein gültiger Zeitstempel,
bleibt der Datenstand offen. Ein historisches `extractDate` ohne diese Nachweise
liefert keinen Zeitraum. Für die Auslieferung dieser Quellenangaben ist ein
neuer Kontextdatenlauf erforderlich.
