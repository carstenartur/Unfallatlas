# Atomische OSM-Sicherheitskette für DGM-Straßenprofile

Die beiden Einzelproducer

1. `osm_structure_producer.js` und
2. `osm_elevation_risk_producer.js`

bilden zusammen die Sicherheitsgrenze zwischen dem OSM-Straßennetz und einer
späteren DGM-basierten Fahrbahnneigung. Werden sie manuell nacheinander auf der
Originaldatei ausgeführt, könnte ein Fehler im zweiten Schritt einen teilweise
aktualisierten Cache hinterlassen.

`scripts/producers/osm_elevation_context_producer.js` führt beide Schritte daher
als eine lokale Transaktion aus.

## Verwendung

```bash
npm run generate:osm-elevation-context -- \
  --input .enrichment-cache/osm/osm_hannover.json
```

Optionale Parameter:

```text
--batch-size <n>       Way-IDs pro Overpass-Aufruf
--delay <ms>           Pause zwischen Batches
--endpoint <URL>       alternativer Overpass-Endpunkt
--retries <n>          Wiederholungsversuche
--backoff <ms>         Basiswartezeit zwischen Wiederholungen
--timeout <ms>         Overpass-Zeitlimit
--retrieved-at <ISO>   reproduzierbarer Abrufzeitpunkt für kontrollierte Läufe
--derived-at <ISO>     reproduzierbarer Ableitungszeitpunkt
--force                Strukturwerte erneut abrufen und Risiken neu ableiten
--json                 maschinenlesbare Zusammenfassung
```

## Transaktionsablauf

Der Producer:

1. prüft, ob bereits ein vollständig gültiger Risiko-Vertrag für **jeden** Way
   vorliegt;
2. kopiert andernfalls das OSM-Artefakt in eine zufällige Geschwisterdatei;
3. führt den vollständigen Strukturabruf ausschließlich auf dieser Stage aus;
4. leitet dort die normalisierten Risikotags ab;
5. validiert Strukturmetadaten, Rohdatenfingerprint, Top-Level-Vertrag und jeden
   einzelnen `ways[wayId].elevationRiskTags`-Eintrag;
6. verschiebt das Original auf eine Sicherungsdatei;
7. installiert die vollständig validierte Stage;
8. löscht die Sicherung erst nach erfolgreicher Installation.

Fehler beim Overpass-Abruf, bei der Layernormalisierung oder bei der
Endvalidierung verändern das Original nicht.

## Rückabwicklung

Schlägt die Installation nach dem Verschieben des Originals fehl, wird die
Sicherung zurückbenannt. Scheitert selbst diese Rückbenennung, bleibt die
Sicherungsdatei ausdrücklich erhalten und der Fehler enthält ihren exakten
Pfad. Sie wird in diesem Extremfall nicht durch einen allgemeinen
Aufräumblock gelöscht.

Die Stage-Datei besitzt genau einen Aufräumpfad im `finally`-Block. Dadurch
entsteht weder bei einem regulären Fehler noch nach erfolgreicher Installation
eine doppelte Löschoperation; die davon getrennte Originalsicherung folgt
weiterhin ausschließlich dem oben beschriebenen Rollbackvertrag.

## Wiederaufnahme und Manipulationsschutz

Ein Lauf wird nur dann als `already current` übersprungen, wenn:

- Struktur-Coverage und Way-Anzahl vollständig sind,
- Query- und Rohstruktur-Fingerprint übereinstimmen,
- Producer- und Schema-Version aktuell sind,
- der Consumervertrag exakt ist,
- jeder Way genau die fünf erwarteten Risikofelder besitzt,
- jeder abgeleitete Wert erneut aus dem unveränderten OSM-Rohwert berechnet
  werden kann.

Die einmal vollständig validierte Vertragsausgabe wird für Way-Anzahl und
Rohstruktur-Fingerprint wiederverwendet. Der Resume-Pfad berechnet denselben
Fingerabdruck daher nicht ein zweites Mal.

Wurde beispielsweise nur `elevationRiskTags.bridge` manipuliert, wird der
Risikovertrag lokal repariert. Der vollständige Strukturabruf muss dafür nicht
erneut ausgeführt werden. `--force` erzwingt dagegen bewusst beide Stufen.

## Bewusste Integrationsgrenze

Der Befehl ist lokal und checkout-reproduzierbar; es gibt keine zusätzliche
GitHub-Actions-Orchestrierung. Er wird in diesem Slice noch nicht automatisch
für jede Stadt durch `generate-context-city.js` ausgeführt. Das vermeidet eine
ungeprüfte zusätzliche Overpass-Last für alle Städte, solange der produktive
DGM1-Way-Profillauf noch nicht verdrahtet ist.

Der folgende #412-Slice soll für den verifizierten Hannover-DGM1-Lauf:

- diese Kette vor der Profilerzeugung aufrufen,
- `ways[wayId].elevationRiskTags` an `computeRoadGradient` übergeben,
- robuste Way-Profile im DEM-/Kontextartefakt speichern,
- Brücken-/Tunnel-Ausschlüsse und übrige Unsicherheitsgründe sichtbar machen.
