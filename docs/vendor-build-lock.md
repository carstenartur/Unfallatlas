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

Der vollständige Lock führt jeden eingebetteten Quelldatensatz mit einem
`ref` aus `supplementalLicenses` als Quelle vom Typ `file`. `attestation`
bindet die Quelle und `licenseAttestation` ihren vollständigen Lizenztext.
Die erzeugende Build-Anweisung nennt beide gehashten Eingaben und gegebenenfalls
den ursprünglichen Copyright-Hinweis. Beide DSSE-Signaturen binden diese
Eingaben und die nach `ref` sortierten Quelldatensätze unter
`externalParameters.supplementalSources` an das ausgelieferte Asset.
`component.buildAttestation` kann den vollständigen Lock ergänzend zur
bestehenden npm-Archivbindung `component.attestation` referenzieren.

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
| `export.docx.iife` | `docx@9.16.0` | `dist/index.iife.js` | `vendor/export/docx.js` |
| `export.pdfmake.min` | `pdfmake@0.3.15` | `build/pdfmake.min.js` | `vendor/export/pdfmake.js` |
| `export.pdfmake.font-container` | `pdfmake@0.3.15` | `build/vfs_fonts.js` | `vendor/export/pdfmake-fonts.js` |

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

Für `docx@9.16.0` wurde das vollständige Upstream-Build mit Node 26.13.1
und npm 11.20.0 aus dem vom npm-Release benannten Git-Stand
`f227ee1b1df33e72829b4250c156488be2fae193` ausgeführt. Das im Quellarchiv
enthaltene npm-Lockfile liegt vollständig in `vendor/docx-build/npm-lock.json.gz`.
Das Prüfskript vergleicht die entpackte Kopie byteweise mit der Herstellerdatei.
Sie fixiert auch die Versionen von fflate (0.8.3),
nanoid (6.0.2), Vite (8.3.8) und Rolldown (1.2.18). Gebautes und vom
Site-Build kopiertes IIFE haben jeweils 1.061.739 Bytes und denselben SHA-256
`436e003b7fc506af50f46ec0eb863d4dfba0f74090c7c5db71249f233f1e48c0`.
Der Seitenbuild prüft die drei npm-Quellpfade im IIFE, den Hash des
entpackten Hersteller-Locks und die unveränderten MIT-Texte. Notice und
CycloneDX binden `fflate@0.8.3` und `nanoid@6.0.2` als enthaltene Komponenten
an `vendor/export/docx.js`.

Die 356 im IIFE markierten DOCX-Quelldateien sind im Herstellerarchiv enthalten.
Beim Packer liegt unter dem Marker `src/export/packer/stream.ts` auch der
`events@3.3.0`-Polyfill. Das Modul importiert den EventEmitter und übernimmt die
benötigte Pipe-Implementierung aus `stream-browserify@3.0.0`. Beide stammen aus
dem Hersteller-Lock. Der Prüflauf gleicht Quelldateien, die 18 Ereignisbindungen
der Pipe und die vollständigen Originalhinweise für James Halliday, Joyent und
weitere Node-Mitwirkende ab. Die Bytebereiche im ausgelieferten IIFE und ihre
Lizenztexte sind einzeln in den Notices und in CycloneDX verzeichnet.

Zusätzlich nennt das ausgelieferte IIFE neun virtuelle Laufzeitmodule.
Rolldown 1.2.18 erzeugt den CommonJS-Helfer aus `runtime-base.js`; acht
weitere Helfer stammen aus `@oxc-project/runtime@0.156.0`. Der Herkunftsnachweis
verknüpft jeden Modulnamen mit dem Hash der unveränderten Quelldatei.
Die Hashes beziehen sich auf die Quellen vor der Minifizierung. Der
Herstellerbuild prüft diese Originaldateien und die ausgelieferten
Lizenztexte einschließlich der von Rolldown und Oxc benannten Drittanbieter.
Der separate Abgleich des vollständigen IIFE prüft die erzeugten Bytes.

