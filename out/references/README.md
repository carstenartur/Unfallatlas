# Bezugsdokumente für Unfallwerkbank V2

Dieses Verzeichnis enthält Referenzen zu relevanten Dokumenten im JSON-Format für verschiedene Städte.

## Dateiformat

Dateien sollten nach dem Muster `references_<stadtslug>.json` benannt werden:

- `references_hannover.json`
- `references_berlin.json`
- `references_muenchen.json`
- etc.

## JSON-Struktur

```json
{
  "documents": [
    {
      "title": "Titel des Dokuments",
      "author": "Autor/Organisation",
      "date": "YYYY-MM-DD",
      "url": "https://example.com/dokument.pdf",
      "description": "Kurzbeschreibung des Dokuments"
    }
  ]
}
```

## Felder

### Erforderlich
- `title`: Titel des Dokuments

### Optional
- `author`: Autor oder Organisation
- `date`: Datum (Format flexibel, empfohlen: YYYY-MM-DD)
- `url`: Direkter Link zum Dokument
- `description`: Kurzbeschreibung oder Zusammenfassung

## Zweck

Bezugsdokumente dienen dazu, relevante Konzepte, Strategien und Planungen im Export-Report zu referenzieren:

- Verkehrssicherheitskonzepte
- Radverkehrspläne
- Schulwegsicherung
- Vision-Zero-Strategien
- Mobilitätsgesetze
- Unfallkommissionsberichte
- etc.

## Verwendung

Die Bezugsdokumente werden automatisch in die Export-Reports der Werkbank V2 integriert, wenn eine entsprechende Datei für die ausgewählte Stadt vorhanden ist.
