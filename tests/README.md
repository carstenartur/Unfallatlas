# Unfallwerkbank-Testarchitektur

Der veröffentlichte Build- und Testvertrag beginnt immer im Repository-Root mit
Maven. GitHub Actions verwendet dieselben Befehle wie ein lokaler Checkout und
enthält keine eigene npm-, Playwright-, Jest- oder Testcontainers-Orchestrierung.

## Voraussetzungen

Für den normalen Build werden JDK 21 oder neuer und Maven 3.9.6 oder neuer
benötigt. Node.js und npm werden vom `frontend-maven-plugin` in den
Build-Ausgabeordner geladen; eine globale Node-Installation ist nicht nötig.

Profile mit `*-it`, Kontextdaten oder Golden Cases benötigen zusätzlich einen
erreichbaren Docker-Daemon. PostgreSQL, Browser, ffmpeg, ImageMagick und die zu
prüfenden Anwendungen werden als Container gestartet.

Das Profil `document-render` benötigt LibreOffice Writer, Poppler und die in der
CI installierten Dokumentfonts. Das Profil `documentation-live` benötigt
Netzzugang zu den explizit erlaubten realen Kartenanbietern.

## Kanonische Befehle

| Zweck | Befehl |
|---|---|
| Unit-, Integrations- und Performance-Tests sowie Analysis Service | `mvn clean verify` |
| Öffentliches Pages-Artefakt einschließlich Browser-Gate | `mvn clean verify -Ppages` |
| Pages-Artefakt nach vollständiger Datengenerierung | `mvn clean verify -Ppages-regenerated` |
| Chromium-, Accessibility-, Firefox- und WebKit-QA | `mvn verify -Pe2e` |
| alle grundlegenden JUnit-/Testcontainers-Systemtests | `mvn verify -Psystem-it` |
| Produktionscontainer und Videoexport | `mvn verify -Pvideo-export-it` |
| Bonn-/Hannover-Golden-Cases mit PostgreSQL | `mvn verify -Plocation-brief-golden` |
| Kontextdaten erzeugen und im Produktionscontainer rendern | `mvn verify -Pcontext-data-e2e` |
| natives PDF und DOCX über LibreOffice/Poppler prüfen | `mvn verify -Pdocument-render` |
| echte Dokumentationskarten ohne Linkprüfung | `mvn verify -Pdocumentation-live -Ddocumentation.liveLinks=false` |
| echte Dokumentationskarten mit veröffentlichten Links | `mvn verify -Pdocumentation-live -Ddocumentation.liveLinks=true` |
| Release-Site mit vollständiger Vendor-Provenienz | `mvn clean verify -Prelease-site` |
| gesamte erweiterte PR-QA | `mvn clean verify -Pe2e,system-it,location-brief-golden '-Dfailsafe.includes=**/*IT.java'` |

Die npm-Skripte bleiben interne Implementierungsbausteine und können bei einer
gezielten Diagnose einzeln verwendet werden. Sie sind keine zweite
Build-Schnittstelle.

## Verantwortlichkeiten

### Maven

Maven besitzt Toolchain, Testauswahl, Reihenfolge, Integrationsphasen,
Containerprofile, Reportpfade und abschließende Erfolgskriterien. Ein Workflow
stellt nur Checkout, JDK, Docker oder Betriebssystempakete bereit und ruft pro
Job höchstens einen dokumentierten Maven-Befehl auf.

### Jest und Playwright

Jest prüft JavaScript-nahe Unit- und Integrationslogik. Playwright prüft die
reale Browseroberfläche. Beide werden im kanonischen Ablauf vom Maven-Lifecycle
gestartet. Das Profil `e2e` baut `_site` genau einmal und verwendet dieses
unveränderte Artefakt für Chromium, Accessibility, Firefox, WebKit und die
abschließende Screenshot-Evidenz.

### JUnit 5, Failsafe und Testcontainers

Systemweite Verträge liegen im Modul [`qa-system-tests`](../qa-system-tests/).
Sie heißen `*IT.java` und werden von Maven Failsafe in `integration-test` und
`verify` ausgeführt. Java Testcontainers besitzt den Lebenszyklus aller
externen Laufzeitkomponenten; feste Host-Ports, Sleeps und vorab gestartete
lokale Dienste sind nicht zulässig.

Nativ geprüft werden:

1. **Produktionscontainer der Unfallwerkbank**
   - Build aus dem exakten Checkout;
   - Health- und Build-Manifest-Vertrag;
   - kein Zugriff auf Repository-Metadaten;
   - früher Abbruch ungültiger Videoanfragen;
   - echter GIF-Export mit Hash-, Provenienz- und Pixel-Evidenz;
   - sichtbare Steigungs- und Verkehrslayer in Container-Chromium.

2. **Analysis Service mit PostgreSQL 17**
   - Produktionsprofil statt H2-Fallback;
   - isoliertes Container-Netzwerk;
   - Actuator-Health, Flyway-Migrationen und Anwendungsschema.

3. **Bonn-/Hannover-Golden-Cases**
   - JavaScript-Produktlogik erzeugt die fachlich autoritativen Brief-Payloads;
   - JUnit speichert sie über den realen Analysis Service in PostgreSQL;
   - Spring Batch priorisiert die Orte;
   - positive Fälle müssen vor negativen Fällen rangieren.

4. **Kontextdaten-End-to-End**
   - Maven erzeugt und validiert OSM-, Steigungs- und Verkehrsdatensätze;
   - JUnit baut danach den Produktionscontainer;
   - Chromium weist echte Canvas-Pixel und beide sichtbaren Legenden nach.

Damit existiert keine zweite Java-Implementierung der fachlichen
Location-Brief-Regeln.

## Report- und Evidenzpfade

| Inhalt | Pfad |
|---|---|
| JUnit/Failsafe XML und Textreports | `qa-system-tests/target/failsafe-reports/` |
| Testcontainers-Logs | `qa-system-tests/target/testcontainers-logs/` |
| Analysis-Service-Unit-Tests | `analysis-service/target/surefire-reports/` |
| Jest Coverage und Integrationsreport | `coverage/` |
| Playwright HTML-Report | `playwright-report/` |
| Playwright Testartefakte | `test-results/` |
| fachliche und Dokument-QA | `out/qa/` |
| erzeugte Dokumentationsscreenshots | `docs/screenshots/` |

## Gezielte Diagnose

Ein einzelner Systemtest kann weiterhin über Maven ausgewählt werden:

```bash
mvn -pl qa-system-tests -am verify -Psystem-it \
  -Dfailsafe.includes='**/ProductionContainerIT.java'
```

Für den PostgreSQL-Vertrag wird entsprechend
`**/AnalysisServicePostgresIT.java` verwendet. Vor einem Commit ist mindestens
der zugehörige vollständige Maven-Profilbefehl maßgeblich.

## Neue Tests hinzufügen

- Reine JavaScript-Funktionen gehören nach `tests/unit/`.
- Browserabläufe und Accessibility-Verträge gehören nach `tests/e2e/`.
- Black-Box-Verträge über mehrere Prozesse oder Infrastrukturkomponenten
  gehören als JUnit-`*IT.java` nach `qa-system-tests/src/test/java/`.
- Neue Dienste und Datenbanken werden dort mit Testcontainers bereitgestellt.
- Neue Profile und Evidenzpfade werden in `pom.xml`, dieser Datei und
  `docs/site-build.md` dokumentiert.
