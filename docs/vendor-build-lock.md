# Exact-Copy-Lock für Browser-Exportbibliotheken

Die statische Unfallwerkbank kopiert Browserbibliotheken ausschließlich aus dem
mit `npm ci` installierten, durch `package-lock.json` festgelegten Bestand. Für
die exportkritischen Pakete `docx` und `pdfmake` erzeugt der kanonische
Site-Build zusätzlich eine maschinenlesbare Exact-Copy-Attestation:

```text
_site/vendor/exact-copy-lock.json
```

## Abgrenzung zum vollständigen Vendor-Build-Lock

Der Typ dieses Piloten lautet ausdrücklich
`unfallatlas-vendor-exact-copy-lock`. Er ist **nicht** identisch mit dem bereits
vorhandenen vollständigen `unfallatlas-vendor-build-lock`, dessen Validator
zusätzlich Toolchain, Befehle, Eingaben, Quellen, Ausgaben und signierte
Rebuilds verlangt. Beide Schemata verwenden deshalb weder denselben Typnamen
noch denselben Referenztyp.

Der Exact-Copy-Lock kann später als Eingabe des vollständigen
Provenienzmodells verwendet werden. Er darf aber nicht als Ersatz für dessen
strengeren Vertrag oder als Nachweis eines vollständigen reproduzierbaren
Upstream-Builds behandelt werden.

## Was der Pilot beweist

Die eingecheckte Recipe `vendor/build-lock.recipe.json` bindet für jedes
abgedeckte Artefakt:

- Paketname und erwartete Version,
- `resolved`-Archiv und `integrity` aus `package-lock.json`,
- den konkreten Eingabepfad im installierten Paket,
- optionale Hilfseingaben wie Source Map und Roboto-TTF-Dateien,
- den exakten Zielpfad im ausgelieferten Site-Artefakt,
- Eingabe- und Ausgabegröße sowie SHA-256,
- eine stabile `lockRef` mit dem separaten Referenztyp
  `vendor-exact-copy-lock-reference`.

Die derzeit abgedeckten Ausgaben sind:

| Lock-Referenz | Paket | Eingabe | ausgelieferte Ausgabe |
|---|---|---|---|
| `export.docx.iife` | `docx@9.7.1` | `dist/index.iife.js` | `vendor/export/docx.js` |
| `export.pdfmake.min` | `pdfmake@0.3.11` | `build/pdfmake.min.js` | `vendor/export/pdfmake.js` |
| `export.pdfmake.font-container` | `pdfmake@0.3.11` | `build/vfs_fonts.js` | `vendor/export/pdfmake-fonts.js` |

Alle drei Operationen sind bewusst als `byte-for-byte-copy` modelliert. Der
Build bricht ab, wenn Version, Lockfile-Metadaten, Eingabepfad oder gelieferte
Bytes nicht mehr zur Recipe passen. Pfadflucht, Symlinks, doppelte Ziele,
fehlende Hilfseingaben und unbekannte Recipe-Felder werden ebenfalls
abgewiesen. Änderungen an einer der vier Roboto-TTF-Dateien ändern die
Lock-ID deterministisch.

## Lokale Reproduktion

```bash
npm ci
npm run build:site
npm run validate:vendor-build-lock
```

`npm run build:site` verwendet
`scripts/build-site-with-vendor-lock.js`: Zuerst läuft der bisherige kanonische
Site-Build, anschließend wird die Exact-Copy-Attestation ausschließlich über
die fertig erzeugten Vendor-Ausgaben geschrieben.
`validate:vendor-build-lock` berechnet dieselbe Attestation erneut und gibt ihre
`lockId` aus; bei Drift endet der Aufruf mit Fehler. Fehlt das Repository- oder
Site-Root, wird ein verständlicher `missing_root`-Fehler statt eines rohen
`ENOENT` ausgegeben.

Die `lockId` ist deterministisch aus Recipe, Package-Lock, Paketarchivdaten,
Eingabehashes, Hilfseingaben und Ausgabehashes abgeleitet. Zeitstempel oder
maschinenabhängige absolute Pfade gehen nicht ein.

## Sicherheitsgrenze

Der Pilot verbessert die Reproduzierbarkeit der bereits vorhandenen
Kopierstrecke, behauptet aber noch keine vollständige transitive
Build-Provenienz. Insbesondere bleiben als Arbeit in #406:

- Zerlegung der von `docx` und `pdfmake` upstream gebündelten Dateien in alle
  enthaltenen transitiven Komponenten;
- vollständige CycloneDX-`contains`-Kanten von den ausgelieferten Bundles zu
  diesen Komponenten;
- unabhängige Reproduktion des upstream Bundling-Schritts statt ausschließlicher
  Verifikation der veröffentlichten npm-Archivbytes;
- Einbindung der Exact-Copy-Referenzen als nachgewiesene Eingaben in den
  bestehenden vollständigen Vendor-Build-Lock;
- direkte Bindung an `vendor/third-party-notices.json`, Komponentenlizenzen und
  Font-Attestationen;
- Ausweitung auf die übrigen ausgelieferten Browserbibliotheken.

Bis diese Punkte abgeschlossen sind, bleibt
`third-party-notices.json.complete` korrekt `false`. Die neue Attestation darf
nicht benutzt werden, um die bestehenden bekannten Lücken zu verbergen oder
einen vollständigen SBOM-Status vorzutäuschen.
