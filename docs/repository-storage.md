# Speicher- und Versionsstrategie

Stand: 8. November 2026. Diese Regeln ergänzen den Maven-gesteuerten
Kontextdaten-Guard und die verbindliche Dokumentationsmedien-Abnahme. Sie ändern
keine historischen Commits oder bestehenden Download-URLs.

## Speicherentscheidung vor einer neuen Datei

1. Quellcode, Konfiguration und kleine reproduzierbare Test-Fixtures gehören in
   Git. Große Quelldateien zunächst auf eingebettete generierte Daten prüfen.
2. Benötigt die Anwendung die Datei direkt? Dann ist ein begrenztes komprimiertes
   Laufzeitformat unter `out/` zulässig. Große neue oder häufig wechselnde Bestände
   werden aus einem versionierten, hashgebundenen Datenspeicher im Build bezogen
   und in das atomare Pages-Artefakt eingebaut. Dafür ist kein neuer
   Cross-Origin-Datenpfad im Browser nötig.
3. Ist sie ein direkt verlinktes kanonisches Dokumentationsmedium? Dann gelten
   `docs/media-manifest.json`, der explizite Acceptance-PR und die vorhandenen
   Quellen-/Readiness-Sidecars. Normale Tests erzeugen nur Kandidaten.
4. Dauerhafte maschinenlesbare Evidenz wird auf Zusammenfassung, Quellenmanifest,
   Hashes und genaue Revisionen begrenzt. Vollständige Laufartefakte bleiben extern.
5. Rohdaten, Logs, Traces, Videos und Render-Zwischenstände gehören in einen
   versionierten Datenspeicher beziehungsweise ein befristetes Actions-Artefakt.
   Ein kleines Manifest nennt Quelle, Zeitpunkt, Lizenz, SHA-256 und Erzeugungsweg.
6. Neue installierbare ZIPs gehören als Assets an den passenden GitHub Release.
   Die vier bereits verlinkten ZIPs bleiben unverändert erhalten.

| Kategorie | Regelmäßiger Speicherort | In Git verbleibt |
|---|---|---|
| Quellcode/Konfiguration | Git | überprüfbarer Text, Lockfiles, kleine Fixtures |
| Statische Daten | begrenztes `out/`; große neue Bestände: Datenspeicher → Pages-Build | komprimierte Laufzeitdaten oder bindendes Eingangsmanifest |
| Kanonische Dokumentationsmedien | Git nach expliziter Abnahme | deklarierte Medien und kleine Provenienz-/Readiness-Dateien |
| Reproduzierbare Evidenz | Zusammenfassung in Git; vollständiger Lauf als Actions-Artefakt | Daten-/Code-/Renderer-Fingerprints und Ergebnisse |
| Rohdaten | versionierter Datenspeicher oder passender Release | Quellen-/Nutzungshinweise, Hash und Reproduktionsweg |
| CI-Diagnostik | Actions-Artefakt mit angemessener Aufbewahrung | keine vollständigen Logs oder Laufverzeichnisse |
| Release-Artefakte | GitHub Release | Versionsnotizen und Artefaktmanifest |
| Große editierbare Binärquellen | LFS nur nach gesonderter Entscheidung | gegebenenfalls Pointer; kein pauschaler LFS-Umzug |

## Verbindliche Budgets

`config/repository-storage-budget.json` ist die maschinenlesbare Regel. Der Job
**Repository storage budget** in `test.yml` prüft PRs und Pushes gegen den
expliziten Ausgangscommit. Fehlende, leere, fremde oder nicht verfügbare Baselines
führen zum Fehler. Eine im selben PR erhöhte Policy genehmigt keine größeren
Dateien: Es gilt die Policy des Ausgangscommits. Nur bei der erstmaligen Einführung
wird die neue Policy auf eine weiterhin reale Baseline angewandt. Manuelle
Testläufe vergleichen ihren tatsächlichen Elterncommit.

