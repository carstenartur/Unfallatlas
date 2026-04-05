# Dockerfile für die Docker-Distribution der Unfallwerkbank
#
# Basiert auf dem offiziellen Playwright-Docker-Image, das Chromium,
# alle System-Dependencies und Node.js bereits enthält.
#
# Die Image-Version (v1.52.0) ist bewusst auf die exakt gleiche
# Playwright-Version wie das npm-Paket (@playwright/test@1.52.0)
# abgestimmt, damit der vorinstallierte Browser des Base-Images
# genutzt wird und kein zusätzlicher Browser-Download erforderlich ist.
#
# Build:  docker build -t unfallatlas .
# Start:  docker run -p 8000:8000 unfallatlas
# Image:  ghcr.io/carstenartur/unfallatlas

FROM mcr.microsoft.com/playwright:v1.52.0-noble

# ffmpeg für WebM → GIF-Konvertierung
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Abhängigkeiten installieren (package.json + package-lock.json zuerst,
# damit die Layer gecacht werden und nicht bei jeder Code-Änderung neu
# gebaut werden müssen).
#
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 stellt sicher, dass npm keinen
# zweiten Chromium-Download auslöst – das Base-Image liefert bereits
# die passende Browser-Version für @playwright/test@1.52.0.
COPY package.json package-lock.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci

# Gesamten Anwendungscode kopieren (nach npm ci, damit node_modules gecacht bleibt)
COPY . .

EXPOSE 8000

ENV PORT=8000
ENV NODE_ENV=production

CMD ["node", "server/index.js"]
