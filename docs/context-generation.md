# Kontextdaten erzeugen und reparieren

Die Unfallwerkbank kann fehlende OSM-, Steigungs- und Verkehrsproxy-Daten für die aktuell ausgewählte Stadt neu erzeugen. Der Knopf erscheint im Abschnitt **Kontext-Filter (Detailanalyse)**, sobald für die Stadt keine angereicherten Kontextdaten erkannt werden.

## Sicherheits- und Konsistenzmodell

Die Erzeugung schreibt niemals direkt während der Producer-Läufe in den öffentlich ausgelieferten Datenbestand. Für jede Stadt gilt:

1. Unfall-GeoJSON in einen Arbeitsbereich übernehmen.
2. vollständiges OSM-Straßennetz erzeugen;
3. lokale SRTM-Kacheln laden und Höhen-/Steigungswerte berechnen;
4. transparent gekennzeichneten OSM-Verkehrsproxy erzeugen;
5. alle drei Producer-Dateien streng prüfen;
6. GeoJSON, Metadaten, Ways-Datei und Kontext-Tiles im Staging erzeugen;
7. Kontext-Dataset und Steigungsabdeckung prüfen;
8. erst danach die bisher ausgelieferten Dateien atomar ersetzen.

Ein fehlgeschlagener Lauf löscht daher keine zuvor funktionierenden Kontextdaten. Insbesondere ist das frühere Verhalten entfernt, bei fehlenden Producer-Dateien alte Felder zu löschen und trotzdem einen unvollständigen Stand zu committen.

> **Verkehrsdichte:** Die derzeit flächendeckend verfügbare Verkehrsklasse ist ein grober, als `OSM-highway-proxy` gekennzeichneter DTV-Proxy. Sie ist keine gemessene Verkehrszählung.

## GitHub Pages

Eine statische GitHub-Pages-Seite darf keinen schreibberechtigten GitHub-Token enthalten. Der Knopf kann deshalb nicht anonym direkt `workflow_dispatch` aufrufen.

Stattdessen:

1. kopiert die Webseite den ausgewählten Stadtnamen;
2. öffnet sie den Workflow **Generate context data for one city**;
3. dort **Run workflow** wählen, den kopierten Stadtnamen einsetzen und starten.

Workflow-Datei: `.github/workflows/generate-context-city.yml`

Für einen vollständigen parallelen Neuaufbau aller Städte steht **Enrich GeoJSONs (per-city matrix)** zur Verfügung. Der Aggregationsjob läuft nur, wenn sämtliche Städte erfolgreich erzeugt wurden; Teilstände werden nicht mehr committed.

## Docker

Im Docker-Image stellt der Node-Server folgende Endpunkte bereit:

| Methode | Endpunkt | Bedeutung |
| --- | --- | --- |
| `GET` | `/api/context-generation/status?city=Bonn` | Verfügbarkeit und laufender/letzter Auftrag |
| `POST` | `/api/context-generation/jobs` | Auftrag starten, Body z. B. `{ "city": "Bonn", "force": true }` |
| `GET` | `/api/context-generation/jobs/:id` | Status und begrenzte letzte Logzeilen |

Der Server akzeptiert ausschließlich Städte aus `cities.txt`, führt höchstens einen Generierungsauftrag gleichzeitig aus und übergibt die Benutzereingabe nicht an eine Shell.

### Persistente Daten und Caches

Für produktive Container sollten `out/` und `.enrichment-cache/` als Volumes persistiert werden:

```bash
docker run --rm -p 8000:8000 \
  -v unfallwerkbank-out:/app/out \
  -v unfallwerkbank-context-cache:/app/.enrichment-cache \
  ghcr.io/carstenartur/unfallatlas:latest
```

Der Producer-Cache spart insbesondere erneute OSM-Abfragen und SRTM-Downloads. Die ausgelieferten Dateien in `out/` überleben mit dem Volume einen Container-Neustart.

### Öffentliche Installationen absichern

Die lokale Generierung ist im Docker-Image standardmäßig aktiviert. Öffentlich erreichbare Installationen sollten sie entweder deaktivieren oder mit einem Token schützen:

```bash
# vollständig deaktivieren
-e CONTEXT_GENERATION_ENABLED=false

# oder schützen; die UI fragt den Wert beim Start ab und hält ihn nur in sessionStorage
-e CONTEXT_GENERATION_TOKEN='ein-langes-zufaelliges-token'
```

Es wird kein Token in statischen Dateien, URLs oder GitHub Pages gespeichert.

## Kommandozeile

Ein einzelner, auch ohne GitHub ausführbarer Checkout kann eine Stadt mit demselben atomaren Pfad erzeugen:

```bash
npm run generate:context-city -- --city Bonn --force
```

Vor einem direkten, selbstgebauten Aufruf des Enrichers können Producer-Dateien separat geprüft werden:

```bash
npm run validate:enrichment-inputs -- --city Bonn
```

Der zentrale Generator ist `scripts/generate-context-city.js`; GitHub Actions und Docker verwenden denselben Codepfad.
