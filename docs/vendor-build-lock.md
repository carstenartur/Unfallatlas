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
| `export.docx.iife` | `docx@9.15.3` | `dist/index.iife.js` | `vendor/export/docx.js` |
| `export.pdfmake.min` | `pdfmake@0.3.14` | `build/pdfmake.min.js` | `vendor/export/pdfmake.js` |
| `export.pdfmake.font-container` | `pdfmake@0.3.14` | `build/vfs_fonts.js` | `vendor/export/pdfmake-fonts.js` |

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
- unabhängige signierte Build-Belege für die reproduzierten Bibliotheken;
- Einbindung der Exact-Copy-Referenzen als nachgewiesene Eingaben in den
  bestehenden vollständigen Vendor-Build-Lock;
- direkte Bindung an `vendor/third-party-notices.json`, Komponentenlizenzen und
  Font-Attestationen;
- Ausweitung auf die übrigen ausgelieferten Browserbibliotheken.

Bis diese Punkte abgeschlossen sind, bleibt
`third-party-notices.json.complete` korrekt `false`. Die neue Attestation darf
nicht benutzt werden, um die bestehenden bekannten Lücken zu verbergen oder
einen vollständigen SBOM-Status vorzutäuschen.

## Reproduktion des ausgelieferten DOCX-Bundles

Für `docx@9.15.3` wurde das vollständige Upstream-Build mit Node 24.22.1
und npm 11.9.0 aus dem vom npm-Release benannten Git-Stand
`ebd29699d5966bffaa9cf829545b8b6d9ed79d9a` ausgeführt. Das im Quellarchiv
enthaltene npm-Lockfile liegt vollständig in `vendor/docx-build/npm-lock.json.gz`.
Das Prüfskript vergleicht die entpackte Kopie byteweise mit der Herstellerdatei.
Sie fixiert auch die Versionen von fflate (0.8.3),
nanoid (6.0.2), Vite (8.3.5) und Rolldown (1.2.15). Gebautes und vom
Site-Build kopiertes IIFE haben jeweils 1.061.595 Bytes und denselben SHA-256
`262bb22541dd3f9f1f0323ce4e28093d1a7080124cfbd79db9fb383b3be72a5e`.
Der Seitenbuild prüft die drei npm-Quellpfade im IIFE, den Hash des
entpackten Hersteller-Locks und die unveränderten MIT-Texte. Notice und
CycloneDX binden `fflate@0.8.3` und `nanoid@6.0.2` als enthaltene Komponenten
an `vendor/export/docx.js`.

Nach `npm ci` im Repository reproduziert der folgende Befehl den Vergleich.
Als optionales Argument akzeptiert er ein bereits heruntergeladenes
Upstream-Quellarchiv. Die Prüfsummen für Archiv, Lockfile und Bundle werden
vor dem Build gegen den festgelegten Stand geprüft.

```sh
bash scripts/verify-docx-upstream.sh
```

Für pdfmake bindet der Build zusätzlich die in der minifizierten Source Map
enthaltene SVG-to-PDFKit-Quelldatei an das veröffentlichte npm-Archiv. Die
vollständige MIT-Lizenz dieses Forks wird mit der Website ausgeliefert.
Die unabhängigen Signaturen und der vollständige Komponentennachweis sind offen.

## Reproduktion des PDF-Bundles und der eingebetteten Schriftdateien

Für `pdfmake@0.3.14` enthält der in npm benannte Git-Stand
`fa0011f9767fde46d9828d0ce1005563c3dec902` kein npm-Lockfile. Das separat
eingecheckte `vendor/pdfmake-build/npm-lock.json` fixiert die für die
Reproduktion verwendeten Archivversionen und Integritäten. Es betrifft nur
den optionalen Herstellerbuild. Die Zuordnung lässt sich mit den
`sources` und `sourcesContent` der ausgelieferten Source Map prüfen.

Der Upstream-Loader `string-replace-webpack-plugin` vergibt bei jedem
Build Zufallskennungen. Sie ändern die von Webpack erzeugten Modulnummern
für FileSaver und den zusammengefassten Browser-Einstieg. Die Buildregel
reserviert für genau diese beiden Module die Nummern 633 und 8069 aus
der veröffentlichten Version und verwendet den ursprünglichen vierstelligen
Nummernraum. Bei einer fehlenden oder mehrdeutigen Zuordnung bricht sie ab.
Quelltext und fertige Bundles werden dabei nicht nachträglich umgeschrieben.

```sh
bash scripts/verify-pdfmake-upstream.sh
```

Der Vergleich prüft das minifizierte Bundle, seine Source Map mit 170
Quelldateien und den aus den Original-TTFs neu erzeugten VFS-Schriftcontainer
jeweils byteweise gegen das mit `npm ci` installierte pdfmake-Archiv.

Die veröffentlichte PDF-Komponentenliste ordnet 26 direkte npm-Paketpfade
der Source Map und den umgeschriebenen `xmldoc`-Pfad dem Herstellerbuild-Lock
zu. Das Bundle enthält beide Versionen von base64-js (0.0.8 und 1.5.1),
sax 1.6.1 und core-js 3.51.0. Der Seitenbuild vergleicht die Source Map und
den Lock mit den Hashes des reproduzierten Builds. Die Policy bindet die
exakte Paketmenge sowie den SHA-256 über Paketname, Version, `purl`,
`integrity`, `resolved`, den SPDX-Ausdruck, die Lock-Referenzen und die nach
Pfad sortierten Lizenzdatensätze. Dieselbe Prüfung bindet für DOCX und PDF
auch den direkten Paket- und Lizenznachweis. Notice und CycloneDX führen den
Hersteller-Lock je Bundle und Paket auf. Für `fflate@0.8.3` erscheinen daher
der DOCX- und der PDF-Lock jeweils an ihrem Bundle.

Fünf Lizenzdateien zu abweichend oder ausschließlich im Herstellerbuild
installierten Versionen sind archiviert und werden beim Neuaufbau mit den
installierten Originalen verglichen. Der exakte SVG-to-PDFKit-Fork besitzt
eine eigene CycloneDX-Dateireferenz mit Quell- und Lizenzhash. Offene Punkte
sind die vollständigen Nachweise für intern gebündelte Komponenten und
Daten, die fehlenden Volltexte für brotli, dfa und fontkit sowie die
unabhängigen, von der Policy anerkannten Build-Signaturen.

Der Nachbau vergleicht die vier als Generator-Eingaben verwendeten TTF-Dateien
mit den Originaldateien unter `web/static/` im Roboto-3.016-Release von
Google Fonts. `vendor/pdfmake-build/roboto-release.json` bindet das
Releasearchiv, die vier Pfade, SHA-256, PostScript-Namen und Versionsfelder.
Der normale Seitenbuild prüft die dekodierten VFS-Dateien gegen dieselben
Hash- und Namensangaben und veröffentlicht den Archivnachweis je Schrift.

Der PDF-Quellverweis `webpack://pdfmake/../xmldoc.ts` entsteht aus der
Source Map des ES-Modul-Einstiegs von `xmldoc@2.0.3`. Der Hersteller liefert
die TypeScript-Datei im Git-Quellarchiv. Die unabhängige Prüfung übersetzt
sie mit TypeScript 5.9.3 und vergleicht das JavaScript und seine Source Map
byteweise mit den tatsächlich für pdfmake installierten Dateien. Der
Seitenbuild prüft die beiden Hashes und ordnet den Eintrag dem exakten
PDF-Build-Lock und dem MIT-Lizenztext zu.
