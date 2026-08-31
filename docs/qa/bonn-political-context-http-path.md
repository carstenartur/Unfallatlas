# Bonn: HTTP- und Browservertrag der politischen Recherche

Stand: 31. August 2026

## Produktpfade

Die vollständige Unfallwerkbank-Serverinstallation verwendet weiterhin:

```text
POST /api/political-context/search
```

Der Server orchestriert OParl, die amtliche Portalsuche und dokumentierte
Fallbacks. Dieser Pfad bleibt die maßgebliche Vollrecherche.

GitHub Pages ist dagegen ein statischer Host und kann den POST-Endpunkt nicht
bereitstellen. Ohne ausdrücklich konfiguriertes HTTP(S)-Backend wird der
bekannt aussichtslose POST dort gar nicht erst gesendet. Die automatische
politische Recherche bleibt sichtbar serverpflichtig und der Suchknopf ist
gesperrt. Für Bonn zeigt die Oberfläche stattdessen Links zum amtlichen
Ratsinformationssystem sowie – soweit belastbare Ortsbegriffe vorliegen –
vorbelegte amtliche Suchlinks.

Ein Betreiber kann über `POLITICAL_CONTEXT_ENDPOINT`, eine passende Meta-Angabe
oder `API_BASE_URL` einen erreichbaren Backend-Endpunkt konfigurieren. Nur dann
sendet die öffentliche Oberfläche den POST an diesen ausdrücklich bestimmten
HTTP(S)-Endpunkt. HTTP 405 bleibt ein harter Konfigurationsfehler und wird nicht
als leerer politischer Suchbefund behandelt.

## Warum kein direkter OParl-Abruf im Browser erfolgt

Der Bonn-Live-Lauf vom 30. August 2026 hat die amtliche Paper-Sammlung mit der
Origin `https://carstenartur.github.io` geprüft. Die Antwort war fachlich
brauchbar (`HTTP 200`, JSON, ein Datensatz), enthielt aber weder
`Access-Control-Allow-Origin: https://carstenartur.github.io` noch `*`.

Damit kann ein Browser auf GitHub Pages die Antwort nach dem CORS-Modell nicht
lesen. Ein Test mit künstlich ergänztem CORS-Header würde lediglich eine
Funktion vortäuschen, die der amtliche Produktionshost nicht anbietet. Der
entsprechende Direktabruf wurde deshalb nicht freigeschaltet. Die negative
Live-Evidenz wird als Architekturentscheidung behandelt, nicht durch ein
abgeschwächtes Gate verdeckt.

Eine spätere automatische Pages-Suche benötigt entweder:

- ein ausdrücklich betriebenes Backend beziehungsweise einen Reverse-Proxy,
- oder einen während der Veröffentlichung erzeugten, versionierten und
  nachweislich vollständigkeitsmarkierten Same-Origin-Snapshot.

Ein begrenzter Snapshot darf weiterhin nie einen leeren Trefferbestand als
`searched-no-results` oder einreichungsreife politische Evidenz ausgeben. Die
Katalog-/Snapshot-Architektur wird in #642 weitergeführt.

## Regressionsevidenz

Vier unabhängige Verträge decken den früheren False-Green-Pfad ab:

1. `politicalContextHttpRoute.test.js` startet den echten Produktionsserver und
   sendet einen realen POST; 404 und 405 sind harte Fehler.
2. `publicPreviewQa.test.js` und
   `publicPoliticalContextFallbackContract.test.js` prüfen den expliziten
   Backendvertrag, den gesperrten Pages-Suchpfad und die amtlichen Bonner Links.
3. `political-context-bonn-pages-fallback.spec.js` führt den öffentlichen Pfad
   in Chromium aus und beweist, dass weder ein POST an den statischen Host noch
   ein nicht lesbarer OParl-Direktabruf gesendet wird.
4. Der bestehende Bonn-Live-Workflow prüft weiterhin den vollständigen
   serverseitigen OParl-/RIS-Evidenzpfad mit realen amtlichen Antworten.

Damit kann ein grüner Provider-Test nicht mehr verdecken, dass der reale
HTTP- oder Browserpfad unbenutzbar ist, und fehlende Browserfähigkeit wird nicht
zu einem falschen politischen Nullbefund.