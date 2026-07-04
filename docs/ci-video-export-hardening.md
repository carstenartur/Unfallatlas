# Videoexport-CI-Guardrails

Der Videoexport-Test ist der einzige Testpfad, der den produktiven Docker-Container inklusive Playwright-Browser und ffmpeg end-to-end ausführt. Damit dieser Test nicht erneut durch ein vorgebautes Image oder durch auseinanderlaufende Playwright-Versionen verfälscht wird, gelten folgende Regeln:

- `@playwright/test` in `package.json` und `package-lock.json` muss zur Version des Docker-Basisimages `mcr.microsoft.com/playwright` passen.
- `scripts/check-playwright-docker-version.js` prüft diese Kopplung vor `npm ci` im normalen Testjob und im Videoexport-Testjob.
- Pull Requests dürfen nur dann das vorgebaute `ghcr.io/carstenartur/unfallatlas:latest` für den Videoexport-Smoke verwenden, wenn sie keine Docker-, Package-, Workflow-, Server-Videoexport- oder Testcontainers-relevanten Dateien ändern.
- Pushes auf `main` bauen immer den aktuellen Checkout, damit der Main-Build nicht gegen ein altes `latest`-Image läuft.

Wenn ein Dependency-PR Playwright aktualisiert, muss der Dockerfile-Bump im selben PR oder in einem vorherigen grünen PR enthalten sein. Andernfalls schlägt der Versionscheck früh und eindeutig fehl.
