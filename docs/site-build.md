# Reproduzierbarer Site-Build

Der kanonische Einstieg für Build und QA ist der Maven-Reaktor im
Repository-Root:

```bash
mvn clean verify
```

Für das auslieferbare öffentliche Pages-Artefakt einschließlich Browser-QA:

```bash
mvn clean verify -Ppages
```

Für eine vollständige Neugenerierung der konfigurierten Städte aus den
Rohquellen mit anschließend identischem Pages-Gate:

```bash
mvn clean verify -Ppages-regenerated
```

Maven installiert über `frontend-maven-plugin` die im Root-`pom.xml`
festgelegten Node- und npm-Versionen, führt `npm ci` gegen das eingecheckte
`package-lock.json` aus und startet anschließend die JavaScript-Werkzeuge als
Bestandteile des Maven-Lifecycles. npm und Playwright sind damit
Implementierungswerkzeuge innerhalb des Maven-Builds, keine konkurrierenden
Build-Einstiege.

Die beiden Pages-Workflows rufen ausschließlich den jeweils passenden
Maven-Befehl auf. Schleifen zur Datengenerierung, Site-Build, Browserstart,
Playwright-Aufrufe, Fingerprinting und Validierung liegen im Checkout und sind
daher ohne GitHub Actions ausführbar.

## Pages-Gate

Das Profil `pages` erzeugt `_site/` aus den eingecheckten Daten und prüft in
einem zusammenhängenden Vertrag:

- den statischen Site-Build und die explizite Datei-Allowlist;
- gzip-only Unfalldaten, Stadtbestand und Mindestanzahl an Features;
- Kontextdatensätze und Dokumentationsmedien;
- das öffentliche Distributionsprofil samt Vendor-, Lizenz- und
  SBOM-Metadaten;
- einen Fingerprint des vollständigen auslieferbaren Dateibaums;
- die Browser-Smoke-Tests und den mobilen kritischen Pfad gegen exakt dieses
  bereits gebaute Artefakt;
- dass die Browser-QA keine ausgelieferten Bytes verändert hat;
- die erneute Profilvalidierung nach dem Browserlauf.

Der kritische Pfad enthält ausdrücklich den gemeldeten widersprüchlichen
Bonn/Hannover-Deeplink und eine künstlich blockierte `cities.txt`-Anfrage. Der
Build schlägt fehl, wenn die aktive Stadt oder deren Unfalldaten auf den
Städtekatalog warten, die Bonner Auswahl außerhalb des sichtbaren Ausschnitts
bleibt oder der Hinweis der öffentlichen Version den mobilen Arbeitsbereich
belegt.

## Site-Artefakt

Der interne Site-Builder:

- übernimmt die statischen HTML-, CSS-, JS-, Daten-, Dokumentations- und
  Template-Dateien über eine explizite Allowlist;
- erzeugt ausschließlich gzip-komprimierte Site-Daten;
- kopiert Leaflet, MarkerCluster, Heat, Draw, leaflet-image, docx, pdfmake und
  FileSaver aus den exakt in `package-lock.json` aufgelösten npm-Paketen nach
  `_site/vendor/`;
- bricht ab, wenn `unpkg`- oder `jsDelivr`-Laufzeitreferenzen in der Anwendung
  verbleiben;
- schreibt `_site/build-manifest.json` mit App-Fingerprint,
  Dependency-Versionen, Vendor-Datei-Hashes, Datenmanifest-Hash,
  Stadt-/Feature-Metadaten, tatsächlich ausgeführter Node-/npm-/zlib-Version
  und Netzwerk-Policy;
- schreibt ein CycloneDX-1.6-Diagnoseinventar, assetgenaue `contains`-Kanten,
  entschlüsselte Roboto-TTF-Hashes samt Name-Tabellen und die geprüfte
  Restlücken-Policy nach `_site/vendor/`.

## Provenienzgrenzen

Der Pages-Build darf ein ausdrücklich als unvollständig markiertes
Top-Level-Vendorinventar erzeugen, sofern alle bekannten Lücken transparent im
öffentlichen Profil, Notice, SBOM und in der Policy dokumentiert sind. Die
bekannten Provenienz-Härtungspunkte blockieren die browserseitigen Funktionen
nicht pauschal.

Vollständige ZIP-/Container-Releases bleiben davon getrennt und rufen
`validate:vendor-provenance -- --require-complete` auf. Sie brechen fail-closed
ab, wenn Build-Locks, Komponenten, Lizenz-/Copyrighttexte,
Fontattestierungen oder SBOM-Kanten fehlen. [Issue #406](https://github.com/carstenartur/Unfallatlas/issues/406)
verfolgt diese Restarbeiten.

Ein vollständiger Build-Lock benötigt außerdem für jedes ausgelieferte Asset
zwei DSSE-signierte in-toto/SLSA-Provenienzen unterschiedlicher, in der
separaten Policy gepinnter Ed25519-Builder. Die Signaturen binden Output-Hash,
Lock-ID, direkten `argv`-Befehl, sämtliche Input-Hashes und die konkrete
Toolchain. Selbstdeklarierte oder im Lock eingeschleuste Schlüssel können das
Gate nicht öffnen.

## Netzwerk- und Offline-Verhalten

Browser-Bibliotheken und gebaute Unfalldaten benötigen zur Laufzeit kein CDN.
Ohne Netz bleiben Oberfläche, Filter und lokale Unfall-Layer verfügbar.
Grundkarten-Kacheln können fehlen; Overpass-Abfragen und optionale Server-APIs
sind dann ebenfalls nicht verfügbar und müssen als optionale Funktionen
degradieren. Ein Service Worker mit vollständigem Tile-Cache ist nicht Teil des
Offline-Vertrags.

Die HTML-Quelldateien referenzieren bewusst `vendor/…`. Direktes Öffnen per
`file://` oder ein Webserver im Repository-Root umgeht den Buildvertrag und wird
nicht unterstützt.

## Dokumentationsmedien

Die Media-QA wird im Maven-Lifecycle ausgeführt und prüft
`docs/media-manifest.json`: Existenz, Soll-Abmessungen, das
1,5-MiB-Einzelbudget statischer Kartenmedien, das 30-MiB-Gesamtbudget,
Dauer-/Größenbudget der explizit ausgenommenen Animation sowie lokale
Markdown-Referenzen. Das Gesamtbudget umfasst auch das kanonische Demo-GIF und
die gerenderte PDF-Vorschau. Neue Vollbild-Screenshots werden mit 1280×640
erzeugt.

Reviewbare Dokumentations-Screenshots entstehen ausschließlich über den
Live-Kartografie-Runner. Er lässt nur die im Layer-Register deklarierten
Grundkartenanbieter zu, verlangt erfolgreiche 2xx-Rasterantworten und schreibt
pro Bild eine Sidecar-Evidenz mit Provider-URL, HTTP-Status und MIME-Typ. Die
hermetische E2E-Suite bleibt davon getrennt und verwendet reproduzierbare
Fixtures.

Die darunterliegenden npm-Kommandos bleiben für gezielte Diagnose verfügbar,
sind aber nicht der veröffentlichte Buildvertrag. CI und lokale Vollprüfung
verwenden Maven.
