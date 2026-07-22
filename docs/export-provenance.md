# Quellenprovenienz der Datenexporte

CSV-, GeoJSON- und KML-Downloads verwenden denselben versionierten
`SourceManifest`-Snapshot. Das Manifest wird aus dem tatsächlichen Exportbereich,
den angewendeten Schwere-, Zeit-, Zustands- und Kontextfiltern sowie den
exportierten Unfallstellen gebildet. Beteiligungsfilter werden als
Szenariokontext dokumentiert; der tabellarische Datenexport bewahrt weiterhin
alle Beteiligungskombinationen im übrigen Filterumfang.

Der Export bricht ab, wenn die Quellen- oder Lizenzangaben nicht vollständig
validiert werden können. In diesem Fall wird auch die vom älteren Exportmodul
bereits erzeugte Zwischendatei nicht an den Browser weitergegeben.

## CSV

CSV wird als deterministisches ZIP-Paket ausgeliefert:

- `Unfallatlas_<stadt>_<datum>.csv`
- `sources.json`
- `README.txt`

`sources.json` enthält das vollständige Manifest. Die README nennt
Datensatz- und Lizenzadressen, Änderungsvermerk und den SHA-256-Hash des
kanonischen Manifests.

## GeoJSON

Das Manifest und sein SHA-256-Hash stehen unter `metadata`. Jedes Feature trägt
`unfallatlas:sourceIds`. Benannte Source-IDs müssen im eingebetteten Manifest
vorhanden sein; unbekannte oder bereits widersprüchlich vorhandene Provenienz
führt zum Abbruch.

## KML

Das `Document` erhält ein `ExtendedData`-Element mit Manifest-Hash, Source-IDs,
Kurzvermerk, verlinkbaren Quelldetails und dem kanonischen Manifest-JSON. Eine
zweite oder bereits vorhandene Unfallwerkbank-Provenienz wird nicht
überschrieben.

## Build- und Datenbindung

Der Build-Fingerprint stammt aus `build-manifest.json`. Der Daten-Fingerprint
wird deterministisch über Stadt, Bereich, Filter, Jahrgänge und die
normalisierten exportierten Unfallstellen berechnet. Mehrere unmittelbar
aufeinanderfolgende Formatexporte desselben Zustands verwenden denselben
Manifest-Snapshot.
