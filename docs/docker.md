# Docker

> Diese Seite ist Teil der Unfallatlas-Doku. Zurück zur [README](../README.md).

Die Unfallwerkbank ist als fertiges Docker-Image unter
`ghcr.io/carstenartur/unfallatlas` verfügbar.
Im Vergleich zu GitHub Pages (statisch, ohne Backend) sind im
servergestützten Betrieb zusätzliche Features verfügbar, darunter der
**„🎬 Als Video exportieren"-Button**.

## Schnellstart

```bash
# Image ziehen und starten
docker run -p 8000:8000 ghcr.io/carstenartur/unfallatlas

# Browser öffnen → http://localhost:8000
```

## Mit Docker Compose

```bash
docker compose up
# → http://localhost:8000
```

## Lokal bauen

```bash
docker build -t unfallatlas .
docker run -p 8000:8000 unfallatlas
```

Lokale Builds verwenden die diagnostische Vendor-Provenienz. Ein öffentliches
Image muss zusätzlich mit
`--build-arg REQUIRE_COMPLETE_VENDOR_PROVENANCE=1` gebaut werden. Dadurch wird
das im Image selbst erzeugte `_site`-Artefakt fail-closed geprüft; solange die
in Issue #406 dokumentierten Herkunftslücken bestehen, bricht dieser Build
absichtlich ab.

Ein optionales `UNFALLATLAS_DATA_ROOT` muss auf ein dediziertes
Datenverzeichnis zeigen. Unter `/out` werden nur die dokumentierten
Unfall-/Kontextartefakte ausgeliefert; Dotfiles, QA-Berichte und temporäre
Dateien sind nicht öffentlich erreichbar.

## Video-Export-Funktion (Server-Betrieb: Node oder Docker)

Sobald die Werkbank mit Backend läuft (lokaler Node-Server oder Docker),
erscheint im Export-Bereich ein
**„🎬 Als Video exportieren"-Button**. Dieser:

1. Sammelt alle aktuellen Einstellungen (Stadt, Filter, Kartenposition, markierter Bereich)
2. Schickt sie an den integrierten Backend-Service
3. Playwright spielt den kompletten Ablauf animiert durch – von der Standardansicht über die Filterauswahl bis zum Bezirksratsantrag
4. Das fertige GIF wird automatisch heruntergeladen

> **Hinweis:** Auf GitHub Pages (ohne Backend) ist der Button nicht
> vorhanden (graceful degradation). In servergestützten Varianten
> (Node/Docker) ist er verfügbar.

## README-Demo-GIF reproduzieren

`npm run regen:demo` startet denselben Container-Helper wie der
Testcontainers-Integrationstest
[`tests/integration/videoExport.testcontainers.test.js`](../tests/integration/videoExport.testcontainers.test.js):
Image-Quelle ist bevorzugt `UNFALLATLAS_IMAGE` (z. B.
`ghcr.io/carstenartur/unfallatlas:latest`), sonst lokaler `docker build`.

```bash
export UNFALLATLAS_IMAGE=ghcr.io/carstenartur/unfallatlas:latest
npm run regen:demo
```

Damit werden Test und das kanonische Doku-Asset `docs/demo.gif` aus derselben
Video-Export-Pipeline erzeugt. Der Generator prüft vor dem Ersetzen Format,
Zielmaß, 60-Sekunden-Dauergrenze und Manifest-Budget. Bei mehr als 9 MiB
bricht er ohne Änderung ab;
ein Wechsel auf WebP/APNG ist eine eigene, gemeinsam mit Manifest und
Markdown-Referenzen zu prüfende Migration.

## Verwandte Doku

- [Nutzerdoku: Video-Export](DOKUMENTATION.md#video-export-docker)
- [Release-Checklist](release-checklist.md)
