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
| `traffic.model.berlin-dtvw-2023` | ausgeglichener DTVw-Modellwert | Berlin, 2023 | `Kfz/24 h` | DL-DE-Zero-2.0 |
| `traffic.count.berlin-bicycle-hourly-2012-2025` | Rad-Dauerzählstelle | Berlin, 2012–2025 | `Fahrräder/Stunde` | DL-DE-Zero-2.0 |

Der Katalog ist keine Behauptung, dass ein aktueller Snapshot bereits
mitgeliefert wird. Originaldistributionen werden bewusst nicht ungeprüft in das
Repository übernommen. Ein Produktionslauf muss die tatsächlich abgerufenen
Bytes und den daraus erzeugten Snapshot pinnen.

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

## Generisches Snapshot-Schema

Das folgende Beispiel verwendet deshalb den weiterhin aktiven Berliner
DTVw-Modellwert:

```json
{
  "schemaVersion": 1,
  "snapshotId": "traffic.model.berlin-dtvw-2023.2026-07-28",
  "sourceId": "traffic.model.berlin-dtvw-2023",
  "retrievedAt": "2026-07-28T12:00:00Z",
  "distribution": {
    "url": "https://gdi.berlin.de/services/wfs/verkehrsmengen_2023",
    "sha256": "<sha256-der-originaldistribution>",
    "bytes": 12345,
    "mediaType": "application/gml+xml",
    "versionOrPublicationDate": "2024-12-06"
  },
  "coverage": {
    "city": "Berlin",
    "fromYear": 2023,
    "toYear": 2023,
    "modes": ["motor_vehicle"]
  },
  "observations": [
    {
      "observationId": "berlin-dtvw-segment-123-2023",
      "measurementType": "model",
      "mode": "motor_vehicle",
      "year": 2023,
      "period": "DTVw",
      "value": 18500,
      "unit": "Kfz/24 h",
      "wayId": "berlin-segment-123",
      "qualityNotes": ["Deterministisches Schema-Beispiel, kein Produktionswert."]
    }
  ]
}
```

Die Zahl illustriert nur das Schema. Sie darf nicht als realer Berliner Wert
in einen Produktionssnapshot kopiert werden.

## Registry-Schema

Die Hashes der normalisierten Snapshots liegen außerhalb der Snapshots selbst:

```json
{
  "schemaVersion": 1,
  "snapshots": [
    {
      "sourceId": "traffic.model.berlin-dtvw-2023",
      "path": "snapshots/berlin-dtvw-2023.json",
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
  city: "Berlin",
  failOnProviderError: true,
});
```

`failOnProviderError: true` ist für Produktion verpflichtend. Ein beschädigter
oder nicht mehr reproduzierbarer Provider darf nicht stillschweigend den
qualitativen Fallback verdecken.

## Noch offene Produktionsintegration

Für die vollständige Umsetzung von #413 fehlen weiterhin:

- WFS/GML- und XLSX-Parser mit Originalzeilen-/Feature-IDs und Goldwerten;
- Geometrie- und richtungsbewusstes Matching der Kölner Link-Werte;
- Coverage-Bericht, Frischeprüfung und sichtbare Warnung bei alten Messständen;
- Übernahme der ausgewählten Evidenz in Unfall-GeoJSON, Way-Tiles, Sidecar,
  Popups und Exporte;
- manuell gegen die Originalquellen geprüfte Goldfälle.

Bis diese Schritte abgeschlossen sind, bleiben die Provider opt-in und der
ausgelieferte Standardbestand qualitativ.
