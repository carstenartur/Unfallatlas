# Lizenzierte Verkehrsdaten-Snapshots

Die Unfallwerkbank verwendet numerische Verkehrswerte nur aus explizit
katalogisierten, offen lizenzierten Fachdatensätzen. Der bundesweite
OpenStreetMap-Fallback bleibt davon getrennt und liefert ausschließlich eine
qualitative Straßenklassen-Proxyklasse.

## Vertrauensgrenze

`scripts/providers/traffic_snapshot_provider.js` lädt keine beliebigen
Live-URLs. Ein importierbarer Stand benötigt gleichzeitig:

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

## Geprüfter Quellenkatalog

| Source-ID | Typ | Abdeckung | Einheit | Lizenz |
|---|---|---|---|---|
| `traffic.count.koeln-kfz-2010-2019` | kommunale Kfz-Zählung | Köln, 2010–2019 | `Kfz/24 h` | DL-DE-Zero-2.0 |
| `traffic.model.berlin-dtvw-2023` | ausgeglichener DTVw-Modellwert | Berlin, 2023 | `Kfz/24 h` | DL-DE-Zero-2.0 |
| `traffic.count.berlin-bicycle-hourly-2012-2025` | Rad-Dauerzählstelle | Berlin, 2012–2025 | `Fahrräder/Stunde` | DL-DE-Zero-2.0 |

Der Katalog ist keine Behauptung, dass ein aktueller Snapshot bereits
mitgeliefert wird. Originaldistributionen werden bewusst nicht ungeprüft in das
Repository übernommen. Ein Produktionslauf muss die tatsächlich abgerufenen
Bytes und den daraus erzeugten Snapshot pinnen.

## Snapshot-Schema

```json
{
  "schemaVersion": 1,
  "snapshotId": "traffic.count.koeln-kfz-2010-2019.2026-07-28",
  "sourceId": "traffic.count.koeln-kfz-2010-2019",
  "retrievedAt": "2026-07-28T12:00:00Z",
  "distribution": {
    "url": "https://offenedaten-koeln.de/sites/default/files/KFZ_Zaheldaten_2016-2019_node.csv",
    "sha256": "<sha256-der-originaldistribution>",
    "bytes": 12345,
    "mediaType": "text/csv"
  },
  "coverage": {
    "city": "Köln",
    "fromYear": 2010,
    "toYear": 2019,
    "modes": ["motor_vehicle"]
  },
  "observations": [
    {
      "observationId": "koeln-zaehlstelle-123-2019",
      "measurementType": "count",
      "mode": "motor_vehicle",
      "year": 2019,
      "period": "DTVw",
      "value": 18500,
      "unit": "Kfz/24 h",
      "geometry": {
        "type": "Point",
        "coordinates": [6.95, 50.94]
      },
      "direction": "Querschnitt, beide Richtungen",
      "qualityNotes": ["Aus der Originalzeile mit stabiler Quellen-ID übernommen."]
    }
  ]
}
```

Die Beispielzahl illustriert nur das Schema. Sie darf nicht als realer Kölner
Messwert in einen Produktionssnapshot kopiert werden.

## Registry-Schema

Die Hashes der normalisierten Snapshots liegen außerhalb der Snapshots selbst:

```json
{
  "schemaVersion": 1,
  "snapshots": [
    {
      "sourceId": "traffic.count.koeln-kfz-2010-2019",
      "path": "snapshots/koeln-kfz-2010-2019.json",
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
  city: "Köln",
  failOnProviderError: true,
});
```

`failOnProviderError: true` ist für Produktion verpflichtend. Ein beschädigter
oder nicht mehr reproduzierbarer Provider darf nicht stillschweigend den
qualitativen Fallback verdecken.

## Noch offene Produktionsintegration

Der Adapter schafft die lizenzierte und reproduzierbare Importgrenze. Für die
vollständige Umsetzung von #413 fehlen weiterhin:

- deterministische Parser für die drei Originalformate CSV, WFS/GML und XLSX;
- eingecheckte Parser-Fixtures mit Quellzeilen-IDs und Goldwerten;
- räumliches Matching gegen das vollständige Stadtstraßennetz einschließlich
  Richtungs- und Parallelfahrbahnkonflikten;
- Coverage-Bericht, Frischeprüfung und sichtbare Warnung bei alten Messständen;
- Übernahme der ausgewählten Evidenz in Unfall-GeoJSON, Way-Tiles, Sidecar,
  Popups und Exporte;
- manuell gegen die Originalquelle geprüfte Goldfälle.

Bis diese Schritte abgeschlossen sind, bleiben die katalogisierten Provider
opt-in und der ausgelieferte Standardbestand qualitativ.
