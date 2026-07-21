# Reproduzierbarer Site-Build

`npm run build:site` ist der einzige unterstützte Einstieg zum Erzeugen der
statischen Anwendung. Der Befehl funktioniert in einem normalen Checkout nach
`npm ci` und schreibt das auslieferbare Ergebnis nach `_site/`.

```bash
npm ci
npm run build:site
npm run serve:site
# http://127.0.0.1:8000/werkbank_v2.html
```

Der Build:

- übernimmt die statischen HTML-, CSS-, JS-, Daten-, Dokumentations- und
  Template-Dateien über eine explizite Allowlist;
- erzeugt ausschließlich gzip-komprimierte Site-Daten;
- kopiert Leaflet, MarkerCluster, Heat, Draw, leaflet-image, docx, pdfmake und
  FileSaver aus den exakt in `package-lock.json` aufgelösten npm-Paketen nach
  `_site/vendor/`;
- bricht ab, wenn `unpkg`- oder `jsDelivr`-Laufzeitreferenzen in der Anwendung
  verbleiben;
- schreibt `_site/build-manifest.json` mit App-Fingerprint, Dependency-Versionen,
  Vendor-Datei-Hashes, Datenmanifest-Hash, Stadt-/Feature-Metadaten, tatsächlich
  ausgeführter Node-/npm-/zlib-Version und der Netzwerk-Policy. Die deklarierte
  `packageManager`-Version wird getrennt von der tatsächlich laufenden
  npm-Version ausgewiesen;
- schreibt ein CycloneDX-1.6-Diagnoseinventar, assetgenaue `contains`-Kanten,
  entschlüsselte Roboto-TTF-Hashes samt Name-Tabellen und die geprüfte
  Restlücken-Policy nach `_site/vendor/`.

GitHub Pages, Playwright-E2E, Dokumentations-Screenshots und der isolierte
Kontextdaten-E2E verwenden denselben Build. GitHub Actions enthält damit nur
Orchestrierung; der vollständige Buildvertrag liegt im Repository.

Der Site-Build darf für Test und Review ein ausdrücklich als unvollständig
markiertes Top-Level-Vendorinventar erzeugen. Veröffentlichung und Release
rufen zusätzlich `validate:vendor-provenance -- --require-complete` auf und
brechen derzeit bewusst ab. [Issue #406](https://github.com/carstenartur/Unfallatlas/issues/406)
verlangt einen reproduzierbaren Eigenbuild der opaken Exportbundles samt
Komponenten-SBOM, vollständigen Lizenztexten und Fontprovenienz.
`validate:vendor-provenance` bindet Notice, Policy und SBOM kryptographisch
aneinander. `complete: true` allein kann die Veröffentlichung nicht freigeben:
fehlende Build-Locks, Komponenten, Lizenz-/Copyrighttexte, Fontattestierungen
oder SBOM-Kanten werden unabhängig davon abgelehnt.
Ein vollständiger Build-Lock benötigt außerdem für jedes ausgelieferte Asset
zwei DSSE-signierte in-toto/SLSA-Provenienzen unterschiedlicher, in der
separaten Policy gepinnter Ed25519-Builder. Die Signaturen binden Output-Hash,
Lock-ID, direkten `argv`-Befehl, sämtliche Input-Hashes und die konkrete
Toolchain. Die aktuelle Policy enthält bewusst keine vertrauenswürdigen
Builder; selbstdeklarierte oder im Lock eingeschleuste Schlüssel können das
Gate daher nicht öffnen.

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

`npm run validate:media` prüft `docs/media-manifest.json`: Existenz,
Soll-Abmessungen, das 1,5-MiB-Einzelbudget statischer Kartenmedien, das
24-MiB-Gesamtbudget, Dauer-/Größenbudget der explizit ausgenommenen Animation
sowie lokale Markdown-Referenzen. Neue Vollbild-Screenshots werden mit
1280×640 erzeugt. Die Grenzen sind auf reale OSM-/WMS-/Orthofoto-Rasterdaten
kalibriert; flächige synthetische SVG-Testkacheln sind kein gültiger Weg, um ein
Medienbudget einzuhalten.

Reviewbare Dokumentations-Screenshots entstehen ausschließlich über den
Live-Kartografie-Runner. Er lässt nur die im Layer-Register deklarierten
Grundkartenanbieter zu, verlangt erfolgreiche 2xx-Rasterantworten und schreibt
pro Bild eine Sidecar-Evidenz mit Provider-URL, HTTP-Status und MIME-Typ. Die
normale E2E-Suite bleibt davon getrennt und verwendet weiterhin hermetische
Fixtures für reproduzierbare Funktionsregressionen.

Die Media-QA besitzt bewusst getrennte Stufen:

- `npm run validate:media:policy` prüft die ausführbare Manifest-, Pfad-,
  Referenz- und Budgetpolitik, ohne geprüfte Mediendateien oder einen
  Provenienz-Ledger vorzutäuschen;
- `validate:media -- --candidate-screenshots` prüft die im aktuellen Lauf
  erzeugten Screenshot- und Dokumentvorschau-Kandidaten vollständig und weist
  nicht neu erzeugte Medien im Report als `deferred` aus;
- der normale `npm run validate:media`-Lauf ist das strikte Promotion-Gate und
  bindet sämtliche eingecheckten Medien an die dauerhaft archivierte Evidence.

Die Screenshot-Workflows veröffentlichen nur Review-Artefakte samt
JSON-Größenbericht; eine Übernahme erfolgt über einen normalen Pull Request.
