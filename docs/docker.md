# Docker

> Diese Seite ist Teil der Unfallatlas-Doku. Zurück zur [README](../README.md).

Die Unfallwerkbank ist als fertiges Docker-Image unter
`ghcr.io/carstenartur/unfallatlas` verfügbar.
Die Docker-Distribution enthält gegenüber der GitHub-Pages-Version einen
zusätzlichen **„🎬 Als Video exportieren"-Button**, der den kompletten
Analyse-Ablauf als GIF-Video generiert.

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

## Video-Export-Funktion (nur Docker)

Nach dem Start der Docker-Version erscheint im Export-Bereich ein
**„🎬 Als Video exportieren"-Button**. Dieser:

1. Sammelt alle aktuellen Einstellungen (Stadt, Filter, Kartenposition, markierter Bereich)
2. Schickt sie an den integrierten Backend-Service
3. Playwright spielt den kompletten Ablauf animiert durch – von der Standardansicht über die Filterauswahl bis zum Bezirksratsantrag
4. Das fertige GIF wird automatisch heruntergeladen

> **Hinweis:** Der Button ist ausschließlich in der Docker-Distribution sichtbar. Auf GitHub Pages ist er nicht vorhanden (graceful degradation).

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

Damit werden Test und Doku-Asset (`docs/demo.gif`) aus derselben
Video-Export-Pipeline erzeugt.

## Verwandte Doku

- [Nutzerdoku: Video-Export](DOKUMENTATION.md#video-export-docker)
- [Release-Checklist](release-checklist.md)