Nach `npm ci` im Repository reproduziert der folgende Befehl den Vergleich.
Als optionales Argument akzeptiert er ein bereits heruntergeladenes
Upstream-Quellarchiv. Die Prüfsummen für Archiv, Lockfile und Bundle werden
vor dem Build gegen den festgelegten Stand geprüft.

```sh
bash scripts/verify-docx-upstream.sh
```

Der Build bindet die in der pdfmake-Source-Map enthaltene SVG-to-PDFKit-Datei
an das eigenständige npm-Paket `@pdfmake/svg-to-pdfkit@0.2.0`. Die Website
liefert dessen vollständige MIT-Lizenz aus.
Die unabhängigen Signaturen und der vollständige Komponentennachweis sind offen.

## Reproduktion des PDF-Bundles und der eingebetteten Schriftdateien

Für `pdfmake@0.3.15` enthält der in npm benannte Git-Stand
`9c0d9c96a21e20b278547380a1ec9d9e6cb4b89a` kein npm-Lockfile. Das separat
eingecheckte `vendor/pdfmake-build/npm-lock.json` fixiert die für die
Reproduktion verwendeten Archivversionen und Integritäten. Es betrifft nur
den optionalen Herstellerbuild. Die Zuordnung lässt sich mit den
`sources` und `sourcesContent` der ausgelieferten Source Map prüfen.

Der Upstream-Loader `string-replace-webpack-plugin` vergibt bei jedem
Build Zufallskennungen. Sie ändern die von Webpack erzeugten Modulnummern
für FileSaver und den zusammengefassten Browser-Einstieg. Die Buildregel
reserviert für genau diese beiden Module die Nummern 411 und 912 aus
der veröffentlichten Version und verwendet den ursprünglichen dreistelligen
Nummernraum. Bei einer fehlenden oder mehrdeutigen Zuordnung bricht sie ab.
Quelltext und fertige Bundles werden dabei nicht nachträglich umgeschrieben.

```sh
bash scripts/verify-pdfmake-upstream.sh
```

Der Vergleich prüft das minifizierte Bundle, seine Source Map mit 184
Quelldateien und den aus den Original-TTFs neu erzeugten VFS-Schriftcontainer
jeweils byteweise gegen das mit `npm ci` installierte pdfmake-Archiv.

Die PDF-Komponentenliste ordnet die Paketpfade der Source Map, die
umgeschriebene `xmldoc`-Referenz und die in PDFKit gebündelten Noble-Module
dem Herstellerbuild-Lock zu. Zu den Paketen gehören base64-js 1.5.1,
sax 1.6.1 und core-js 3.51.0. Der Seitenbuild vergleicht die Source Map und
den Lock mit den Hashes des reproduzierten Builds. Die Policy bindet die
exakte Paketmenge sowie den SHA-256 über Paketname, Version, `purl`,
`integrity`, `resolved`, den SPDX-Ausdruck, die Lock-Referenzen und die nach
Pfad sortierten Lizenzdatensätze. Dieselbe Prüfung bindet für DOCX und PDF
auch den direkten Paket- und Lizenznachweis. Notice und CycloneDX führen den
Hersteller-Lock je Bundle und Paket auf. Für `fflate@0.8.3` erscheinen daher
der DOCX- und der PDF-Lock jeweils an ihrem Bundle.

Die vier archivierten Lizenzdateien werden beim Neuaufbau mit den Originalen
aus fünf npm-Paketen verglichen. Webpack 5.113.0 und expose-loader 5.0.1
liefern denselben MIT-Hinweis bytegleich aus. Der exakte SVG-to-PDFKit-Fork
besitzt eine eigene CycloneDX-Dateireferenz mit Quell- und Lizenzhash.

Der Seitenbuild prüft alle neun von Webpack erzeugten Abschnitte in der
pdfmake-Source-Map gegen die Policy. Dazu zählen sechs Laufzeithelfer, der
UMD-Wrapper, der Bootstrap und der Einstieg. Notice und CycloneDX binden
den jeweiligen Quellhash an `webpack@5.113.0` aus dem PDF-Build-Lock und
an dessen vollständigen MIT-Hinweis. Der Hersteller-Rebuild prüft die
erzeugte Source-Map und das minifizierte Bundle byteweise.

