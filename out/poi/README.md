# POI-Daten für Unfallwerkbank V2

Dieses Verzeichnis enthält POI-Daten (Points of Interest) im GeoJSON-Format für verschiedene Städte.

## Dateiformat

Dateien sollten nach dem Muster `poi_<stadtslug>.geojson` benannt werden:

- `poi_hannover.geojson`
- `poi_berlin.geojson`
- `poi_muenchen.geojson`
- etc.

## GeoJSON-Struktur

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": {
        "type": "Point",
        "coordinates": [lon, lat]
      },
      "properties": {
        "id": "osm:node:123456",
        "type": "school|kindergarten|childcare",
        "name": "Name der Einrichtung",
        "source": "OpenStreetMap/Overpass"
      }
    }
  ]
}
```

## POI-Typen

- `school`: Schulen
- `kindergarten`: Kindergärten
- `childcare`: Kindertagesstätten

## Daten generieren

Das Script `fetch_poi_osm.sh` im Hauptverzeichnis kann verwendet werden:

```bash
./fetch_poi_osm.sh "Stadtname"
```

Dies lädt automatisch POI-Daten von OpenStreetMap und erstellt eine entsprechende GeoJSON-Datei in diesem Verzeichnis.

## Lizenz

POI-Daten stammen von OpenStreetMap:
- © OpenStreetMap contributors
- Lizenz: Open Database License (ODbL)
- https://www.openstreetmap.org/copyright
