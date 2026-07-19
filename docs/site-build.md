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
  npm-Version ausgewiesen.

GitHub Pages, Playwright-E2E, Dokumentations-Screenshots und der isolierte
Kontextdaten-E2E verwenden denselben Build. GitHub Actions enthält damit nur
Orchestrierung; der vollständige Buildvertrag liegt im Repository.

Der Site-Build darf für Test und Review ein ausdrücklich als unvollständig
markiertes Top-Level-Vendorinventar erzeugen. Veröffentlichung und Release
rufen zusätzlich `validate:vendor-provenance -- --require-complete` auf und
brechen derzeit bewusst ab. [Issue #406](https://github.com/carstenartur/Unfallatlas/issues/406)
verlangt einen reproduzierbaren Eigenbuild der opaken Exportbundles samt
Komponenten-SBOM, vollständigen Lizenztexten und Fontprovenienz.

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
Soll-Abmessungen, Dateibudgets, begründete Bestandsausnahmen sowie lokale
Markdown-Referenzen. Neue Vollbild-Screenshots werden mit 1280×640 erzeugt und
müssen höchstens 1 MiB groß sein. Die Screenshot-Workflows veröffentlichen nur
Review-Artefakte samt JSON-Größenbericht; eine Übernahme erfolgt über einen
normalen Pull Request.
