# Bindung des Exact-Copy-Locks an das Site-Build-Manifest

Der Exact-Copy-Lock für `docx` und `pdfmake` wird beim kanonischen
`npm run build:site` erst erzeugt, nachdem die Browserdateien in `_site/vendor`
kopiert wurden. Ein Lock außerhalb des `build-manifest.json` wäre jedoch nur ein
Nebenartefakt: Ein verteiltes Site-Paket könnte ihn verlieren oder austauschen,
ohne dass sich der bisherige Site-Fingerprint ändert.

`scripts/vendor-exact-copy-manifest.js` schließt diese Lücke. Nach der
Erzeugung von `_site/vendor/exact-copy-lock.json` wird der vorhandene
Site-Dateibaum erneut vollständig und deterministisch fingerprinted. Dabei gilt:

- `vendor/exact-copy-lock.json` ist eine normale, gehashte Anwendungsdatei;
- `build-manifest.json` bleibt zur Vermeidung einer Selbstreferenz aus seinem
  eigenen Anwendungsfingerprint ausgeschlossen;
- Pfad, SHA-256, Lock-ID und Anzahl der Exact-Copy-Operationen werden im Abschnitt
  `vendorExactCopyLock` des Build-Manifests festgehalten;
- der `fingerprint` bindet Anwendungsdateien,
  Abhängigkeiten, Third-Party-Notices, Daten, Netzwerkpolicy und den
  Exact-Copy-Lock gemeinsam;
- Byte-Drift oder eine andere Lock-ID zwischen Writer-Ergebnis und Datei führen
  zum Abbruch;
- fehlende Roots, fehlende Manifestdateien und unvollständige
  Fingerprint-Eingaben erzeugen verständliche Domänenfehler.

Beispielauszug:

```json
{
  "application": {
    "files": [
      "index.html",
      "vendor/exact-copy-lock.json"
    ],
    "fingerprint": "<sha256-des-anwendungsdateibaums>"
  },
  "vendorExactCopyLock": {
    "schemaVersion": 1,
    "type": "unfallatlas-vendor-exact-copy-manifest-binding",
    "path": "vendor/exact-copy-lock.json",
    "sha256": "<sha256-der-lockdatei>",
    "lockId": "<deterministische-lock-id>",
    "operationCount": 3
  },
  "fingerprint": "<sha256-aller-buildnachweise>"
}
```

## Abgrenzung

Diese Bindung beweist, dass der ausgelieferte Exact-Copy-Lock selbst zum
fingerprinted Site-Artefakt gehört. Sie erweitert nicht die Aussagekraft des
Locks: Er belegt weiterhin die exakte Kopie aus den durch `package-lock.json`
gepinnten npm-Paketdateien, aber noch keinen unabhängig reproduzierten
Upstream-Bundle-Build und keine vollständige transitive Komponentenzerlegung.
Der strengere signierte Vendor-Build-Lock und die offenen CycloneDX-/Lizenz-
Arbeiten aus #406 bleiben daher erforderlich.
