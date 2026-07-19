# Release-Checklist – Unfallwerkbank

Vor jedem Release sollten die folgenden Smoke-Tests in **allen fünf
Betriebsarten** erfolgreich durchlaufen werden.  Die Prüfungen sind bewusst
manuell und kurz – sie ergänzen die automatisierte Test-Suite (`npm test`,
`npm run test:e2e`) und stellen sicher, dass jede unterstützte Variante real
funktioniert.

> **Aktueller Release-Blocker:**
> `npm run validate:vendor-provenance -- --require-complete` muss grün sein.
> Bis [#406](https://github.com/carstenartur/Unfallatlas/issues/406) ist die
> Komponenten-/Lizenzprovenienz der opaken Exportbundles und Roboto-Fonts
> ausdrücklich unvollständig; Pages und Release brechen deshalb fail-closed ab.

> Übersicht der Betriebsmodi: siehe README → *Betriebsmodi – Browser-only ·
> Node-Standalone · Node + Analysis Service*.

---

## 1. Browser-only (GitHub Pages oder lokaler kanonischer Site-Build)

```bash
npm ci
npm run serve:site
```

- [ ] `werkbank_v2.html` öffnet, Karte und Stadtauswahl erscheinen
- [ ] Stadt wechseln (z. B. Bonn → Hannover) funktioniert
- [ ] Filter (Beteiligung, Schwere, Uhrzeit, Wochentag) wirken
- [ ] Cluster, Heatmap und Hotspot-Anzeige aktivierbar
- [ ] Bereichsauswahl per Rechteck funktioniert
- [ ] PDF- und Word-Export wird erzeugt (deterministisch, ohne Server)
- [ ] CSV-, GeoJSON- und KML-Download liefern eine valide Datei
- [ ] Geteilte URL reproduziert den exakt gleichen Zustand
- [ ] Tour-Player startet (`?tour=demo`)
- [ ] `_site/build-manifest.json` enthält gelockte Dependency- und Datenfingerprints
- [ ] `npm run validate:media` besteht (Abmessungen, Budget, Referenzen)
- [ ] `npm run validate:vendor-provenance -- --require-complete` besteht
- [ ] **Erwartet nicht verfügbar:** Video-Export-Button, KI-Bewertung,
      Button „Politische Vorgänge recherchieren" (graceful degradation)

## 2. Lokaler Server **ohne** `GEMINI_API_KEY`

```bash
unset GEMINI_API_KEY
npm run start:server
# → http://localhost:8000
```

- [ ] `GET /api/health` antwortet `{ status: "ok" }`
- [ ] `GET /api/ai-assessment-available` liefert `{ available: false }`
- [ ] `GET /api/political-context/supported` liefert nicht-leere
      `cities`-Liste
- [ ] Werkbank lädt, alle Browser-only-Punkte (s. o.) bleiben erfüllt
- [ ] **Politische Recherche** liefert für mindestens eine unterstützte
      Stadt (z. B. Hannover) Treffer; Übernahme in den Export funktioniert
- [ ] **Export ohne KI** liefert vollständigen PDF-/Word-Antrag mit
      Statistik, Karte, POI-Analyse und Beschlussvorschlag
- [ ] `POST /api/ai/export-assessment/v2` antwortet `200 OK` mit
      `source: "fallback"` (deterministischer Output)
- [ ] `POST /api/ai/export-assessment` (v1) antwortet `503` mit Hinweis
      auf fehlenden `GEMINI_API_KEY`

## 3. Lokaler Server **mit** `GEMINI_API_KEY`

```bash
export GEMINI_API_KEY=...     # gültiger Schlüssel
npm run start:server
```

- [ ] `GET /api/ai-assessment-available` liefert `{ available: true }`
- [ ] `POST /api/ai/export-assessment/v2?mode=assessment` liefert
      `source: "ai"` (oder `"cache"` bei Wiederholung) und
      schemakonformes Ergebnis
- [ ] `POST /api/ai/export-assessment/v2?mode=proposal-brief` liefert
      schemakonformen Maßnahmen­steckbrief
- [ ] Wiederholung derselben Anfrage → `source: "cache"`
- [ ] Asynchroner Job: `POST /api/ai/jobs` → `202`, anschließend
      `GET /api/ai/jobs/:id` erreicht `status: "done"` mit Ergebnis
- [ ] Politische Recherche funktioniert wie in Variante 2
- [ ] **Export mit KI**: PDF/Word enthält die übernommenen KI-Bewertungs­
      bausteine zusätzlich zu den deterministischen Tabellen
- [ ] **Export ohne KI** in derselben Session weiterhin möglich
      (Nutzer entscheidet pro Export, ob KI verwendet wird)

## 4. Docker

```bash
docker compose up
# oder:
docker run -p 8000:8000 -e GEMINI_API_KEY=... \
  ghcr.io/carstenartur/unfallatlas
```

- [ ] Container startet, `http://localhost:8000` erreichbar
- [ ] Werkbank lädt (`werkbank_v2.html`), Karte sichtbar
- [ ] Button **„🎬 Als Video exportieren"** ist sichtbar (nur Docker)
- [ ] Video-Export liefert in allen drei Formaten (`gif`, `webp`, `apng`) eine valide Datei (Magic-Byte-Check)
- [ ] Mit gesetztem `GEMINI_API_KEY`: KI-Bewertung funktioniert (s. o.)
- [ ] Ohne `GEMINI_API_KEY`: KI-Endpunkte verhalten sich wie in Variante 2
- [ ] Politische Recherche funktioniert für die unterstützten Städte
- [ ] Container-Logs enthalten keine API-Keys oder PII
- [ ] Rate-Limit greift bei `>3` Video-Requests/min mit `429`

## 5. Node + Analysis Service (Persistenz aktiv)

Voraussetzung: Compose-Profil `persist` startet PostgreSQL, den
Analysis Service (Spring Boot, Port `8081`) und die Node-App.

```bash
docker compose --profile persist up
# Node:               http://localhost:8000
# Analysis Service:   http://localhost:8081
```

Stand-alone (ohne Docker) lokal:

```bash
export ANALYSIS_SERVICE_BASE_URL=http://localhost:8081
npm run start:server
# parallel:
cd analysis-service && SPRING_PROFILES_ACTIVE=prod \
  ANALYSIS_DB_URL=jdbc:postgresql://localhost:5432/unfallatlas \
  ANALYSIS_DB_USER=unfallatlas ANALYSIS_DB_PASSWORD=… mvn spring-boot:run
```

### PostgreSQL & Flyway-Start

- [ ] Analysis Service startet ohne Fehler; Logs zeigen Flyway-Migration
      `V1__init_schema.sql` (und ggf. `V2__…`, `V3__…`) als `Successfully applied`
- [ ] `spring.jpa.hibernate.ddl-auto=validate` ist aktiv (kein
      automatisches Schema-Update); Schema wird validiert
- [ ] PostgreSQL-Container ist erreichbar (Compose-Profil `persist`)
      bzw. lokale DB enthält die Tabellen `location_action_brief`,
      `conflict_pattern_assessment`, `candidate_measure_assessment`,
      `prioritization_profile_score`, `political_reference_summary`,
      `analysis_job` und die `BATCH_*`-Metadatentabellen

### Health & Actuator

- [ ] `GET http://localhost:8081/actuator/health` antwortet
      `{ "status": "UP" }` (DB + Anwendung)
- [ ] `GET http://localhost:8081/actuator/info` liefert Build-/App-Info
- [ ] `GET http://localhost:8000/api/status` zeigt
      `capabilities.analysisService.available: true`,
      `reasonCode: "ok"`,
      `capabilities.batchJobs.supportedJobs` enthält
      `"city-prioritization-job"`

### Persistieren eines Location Briefs

- [ ] `POST http://localhost:8000/api/location-brief` mit `persist: true`,
      `locationId` und `profile` antwortet `200 OK` mit
      `persistence.status: "persisted"`, `persistence.storedId` gesetzt,
      `persistence.attempts >= 1`
- [ ] Wiederholtes Posten desselben Briefs (gleiche Eingaben) liefert
      denselben Datensatz zurück (Idempotenz über
      `locationKey + profileKey + sourceFingerprint`) – kein Duplikat
- [ ] Ohne `persist` (Default): Antwort enthält
      `persistence.status: "freshly_computed"`, `persisted: false`
- [ ] Mit `useStored: true` und vorhandenem Brief: Antwort enthält
      `source: "analysis-service"` und
      `persistence.status: "loaded_from_store"`
- [ ] Bei abgeschaltetem Analysis Service (`docker compose stop
      analysis-service`) liefert die Node-App den Brief weiter aus mit
      `persistence.status: "persist_skipped"` und einem `reason` – **kein** `5xx`

### Abruf by-location

- [ ] `GET http://localhost:8000/api/location-briefs/by-location/<key>`
      liefert ein Array gespeicherter Briefs (neueste zuerst), 1:1
      vom Analysis Service durchgereicht
- [ ] Ohne konfigurierten Analysis Service: Endpunkt antwortet
      `503 ANALYSIS_SERVICE_NOT_CONFIGURED`
- [ ] Bei Upstream-Fehler (Service down): `502 upstream_error` mit
      `details.attempts > 0`

### Top-N / Profil-Ranking

- [ ] `GET /api/location-briefs/top?city=Hannover&profile=safety_first&limit=10`
      liefert Array sortiert nach Profil-Score (höchster zuerst)
- [ ] `GET /api/location-briefs?city=Hannover&profile=low_hanging_fruit&page=0&size=20`
      liefert paginierte Ergebnisse einer Stadt
- [ ] `POST /api/batch/jobs/city-prioritization` mit
      `{city, profile, limit, runLabel}` antwortet `202` mit
      `executionId`; anschließend zeigt
      `GET /api/batch/jobs/{executionId}` schließlich `status: "COMPLETED"`
- [ ] `GET /api/batch/jobs/{executionId}/summary` liefert die
      fachliche Top-N-Zusammenfassung

## 6. Querschnitts-Checks

- [ ] `npm test` (Unit + Integration) ist grün
- [ ] `npm run test:e2e` (Playwright) ist grün
- [ ] `npm run smoke` gegen den laufenden Server ist grün (deckt Variante 2/3/4 schnell ab; siehe [`scripts/smoke.sh`](../scripts/smoke.sh))
- [ ] `GET /api/status` zeigt für die jeweilige Betriebsart die korrekten `reasonCode`-Werte (`missing_api_key` ohne Key, `ok` mit Key, `server_only_feature` für Video-Export)
- [ ] CHANGELOG / Release-Notes erwähnen alle neuen oder geänderten
      Endpunkte und Env-Variablen
- [ ] Doku ist aktuell:
      [`README.md`](../README.md),
      [`docs/architecture.md`](architecture.md),
      [`docs/server-features.md`](server-features.md),
      [`server/ai/README.md`](../server/ai/README.md),
      [`server/political-context/README.md`](../server/political-context/README.md),
      [`analysis-service/README.md`](../analysis-service/README.md)

## 7. Stabilisierungs-Checks (vor Release)

- [ ] README-Linkprüfung: kein `¢erLat`/`¢erLon`, keine isolierten kaputten Symbolzeichen (`grep -nP "¢er(Lat|Lon)" README.md` muss leer sein).
- [ ] README-Demo-Asset aktuell — `npm run regen:demo` neu ausgeführt (kanonisches GIF, harte 9-MiB-/60-Sekunden-Budgets ohne stillen Formatwechsel), Datum/Commit im PR notiert.
- [ ] Live-Demo-Hydration: Playwright-Test gegen GitHub Pages mit Bonn-URL grün.
- [ ] Steigungslayer bleibt nach Filterwechsel/Stadtreload/Exportdialog sichtbar.
- [ ] PDF-Render-Gate in CI grün (`npm run generate:sample-pdf && npm run test:render-gate -- --pdf out/ci-render-gate.pdf`).
- [ ] Bildseitenverhältnistest (`ua.report_v2.imageAspectRatio.test.js`) grün.
