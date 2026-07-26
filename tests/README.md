# Unfallwerkbank-Testarchitektur

Der veröffentlichte Build- und Testvertrag beginnt immer im Repository-Root mit
Maven. GitHub Actions verwendet dieselben Befehle wie ein lokaler Checkout und
enthält keine eigene npm-, Playwright- oder Testcontainers-Orchestrierung.

## Voraussetzungen

Für den normalen Build werden benötigt:

- JDK 21 oder neuer;
- Maven 3.9.6 oder neuer.

Node.js und npm werden vom `frontend-maven-plugin` in den Build-Ausgabeordner
geladen. Eine globale Node-Installation ist für den kanonischen Build daher
nicht erforderlich.

Für `system-it` und den persistierenden Golden-Case-Lauf wird zusätzlich ein
erreichbarer Docker-Daemon benötigt. PostgreSQL, Browser, ffmpeg,
ImageMagick und die zu prüfenden Anwendungen werden als Container gestartet;
sie müssen nicht separat installiert werden.

## Kanonische Befehle

| Zweck | Befehl |
|---|---|
| Unit-, Integrations- und Performance-Tests sowie Analysis Service | `mvn clean verify` |
| Öffentliches Pages-Artefakt einschließlich Browser-Gate | `mvn clean verify -Ppages` |
| Pages-Artefakt nach vollständiger Datengenerierung | `mvn clean verify -Ppages-regenerated` |
| Chromium-, Accessibility-, Firefox- und WebKit-QA | `mvn verify -Pe2e` |
| JUnit-/Testcontainers-Systemtests | `mvn verify -Psystem-it` |
| Bonn-/Hannover-Golden-Cases einschließlich Persistenz | `mvn verify -Plocation-brief-golden` |
| Gesamte erweiterte QA | `mvn clean verify -Pe2e,system-it,location-brief-golden` |

Die npm-Skripte bleiben als Implementierungsbausteine und für gezielte
Fehlerdiagnosen vorhanden. Sie sind keine zweite Build-Schnittstelle.

## Verantwortlichkeiten

### Maven

Maven besitzt:

- Toolchain und gelockte Installation von Node/npm;
- Auswahl und Reihenfolge aller Tests;
- Start und Abschluss der Integrationsphasen;
- stabile Report- und Evidenzpfade;
- die lokal und in CI identischen Profile.

### Jest

Jest prüft JavaScript-nahe Unit- und Integrationslogik, etwa Filter,
URL-Zustände, Exportfunktionen und Datenverarbeitung. Maven startet diese Tests
im normalen Lifecycle über das `frontend-maven-plugin`.

### Playwright

Playwright prüft die reale Browseroberfläche. Das Profil `e2e` installiert die
gelockten Browser, bereitet deterministische Screenshot-Verzeichnisse vor,
führt Chromium-, Accessibility-, Firefox- und WebKit-Szenarien aus und
validiert anschließend die erzeugte Evidenz.

### JUnit 5 und Maven Failsafe

Systemweite Verträge liegen im Modul [`qa-system-tests`](../qa-system-tests/).
Sie heißen `*IT.java` und werden von Maven Failsafe in den Phasen
`integration-test` und `verify` ausgeführt. Ein fehlender Systemtest lässt den
Build bewusst fehlschlagen.

### Testcontainers

Java Testcontainers besitzt den Lebenszyklus externer Laufzeitkomponenten. Die
Tests verwenden keine fest belegten Host-Ports und keine vorab gestarteten
lokalen Dienste.

Derzeit werden nativ geprüft:

1. **Produktionscontainer der Unfallwerkbank**
   - Build aus dem exakten Checkout und dessen `.dockerignore`;
   - Health- und Build-Manifest-Vertrag;
   - kein Zugriff auf Repository-Metadaten wie `package.json`;
   - frühe Ablehnung ungültiger Videoanfragen;
   - echter GIF-Export einschließlich Hash-, Provenienz- und Pixel-Evidenz;
   - sichtbare Steigungs- und Verkehrslayer in Chromium innerhalb des
     ausgelieferten Containers;
   - persistierte Containerlogs.

2. **Analysis Service mit PostgreSQL**
   - Produktionsprofil statt H2-Fallback;
   - eigener PostgreSQL-17-Container in einem isolierten Netzwerk;
   - erfolgreicher Actuator-Health-Check;
   - ausgeführte Flyway-Migrationen und vorhandenes Anwendungsschema;
   - persistierte Service- und Datenbanklogs.

Die fachliche Berechnung der Location Briefs bleibt JavaScript-Produktlogik.
Das Profil `location-brief-golden` führt ihre deterministische Vorprüfung und
den persistierenden Bonn-/Hannover-Lauf unter Maven aus. Damit wird keine
zweite Implementierung der fachlichen Regeln in Java erzeugt.

## Report- und Evidenzpfade

| Inhalt | Pfad |
|---|---|
| JUnit/Failsafe XML und Textreports | `qa-system-tests/target/failsafe-reports/` |
| Testcontainers-Logs | `qa-system-tests/target/testcontainers-logs/` |
| Analysis-Service-Unit-Tests | `analysis-service/target/surefire-reports/` |
| Jest Coverage und Integrationsreport | `coverage/` |
| Playwright HTML-Report | `playwright-report/` |
| Playwright Testartefakte | `test-results/` |
| fachliche QA-Berichte | `out/qa/` |
| erzeugte Dokumentationsscreenshots | `docs/screenshots/` |

Diese Pfade werden auch von GitHub Actions als Artefakte hochgeladen. Die
Workflow-Datei entscheidet nicht selbst, wie die Inhalte erzeugt werden.

## Gezielte Diagnose

Ein einzelner nativer Systemtest lässt sich weiterhin über Maven ausführen:

```bash
mvn -pl qa-system-tests -am verify -Psystem-it \
  -Dit.test=ProductionContainerIT
```

Für den PostgreSQL-Vertrag:

```bash
mvn -pl qa-system-tests -am verify -Psystem-it \
  -Dit.test=AnalysisServicePostgresIT
```

JavaScript- oder Playwright-Befehle dürfen zur interaktiven Fehlersuche direkt
ausgeführt werden. Vor einem Commit ist jedoch mindestens der dazugehörige
Maven-Befehl maßgeblich, weil nur er den vollständigen Lifecycle und die
abschließende Failsafe-Auswertung umfasst.

## Neue Tests hinzufügen

- Reine JavaScript-Funktionen gehören nach `tests/unit/`.
- Browserabläufe und Accessibility-Verträge gehören nach `tests/e2e/`.
- Black-Box-Verträge über mehrere Prozesse oder Infrastrukturkomponenten
  gehören als JUnit-`*IT.java` nach `qa-system-tests/src/test/java/`.
- Datenbanken und Dienste werden dort mit Testcontainers bereitgestellt; feste
  Ports, Sleeps und workfloweigene Startskripte sind nicht zulässig.
- Neue Profile und Artefaktpfade werden in `pom.xml`, dieser Datei und
  `docs/site-build.md` dokumentiert.