PDFKit 0.21.0 enthält in seiner eigenen Browser-Source-Map fünf Module
von `@noble/hashes@2.4.0` und drei Module von `@noble/ciphers@2.4.0`.
Für jedes Modul vergleicht der Seitenbuild die Bytes mit dem installierten
Original aus dem PDF-Build-Lock. Die gehashte PDFKit-Source-Map ist über ihr
Browser-Modul an die äußere pdfmake-Map gebunden. Dabei prüft der Build
die vorgesehene Ersetzung des ICC-Ressourcenpfads. Die acht Dateien erscheinen
mit ihren Hashes und den ursprünglichen MIT-Texten in Notice und SBOM.
Das eingebettete Farbprofil ist bytegleich mit den 3.024 Originalbytes
von `sRGB2014.icc` im Profilregister des International Color Consortium.
Der Build vergleicht das Profil mit den Base64-Daten der inneren Source-Map
und dem Hersteller-Hash. Notice und SBOM binden den eigenen Lizenztext
des ICC an diese Datei. Der Abschnitt zu den Unicode-Daten beschreibt die
reproduzierten Ressourcen und die offenen Nachweise für die Shaper-Regeln.

PDFKit schreibt seinen SVG-Pfadparser ausdrücklich SVGO zu. Der Hersteller
[dokumentiert die Übernahme](https://github.com/foliojs/pdfkit/pull/1679).
Der Vergleich der Funktionskörper prüft die nach Umbenennungen, JSDoc-Cast und
einer umgestellten Bedingung verbleibenden Token. Der Quellabschnitt in der
inneren PDFKit-Map trägt den MIT-Originalhinweis von Kir Belevich. Die separat
von PDFKit als Inkscape-`svgtopdf` bezeichnete Bogenumwandlung hat einen
eigenen ausstehenden Herkunfts- und Lizenznachweis.

`fontkit@3.0.0` nennt in `src/utils.js` das Projekt `base64-arraybuffer`
als Quelle seines angepassten Base64-Decoders. Für die arabische und indische
Schriftformung nennt Fontkit HarfBuzz. Der Hersteller-Rebuild erzeugt die
Browser- und Node-Module aus dem in npm benannten Git-Stand und dessen Lockfile.
Er vergleicht die Module byteweise mit der npm-Version. Der Seitenbuild bindet
die Browser-Module direkt an die äußere PDF-Source-Map. Notice und CycloneDX
führen die Hashes der zugeordneten Quellabschnitte und die ursprünglichen
Lizenztexte. Die genaue Revision des Base64-Originals ist nicht angegeben.

Die 42 Übergänge der arabischen Zustandstabelle, alle elf aktiven indischen
Skriptkonfigurationen und 52 Fallzuordnungen für kombinierende Zeichen
stimmen mit den zeitgenössischen HarfBuzz-Referenzen überein. Fontkit nutzt
für Sinhala den Universal-Shaper. Der unabhängige Vergleich prüft für Thai
auch die Korrektur von U+0E4D. Die Google-Originalhinweise stehen in der Policy.

Der Herstellerlauf vergleicht außerdem die indische und die USE-Silbengrammatik
mit den hashgebundenen HarfBuzz-Quellen. Fontkit kürzt den indischen Silbenauslaut.
In der USE-Grammatik lässt Fontkit `Rsv` im unabhängigen Cluster aus und
ergänzt drei Regeln um die Kategorie Sakot und fügt zwei Sakot-Regeln hinzu.
Der Lauf prüft diese Anpassungen, baut die Zustandsmaschinen neu und vergleicht
die erzeugten Browser-Module byteweise. Der USE-Originalhinweis nennt Mozilla
und Google. Die Unicode-Kategorien und -Zerlegungen in diesen Modulen haben
eigene Herkunftsnachweise.

Sechs Dateien aus `brotli@2.1.0` tragen denselben Apache-2.0-Lizenzhinweis
mit Copyright von Google Inc. aus dem Jahr 2013. Der Seitenbuild vergleicht
diese Dateien bytegenau mit den in der PDF-Source-Map enthaltenen Quellen.
Der Hersteller-Lock fixiert das npm-Archiv und die Policy bindet die
Quellhashes, den gemeinsamen Lizenzkopf und den unveränderten Lizenzvolltext
der Apache Software Foundation. Notice und CycloneDX verknüpfen jede der
sechs Dateien mit dem gemeinsamen Copyright- und Lizenztext unter
`vendor/licenses/components/pdfmake-brotli-decoder-Apache-2.0.txt`.

Im [ersten manuellen JavaScript-Port](https://github.com/foliojs/brotli.js/commit/0dcb0a7394bda3e72ed7c9a8da8e22b592cc7ca8)
von Juli 2015 verweist das Submodul `vendor` auf [Googles Originalrevision](https://github.com/google/brotli/tree/d9a74803fa884559879e3205cfe6f257a2d85519/brotli/dec).
Deren C-Quellen für die Huffman-Dekodiertabelle und Speicherstreams tragen den
Google-Copyrightvermerk und Apache-2.0. Der Herstellercheck kompiliert diese
C-Dateien und vergleicht die erzeugten Huffman-Tabelleneinträge sowie die Lese-
und Schreiboperationen mit den JavaScript-Umsetzungen aus dem npm-Archiv.
Die Source Map bindet beide JS-Dateien. Der eigene ausgelieferte Hinweis
ordnet den Google-Text den übernommenen C-Anteilen zu.

Das aus `dec/dictionary.bin.js` dekodierte Wörterbuch ist mit den 122.784
Bytes von `c/common/dictionary.bin` im Original-Release 1.1.0 des
Brotli-Projekts identisch. Auch der Hexdump in RFC 7932, Anhang A,
ergibt denselben SHA-256. Notice und SBOM verknüpfen die Originalbytes
mit dem MIT-Text der Brotli-Autoren. Der Dateieintrag umfasst die
dekodierten Wörterbuchdaten.

Offen bleiben der Volltext für die MIT-Deklaration im Brotli-NPM-Paket,
die Lizenznachweise für die übrigen eingebetteten Brotli-Dateien, die
releasebezogenen Lizenzvolltexte für `dfa`, die vollständigen Nachweise
für intern gebündelte Komponenten und Daten sowie die unabhängigen,
von der Policy anerkannten Build-Signaturen.

Der Nachbau vergleicht die vier als Generator-Eingaben verwendeten TTF-Dateien
mit den Originaldateien unter `web/static/` im Roboto-3.016-Release von
Google Fonts. `vendor/pdfmake-build/roboto-release.json` bindet das
Releasearchiv, die vier Pfade, SHA-256, PostScript-Namen und Versionsfelder.
Der normale Seitenbuild prüft die dekodierten VFS-Dateien gegen dieselben
Hash- und Namensangaben und veröffentlicht den Archivnachweis je Schrift.

Der PDF-Herstellercheck baut außerdem alle vier Web-Schriften aus den UFO-
und Designspace-Quellen des Tags `v3.016` von Google Fonts. Er verwendet
Python 3.11, hashgebundene Buildwerkzeuge und den Hinting-, Subsetting-
und Instanziierungspfad des Herstellers. Für die Zeitfelder dienen die
Originalzeitstempel der jeweiligen Schrift aus dem gehashten Release.
Der Vergleich umfasst die vollständigen neu erzeugten TTF-Dateien.
Der separate Aufruf lautet `bash scripts/verify-roboto-upstream.sh Roboto_v3.016.zip`.
Mit `ROBOTO_PYTHON` lässt sich der Pfad zu Python 3.11 angeben.

Der PDF-Quellverweis `webpack://pdfmake/../xmldoc.ts` entsteht aus der
Source Map des ES-Modul-Einstiegs von `xmldoc@2.0.3`. Der Hersteller liefert
die TypeScript-Datei im Git-Quellarchiv. Die unabhängige Prüfung übersetzt
sie mit TypeScript 5.9.3 und vergleicht das JavaScript und seine Source Map
byteweise mit den tatsächlich für pdfmake installierten Dateien. Der
Seitenbuild prüft die beiden Hashes und ordnet den Eintrag dem exakten
PDF-Build-Lock und dem MIT-Lizenztext zu.

## Eingebettete Leaflet-image-Module

Der Seitenbuild vergleicht die beiden Browserify-Modulkörper in
`vendor/leaflet-image/leaflet-image.js` bytegenau mit `index.js` aus
`leaflet-image@0.4.0` und `build/d3-queue.js` aus `d3-queue@2.0.3`. Die
Policy bindet den Bundle-Hash, die Quellpfade und ihre SHA-256-Werte an die
Paketversionen und Archivintegritäten aus `package-lock.json`.

Notice und CycloneDX geben die Quellpfade und Hashes am ausgelieferten
Bundle an. Der Lizenznachweis bindet den archivierten Mapbox-Lizenztext und
die mit `d3-queue` gelieferte BSD-3-Clause-Lizenz. Die Artefaktprüfung
vergleicht das Inventar und die Lizenzhashes mit der eingecheckten Policy.
Der Maven-Profilaufruf `vendor-upstream-rebuild` prüft auch die zwei Kartenbibliotheken.
`bash scripts/verify-leaflet-upstream.sh` baut Leaflet-image 0.4.0 aus dem
bei npm angegebenen Git-Commit. Das separate npm-Lock unter
`vendor/leaflet-build/` fixiert Browserify 13.0.1, browser-pack 6.0.2,
umd 3.0.1 und d3-queue 2.0.3. Diese Werkzeuge laufen nur beim Nachbau.

Für Leaflet.heat 1.0.1 liefert das gehashte Quellarchiv das npm-Lock,
Rolldown 1.2.16, die Global-Einstiegsdatei und die Build-Konfiguration.
Der Nachbau setzt das Jahr im Copyright-Banner auf das Veröffentlichungsjahr
2026. Er vergleicht Global-Bundle und Source Map byteweise mit dem npm-Paket.
Für beide Kartenbibliotheken stehen die unabhängigen Signaturen aus.

## Generierte Unicode-Daten des PDF-Exporters

Drei generierte Unicode-Ressourcen des PDF-Exporters sind aus Originaldaten
reproduziert. `unicode-properties@2.0.2` erzeugt aus den 13 UCD-12.0.0-Dateien
in `codepoints@1.3.0` die Dateien `data.trie` (12.355 Bytes) und `data.js`
(2.556 Bytes). `linebreak@2.0.0` erzeugt aus `LineBreak.txt` von UCD 15.0.0
eine als JavaScript-Datendatei verpackte Trie-Struktur (4.110 Bytes).
Nach `npm ci` wiederholt `python3 scripts/reproduce-pdf-unicode.py` die
ursprünglichen Generatoren mit den gepinnten Quellen. Der Seitenbuild bindet
die Daten aus den installierten Paketmodulen an die PDF-Source-Map und das
ausgelieferte minifizierte Bundle. Notice und SBOM binden die
[Unicode-Lizenz](https://www.unicode.org/license.txt) ein. Die mitgelieferten
Original-Readmes nennen für UCD 12.0.0 © 2019 Unicode®, Inc. und für UCD 15.0.0
© 2022 Unicode®, Inc. Der archivierte Lizenztext nennt Copyright 1991–2026.

Das Maven-Profil `vendor-upstream-rebuild` baut außerdem die drei Tries und
die indische und USE-Zustandsmaschine aus Fontkit 3.0.0 nach und prüft die
damit erzeugten Browser- und Node-Dateien byteweise. Für die beiden
Silbengrammatiken liegen eigenständige Herkunfts- und Lizenznachweise vor.
Die Nachweise für andere Shaper-Regeln und die darin enthaltenen Daten
bleiben offen. Originaladressen und Prüfsummen stehen im
[Quellenmanifest](../vendor/pdfmake-build/unicode-data.json).