| Grenze | Budget | Begründung |
|---|---:|---|
| Einzelne Git-Datei | 16 MiB | größere neue Bestände brauchen eine Speicherentscheidung |
| Gesamter aktueller Dateibaum | 320 MiB | Bestand 224,63 MiB einschließlich unveränderlicher alter Release-ZIPs |
| Veröffentlichte Daten in `out/` | 160 MiB | Bestand 110,20 MiB; Delta-Guard bleibt zusätzlich wirksam |
| Dauerhafte maschinenlesbare Evidenz | 4 MiB insgesamt, 1 MiB pro Datei | Bestand 1,47 MiB; vollständige Läufe bleiben extern |
| Geänderte / neue / gelöschte Dateien pro PR | 5.000 / 1.000 / 1.000 | begrenzt unbemerkte Massenänderungen |
| Neu geschriebene Dateibytes / neu erreichbare Blob-Inhalte pro PR | je 128 MiB | auch Zwischenversionen und gleich großer Binäraustausch zählen |
| Positive Zuwächse / Nettozuwachs pro PR | 64 MiB / 32 MiB | Löschungen dürfen große neue Dateien nicht verdecken |
| Kanonische Dokumentationsmedien | unverändert 30 MiB insgesamt | bestehende Medien-Policy bleibt maßgeblich |
| Statische Kartenmedien | unverändert 1,5 MiB pro Datei | vorhandene Abmessungs-/Inhalts-/Quellenprüfung bleibt maßgeblich |

Die vier alten Release-ZIPs sind durch einzelne Git-Blob-IDs festgeschrieben.
Die Ausnahme erlaubt weder ihren Austausch noch neue ZIP-Versionen. Symlinks,
Submodule, eingecheckte Laufdiagnostik und neue Rohdatenverzeichnisse werden nicht
als reguläre freigegebene Dateien akzeptiert.

Zusätzlich zum endgültigen Baum werden alle seit der Baseline neu erreichbaren
Blobs geprüft. Eine zwischenzeitlich hinzugefügte und wieder gelöschte Großdatei
bleibt bei einem normalen Merge Teil der Historie und verbraucht daher ihr Budget.
Gleiche Blob-IDs zählen nur einmal. CI lädt die betroffene Commit-Strecke begrenzt
nach; verbleibende flache Grenzen oder fehlende Objekte führen zum Fehler.

Der automatische Kontextdaten-Commit behält seine Maven-Einbindung, erlaubten
Pfade, strengeren Dateizahl-/Löschgrenzen und den versionierten Delta-Bericht vor
jedem Push. Der neue Job ersetzt diesen Schreibschutz nicht. Lokal nach einem Commit:

```sh
STORAGE_BASE=<Ausgangs-SHA> mvn -B -ntp -N process-resources -Prepository-storage
# Bereits vollständig geladene Historie lokal ohne Netzabruf prüfen:
node scripts/check-repository-storage.js --base <Ausgangs-SHA> --head HEAD --report out/qa/repository-storage.json
```

## Inventar der vollständig erreichbaren Historie

Das [Inventar vom 8. November 2026](storage-evidence/2026-11-08-inventory.json)
nennt alle 334 abgefragten Remote-Branch-/Tag-Referenzen samt Sammelhash. Erfasst
sind 2.939 erreichbare Commits und 23.605 unterschiedliche Blobs. Der aktuelle
`main` ist `5a96aec8a2910849a8a5c257904a8926a4898f54`.

Die Summe unterschiedlicher **unkomprimierter Blob-Inhalte** beträgt
13.036.810.824 Byte. Das ist weder die Git-Packgröße noch GitHubs belegter Speicher.
Git-Deltakompression, mehrfach gepackte und nicht mehr erreichbare Objekte führen
zu anderen Speicheranzeigen. Identische Blobs werden einmal gezählt und dem ersten
von Git gelieferten Pfad zugeordnet. Nicht mehr veröffentlichte Referenzen und
unerreichbare serverseitige Objekte sind über diese Schnittstelle nicht erfassbar.

