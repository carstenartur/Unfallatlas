# Exact-Copy-Provenienz in Notices und CycloneDX

Der kanonische Browserbuild erzeugt zunächst ein schlankes Assetinventar, danach
den `vendor/exact-copy-lock.json` und bindet die geprüften Operationen an
`build-manifest.json.vendorAssets[]`. Diese Zuordnung wäre unvollständig, wenn
`third-party-notices.json` und die CycloneDX-Dateikomponenten weiterhin nur den
Paketnamen und den ausgelieferten Hash kennen würden.

`scripts/vendor-exact-copy-provenance.js` projiziert deshalb dieselbe bereits
validierte Exact-Copy-Beziehung in alle finalen Provenienzartefakte.

## Gebundene Artefakte

Für jedes Asset mit `vendorAssets[].exactCopy` müssen gleichzeitig existieren:

- ein bytegleiches `assetAssessments[]`-Element in
  `vendor/third-party-notices.json`;
- die über `componentPurl` referenzierte Notice-Komponente;
- eine CycloneDX-Dateikomponente
  `urn:unfallatlas:vendor-asset:<asset-path>`;
- die CycloneDX-Paketkomponente mit genau derselben PURL;
- eine Datei-zu-Paket-Abhängigkeitskante.

Das Notice-Asset erhält den vollständigen `exactCopy`-Beleg. Die CycloneDX-
Dateikomponente erhält Eigenschaften für Lock-ID, Lock-Referenz, Komponent-PURL,
Methode sowie Eingabe- und Ausgabe-SHA-256. Die Dateiabhängigkeit enthält die
Komponenten-PURL in `dependsOn`.

## Fail-closed-Vertrag

Die Bindung bricht unter anderem ab bei:

- fehlendem oder doppeltem Asset, `lockRef` oder CycloneDX-`bom-ref`;
- Abweichungen von Paket, Pfad, Bytezahl oder SHA-256;
- fehlender Komponentenreferenz in Notices oder SBOM;
- fehlender Datei-zu-Komponente-Kante;
- einer Summary-Zeile, die nicht exakt zum eingebetteten Assetbeleg passt;
- abweichender Anzahl oder abweichendem Asset-Binding-Fingerprint;
- Hashdrift bei Notice oder SBOM;
- Symlink-, Pfadflucht- oder Nicht-Datei-Zielen.

## Atomare Installation

Die neuen Notice- und SBOM-Bytes werden zuerst nur im Speicher erzeugt. Der
Application-Fingerprint wird mit diesen virtuellen Bytes berechnet, ohne den
bestehenden Sitebaum vorzeitig zu verändern. Erst danach ersetzt eine gemeinsame
Transaktion:

1. `vendor/sbom.cdx.json`,
2. `vendor/third-party-notices.json`,
3. `build-manifest.json`.

Schlägt eine Umbenennung mitten in der Installation fehl, werden alle bereits
ausgetauschten Dateien aus den Geschwister-Backups wiederhergestellt. Ein
Buildmanifest kann dadurch nicht auf alte Notices oder ein neues SBOM ohne
passendes Manifest zeigen.

## Fingerprints

Nach der Projektion werden erneuert:

- SBOM-SHA-256 in den Notices;
- Notice-SHA-256 im Buildmanifest;
- Notice-/SBOM-Referenzen im Buildmanifest;
- Application-Dateiliste und Application-Fingerprint;
- Gesamtfingerprint des Buildmanifests.

Damit ist eine Änderung an Lock-Operation, Assetzuordnung, Notice oder
CycloneDX-Kante im finalen Siteartefakt sichtbar.

## Verbleibende Grenze von #406

Dieser Slice belegt die bereits bekannten direkten Exact-Copy-Operationen über
alle drei Provenienzartefakte. `complete:false` bleibt korrekt, solange größere
Upstream-Bundles nicht vollständig transitiv zerlegt, unabhängig reproduziert
und mit vollständigen `contains`-/Kompositionsbeziehungen attestiert sind.
