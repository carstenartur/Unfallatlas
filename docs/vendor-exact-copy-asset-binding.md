# Exact-Copy-Referenzen an ausgelieferten Vendor-Assets

Der kanonische Site-Build erzeugt für die exportkritischen Browserdateien einen
`vendor/exact-copy-lock.json`. Der Gesamt-Lock allein beweist jedoch noch nicht,
dass ein bestimmter Eintrag in `build-manifest.json.vendorAssets` genau zu einer
bestimmten Lock-Operation gehört.

`scripts/vendor-exact-copy-manifest.js` bindet deshalb jede abgedeckte
`byte-for-byte-copy`-Operation direkt an das ausgelieferte Asset.

## Prüfvertrag

Das ursprüngliche Assetinventar des Site-Builds ist bewusst schlank und enthält
pro Datei nur Paketname, Zielpfad, Bytezahl und SHA-256. Die Bindestufe führt
diese Felder mit zwei weiteren bereits verifizierten Quellen zusammen:

- `manifest.dependencies` liefert die package-lock-gepinnte Paketversion;
- die Exact-Copy-Operation liefert PURL und Quellpfad im installierten Paket.

Für jede Operation müssen damit exakt übereinstimmen:

- Zielpfad der Operation und Assetpfad,
- npm-Paketname,
- Paketversion aus `manifest.dependencies` und Lock-Komponente,
- Eingabe- und Ausgabebytezahl bei der Byte-für-Byte-Kopie,
- Eingabe-, Ausgabe- und ausgelieferter SHA-256.

Enthält ein bereits angereicherter Asseteintrag zusätzlich `version`, `purl`
oder `sourcePath`, müssen auch diese Werte exakt zur Operation passen. Fehlt das
Asset oder weicht ein Feld ab, bricht der Build ab. Doppelte Assetpfade,
`lockRef`-Werte und Ausgabeziele werden ebenfalls abgewiesen.

Ein erfolgreich gebundener Asset-Eintrag wird um die aus den geprüften Quellen
abgeleiteten Felder ergänzt:

```json
{
  "package": "docx",
  "version": "9.7.1",
  "purl": "pkg:npm/docx@9.7.1",
  "sourcePath": "dist/index.iife.js",
  "path": "vendor/export/docx.js",
  "sha256": "...",
  "exactCopy": {
    "type": "vendor-exact-copy-lock-reference",
    "schemaVersion": 1,
    "lockId": "...",
    "lockRef": "export.docx.iife",
    "method": "byte-for-byte-copy",
    "componentPurl": "pkg:npm/docx@9.7.1",
    "input": {
      "path": "dist/index.iife.js",
      "bytes": 1234,
      "sha256": "..."
    },
    "auxiliaryInputs": [],
    "output": {
      "path": "vendor/export/docx.js",
      "bytes": 1234,
      "sha256": "..."
    }
  }
}
```

## Übergeordnete Bindung

`vendorExactCopyLock` im Buildmanifest enthält zusätzlich:

- Anzahl der abgedeckten Assets,
- sortierte Kurzreferenzen je `lockRef`,
- einen deterministischen `assetBindingFingerprint`.

Dieser Fingerprint geht in den Gesamtfingerprint des Site-Builds ein. Änderungen
an der Operation-zu-Asset-Zuordnung können dadurch nicht neben einem ansonsten
gleich aussehenden Buildmanifest unbemerkt bleiben.

## Fehlerdiagnose

Abweichungen werden nach ihrer Herkunft getrennt berichtet. Insbesondere sind

- `dependencyVersion`: Version aus dem package-lock-gebundenen
  `manifest.dependencies`, und
- `assetVersion`: optional bereits im Assetinventar gespeicherte Version

zwei unabhängige Befunde. Liegen beide gleichzeitig vor, bleiben beide im
strukturierten Fehler erhalten. Dasselbe gilt für optionale Asset-PURL und
Quellpfadangaben. Dadurch verdeckt eine spätere Vergleichsstufe keine bereits
erkannte Abweichung einer anderen Evidenzquelle.

## Rückwärtskompatibilität

Historische Minimal-Fixtures ohne `vendorAssets` bleiben für isolierte
Schema-/Fingerprinttests zulässig. Ein realer Site-Build besitzt dagegen immer
ein Vendor-Asset-Inventar; dort ist die Einzelbindung verpflichtend und
fail-closed.

## Noch offen in #406

Dieser Slice bindet die Operationen an das Buildmanifest. Weiter offen bleiben:

- dieselben Referenzen in `third-party-notices.json.assetAssessments`,
- CycloneDX-`contains`-Kanten und Komponentenbeziehungen,
- vollständige transitive Zerlegung der Upstream-Bundles,
- unabhängig reproduzierte Upstream-Builds,
- Ausweitung auf weitere ausgelieferte Browserbibliotheken.