| Kategorie | Aktueller Baum | Eindeutige historische Blob-Inhalte |
|---|---:|---:|
| Statische Daten | 115.555.475 Byte | 11.540.413.948 Byte |
| Dokumentationsmedien | 27.465.987 Byte | 1.307.866.841 Byte |
| Release-ZIPs | 80.673.586 Byte | 80.673.586 Byte |
| Dauerhafte Evidenz | 1.544.156 Byte | 3.600.321 Byte |
| Quellcode/übrige Dateien | 10.306.795 Byte | 104.256.128 Byte |

Größter historischer Blob ist das frühere unkomprimierte Berliner GeoJSON mit
55.316.452 Byte. Zwanzig Versionen dieses Pfads summieren sich auf 901.326.368 Byte;
Hamburg auf 674.065.577 Byte, München auf 476.687.805 Byte. Hannover liegt mit
22 Versionen bei 222.041.599 Byte. Der Karten-Screenshot `10-auto-fahrrad-und.png`
hat 88 verschiedene Blobs mit zusammen 104.301.428 Byte. Das Inventar enthält
die größten 40 Blobs und 30 wiederholten Pfade samt Objekt-IDs.

Konkrete Entscheidungen:

- Frühere unkomprimierte GeoJSON-/Kachelversionen bleiben historische Evidenz.
  Neue Veröffentlichungen nutzen die komprimierten Formate und Delta-Grenzen;
  umfangreiche neue Archive werden nicht als weitere Vollkopien eingecheckt.
- Alte Release-ZIPs bleiben wegen bestehender Links hashfest erhalten. Neue
  Releases verwenden ausschließlich Release-Assets. Eine spätere Entfernung
  alter Dateien verlangt zuvor geprüfte Ersatzlinks.
- Kanonische Screenshots werden nur nach expliziter visueller Abnahme ersetzt.
  E2E-Läufe und `generate-screenshots.yml` haben keinen automatischen Commit-/Push-Pfad.
- Diese Änderung löscht oder überschreibt keine alten Commits, Tags oder Branches.

Reproduktion in einem vollständigen, nicht flachen Checkout:

```sh
git fetch --no-filter --tags origin '+refs/heads/*:refs/remotes/origin/*'
node scripts/inventory-repository-storage.js --output out/qa/repository-storage-inventory.json
```

Ein partieller Clone muss fehlende Blobs zuvor beispielsweise mit
`git fetch --refetch --no-filter origin main` nachladen. Das Werkzeug lehnt
fehlende Objekte und flache Historien ab. Ein späterer Lauf nennt andere
Referenzen, wenn inzwischen Branches, Tags oder Commits hinzugekommen sind.

## LFS und mögliche spätere Migration

Für den aktuellen Bestand wird **kein Git LFS eingeführt**. Anwendung und
Dokumentation benötigen direkt nutzbare Dateien in Pages, Raw-URLs, Forks und
Offline-Paketen. LFS speichert Pointer in Git und benötigt die Binärobjekte beim
Checkout. GitHub dokumentiert, dass Git LFS nicht mit GitHub Pages verwendet
werden kann. Die Aufnahme der LFS-Objekte in generierte Quellarchive ist eine
eigene Repository-Einstellung. Quellen, geprüft am 8. November 2026:
[GitHub: Git LFS](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage),
[GitHub: Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

Eine spätere LFS-Entscheidung für editierbare Binärquellen muss Objektbereitstellung
im Build, Fork-Zugriff, Bandbreiten-/Speicherbudget, Quellarchive und getesteten
Offline-Export festlegen. Rohdaten und regenerierte CI-Ausgaben werden dadurch
nicht zu versionspflichtigen Quelldateien.

Eine History-Bereinigung bleibt ein eigenes Migrationsvorhaben: vollständiges
Backup, angekündigter Umschalttermin, Liste betroffener SHAs/Refs, Zuordnung alter
zu neuer Revisionen und Prüfung aller Release-, Zenodo-, DOI-, Raw- und Deep-Links.
Erst danach darf eine gesondert freigegebene Migration stattfinden.
