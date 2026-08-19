# Dockerfile für die Docker-Distribution der Unfallwerkbank
#
# Basiert auf dem offiziellen Playwright-Docker-Image, das Chromium,
# alle System-Dependencies und Node.js bereits enthält.
#
# Die Image-Version muss zur Version des npm-Pakets `@playwright/test`
# in package.json / package-lock.json passen. Der Docker-Build setzt
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1, damit der Browser aus dem Base-Image
# genutzt wird. Bei abweichenden Versionen kann der Videoexport im Container
# fehlschlagen, obwohl die normalen PR-Tests grün waren.
#
# Build:  docker build -t unfallatlas .
# Start:  docker run -p 8000:8000 unfallatlas
# Image:  ghcr.io/carstenartur/unfallatlas

FROM mcr.microsoft.com/playwright:v1.62.1-noble

# ffmpeg erzeugt GIF, WebP und APNG. ImageMagick/libwebp übernimmt ausschließlich
# die formatgerechte Nachprüfung animierter WebP-Dateien und das Reservieren der
# festen QA-Nachweisfarben in der adaptiven GIF-Palette.
#
# Das Playwright-Image enthält zusätzlich eine NodeSource-Paketquelle. Für diese
# beiden Ubuntu-Pakete wird bewusst ausschließlich ubuntu.sources verwendet:
# Ein Ausfall des nicht benötigten Drittanbieter-Repositories darf den
# Produktions-Container nicht blockieren. APT wiederholt vorübergehend
# fehlgeschlagene Mirror-Abrufe bis zu fünfmal und begrenzt jede Verbindung.
RUN set -eux; \
    apt-get \
      -o Acquire::Retries=5 \
      -o Acquire::http::Timeout=30 \
      -o Acquire::https::Timeout=30 \
      -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/ubuntu.sources \
      -o Dir::Etc::sourceparts=- \
      update; \
    DEBIAN_FRONTEND=noninteractive apt-get \
      -o Acquire::Retries=5 \
      -o Acquire::http::Timeout=30 \
      -o Acquire::https::Timeout=30 \
      -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/ubuntu.sources \
      -o Dir::Etc::sourceparts=- \
      install -y --no-install-recommends \
        ffmpeg \
        imagemagick; \
    test -x /usr/bin/ffmpeg; \
    command -v convert >/dev/null; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Abhängigkeiten installieren (package.json + package-lock.json zuerst,
# damit die Layer gecacht werden und nicht bei jeder Code-Änderung neu
# gebaut werden müssen).
#
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 stellt sicher, dass npm keinen
# zweiten Chromium-Download auslöst – das Base-Image liefert bereits
# die passende Browser-Version für @playwright/test.
COPY package.json package-lock.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci

# Gesamten Anwendungscode kopieren (nach npm ci, damit node_modules gecacht bleibt)
COPY . .
RUN chmod 0755 /app/bin/ffmpeg

# Materialisiert die exakt gelockten Browser-Abhängigkeiten und dasselbe
# Site-Artefakt, das Pages, Playwright und die Screenshot-QA verwenden.
# Lokale Entwicklungs-Images dürfen solange #406 offen ist weiterhin mit der
# diagnostischen (unvollständigen) Provenienz gebaut werden. Öffentliche
# Images setzen den Build-Arg zwingend auf 1; dann wird genau das gerade im
# Image erzeugte _site-Artefakt vor dem nächsten Layer fail-closed geprüft.
ARG REQUIRE_COMPLETE_VENDOR_PROVENANCE=0
ARG VIDEO_EXPORT_INTEGRATION_FIXTURE=0
RUN case "$VIDEO_EXPORT_INTEGRATION_FIXTURE" in \
      0) ;; \
      1) VIDEO_EXPORT_INTEGRATION_FIXTURE=1 node scripts/install-video-export-fixture.js ;; \
      *) echo "VIDEO_EXPORT_INTEGRATION_FIXTURE must be 0 or 1" >&2; exit 2 ;; \
    esac \
    && npm run build:site \
    && case "$REQUIRE_COMPLETE_VENDOR_PROVENANCE" in \
         0) ;; \
         1) npm run validate:vendor-provenance -- --require-complete ;; \
         *) echo "REQUIRE_COMPLETE_VENDOR_PROVENANCE must be 0 or 1" >&2; exit 2 ;; \
       esac

EXPOSE 8000

ENV PORT=8000
ENV NODE_ENV=production
# Der lokale Docker-Server darf fehlende Kontextdaten per UI-Job erzeugen.
# Öffentliche Installationen können dies mit CONTEXT_GENERATION_ENABLED=false
# abschalten oder mit CONTEXT_GENERATION_TOKEN absichern.
ENV CONTEXT_GENERATION_ENABLED=true

CMD ["node", "server/start.js"]
