# Exact-Copy-Referenzen an ausgelieferten Vendor-Assets

Der kanonische Site-Build erzeugt für die exportkritischen Browserdateien einen
`vendor/exact-copy-lock.json`. Der Gesamt-Lock allein beweist jedoch noch nicht,
dass ein bestimmter Eintrag in `build-manifest.json.vendorAssets` genau zu einer
bestimmten Lock-Operation gehört.

`scripts/vendor-exact-copy-manifest.js` bindet deshalb jede abgedeckte
`byte-for-byte-copy`-Operation direkt an das ausgelieferte Asset.

## Prüfvertrag

Für jede Operation müssen exakt übereinstimmen:

- Zielpfad,
- npm-Paketname,
- Paketversion,
- Package URL (PURL),
- Quellpfad im installierten Paket,
- ausgelieferte Bytezahl,
- ausgelieferter SHA-256.

Fehlt das Asset oder weicht eines dieser Felder ab, bricht der Build ab. Doppelte
Assetpfade, `lockRef`-Werte und Ausgabeziele werden ebenfalls abgewiesen.

Ein erfolgreich gebundener Asset-Eintrag enthält beispielsweise:

```json
{
  "package": "docx",
  "version": "9.7.1",
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
