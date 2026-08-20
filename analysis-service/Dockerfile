# ─────────────────────────────────────────────────────────────────────────────
# Multi-Stage Dockerfile für den Unfallatlas Analysis Service.
#
#   Stage 1 (build):    baut das Spring-Boot-Fat-JAR mit Maven (Java 21).
#   Stage 2 (runtime):  schlankes JRE-Image, das das Fat-JAR ausführt.
#
# Build:
#   docker build -t unfallatlas/analysis-service ./analysis-service
#
# Run (PostgreSQL-Modus):
#   docker run -p 8081:8081 \
#     -e SPRING_PROFILES_ACTIVE=prod \
#     -e ANALYSIS_DB_URL=jdbc:postgresql://db:5432/unfallatlas \
#     -e ANALYSIS_DB_USER=unfallatlas \
#     -e ANALYSIS_DB_PASSWORD=unfallatlas \
#     unfallatlas/analysis-service
# ─────────────────────────────────────────────────────────────────────────────
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /workspace

# Maven-Caching: erst nur die POM kopieren, dann Abhängigkeiten ziehen,
# bevor der eigentliche Source-Tree dazukommt.
COPY pom.xml .
RUN mvn -B -q dependency:go-offline -DskipTests

COPY src ./src
RUN mvn -B -q -DskipTests package && \
    cp target/unfallatlas-analysis-service-*.jar /workspace/app.jar

FROM eclipse-temurin:26.0.1_8-jre
WORKDIR /app
COPY --from=build /workspace/app.jar /app/app.jar

# `curl` für den HEALTHCHECK installieren – das Basis-Image bringt weder
# `curl` noch `wget` mit. Kurzzeitige Paketmirror-Ausfälle werden begrenzt
# wiederholt; fehlende Mirrors dürfen den Build nicht unbegrenzt blockieren.
RUN set -eux; \
    apt-get \
      -o Acquire::Retries=5 \
      -o Acquire::http::Timeout=30 \
      -o Acquire::https::Timeout=30 \
      update; \
    DEBIAN_FRONTEND=noninteractive apt-get \
      -o Acquire::Retries=5 \
      -o Acquire::http::Timeout=30 \
      -o Acquire::https::Timeout=30 \
      install -y --no-install-recommends curl; \
    test -x /usr/bin/curl; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# Standard: Prod-Profil; kann via SPRING_PROFILES_ACTIVE überschrieben werden.
ENV SPRING_PROFILES_ACTIVE=prod
EXPOSE 8081

# Spring-Boot-Actuator-Endpunkt für Health-Check.
HEALTHCHECK --interval=20s --timeout=3s --start-period=30s --retries=5 \
  CMD curl --fail --silent --show-error http://localhost:8081/actuator/health || exit 1

ENTRYPOINT ["java", "-jar", "/app/app.jar"]
